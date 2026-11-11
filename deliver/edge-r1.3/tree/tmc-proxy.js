#!/usr/bin/env node
// TMC Mac Terminal — local CORS proxy for the ProjectX/TopstepX Gateway API.
//
// Browsers block cross-origin requests from a page opened as a local file
// (or from any page on a different origin) straight to api.topstepx.com,
// because that API doesn't send CORS headers. This tiny proxy runs on your
// own machine, forwards your requests to the real API, and adds the CORS
// headers so the browser will accept the response.
//
// Usage:
//   node tmc-proxy.js
// Then open terminal.html in your browser (it already points at
// http://localhost:8787). No npm install needed — this only uses Node's
// built-in http/https modules.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 8787;
const UPSTREAM_HOST = 'api.topstepx.com';
// Shared-secret gate (2026-09-21): this proxy was designed to only ever run
// on localhost, where "anyone who can reach it" already means "you, on your
// own machine" — no auth needed. Running it on a public VPS (so the bot and
// terminal work when you're away from home) changes that completely: with
// CORS wide open and no auth, ANYONE who finds the IP:port could relay
// requests to your real TopstepX account through this proxy. Set
// PROXY_SECRET in the environment to require every request to carry it,
// either as an X-Proxy-Key header or a ?key= query param (handy for a quick
// curl check or a test URL pasted straight into a browser); unset (the
// original localhost-only usage) is unchanged — no auth, exactly as before.
const PROXY_SECRET = process.env.PROXY_SECRET || null;
// live-executor.js writes its live bias readout here every 15m bar close,
// into the SAME folder this proxy runs from. Serving it from the already-
// running proxy means the terminal can poll one local origin for both the
// real API and the bot's own bias state, without a second server or a
// second copy of the indicator logic. One file PER SYMBOL (2026-09-22) once
// more than one instrument can be trading at once — see the ?symbol=
// handling below for the filename it actually resolves to per request.
function biasFilePath(symbol) { return path.join(__dirname, `bias-snapshot-${symbol}.json`); }
// Same file live-executor.js's appendJournal()/journalSignalSnapshot() write
// to — one JSONL stream per symbol holding every signal check (traded or
// sat-out + why), every real entry, and every peak-unrealized record.
// Mobile's Signal Journal tab (2026-09-24) reads this directly; nothing here
// can affect what the bot does, it's a read-only tail of an append-only file.
const TRADE_LOG_TYPES = new Set(['trade_plan', 'trade_manage', 'trade_block']); // TRADE LOG rows: served by /trade-why and /trade-blocks, kept out of the journal card feed
function journalFilePath(symbol) { return path.join(__dirname, `trade-journal-${symbol}.jsonl`); }

// Trading-day/week boundaries for /trade-stats (2026-10-09) — deliberately
// reimplemented here rather than require()'d from ../mac-bot/lib/dailyRisk,
// matching this file's own "no dependencies outside Node's built-ins, runs
// standalone" design (see the header comment). tradingDayKey mirrors
// lib/dailyRisk.js's function EXACTLY (same TopstepX reset: 5pm Chicago
// time, same Intl-based offset lookup) so "Daily" here means the identical
// trading day live-executor.js's own currentDayKey/dayPnl already use —
// keep the two in sync if either ever changes.
function chicagoOffsetHours(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const m = s.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -6;
}
function tradingDayKey(ts) {
  const now = new Date(ts);
  const offset = chicagoOffsetHours(now);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const yyyy = parseInt(parts.year, 10), mm = parseInt(parts.month, 10), dd = parseInt(parts.day, 10);
  let sessionStartUTC = Date.UTC(yyyy, mm - 1, dd, 17 - offset, 0, 0);
  if (now.getTime() < sessionStartUTC) sessionStartUTC -= 86400000;
  return sessionStartUTC;
}
// "Weekly" = the current CME trading week, which opens Sunday 5pm CT —
// i.e. the tradingDayKey of the most recent Sunday. dayKey's own instant
// (17:00 Chicago time on its calendar day) always falls on that same
// calendar day, so its Chicago weekday IS the trading day's weekday.
function weekStartKey(ts) {
  const dayKey = tradingDayKey(ts);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(new Date(dayKey)));
  return dayKey - weekday * 86400000;
}

// The /trade-stats supersede rule, shared with /trade-list (10/16): does closed row `e` replace `prev` for the same journalId?
// The last 'closed' row wins, except a broker-confirmed row (pnlSource 'broker') is never superseded by a non-broker one.
function closedRowSupersedes(prev, e) { return !(prev && prev.pnlSource === 'broker' && e.pnlSource !== 'broker'); }

// Shared aggregator (2026-10-09) — same math for every time window
// (daily/weekly/all-time), so the three stat boxes can never drift from
// each other's definition of win rate/PF/etc., only the trade list differs.
function aggregateTradeStats(trades) {
  const wins = trades.filter(t => (t.realizedPnl || 0) > 0);
  const losses = trades.filter(t => (t.realizedPnl || 0) <= 0);
  const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.realizedPnl || 0), 0));
  const totalPnl = trades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const bySource = {};
  for (const t of trades) {
    const key = t.source || 'unknown';
    if (!bySource[key]) bySource[key] = { count: 0, pnl: 0 };
    bySource[key].count++; bySource[key].pnl += (t.realizedPnl || 0);
  }
  const byDir = { long: { count: 0, pnl: 0 }, short: { count: 0, pnl: 0 } };
  for (const t of trades) {
    const k = t.dir === 1 ? 'long' : 'short';
    byDir[k].count++; byDir[k].pnl += (t.realizedPnl || 0);
  }
  // Giveback — how much of the peak unrealized gain got handed back before
  // exit, only over trades that actually ran up a real peak (peakUnrealized
  // > 0); 2026-10-08's trade review flagged a real +$480->-$15 case, this
  // makes that pattern visible at a glance instead of only found by
  // manually reading individual trade rows.
  const ranUp = trades.filter(t => (t.peakUnrealized || 0) > 0);
  const avgGiveback = ranUp.length ? ranUp.reduce((s, t) => s + (t.peakUnrealized - (t.realizedPnl || 0)), 0) / ranUp.length : null;
  return {
    totalClosed: trades.length,
    wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? 100 * wins.length / trades.length : null,
    totalPnl, avgPnl: trades.length ? totalPnl / trades.length : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    bestTrade: trades.length ? Math.max(...trades.map(t => t.realizedPnl || 0)) : null,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.realizedPnl || 0)) : null,
    firstTradeTime: trades.length ? (trades[0].exitTime || trades[0].t) : null,
    lastTradeTime: trades.length ? (trades[trades.length - 1].exitTime || trades[trades.length - 1].t) : null,
    bySource, byDir, avgGiveback,
    // 2026-10-12 journal fix: how many of these trades carry the broker's own exit/P&L (pnlSource 'broker', appended by
    // live-executor.js once the fills arrive) vs. only the bot's same-poll estimate (older rows have no pnlSource at all).
    brokerConfirmed: trades.filter(t => t.pnlSource === 'broker').length,
    estimated: trades.filter(t => t.pnlSource !== 'broker').length,
  };
}

const server = http.createServer((req, res) => {
  // CORS headers on every response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Proxy-Key');
  // Every response here is live/dynamic (account balance, position,
  // bias) — mobile browsers, especially a home-screen-launched standalone
  // PWA, can otherwise cache a GET response longer than expected, showing
  // stale numbers (e.g. an old account's balance) after something changes
  // server-side until the cache happens to expire.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, 'http://localhost');
  // live-executor.js is ALSO a client of this proxy (lib/bars.js's ptxFetch
  // always routes through PROXY_BASE = 'http://localhost:8787', even for its
  // own login/order calls) — not just the browser pages. A request that
  // arrives over the loopback interface is, by definition, already running
  // on this same machine, which was the ENTIRE trust boundary before
  // PROXY_SECRET existed (anyone who could reach localhost:8787 already had
  // a shell here). So loopback stays exempt — the secret only gates the
  // PUBLIC-facing surface (your phone, your browser, reached via the
  // droplet's public IP) that didn't exist as a concern until this ran on a
  // VPS instead of your own laptop.
  const isLoopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  if (PROXY_SECRET && !isLoopback) {
    const supplied = req.headers['x-proxy-key'] || reqUrl.searchParams.get('key');
    if (supplied !== PROXY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errorMessage: 'Missing or incorrect proxy key.' }));
      return;
    }
  }

  // Multi-instrument (2026-09-22): each live-executor.js instance (one per
  // symbol — MNQ, MGC, ...) writes/reads its OWN namespaced files. ?symbol=
  // picks which one; strictly whitelisted to A-Z0-9 before it ever touches
  // a file path, since this value would otherwise flow straight into one —
  // an unsanitized value here would be a path-traversal hole.
  const rawSymbol = (reqUrl.searchParams.get('symbol') || 'MNQ').toUpperCase();
  const symbol = /^[A-Z0-9]{1,10}$/.test(rawSymbol) ? rawSymbol : 'MNQ';

  // Exact-entry cancel is deliberately separate from /flatten. Receipt means queued only.
  if (reqUrl.pathname === '/cancel-entry' && ['POST', 'GET'].includes(req.method)) {
    try {
      if (!/^[A-Z0-9]{1,10}$/.test(rawSymbol)) throw new Error('Invalid symbol');
      const queue = require('./lib/entryCancelRequests').store(__dirname, rawSymbol);
      let receipt;
      if (req.method === 'GET') receipt = queue.read(reqUrl.searchParams.get('requestId'));
      else {
        const target = JSON.parse(reqUrl.searchParams.get('target') || 'null');
        receipt = queue.enqueue(target, t => {
          const snapshot = JSON.parse(fs.readFileSync(biasFilePath(rawSymbol), 'utf8'));
          const expected = snapshot?.position?.cancelTarget;
          if (!expected || require('./lib/entryCancelRequests').requestId(rawSymbol, expected) !== require('./lib/entryCancelRequests').requestId(rawSymbol, t)) throw new Error('Snapshot target mismatch');
        });
      }
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, ...receipt }));
    } catch (e) {
      res.writeHead(e.code === 'ENOENT' ? 404 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, outcome: 'failed', errorMessage: 'Request could not be read or queued; no cancellation confirmed' }));
    }
    return;
  }

  // Manual flatten (2026-09-22): mobile.html's "Flatten Position" button
  // posts here. This proxy never holds your real TopstepX credentials and
  // never will — it just drops a marker file that the matching
  // live-executor.js instance (which DOES hold them) checks every poll
  // cycle and acts on itself. A request that only has the proxy key can
  // request a flatten; it can never place a new order, change a stop, or do
  // anything that INCREASES risk — the one thing this endpoint can trigger
  // only ever reduces exposure.
  if (req.method === 'POST' && reqUrl.pathname === '/flatten') {
    try {
      // botfix-B: the request carries its own id and write time (the bot rejects one older than 60 s and acks each id in the snapshot's requests.lastAck);
      // written atomically (tmp + rename). The response keeps its old fields and adds requestId / requestedAt.
      const ff = path.join(__dirname, `flatten-request-${symbol}.json`), requestId = 'f-' + require('crypto').randomBytes(8).toString('hex'), requestedAt = Date.now();
      fs.writeFileSync(ff + '.tmp', JSON.stringify({ id: requestId, requestedAt })); fs.renameSync(ff + '.tmp', ff);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, outcome: 'requested', requestId, requestedAt }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errorMessage: e.message }));
    }
    return;
  }

  // Manual PAUSE / RESUME (2026-10-16, owner: "break" buttons on the phone). Same trust model and the same auth path as /flatten above (the proxy key gate runs
  // before every route): it only drops a marker file the matching live-executor.js reads every poll. A pause can only BLOCK new entries (and cancel a resting
  // entry order through the bot's verified cancel); it never places an order. minutes must be 5, 10, 15 or 30; 0 = resume. Anything else is refused (400).
  if (req.method === 'POST' && reqUrl.pathname === '/pause') {
    // round 4 (QA M3): exactly 0, 5, 10, 15 or 30 as typed; an empty value, 1e1, 0x5, ' 5' or 5.0 is refused (an empty minutes= used to mean RESUME)
    const raw = reqUrl.searchParams.get('minutes');
    if (raw === null || !/^(0|5|10|15|30)$/.test(raw)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errorMessage: 'minutes must be 5, 10, 15 or 30 (0 = resume)' }));
      return;
    }
    try {
      const m = Number(raw), pf = path.join(__dirname, `pause-request-${symbol}.json`), requestId = 'p-' + require('crypto').randomBytes(8).toString('hex'), requestedAt = Date.now();   // botfix-B: + id
      fs.writeFileSync(pf + '.tmp', JSON.stringify({ id: requestId, minutes: m, requestedAt })); fs.renameSync(pf + '.tmp', pf);   // round 4 (QA M2): atomic (tmp + rename)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, minutes: m, requestId, requestedAt }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errorMessage: e.message }));
    }
    return;
  }

  // OWNER FLAG (edge r1.3, record only): the phone's Flag button on a trade posts here. Same trust model and auth path as /flatten and /pause (the proxy key
  // gate runs before every route): it only queues one small file per request in owner-flag-<SYMBOL>/ that the matching live-executor.js reads about every 3 s.
  // A flag can never place, cancel or change an order: the bot writes one journal row (owner_flag) and answers in the snapshot's requests.lastAck / recent
  // under the requestId returned here. Fields: trade, reason, note (optional), id (optional, for a retry of the same tap) - as query parameters or a JSON body
  // (at most 4 kB; the body wins). The bot validates them; this route only refuses an oversized body or a full queue.
  if (req.method === 'POST' && reqUrl.pathname === '/flag') {
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > 4096) over = true; else chunks.push(c); });
    req.on('error', () => { try { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, errorMessage: 'request could not be read' })); } catch (e) { /* closed */ } });
    req.on('end', () => {
      try {
        if (over) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, errorMessage: 'flag request too large (4 kB limit)' })); return; }
        const q = k => (reqUrl.searchParams.has(k) ? reqUrl.searchParams.get(k) : undefined);
        let input = { id: q('id'), trade: q('trade'), reason: q('reason'), note: q('note') };
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (text) { let b = null; try { b = JSON.parse(text); } catch (e) { b = null; }
          if (!b || typeof b !== 'object' || Array.isArray(b)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, errorMessage: 'body must be a JSON object' })); return; }
          input = { ...input, ...b }; }
        const r = require('./lib/ownerFlags').enqueue(__dirname, symbol, input);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, outcome: 'requested', ...r }));
      } catch (e) {
        res.writeHead(e.code === 'QUEUE_FULL' ? 429 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errorMessage: e.code === 'QUEUE_FULL' ? e.message : 'flag could not be queued' }));
      }
    });
    return;
  }

  if (reqUrl.pathname === '/bias') {
    fs.readFile(biasFilePath(symbol), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Alignment-Display-Served-At': String(Date.now()) });
        res.end(JSON.stringify({ available: false, reason: `live-executor.js for ${symbol} has not written a snapshot yet — is it running?` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Alignment-Display-Served-At': String(Date.now()) });
      res.end(data);
    });
    return;
  }

  // Signal journal (2026-09-24, mobile Tab 1). ?limit= caps how many of the
  // most RECENT lines come back (default 150) — the file only ever grows,
  // so this is a tail read, not the whole history, every 15s poll.
  //
  // ?filter= (2026-10-09, JayMac: "the signal filters are not working...
  // none of the old logs are coming up when clicking the filters") — with
  // intrabar polling writing a signal_check row roughly every
  // CONFIG.evaluationIntrabarPollMs (~20s, almost all 'sat_out'), a plain
  // tail of 100-500 RAW lines can be 100% sat_out (confirmed: the last 100
  // lines of a real live file were ALL sat_out, spanning just 35 minutes) —
  // so clicking Traded/Pending/Canceled found nothing to show, not because
  // filtering was broken, but because the unfiltered tail never reached far
  // enough back to contain a match. When ?filter= is one of
  // traded/pending/canceled (sat_out needs no grouping, handled as a plain
  // tail filter), this reads the FULL file, groups signal_check rows by
  // journalId, and computes each group's current lifecycle bucket — this
  // MIRRORS mobile.html's own cardState()/cardFilterBucket() exactly (a
  // group showing 'closed' counts as the 'traded' bucket, same as there;
  // keep the two in sync if either ever changes) — then returns whole
  // matching groups' rows, most recent first, instead of a blind raw tail.
  if (reqUrl.pathname === '/signal-journal') {
    const rawLimit = parseInt(reqUrl.searchParams.get('limit'), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 150;
    const filter = reqUrl.searchParams.get('filter') || 'all';
    fs.readFile(journalFilePath(symbol), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: `No journal file yet for ${symbol} — live-executor.js writes one on its first signal check.` }));
        return;
      }
      let entries;
      if (filter === 'all') {
        // TRADE LOG (2026-10-13): trade_plan / trade_manage / trade_block rows are left out BEFORE the tail window and the journalId completion below, so they cannot change which cards show
        const allLines = data.split('\n').filter(l => l && !/^\{"type":"trade_(plan|manage|block)"/.test(l));
        const lines = allLines.slice(-limit);
        entries = [];
        for (const line of lines) {
          try { entries.push(JSON.parse(line)); } catch (e) { /* one bad line shouldn't sink the rest */ }
        }
        // 2026-10-12 fix 2: a broker-confirmed 'closed' row is APPENDED later (possibly days later, by the startup backfill), so the
        // tail can hold it without the trade's own pending/traded/estimate rows. Cards built from that lone row lost the entry
        // line and showed the reconcile time as the trade time. Rule: a trade whose only rows in the tail are broker rows belongs
        // to the past and is dropped here (it still shows under the Traded filter and in the stats); a trade with any of its own
        // rows in the tail is completed with ALL its rows from the full file.
        const inTail = new Map();
        for (const e of entries) {
          if (!e.journalId) continue;
          if (!inTail.has(e.journalId)) inTail.set(e.journalId, { own: false });
          if (e.pnlSource !== 'broker') inTail.get(e.journalId).own = true;
        }
        if (inTail.size) {
          const complete = new Set([...inTail].filter(([, v]) => v.own).map(([k]) => k));
          const extra = [];
          const tailStart = allLines.length - lines.length;
          for (let i = 0; i < tailStart; i++) {
            const line = allLines[i];
            if (line.indexOf('"journalId"') < 0) continue;
            let e; try { e = JSON.parse(line); } catch (e2) { continue; }
            if (e.journalId && complete.has(e.journalId)) extra.push(e);
          }
          entries = extra.concat(entries.filter(e => !e.journalId || complete.has(e.journalId)));
          entries.sort((a, b) => a.t - b.t);
        }
      } else if (filter === 'sat_out') {
        // No grouping needed — sat_out rows are always standalone (no journalId).
        const all = [];
        for (const line of data.split('\n')) {
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === 'signal_check' && e.outcome === 'sat_out') all.push(e);
          } catch (e2) { /* skip */ }
        }
        entries = all.slice(-limit);
      } else {
        // traded/pending/canceled — group by journalId, mirror
        // cardState()/cardFilterBucket() from mobile.html exactly.
        const groups = new Map();
        const loose = [];
        for (const line of data.split('\n')) {
          if (!line) continue;
          let e;
          try { e = JSON.parse(line); } catch (e2) { continue; }
          if (e.type !== 'signal_check') continue;
          if (!e.journalId) { loose.push(e); continue; }
          if (!groups.has(e.journalId)) groups.set(e.journalId, []);
          groups.get(e.journalId).push(e);
        }
        const cardState = (rows) => {
          if (rows.some(r => r.outcome === 'closed')) return 'closed';
          if (rows.some(r => r.outcome === 'canceled')) return 'canceled';
          if (rows.some(r => r.outcome === 'traded')) return 'traded';
          if (rows.some(r => r.outcome === 'pending')) return 'pending';
          return rows[0].outcome;
        };
        const bucket = (state) => (state === 'closed' ? 'traded' : state);
        const matchingGroups = [];
        for (const rows of groups.values()) {
          rows.sort((a, b) => a.t - b.t);
          if (bucket(cardState(rows)) === filter) matchingGroups.push(rows);
        }
        for (const e of loose) {
          if (bucket(e.outcome) === filter) matchingGroups.push([e]);
        }
        // 2026-10-12 fix 2: order trades by when they STARTED (first row), not by their last row: a broker-confirmed row appended
        // days later must not move an old trade to the top of the list.
        matchingGroups.sort((a, b) => a[0].t - b[0].t);
        entries = matchingGroups.slice(-limit).flat().sort((a, b) => a.t - b.t);
      }
      // TRADE LOG (2026-10-13): trade_plan / trade_manage / trade_block rows are served by /trade-why and /trade-blocks, not as journal cards
      entries = entries.filter(e => !TRADE_LOG_TYPES.has(e.type));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: true, entries }));
    });
    return;
  }

  // TRADE LOG (2026-10-13, owner: "I want to know why our bot is setting the stop loss, take profit targets ... to understand where the disconnect between me and it is").
  // /trade-why?journalId=...  -> the trade's plan (why it entered, why this stop / TP1 / TP2 / size) and the timeline of management events, read from the same append-only journal.
  // /trade-blocks?limit=N     -> the most recent blocked signals (cooldown, broker guard, grade/score/conflict, blackout, day stop) with plain-English reasons.
  // Read-only, same key gate as every other route.
  if (reqUrl.pathname === '/trade-why' || reqUrl.pathname === '/trade-blocks') {
    const wantWhy = reqUrl.pathname === '/trade-why';
    const jid = reqUrl.searchParams.get('journalId') || '';
    if (wantWhy && !/^[0-9a-fA-F-]{8,64}$/.test(jid)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: false, reason: 'bad journalId' })); return; }
    const rawLimit = parseInt(reqUrl.searchParams.get('limit'), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 40;
    fs.readFile(journalFilePath(symbol), 'utf8', (err, data) => {
      if (err) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: false, reason: `No journal file yet for ${symbol}.` })); return; }
      const out = wantWhy ? { available: true, found: false, journalId: jid, plan: null, manage: [], rows: [] } : { available: true, blocks: [] };
      for (const line of data.split('\n')) {
        if (!line) continue;
        if (wantWhy ? line.indexOf(jid) < 0 : line.indexOf('"trade_block"') < 0) continue;
        let e; try { e = JSON.parse(line); } catch (e2) { continue; }
        if (wantWhy) {
          if (e.journalId !== jid) continue;
          out.found = true;
          if (e.type === 'trade_plan') out.plan = e;
          else if (e.type === 'trade_manage') out.manage.push(e);
          else if (e.type === 'signal_check') out.rows.push({ t: e.t, outcome: e.outcome, entryPrice: e.entryPrice, exitPrice: e.exitPrice, realizedPnl: e.realizedPnl, pnlSource: e.pnlSource, reason: e.reason, source: e.source, grade: e.grade, peakUnrealized: e.peakUnrealized });
        } else if (e.type === 'trade_block') out.blocks.push(e);
      }
      if (wantWhy) { out.manage.sort((a, b) => a.t - b.t); out.rows.sort((a, b) => a.t - b.t); } else out.blocks = out.blocks.slice(-limit).reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  // Trade stats (2026-10-09, mobile Journal tab — JayMac: "our trade
  // journal seems to have very minimal stats now, can we improve it?", then
  // "I'd like multiple similar boxes on top of that for different time
  // frames. Daily + Weekly + All Time would be better"). Deliberately a
  // SEPARATE route from /signal-journal rather than the client aggregating
  // that tail: with intrabar polling writing a signal_check row roughly
  // every CONFIG.evaluationIntrabarPollMs (~20s, almost all 'sat_out'), the
  // 500-line tail /signal-journal caps at covers maybe the last hour,
  // nowhere near enough trades for a real win-rate/PF read, let alone a
  // weekly or all-time one. This reads the FULL file server-side (same
  // file /trade-journal-download already reads whole into memory, so no
  // new read-path risk) and aggregates ONLY the sparse 'closed' outcome
  // rows — the true lifetime trade record. Read-only; cannot affect trading.
  if (reqUrl.pathname === '/trade-stats') {
    fs.readFile(journalFilePath(symbol), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: `No journal file yet for ${symbol}.` }));
        return;
      }
      const lines = data.split('\n').filter(Boolean);
      const closedByJournalId = new Map(); // last 'closed' row per journalId wins (the estimate, then the broker-confirmed row appended later)
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch (err2) { continue; }
        if (e.type === 'signal_check' && e.outcome === 'closed' && e.journalId) {
          // 2026-10-12: a broker-confirmed row (pnlSource 'broker') supersedes the estimate and is never itself superseded by one
          if (!closedRowSupersedes(closedByJournalId.get(e.journalId), e)) continue;
          closedByJournalId.set(e.journalId, e);
        }
      }
      // 2026-10-12 fix 4: a restart-reconcile close row has no price/P&L until its broker row lands - leave it out of the numbers.
      for (const [k, v] of closedByJournalId) if (v.realizedPnl == null && v.pnlSource !== 'broker') closedByJournalId.delete(k);
      const allTrades = [...closedByJournalId.values()].sort((a, b) => (a.exitTime || a.t) - (b.exitTime || b.t));

      const now = Date.now();
      const dayStart = tradingDayKey(now);
      const weekStart = weekStartKey(now);
      const daily = aggregateTradeStats(allTrades.filter(t => (t.exitTime || t.t) >= dayStart));
      const weekly = aggregateTradeStats(allTrades.filter(t => (t.exitTime || t.t) >= weekStart));
      const allTime = aggregateTradeStats(allTrades);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: true, daily, weekly, allTime }));
    });
    return;
  }

  // Trade list (10/16, owner: "Replace the Risk tab with a tab where every triggered trade/entry the bot has taken has its own Why button").
  // /trade-list?limit=N  -> every bot-triggered trade (journalId) in the journal, newest entry first, capped at limit (default 200, max 1000).
  // A trade = a journalId with a 'traded' or 'closed' signal_check row, or a trade_plan whose order was not canceled. Per trade: entry/exit
  // time + price, side, size, realizedPnl/pnlSource (the /trade-stats supersede rule: last 'closed' row wins, broker rows are never
  // superseded by an estimate), source/grade (trade_plan first), status open|closed, and tradeDay (the TopstepX trading-day key,
  // 17:00 Chicago = 15:00 PT, the same tradingDayKey /trade-stats uses). READ-ONLY: one fs.readFile of the journal, nothing is written.
  if (reqUrl.pathname === '/trade-list') {
    const rawLimit = parseInt(reqUrl.searchParams.get('limit'), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
    fs.readFile(journalFilePath(symbol), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: `No journal file yet for ${symbol}.` }));
        return;
      }
      const groups = new Map();
      const g = jid => { if (!groups.has(jid)) groups.set(jid, { plan: null, traded: null, closed: null, canceled: false, firstT: null }); return groups.get(jid); };
      for (const line of data.split('\n')) {
        if (!line || line.indexOf('"journalId"') < 0) continue;
        let e;
        try { e = JSON.parse(line); } catch (err2) { continue; }
        if (!e || !e.journalId || typeof e.journalId !== 'string') continue;
        if (e.type === 'trade_plan') { const x = g(e.journalId); x.plan = e; if (x.firstT == null) x.firstT = e.t; continue; }
        if (e.type !== 'signal_check') continue;
        const x = g(e.journalId);
        if (x.firstT == null) x.firstT = e.t;
        if (e.outcome === 'traded') x.traded = e;   // the last 'traded' row (same rule as live-executor's openJournalTrades)
        else if (e.outcome === 'closed') { if (closedRowSupersedes(x.closed, e)) x.closed = e; }
        else if (e.outcome === 'canceled') x.canceled = true;
      }
      const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
      const trades = [];
      for (const [journalId, x] of groups) {
        const filled = !!(x.traded || x.closed);
        // A 'canceled' row with no 'closed' row = the order never filled (pending -> canceled) or the fill was voided at restart
        // ("no broker fill found"): not a trade. A plan with no outcome yet is an entry order still working: listed as open, filled false.
        if (!x.closed && (x.canceled || (!x.traded && !x.plan))) continue;
        const c = x.closed, tr = x.traded, pl = x.plan;
        const isBroker = !!(c && c.pnlSource === 'broker');
        const entryTime = num(isBroker ? c.brokerEntryTime : null) ?? num(tr && tr.t) ?? num(pl && pl.t) ?? num(x.firstT);
        const entryPrice = num(isBroker ? c.brokerEntryPrice : null) ?? num(tr && tr.entryPrice) ?? num(pl && pl.entry && pl.entry.price);
        const size = num(isBroker ? c.brokerContracts : null) ?? num(tr && tr.contracts) ?? num(c && c.contracts) ?? num(pl && pl.sizes && pl.sizes.contracts);
        const dir = [pl, tr, c].map(r => r && r.dir).find(d => d === 1 || d === -1) || null;
        trades.push({
          journalId,
          status: c ? 'closed' : 'open',
          filled,
          side: dir === 1 ? 'LONG' : dir === -1 ? 'SHORT' : null, dir,
          size,
          entryTime, entryPrice,
          exitTime: c ? (num(c.exitTime) ?? num(c.t)) : null,
          exitPrice: c ? num(c.exitPrice) : null,
          realizedPnl: c ? num(c.realizedPnl) : null,
          netPnl: c ? num(c.netPnl) : null, commissions: c ? num(c.commissions) : null,   // 10-18u2: broker NET as TopstepX prints it (null on rows written before u2)
          pnlSource: c ? (c.pnlSource || null) : null,
          source: (pl && pl.source) || (tr && tr.source) || (c && c.source) || null,
          grade: (pl && pl.grade) || (tr && tr.grade) || (c && c.grade) || null,
          pathLabel: pl ? (pl.pathLabel || pl.path || null) : null,
          hasPlan: !!pl,
          tradeDay: entryTime != null ? tradingDayKey(entryTime) : null,
        });
      }
      trades.sort((a, b) => (b.entryTime || 0) - (a.entryTime || 0) || (a.journalId < b.journalId ? 1 : -1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: true, symbol, total: trades.length, limit, trades: trades.slice(0, limit) }));
    });
    return;
  }

  // Trade log download (2026-10-09): mobile's Journal tab button — lets
  // JayMac grab the raw journal straight from his phone (tap, it lands in
  // Files/Downloads, share straight into the Claude app) instead of SSHing
  // in from a computer every time. Same file /signal-journal already reads,
  // just served as a raw attachment instead of parsed/tail-limited JSON —
  // this is the ONE place the mobile UI gets the FULL file, not a capped
  // tail, since the whole point is handing it off for real analysis.
  // Read-only, same PROXY_SECRET gate as every other route (checked above,
  // before dispatch) — this can't affect what the bot does, only read a
  // file it already writes.
  // r9.10 (Mac 10/20: minute-by-minute Levels log): the day's levels-minute file, raw, as an attachment. ?date=YYYY-MM-DD (PT), default today.
  // Read-only, same PROXY_SECRET gate as every route; the date is validated so it can never name another file.
  if (reqUrl.pathname === '/levels-minute-download') {
    const q = reqUrl.searchParams.get('date'), date = q || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, errorMessage: 'date must be YYYY-MM-DD' })); return; }
    const fp = path.join(__dirname, `levels-minute-${symbol}-${date}.jsonl`);
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, errorMessage: `No levels-minute file for ${symbol} on ${date}.` })); return; }
      res.writeHead(200, { 'Content-Type': 'application/jsonl; charset=utf-8', 'Content-Disposition': `attachment; filename="levels-minute-${symbol}-${date}.jsonl"` });
      res.end(data);
    });
    return;
  }

  if (reqUrl.pathname === '/trade-journal-download') {
    const filePath = journalFilePath(symbol);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errorMessage: `No journal file yet for ${symbol}.` }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/jsonl; charset=utf-8',
        'Content-Disposition': `attachment; filename="trade-journal-${symbol}.jsonl"`,
      });
      res.end(data);
    });
    return;
  }

  // Static pages (2026-09-21): serving these directly means a phone can
  // just navigate to http://your-vps:8787/mobile.html?key=... and bookmark
  // or "Add to Home Screen" that exact URL — the query-string key rides
  // along automatically on every future launch, no separate settings step.
  // Falls back to a small index if the file was never uploaded next to
  // tmc-proxy.js, rather than a bare 404.
  const STATIC_PAGES = { '/mobile.html': 'mobile.html', '/terminal.html': 'terminal.html', '/prop-farm.html': 'prop-farm.html' };
  if (STATIC_PAGES[reqUrl.pathname]) {
    fs.readFile(path.join(__dirname, STATIC_PAGES[reqUrl.pathname]), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`${STATIC_PAGES[reqUrl.pathname]} not found next to tmc-proxy.js on this server — upload it here too.`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<a href="/terminal.html">Desktop terminal</a> &middot; <a href="/mobile.html">Mobile status</a>');
    return;
  }

  if (!req.url.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. This proxy only forwards /api/* to ' + UPSTREAM_HOST + ', plus /bias, /signal-journal, /trade-stats, /trade-list, /trade-journal-download, /levels-minute-download, /mobile.html, and /terminal.html.');
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    const upstreamReq = https.request(
      {
        host: UPSTREAM_HOST,
        path: req.url,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          'Content-Length': Buffer.byteLength(body),
        },
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
        });
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', err => {
      console.error('Upstream request failed:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errorMessage: 'Proxy upstream error: ' + err.message }));
      }
    });

    // 15s socket timeout (2026-09-29): with no timeout, a connection that
    // goes quietly dead (no data, no FIN/RST — the exact failure mode an
    // idle weekend connection can hit) leaves this request hanging forever.
    // destroy() forces the 'error' handler above to fire so the caller
    // (live-executor.js's ptxFetch, itself now timeout-protected) gets a
    // clean failure instead of an indefinite hang one hop upstream.
    upstreamReq.setTimeout(15000, () => {
      upstreamReq.destroy(new Error('upstream request to ' + UPSTREAM_HOST + ' timed out'));
    });

    upstreamReq.end(body);
  });
});

// edge r1.2 (2026-11-11): keep idle connections open for 75 s instead of Node's default 5 s. The bot (Node fetch) reuses its
// connections; while its 15m bar-close evaluation ran (one long synchronous block) the 5 s default closed them under it, and
// the bot's next call failed at once with "fetch failed" (other side closed) - one skipped intrabar check per 15m close.
// headersTimeout must stay above keepAliveTimeout (Node's own rule).
server.keepAliveTimeout = 75000;
server.headersTimeout = 80000;

server.listen(PORT, () => {
  console.log(`TMC proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding /api/* -> https://${UPSTREAM_HOST}/api/*`);
  console.log('Leave this running, then open terminal.html in your browser.');
});

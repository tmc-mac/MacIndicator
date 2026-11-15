#!/usr/bin/env node
'use strict';
// health-watchdog.js - bf-alerts r1. A small EXTERNAL check, run every minute by cron or a systemd timer (never by the bot).
// The bot cannot push when its process is dead or frozen, so this reads the heartbeat file the bot rewrites every ~30 s
// (health-heartbeat-<SYMBOL>.json, next to live-executor.js) and pushes Mac's phone through the same ntfy channel when it is
// older than 10 minutes during trading hours. Re-pushed every 30 min while it lasts; "heartbeat back" once when it returns.
// No trading effect: it only reads two small files, writes its own state file and sends a push. It never starts, stops or restarts the bot.
//
// usage:  node health-watchdog.js [--dir <bot folder>] [--symbol MNQ] [--paper]
//   --dir     the folder that holds live-executor.js and the heartbeat (default: this script's folder)
//   --symbol  default MNQ
//   --paper   watch the paper process's heartbeat (health-heartbeat-<SYMBOL>-paper.json)
// env: NTFY_TOPIC (required to push; unset = log only), NTFY_TOKEN (optional) - the SAME values the bot's service uses.
// Exit code is always 0 (a watchdog that fails must not spam the scheduler); every outcome is one line on stdout.

const fs = require('fs');
const path = require('path');
const https = require('https');

const MIN = 60000;
const STALE_MS = 10 * MIN;
const REPUSH_MS = 30 * MIN;

function loadNP(dir) {
  for (const p of [path.join(dir, 'lib', 'notifyPolicy.js'), path.join(__dirname, 'lib', 'notifyPolicy.js')]) { try { return require(p); } catch (e) { /* next */ } }
  return null;
}
function inTradingHours(NP, t) {
  if (NP && typeof NP.statusPushWindow === 'function') return NP.statusPushWindow(t);
  // fallback (lib missing): Sun 15:00 PT -> Fri 13:10 PT, not 13:10-15:00 PT on weekdays
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const o = {}; for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  const m = (+o.hour % 24) * 60 + (+o.minute), open = 15 * 60, close = 13 * 60 + 10;
  if (o.weekday === 'Sat') return false; if (o.weekday === 'Sun') return m >= open; if (o.weekday === 'Fri') return m < close;
  return m < close || m >= open;
}

// Pure decision. hb = parsed heartbeat or null (missing / unreadable); st = this watchdog's saved state.
// -> { st (new state), push: null | { title, body, priority, tags }, line }
function decide({ hb, st = {}, now, inHours }) {
  const s = { alertedAt: st.alertedAt ?? null, since: st.since ?? null, pushes: st.pushes || 0 };
  const beatT = hb && Number.isFinite(hb.t) ? hb.t : null;
  const age = beatT != null ? now - beatT : Infinity;
  const ageTxt = beatT != null ? `${Math.round(age / MIN)} min old (last beat ${new Date(beatT).toISOString().slice(11, 16)}Z)` : 'missing or unreadable';
  if (age < STALE_MS) {
    if (s.alertedAt != null) return { st: { alertedAt: null, since: null, pushes: 0 }, push: { title: 'Bot heartbeat is back', body: `The bot process is running again (heartbeat fresh; it was stale for about ${Math.round((now - (s.since ?? now)) / MIN)} min). ${hb && hb.live === false ? `It reports NOT LIVE: ${hb.reason || 'unknown'}.` : 'It reports LIVE.'}`, priority: 'high', tags: 'white_check_mark' }, line: 'heartbeat fresh again: recovered push' };
    return { st: { alertedAt: null, since: null, pushes: 0 }, push: null, line: `ok: heartbeat ${Math.round(age / 1000)} s old${hb && hb.live === false ? ` (bot reports not live: ${hb.reason})` : ''}` };
  }
  if (!inHours) return { st: { alertedAt: null, since: null, pushes: 0 }, push: null, line: `heartbeat ${ageTxt}; outside trading hours: no push` };
  const since = s.since ?? (beatT != null ? beatT : now);
  if (s.alertedAt != null && now - s.alertedAt < REPUSH_MS) return { st: { ...s, since }, push: null, line: `heartbeat ${ageTxt}; pushed ${Math.round((now - s.alertedAt) / MIN)} min ago` };
  const n = s.pushes + 1;
  return { st: { alertedAt: now, since, pushes: n },
    push: { title: 'Bot NOT RUNNING (no heartbeat)', body: `The bot's heartbeat is ${ageTxt}: the process is stopped, crashed or frozen, so it is not trading and cannot alert by itself.${n > 1 ? ` Reminder ${n} (every 30 min).` : ' Repeats every 30 min while it lasts.'} Check the service on the server; open positions keep their broker-side stops.`, priority: 'urgent', tags: 'skull' },
    line: `heartbeat ${ageTxt}: push ${n}` };
}

function sanitize(s) { return String(s).replace(/[^\x20-\x7E]/g, ''); }
function ntfyPush(topic, token, symbol, p) {
  return new Promise(resolve => {
    try {
      const body = Buffer.from(p.body, 'utf8');
      const req = https.request({ hostname: 'ntfy.sh', path: '/' + encodeURIComponent(topic), method: 'POST', headers: {
        'Title': sanitize(`MacMillionz ${symbol}: ${p.title}`), 'Priority': p.priority, 'Tags': sanitize(p.tags), 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length,
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? 'sent' : `rejected HTTP ${res.statusCode}`)); });
      req.on('error', e => resolve('failed: ' + e.message));
      req.setTimeout(15000, () => req.destroy(new Error('timed out')));
      req.write(body); req.end();
    } catch (e) { resolve('failed: ' + e.message); }
  });
}

async function main(argv = process.argv.slice(2), env = process.env, now = Date.now()) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dir = path.resolve(arg('--dir') || __dirname), symbol = arg('--symbol') || 'MNQ', sfx = argv.includes('--paper') ? '-paper' : '';
  const hbFile = path.join(dir, `health-heartbeat-${symbol}${sfx}.json`), stFile = path.join(dir, `health-watchdog-state-${symbol}${sfx}.json`);
  const NP = loadNP(dir);
  let hb = null; try { hb = JSON.parse(fs.readFileSync(hbFile, 'utf8')); } catch (e) { hb = null; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(stFile, 'utf8')) || {}; } catch (e) { st = {}; }
  const d = decide({ hb, st, now, inHours: inTradingHours(NP, now) });
  let sent = '';
  if (d.push) {
    const topic = env.NTFY_TOPIC || null, tok = env.NTFY_TOKEN && /^[\x21-\x7e]{1,512}$/.test(env.NTFY_TOKEN.trim()) ? env.NTFY_TOKEN.trim() : null;
    sent = topic ? ' -> ' + await ntfyPush(topic, tok, symbol, d.push) : ' -> not sent (NTFY_TOPIC not set)';
  }
  try { const tmp = stFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d.st)); fs.renameSync(tmp, stFile); } catch (e) { sent += ` (state not saved: ${e.message})`; }
  console.log(`[${new Date(now).toISOString()}] health-watchdog ${symbol}${sfx}: ${d.line}${d.push ? ` [${d.push.title}]` : ''}${sent}`);
}

if (require.main === module) main().catch(e => { console.log('health-watchdog error (non-fatal): ' + e.message); }).then(() => process.exit(0));
module.exports = { decide, inTradingHours, main, STALE_MS, REPUSH_MS };

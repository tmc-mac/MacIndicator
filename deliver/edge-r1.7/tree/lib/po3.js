'use strict';
// po3 r1.1 (Mac 10/26: "build the PO3 concepts into the bot"; MacDot HOLD 6429000789 addressed). OBSERVE-ONLY: pure functions, no I/O, nothing here is read by
// admission, sizing, stops, exits or order handling. The executor writes the result to its OWN file (po3-journal-<SYMBOL>.jsonl), never the trade journal.
// Spec: docs/claude-session/cluster-map-r0/PO3-IMPLEMENTATION-PROPOSAL.md r1 (MacDot 6428409952) + cluster-map COMMISSION (MacDot 6427963306).
// [P] = builder-proposed research parameter (frozen here; a different value is a new version, not a setting).
//
// AVAILABILITY (r1.2, MacDot 6429200579): every series carries readAt[k] = the START of the request that fetched it (a conservative cutoff) and observedAt[k] =
//   when that response arrived. A bar counts only if COMPLETED BEFORE THE REQUEST STARTED (t + period <= min(now, readAt[k])): a pre-close request answered after the
//   close never qualifies the closing bar, and a forming bar never "ages into" completion. A series with no request time is UNAVAILABLE.
// OBSERVED vs RECONSTRUCTED (r1.3, MacDot 6429596500): labels say only what the timestamps prove. The map's firstObservedAt = the latest response time over
//   EVERY series it depends on (M5 + D always - D decides knownHigh/mode - plus H4/H1 or D/W); any dependency without a response time = 'first observation
//   unknown'. Labels: 'first observed within 5 min after the open (+Ns)' or 'reconstructed (late): ...' - never 'at the open'. EVENTS carry a FIRST SIGHTING:
//   the executor passes back frozen.seen (key -> time of the first persisted row that contained the event); each event gets firstSeenAt and seenLagMs =
//   firstSeenAt - event time, so a gap recovered/backfilled later IN THE SAME PROCESS shows its real lag. eventAfterRunStart only compares the event time with
//   process start (it proves nothing about observation). Content ids (mapId, level_id) repeat on identical inputs; the executor adds run/publication identity.
// TradeDay: 15:00 America/Los_Angeles -> 15:00 next day (DST-aware through Intl). Session clock labels (not mandatory phases): Asia 15:00-00:00 PT,
//   London 00:00-06:30, NY 06:30-13:05 [P].
// FROZEN INPUTS: the cluster map (built from bars completed and read by the TradeDay start) and the Asia range (once complete) are computed once, published by the
//   executor, then passed back in `frozen` and NEVER recomputed for that TradeDay; every state carries their ids. A later different recomputation (restart,
//   provider revision) is reported as `revisionSeen`, never silently substituted. After a restart the map is rebuilt and published as a new version.
// 1 ACCUMULATION: the Asia range = the 108 completed 5m bars 15:00-00:00 PT, usable only once complete AND read after 00:00. Missing bars = UNKNOWN.
// 2 MANIPULATION (observed sweep side + reclaim direction, never inferred from later delivery): a completed 5m bar whose PREVIOUS close was inside the range and
//   that trades >= SWEEP_PTS beyond the Asia high (low) opens an episode. RECLAIM = a completed 5m CLOSE strictly inside BOTH range bounds (lo < c < hi) on the sweep
//   bar itself or within RECLAIM_BARS bars after it. ACCEPTED-BEYOND = a close beyond the sweep bar's extreme first. A bar sweeping BOTH sides is AMBIGUOUS (no
//   intrabar order is inferred; no direction). A reclaim later overrun by a close beyond its sweep extreme = RECLAIM-FAILED. Separate events, never OR'd into the
//   reclaim: the first completed 15m-aligned close back inside, and the first 5m close back across the 15:00 open.
// 3 DELIVERY from the latest reclaim that has not failed, to the nearest zone of the FROZEN map beyond the reclaim close. No zone = 'no zone beyond'; a map that is
//   warmup/missing/unavailable = 'UNKNOWN: map unavailable' (never "no zone").
// 4 AT THE ZONE (completed + read 1H bars after the tag; adjacency required; an hourly close is stamped at the hour END, never backdated): TAG / no-displacement count /
//   DEPARTURE / RETEST-REJECT (stand aside) / BREAK (hand-off). "Buyers/sellers won" = these price states only.
// UNKNOWN PROPAGATES: everything after the first missing 5m bar (or a trailing gap vs the read cutoff) is UNKNOWN - episodes and delivery use only the validated
//   causal prefix. Zone events dated before the delivery view became active are flagged `retrospective`.
const VERSION = 'po3-observe-r1.3';
const M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 4 * H1, D1 = 86400000, W1 = 7 * D1;
const SWEEP_PTS = 0.25, RECLAIM_BARS = 6;                                    // [P]
const CLUSTER_TOL = 3, CLUSTER_K = 3, CLUSTER_BARS = 3, WICK_MAX = 30;      // [P]
const LOOKBACK = { H4: 30, H1: 60, D: 60, W: 52 }, ATH_NEAR = 0.01;          // [P]
const LATE_MS = 5 * 60000;                                                   // first sighting later than this after the boundary/event = 'reconstructed (late)'
const SEEN_MAX = 500;                                                        // first-sighting keys kept per TradeDay (bounded)
const MAX_EPISODES = 20, MAX_HOPS = 12, MAX_ZONES = 60;                      // output bounds
const INPUT_CAP = { M5: 400, H1: 200, H4: 80, D: 80, W: 60 };               // work bounds (newest bars kept)
const TZ = 'America/Los_Angeles';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function ptParts(ts) { const o = {}; for (const p of fmt.formatToParts(new Date(ts))) o[p.type] = p.value; return { y: +o.year, mo: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute }; }
function ptWall(y, mo, d, hh, mm) {
  let t = Date.UTC(y, mo - 1, d, hh, mm) + 8 * H1;
  for (let i = 0; i < 3; i++) { const p = ptParts(t); const diff = ((p.hh * 60 + p.mm) - (hh * 60 + mm)) * 60000 + (Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(y, mo - 1, d)); if (!diff) return t; t -= diff; }
  return t;
}
function tradeDayStart(ts) { const p = ptParts(ts); let s = ptWall(p.y, p.mo, p.d, 15, 0); if (s > ts) { const q = ptParts(s - 20 * H1); s = ptWall(q.y, q.mo, q.d, 15, 0); } return s; }
function sessionWindows(start) { const p = ptParts(start + 12 * H1); return { start, asiaEnd: ptWall(p.y, p.mo, p.d, 0, 0), londonEnd: ptWall(p.y, p.mo, p.d, 6, 30), nyEnd: ptWall(p.y, p.mo, p.d, 13, 5) }; }
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
const okBar = b => b && Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite);
const cap = (bars, n) => (Array.isArray(bars) ? bars.slice(-n) : []);
const completed = (bars, period, cutoff) => Number.isFinite(cutoff) ? bars.filter(b => okBar(b) && b.t + period <= cutoff).sort((a, b) => a.t - b.t) : [];
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); }

// ---- cluster map -------------------------------------------------------------------------------------------------------------------------------------------
function clustersFor(tf, bars, period, cutoff, n) {
  if (!Number.isFinite(cutoff)) return { tf, zones: [], coverage: 'unavailable (no read time)', bars: 0, cutoff: null };
  const done = completed(bars, period, cutoff).slice(-n);
  if (done.length < n) return { tf, zones: [], coverage: 'warmup', bars: done.length, cutoff };
  const edges = [];
  done.forEach((b, i) => { edges.push({ p: b.o, i }); edges.push({ p: b.c, i }); });
  edges.sort((a, b) => a.p - b.p);
  const zones = []; let j = 0;
  while (j < edges.length) {
    const grp = edges.filter(e => e.p >= edges[j].p && e.p <= edges[j].p + CLUSTER_TOL);
    const barsIn = new Set(grp.map(e => e.i));
    if (grp.length >= CLUSTER_K && barsIn.size >= CLUSTER_BARS) {
      const lo = grp[0].p, hi = grp[grp.length - 1].p, src = [...barsIn].map(i => done[i]);
      const wHi = Math.max(hi, ...src.map(b => b.h).filter(h => h <= hi + WICK_MAX)), wLo = Math.min(lo, ...src.map(b => b.l).filter(l => l >= lo - WICK_MAX));
      const bornAt = Math.max(...src.map(b => b.t + period));
      zones.push({ zone_id: `${tf}:${r2(lo)}-${r2(hi)}@${bornAt}`, tf, bodyLo: r2(lo), bodyHi: r2(hi), wickLo: r2(wLo), wickHi: r2(wHi), edges: grp.length, bars: barsIn.size, bornAt });
      j = edges.indexOf(grp[grp.length - 1]) + 1;
    } else j++;
  }
  return { tf, zones, coverage: 'ok', bars: done.length, cutoff };
}
const afterLabel = (lag, what) => lag > LATE_MS ? `reconstructed (late): first observed ${Math.round(lag / 60000)} min after ${what}` : lag >= 0 ? `first observed within 5 min after ${what} (+${Math.round(lag / 1000)} s)` : `first observed before ${what}`;
function buildClusterMap({ start, h1, h4, d, w, m5, readAt, observedAt = {} }) {
  const at = k => (Number.isFinite(readAt[k]) ? Math.min(start, readAt[k]) : NaN);
  const dDone = completed(d, D1, at('D')), m5Done = completed(m5, M5, at('M5'));
  const lastClose = m5Done.length ? m5Done[m5Done.length - 1].c : (dDone.length ? dDone[dDone.length - 1].c : null);
  const knownHigh = dDone.length ? Math.max(...dDone.map(b => b.h)) : null;
  const nearAth = Number.isFinite(knownHigh) && Number.isFinite(lastClose) && lastClose >= knownHigh * (1 - ATH_NEAR);
  const sets = nearAth ? [clustersFor('D', d, D1, at('D'), LOOKBACK.D), clustersFor('W', w, W1, at('W'), LOOKBACK.W)]
                       : [clustersFor('4H', h4, H4, at('H4'), LOOKBACK.H4), clustersFor('1H', h1, H1, at('H1'), LOOKBACK.H1)];
  let zones = [].concat(...sets.map(s => s.zones));
  if (Number.isFinite(lastClose) && zones.length > MAX_ZONES) zones = zones.sort((a, b) => Math.abs(a.bodyLo - lastClose) - Math.abs(b.bodyLo - lastClose)).slice(0, MAX_ZONES);
  for (const z of zones) z.confluence = zones.filter(o => o.tf !== z.tf && o.bodyLo <= z.wickHi && o.bodyHi >= z.wickLo).map(o => o.zone_id);
  zones.sort((a, b) => a.bodyLo - b.bodyLo);
  const coverage = Object.fromEntries(sets.map(s => [s.tf, { coverage: s.coverage, bars: s.bars, cutoff: s.cutoff }]));
  const usable = sets.every(s => s.coverage === 'ok');
  const deps = [...new Set(['M5', 'D', ...sets.map(s => s.tf === '4H' ? 'H4' : s.tf === '1H' ? 'H1' : s.tf)])], missing = deps.filter(k => !Number.isFinite(observedAt[k]));
  const firstObservedAt = missing.length ? null : Math.max(...deps.map(k => observedAt[k]));
  const availability = missing.length ? `first observation unknown (no response time for ${missing.join(', ')})` : afterLabel(firstObservedAt - start, 'the open');
  const body = { version: VERSION, tradeDay: new Date(start).toISOString(), builtFor: start, mode: nearAth ? 'near-ATH (D/W)' : 'normal (4H/1H)', refClose: r2(lastClose), knownHigh: r2(knownHigh),
    aboveKnownHigh: Number.isFinite(knownHigh) && Number.isFinite(lastClose) && lastClose > knownHigh, usable, coverage, dependsOn: deps, firstObservedAt, availability, zones };
  return { mapId: `map:${body.tradeDay}:${hash(JSON.stringify([body.mode, coverage, zones]))}`, ...body };   // content id: repeats on identical inputs (publication id is the executor's)
}
function nextZone(map, px, dir) {
  const zs = map.zones.filter(z => dir > 0 ? z.bodyLo > px : z.bodyHi < px);
  if (!zs.length) return null;
  return dir > 0 ? zs.reduce((a, b) => (b.bodyLo < a.bodyLo ? b : a)) : zs.reduce((a, b) => (b.bodyHi > a.bodyHi ? b : a));
}

// ---- PO3 state ---------------------------------------------------------------------------------------------------------------------------------------------
function po3Compute({ now, m5, h1, h4, d, w, readAt = {}, observedAt = {}, observerStartedAt = null, frozen = {} }) {
  m5 = cap(m5, INPUT_CAP.M5); h1 = cap(h1, INPUT_CAP.H1); h4 = cap(h4, INPUT_CAP.H4); d = cap(d, INPUT_CAP.D); w = cap(w, INPUT_CAP.W);
  const start = tradeDayStart(now), win = sessionWindows(start), td = new Date(start).toISOString();
  const cut = k => (Number.isFinite(readAt[k]) ? Math.min(now, readAt[k]) : NaN);
  // frozen map: reuse the published one for this TradeDay; otherwise build a new candidate (the executor publishes it before it is ever referenced)
  const fresh = buildClusterMap({ start, h1, h4, d, w, m5, readAt, observedAt });
  const map = frozen.map && frozen.map.tradeDay === td ? frozen.map : fresh;
  const mapIsNew = map === fresh;
  const st = { version: VERSION, tradeDay: td, session: now < win.asiaEnd ? 'Asia' : now < win.londonEnd ? 'London' : now < win.nyEnd ? 'NY' : 'post-NY',
    mapId: map.mapId, mapRevisionSeen: !mapIsNew && fresh.mapId !== map.mapId ? fresh.mapId : null,
    open1500: null, asia: null, episodes: [], delivery: null, coverage: 'ok', evaluatedThrough: null, events: [],
    inputs: Object.fromEntries([['M5', m5, M5], ['H1', h1, H1], ['H4', h4, H4]].map(([k, bs, per]) => { const c = completed(bs, per, cut(k)); const end = c.length ? c[c.length - 1].t + per : null;
      return [k, { readAt: Number.isFinite(readAt[k]) ? readAt[k] : null, lastCompletedEnd: end, ageMs: end == null ? null : now - end }]; })) };
  const c5 = cut('M5');
  if (!Number.isFinite(c5)) { st.coverage = 'UNKNOWN: M5 unavailable (no read time)'; return finish(st, map, mapIsNew, false, { now, frozen }); }
  const b5 = completed(m5, M5, c5).filter(b => b.t >= start);
  st.open1500 = b5.length && b5[0].t === start ? b5[0].o : null;
  // 1 accumulation (frozen once accepted)
  let asiaIsNew = false;
  const asiaFrozen = frozen.asia && frozen.asia.tradeDay === td ? frozen.asia : null;
  const asiaBars = b5.filter(b => b.t < win.asiaEnd), expect = (win.asiaEnd - start) / M5;
  const contiguous = asiaBars.length === expect && asiaBars.every((b, i) => b.t === start + i * M5);
  if (asiaFrozen) {
    st.asia = asiaFrozen;
    if (contiguous) { const hiN = Math.max(...asiaBars.map(b => b.h)), loN = Math.min(...asiaBars.map(b => b.l)); if (r2(hiN) !== asiaFrozen.high || r2(loN) !== asiaFrozen.low) st.asiaRevisionSeen = { high: r2(hiN), low: r2(loN) }; }
  } else if (c5 < win.asiaEnd) { st.asia = { frozen: false, why: 'Asia range still forming (not usable)' }; st.evaluatedThrough = b5.length ? b5[b5.length - 1].t + M5 : null; return finish(st, map, mapIsNew, false, { now, frozen }); }
  else if (!contiguous) { st.asia = { frozen: false, why: 'UNKNOWN: missing-bars', have: asiaBars.length, expect }; st.coverage = 'missing-bars'; return finish(st, map, mapIsNew, false, { now, frozen }); }
  else {
    const hi = r2(Math.max(...asiaBars.map(b => b.h))), lo = r2(Math.min(...asiaBars.map(b => b.l)));
    const obs = Number.isFinite(observedAt.M5) ? observedAt.M5 : null;
    st.asia = { tradeDay: td, frozen: true, level_id: `asia:${td}:${hash(JSON.stringify([hi, lo]))}`, high: hi, low: lo, bornAt: win.asiaEnd, requestAt: readAt.M5, firstObservedAt: obs,
      availability: obs == null ? 'first observation unknown (no M5 response time)' : afterLabel(obs - win.asiaEnd, '00:00'),
      construction: '108 completed 5m bars 15:00-00:00 PT' };
    asiaIsNew = true;
  }
  const hi = st.asia.high, lo = st.asia.low, open = st.open1500, eps = st.episodes;
  // validated causal prefix after the freeze: stop at the first missing bar; a trailing gap vs the read cutoff is also missing data
  const post = []; let expectT = win.asiaEnd;
  for (const b of b5.filter(x => x.t >= win.asiaEnd)) { if (b.t !== expectT) break; post.push(b); expectT += M5; }
  const lastExpectedStart = Math.floor(c5 / M5) * M5 - M5;   // the newest bar that should be complete at the read
  st.evaluatedThrough = expectT;
  if (expectT <= lastExpectedStart && c5 > win.asiaEnd) { st.coverage = 'UNKNOWN: missing-bars'; st.events.push({ at: expectT, ev: 'coverage-gap', why: 'UNKNOWN from here: missing or not-yet-read 5m bar' }); }
  // 2 manipulation
  let prevClose = asiaBars.length ? asiaBars[asiaBars.length - 1].c : NaN;
  const inside = c => c < hi && c > lo;
  for (const b of post) {
    const te = b.t + M5;
    for (const e of eps) {
      if (e.status !== 'swept') continue;
      e.barsSince++;
      const beyond = e.side === 'high' ? b.c > e.sweepBarExtreme : b.c < e.sweepBarExtreme;
      if (inside(b.c)) Object.assign(e, { status: 'reclaimed', reclaimAt: te, reclaimClose: r2(b.c), reclaimDir: e.side === 'high' ? -1 : 1 });
      else if (beyond) Object.assign(e, { status: 'accepted-beyond', acceptedAt: te });
      else if (e.barsSince >= RECLAIM_BARS) Object.assign(e, { status: 'no-reclaim', expiredAt: te });
    }
    for (const e of eps) if (e.status === 'reclaimed' && e.reclaimAt < te && (e.side === 'high' ? b.c > e.sweepBarExtreme : b.c < e.sweepBarExtreme)) Object.assign(e, { status: 'reclaim-failed', failedAt: te });
    for (const e of eps) {   // separate events, never part of the reclaim rule
      if (e.side === 'both') continue;
      if (e.confirm15At == null && te % M15 === 0 && te > e.sweepAt && inside(b.c)) e.confirm15At = te;
      if (e.openCrossAt == null && Number.isFinite(open) && te > e.sweepAt && (e.side === 'high' ? b.c < open : b.c > open)) e.openCrossAt = te;
    }
    const prevInside = prevClose <= hi && prevClose >= lo;
    const hitH = prevInside && b.h >= hi + SWEEP_PTS && !eps.some(e => e.side === 'high' && e.status === 'swept');
    const hitL = prevInside && b.l <= lo - SWEEP_PTS && !eps.some(e => e.side === 'low' && e.status === 'swept');
    const sess = te <= win.londonEnd ? 'London' : te <= win.nyEnd ? 'NY' : 'post-NY';
    if (eps.length < MAX_EPISODES) {
      if (hitH && hitL) eps.push({ id: eps.length + 1, side: 'both', reference: st.asia.level_id, sweepAt: te, status: 'ambiguous-outside-bar', why: 'one bar swept both sides; intrabar order unknown - no direction', session: sess });
      else for (const side of (hitH ? ['high'] : hitL ? ['low'] : [])) {
        const ep = { id: eps.length + 1, side, reference: st.asia.level_id, sweepAt: te, sweepBarExtreme: r2(side === 'high' ? b.h : b.l), status: 'swept', barsSince: 0, session: sess };
        if (inside(b.c)) Object.assign(ep, { status: 'reclaimed', reclaimAt: te, reclaimClose: r2(b.c), reclaimDir: side === 'high' ? -1 : 1, sameBar: true });
        eps.push(ep);
      }
    }
    prevClose = b.c;
  }
  if (Number.isFinite(observerStartedAt)) for (const e of eps) e.eventAfterRunStart = e.sweepAt >= observerStartedAt;   // event time vs process start ONLY - not an observation claim
  // 3/4 delivery
  const rec = eps.filter(e => e.status === 'reclaimed').sort((a, b) => b.reclaimAt - a.reclaimAt)[0];
  if (rec) {
    const activeSince = Math.max(rec.reclaimAt, ...eps.filter(e => e.reclaimAt > rec.reclaimAt && e.failedAt).map(e => e.failedAt));
    const hourBound = Math.min(cut('H1'), st.evaluatedThrough);   // hourly conclusions never run past the validated 5m prefix
    st.delivery = map.usable ? deliver(rec, map, post, h1, hourBound) : { episode: rec.id, dir: rec.reclaimDir, zones: [{ zone_id: null, state: 'UNKNOWN: map unavailable (' + JSON.stringify(map.coverage) + ')' }] };
    st.delivery.activeSince = activeSince;
    if (map.usable) { st.delivery.hourlyBound = Number.isFinite(hourBound) ? hourBound : null; st.delivery.hourlyBoundBy = !Number.isFinite(cut('H1')) ? 'H1 unavailable' : st.evaluatedThrough < cut('H1') ? 'validated 5m prefix' : 'H1 request start'; }
    st.delivery.liveFrom = Math.max(activeSince, Number.isFinite(observerStartedAt) ? observerStartedAt : -Infinity);   // retrospective flags are set in finish() with the first sightings
    if (String(st.coverage).startsWith('UNKNOWN')) st.delivery.coverage = 'UNKNOWN beyond ' + new Date(st.evaluatedThrough).toISOString() + ' (5m gap)';
  }
  return finish(st, map, mapIsNew, asiaIsNew, { now, frozen });
}
function deliver(rec, map, post, h1, cutH1) {
  const dir = rec.reclaimDir, dv = { episode: rec.id, dir, from: rec.reclaimClose, zones: [] };
  let px = rec.reclaimClose, after = rec.reclaimAt;
  const hours = completed(h1, H1, cutH1), hourAvailable = Number.isFinite(cutH1);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const z = nextZone(map, px, dir);
    if (!z) { dv.zones.push({ zone_id: null, state: map.aboveKnownHigh || map.mode.startsWith('near') ? 'no zone beyond (measured-move research; no default target)' : 'no zone beyond' }); break; }
    const near = dir > 0 ? z.bodyLo : z.bodyHi, far = dir > 0 ? z.bodyHi : z.bodyLo;
    const zs = { zone_id: z.zone_id, tf: z.tf, body: [z.bodyLo, z.bodyHi], wick: [z.wickLo, z.wickHi], state: 'approach', tagAt: null, noDisplacement: 0, departedAt: null, retestRejectAt: null, breakAt: null };
    dv.zones.push(zs);
    const tagBar = post.find(b => b.t + M5 > after && (dir > 0 ? b.h >= near : b.l <= near));
    if (!tagBar) break;
    zs.tagAt = tagBar.t + M5; zs.state = 'tagged';
    if (!hourAvailable) { zs.state = 'UNKNOWN: H1 unavailable (no read time)'; break; }
    let broke = false, lastEnd = zs.tagAt;
    for (const h of hours.filter(h => h.t + H1 > zs.tagAt)) {
      const prev = hours.find(x => x.t === h.t - H1), end = h.t + H1;
      if (!prev) { zs.state = 'UNKNOWN: missing-bars (hour adjacency)'; zs.unknownAt = end; broke = null; break; }
      lastEnd = end;
      const disp = dir > 0 ? h.c > prev.h : h.c < prev.l;
      if (disp && (dir > 0 ? h.c > far : h.c < far)) { zs.breakAt = end; zs.state = 'broken (hand-off)'; px = h.c; after = end; broke = true; break; }
      zs.noDisplacement = disp ? 0 : zs.noDisplacement + 1;
      const outside = dir > 0 ? h.c < near : h.c > near;
      if (zs.departedAt != null && zs.retestRejectAt == null && (dir > 0 ? h.h >= near : h.l <= near) && outside && end > zs.departedAt) zs.retestRejectAt = end;
      if (zs.departedAt == null && outside) zs.departedAt = end;
      zs.state = zs.retestRejectAt ? 'retest rejected (stand-aside state)' : zs.noDisplacement > 0 ? `no displacement x${zs.noDisplacement}` : 'tagged';
    }
    if (broke === null) break;
    const expectedLastEnd = Math.floor(cutH1 / H1) * H1;   // the newest hour that should be complete at the read
    if (!broke && lastEnd < expectedLastEnd && expectedLastEnd > zs.tagAt + H1) { zs.state += ' | UNKNOWN: hourly bars not read through ' + new Date(expectedLastEnd).toISOString(); zs.hourlyEvaluatedThrough = lastEnd; }
    if (!broke) break;
  }
  return dv;
}
const EP_EVENTS = ['sweepAt', 'reclaimAt', 'failedAt', 'confirm15At', 'openCrossAt'], ZONE_EVENTS = ['tagAt', 'departedAt', 'retestRejectAt', 'breakAt'];
function finish(st, map, mapIsNew, asiaIsNew, { now, frozen = {} }) {
  for (const e of st.episodes) delete e.barsSince;
  // FIRST SIGHTINGS: key -> first persisted time (frozen.seen, from the executor); a key not yet seen is first seen in THIS row (now). seenNext is committed by
  // the executor only after this row is written; the key list is in the signature, so a new event always produces a row.
  const prior = frozen.seen && frozen.seen.tradeDay === st.tradeDay ? frozen.seen.at : {}, at = { ...prior };
  let seenOverflow = 0;
  const sight = (key, t) => {
    if (!(key in at)) { if (Object.keys(at).length >= SEEN_MAX) { seenOverflow++; return { firstSeenAt: null, seenLagMs: null }; } at[key] = now; }
    return { firstSeenAt: at[key], seenLagMs: at[key] - t };
  };
  for (const e of st.episodes) { e.firstSeen = {}; for (const k of EP_EVENTS) if (Number.isFinite(e[k])) e.firstSeen[k] = sight(`ep:${e.side}@${e.sweepAt}:${k}@${e[k]}`, e[k]); }
  if (st.delivery) for (const z of st.delivery.zones) {
    if (!z.zone_id) continue;
    z.firstSeen = {}; for (const k of ZONE_EVENTS) if (Number.isFinite(z[k])) z.firstSeen[k] = sight(`z:${st.delivery.episode}:${z.zone_id}:${k}@${z[k]}`, z[k]);
    z.retrospective = ZONE_EVENTS.filter(k => Number.isFinite(z[k]) && (z[k] < st.delivery.liveFrom || !(Number.isFinite(z.firstSeen[k].seenLagMs) && z.firstSeen[k].seenLagMs <= LATE_MS)));
  }
  if (seenOverflow) st.seenOverflow = seenOverflow;
  const stale = Object.fromEntries(Object.entries(st.inputs).map(([k, v]) => [k, v.readAt == null ? 'unavailable' : v.ageMs != null && v.ageMs > ({ M5: 2 * M5, H1: 2 * H1, H4: 2 * H4 })[k] ? 'stale' : 'ok']));
  st.inputStatus = stale;
  const sig = JSON.stringify([st.tradeDay, st.session, st.mapId, st.mapRevisionSeen, st.asia && [st.asia.level_id, st.asia.frozen, st.asia.why], st.asiaRevisionSeen || null, st.coverage, stale,
    st.episodes.map(e => [e.id, e.status, e.confirm15At, e.openCrossAt, e.failedAt]), st.delivery && [st.delivery.coverage, st.delivery.zones.map(z => [z.zone_id, z.state, z.tagAt])],
    hash(Object.keys(at).sort().join('|'))]);
  return { tradeDay: st.tradeDay, signature: sig, state: st, map, mapIsNew, asiaIsNew, seenNext: { tradeDay: st.tradeDay, at } };
}
module.exports = { VERSION, po3Compute, buildClusterMap, clustersFor, nextZone, tradeDayStart, sessionWindows, ptWall,
  PARAMS: Object.freeze({ LATE_MS, SEEN_MAX, SWEEP_PTS, RECLAIM_BARS, CLUSTER_TOL, CLUSTER_K, CLUSTER_BARS, WICK_MAX, LOOKBACK, ATH_NEAR, MAX_EPISODES, MAX_HOPS, MAX_ZONES, INPUT_CAP }) };

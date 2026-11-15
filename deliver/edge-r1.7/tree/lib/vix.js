// Free daily VIX close, for MAC Trap Machine v4's VIX regime filter. TopstepX
// doesn't offer VIX as a tradable contract, so this pulls from CBOE's own
// official published VIX history CSV — the primary source, not a scrape —
// which returns cleanly with no bot-challenge (verified: Stooq now sits
// behind a JS proof-of-work challenge and silently returns 0 usable rows,
// which is why the first version of this file didn't work). The filter only
// ever looks at daily closes, so this only needs to be refreshed once a day.
//
// If this fetch fails for any reason, callers should treat VIX as unavailable
// — which matches the Pine script's own behavior (`vix_ok = ... or na(vix_now)`,
// i.e. an unavailable VIX never blocks entries, it just stops gating on it).

const CBOE_VIX_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';

// 15s timeout (2026-10-07): same fix as lib/bars.js's ptxFetch — this is a
// raw fetch() to an external CDN with no timeout of its own, called once at
// startup. A hang here means a restart never reaches "Entering live loop" at
// all, which would have defeated the whole point of restarting to pick up
// the bars.js fix. Non-fatal either way (the caller already treats VIX
// fetch failure as "gate stays open"), but a hang isn't a failure the
// existing catch can ever see.
async function fetchVixDaily(days = 10) {
  const r = await fetch(CBOE_VIX_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`CBOE HTTP ${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split('\n').slice(1); // drop header row: DATE,OPEN,HIGH,LOW,CLOSE
  const bars = lines
    .map(line => line.split(','))
    .filter(cols => cols.length >= 5)
    .map(cols => {
      const [mm, dd, yyyy] = cols[0].split('/').map(Number);
      return { t: Date.UTC(yyyy, mm - 1, dd), c: parseFloat(cols[4]) };
    })
    .filter(b => Number.isFinite(b.c) && Number.isFinite(b.t));
  bars.sort((a, b) => a.t - b.t);
  return bars.slice(-days);
}

module.exports = { fetchVixDaily };

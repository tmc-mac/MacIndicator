'use strict';
// Notification only: the detailed "Signal" push for the entry the bot is actually sending. Built from the trade_plan row the bot just
// journaled (path, stop basis, risk, targets, entry reasoning) and the sizing result of that same entry (producer grade, raw/allowed/entered).
// Stage and invalidation have no producer and are not claimed. Never consumed by an entry, sizing, gate, exit or transport path.
// The title keeps its "Signal:" prefix so the push budget tier is unchanged.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const px = v => (num(v) == null ? '?' : v.toFixed(2));
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function entryPushDetail({ row, dir, contracts, entryType, entryPrice, stopPrice, target1, target2, sizing, alignmentConsumed, showGrade = true } = {}) {   // lv1 r13.3.4: showGrade false = no grade (levels-only)
  const side = dir === 1 ? 'LONG' : dir === -1 ? 'SHORT' : '?';
  const conf = sizing && sizing.confidence && typeof sizing.confidence === 'object' ? sizing.confidence : null;
  const prod = conf && conf.source ? (showGrade ? `${conf.source} ${conf.grade || '?'}` : conf.source) : (showGrade ? 'sizing grade not recorded' : 'sizing source not recorded');
  const label = (row && (row.pathLabel || row.path)) || null;
  const title = `Signal: ${side} ${num(contracts) != null ? contracts + 'x' : '?x'} · ${prod}${label ? ' · ' + cut(label, 40) : ''}`;
  const stopPts = row && row.stop && num(row.stop.points) != null ? row.stop.points : (num(entryPrice) != null && num(stopPrice) != null ? Math.abs(entryPrice - stopPrice) : null);
  const risk = row && row.riskCap && num(row.riskCap.riskUsd) != null ? `risk $${Math.round(row.riskCap.riskUsd)}${num(row.riskCap.cap) != null ? ' (cap $' + row.riskCap.cap + ')' : ''}` : 'risk not recorded';
  const tp1Pts = row && row.tp1 && num(row.tp1.points) != null ? ` (+${row.tp1.points.toFixed(2)})` : '';
  const lines = [
    `${entryType || '?'} ${entryType === 'MARKET' ? '~' : '@ '}${px(entryPrice)} · stop ${px(stopPrice)}${stopPts != null ? ' (' + stopPts.toFixed(2) + ' pts)' : ''} · ${risk}`,
    `TP1 ${px(target1)}${tp1Pts}${num(target2) != null ? ' · TP2 ' + px(target2) : ''}`,
    sizing ? `Size: raw ${num(sizing.rawContracts) ?? '?'} → allowed ${num(sizing.contracts) ?? '?'}${sizing.reason ? ' (' + sizing.reason + ')' : ''} · entering ${num(contracts) ?? '?'}x` : 'Size: sizing not recorded',
  ];
  const stopWhy = row && row.stop && (row.stop.basis || row.stop.text); if (stopWhy) lines.push('Stop: ' + cut(stopWhy, 160));
  const why = row && row.entry && row.entry.why; if (why) lines.push('Why: ' + cut(why, 220));   // not row.summary: it embeds the legacy selector grade
  lines.push(`Alignment ${alignmentConsumed === true ? 'used' : alignmentConsumed === false ? 'not used' : 'use not recorded'} · stage UNKNOWN`);
  return { title, body: lines.join('\n') };
}
// Replace an armed push's text with the detailed one; on any problem keep the original push unchanged.
function withEntryDetail(armed, facts) {
  if (!armed) return armed;
  try { const d = entryPushDetail(facts); return { ...armed, title: d.title, body: d.body }; } catch (e) { return armed; }
}
module.exports = { entryPushDetail, withEntryDetail };

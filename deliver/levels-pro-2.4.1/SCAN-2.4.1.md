# SCAN 2.4.1 — runtime index-guard scan + barstate.islast read

Method (Nov 1 lesson: Pine v5 `and`/`or` evaluate both sides): every line with `array.get/set`, `str.substring`, `matrix.get` AND an `and`/`or` was listed (`grep`), then each index checked by hand. Then every `barstate.islast` / `isrealtime` block was read line by line.

## A. Index-guarded accesses inside `and`/`or` — 39 lines in v2.4.1 (36 in 2.4-dev + 3 new)
All indexes are **constants or `for` loop variables inside the array's bounds**; none depends on the other side of the `and`/`or`. No rewrite needed.

| v2.4.1 line(s) | Expression | Index | Verdict |
|---|---|---|---|
| 616-619 | `array.set(L_ON, 13..16, show_ropens and …)` | constants | safe (the `and` is the stored value) |
| 644, 647 | `array.get(L_ON, i/j) and not na(px)` | loop i, j | safe |
| 1005, 1009, 1044 | `array.get(REJ, i) != 0 and not array.get(REJDEAD, i)`, `contra and array.get(XAGE, i) < array.get(REJAGE, i)` | loop i | safe |
| 1094 | `array.get(L_ROLL, i) and array.get(L_AGE, i) < min_age` | loop i | safe |
| 1173, 1189, 1199, 1204, 1206, 1217, 1219, 1231, 1243 | event pool: `array.get(EV_BORN, s) >= 0 and …`, `array.get(EV_LB, i) != bar_index or …` | loop s / i | safe |
| 1313, 1387, 1557 | `not na(px) and array.get(L_ON, i)` | loop i | safe |
| 1638 | `array.get(L_NAME, math.max(ip_i, 0))` | clamped | safe (ternary, not and/or) |
| 1695, 1709 (2.4.1) | `not na(mpx) and array.get(L_ON, i)`; `if array.get(mk, b) > kv` inside `while keep` with `keep := b >= 0` set before the read | loop i; b guarded by the while condition | safe (new, same shape as the ladder sort at 2036) |
| 1729 (2.4.1) | `q != k and math.abs(close - array.get(mk, q)) < di` | loop q | safe (new) |
| 1737, 1751, 1758, 1763, 1769 | per-level drawing: `na(px) or not array.get(L_ON, i)`, `array.get(L_ROLL, i) or (mobile and i >= 21) ? …`, `array.get(L_ON, q)` | loop i, q | safe |
| 1798, 1804 | confluence `not na(pxi) and array.get(L_ON, i/j)` | loop | safe |
| 2025 | ladder `not na(px) and array.get(L_ON, i)` | loop | safe |
| 2358, 2360, 2366, 2367, 2379 | PARITY event log `barstate.isconfirmed and array.get(L_ON, i)` etc. | loop i | safe |
| 2553 | alerts `not na(px) and array.get(L_ON, i)` | loop i | safe |

`while` loops: 2 (ladder sort 2.4-dev 1968 → 2.4.1 2036; new mobile sort 1705). Both read `array.get(…, b)` only inside the body after `keep := b >= 0`.
`str.split` in `f_mobile_name` (1655): `array.size(str.split("", "+")) - 1` — on an empty merge string the size is 1 (one empty substring) ⇒ 0 aliases; a 0-size result would give −1, which the `> 0` test also hides. No access by index.

## B. `barstate.islast` / `isrealtime` blocks, read line by line
| v2.4.1 lines | Block | Read |
|---|---|---|
| 637-639 | L_MRG reset | loop 0..NL-1, constant bounds. OK |
| 651, 655 | dedupe merge strings | inside loop i, j. OK |
| 1673-1786 | DRAWING: halo, mobile pre-pass, per-level lines/labels | all arrays NL-sized or pushed in the same block; `m_y` na-guarded; `M_RK` default 99 (⇒ "far") for hidden levels. OK |
| 1791-1816 | CONFLUENCE | loop bounds. OK |
| 1841-1842 | table.clear | constants. OK |
| 1844-2140 | DASHBOARD (mobile + desktop) incl. ladder sort and `shown = min(n, mob_rows)` | `array.get(ord, k)` with k < shown ≤ n. OK |
| 2196 | `f_p_flag` reads `barstate.islast and timenow` | strings only. OK |
| 2253-2266 | isrealtime gap / STALE badge | scalar. OK |
| 2420-2581 | PARITY + EVENTS tables | `EV_LAST` reads `array.get(PE_*, 0)` only in the `pec == 0 ? "NONE" : …` else branch (ternary, not and/or); event rows loop `k < pec`. OK |

Result: **0 defects** of the Nov 1 kind in 2.4-dev or 2.4.1. Display fixes F1/F2 are in CHANGES-2.4.1.md.

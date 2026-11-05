# TOKENS 2.4.1 — compiled-token estimate

Counter: the desk's calibrated `tokcount.py` (v2.5.1 → v2.7.1 tools; source-token lexer + inline call-site model), coefficients from the v2.6.3 report: **k_inline 1.741** (compiled ≈ inline-model × 1.741) and **k_linear 3.239** (compiled ≈ source × 3.239). Calibration points: v2.5 failed at 95,781 compiled (TradingView's own count, limit 80,000); the compiled v2.4.x / v2.5.1 builds passed. Run: `python3 -I tokcount.py LevelsPRO-v2.4-dev.pine LevelsPRO-v2.4.1.pine`.

| File | Source tokens | Inline model | Est. compiled (k_inline) | Est. compiled (k_linear) |
|---|---|---|---|---|
| LevelsPRO-v2.4-dev.pine (Mac's running build, compiles) | 21,925 (global 20,381, functions 1,544) | 38,281 | 66,647 | 71,015 |
| **LevelsPRO-v2.4.1.pine** | **22,531** (global 20,987, functions 1,544) | **39,046** | **67,979** | **72,978** |
| **LevelsPRO-v2.4.1b.pine** (compile fix: drawing loop + mobile pre-pass as functions) | **22,571** (global 20,108, functions 2,463) | **39,086** | **68,049** | **73,107** |
| **LevelsPRO-v2.4.2.pine** (★ main lines + Focus toggle) | **22,642** (global 20,105, functions 2,537) | **39,157** | **68,172** | **73,337** |
| delta 2.4.1b vs 2.4-dev | +646 | +805 | +1,402 | +2,092 |

- Desk ceilings (v2.6.3 report): source ≤ 22,900, inline ≤ 40,200 — both met (369 and 1,154 to spare).
- Target ≤ 70,000: met on k_inline (68.0k). k_linear reads 73.0k, but the same k_linear puts 2.4-dev — which compiles and runs on Mac's chart — at 71.0k, so k_linear is the pessimistic model here; v2.4.1 adds about **+2.0 % … +2.9 %** over a known-good build.
- Uncertainty: the two models disagree by ~5k on this file (≈ ±7 %); the TradingView compile governs. The addition is display code in one `barstate.islast` block (two small sorts, no new functions, no new `request.*`: 17 security calls, unchanged).
- If the paste fails on tokens: the fallback is the untouched 2.4-dev (INSTALL.txt). The first cut would be the distance-rank loop (lines 1725-1732, ~90 source tokens) replaced by `m_near := true`.

Main-body size (the limit v2.4.1 hit, "The main body of the script is too long"): 2.4-dev 1,647 main-scope lines, v2.4.1 1,699, v2.4.1b 1,620 (function bodies 91 / 91 / 176). See CHANGES-2.4.1.md v2.4.1b.
v2.4.2: main-body lines 1,619 (≤ v2.4.1b's 1,620), function bodies 179.

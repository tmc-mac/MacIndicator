# NQ-7 final
Concept: daily-structure conditioned afternoon continuation. If prior session CLV in [0.1,0.9] (excludes only the most extreme closes) and 09:36->11:00 ET move is non-zero, enter at 11:00 in morning direction; stop 0.25 x mean10 session range; exit 15:55 ET; 1 trade/day.
Frozen PARAMS: clv_lo 0.1, clv_hi 0.9, look 10, min_move 0, stop_mult 0.25, risk 150 (-> 1 contract), times 576/659/955.
Train: net $13.7k, PF 1.55, 387 trades, 0.66/day, raw maxDD $2.0k, 7/9 quarters positive (2023Q3-ish negative). Rolling 3m: pass 15%, bust 0%, positive 91%, median score 1.25. lookahead clean.
Weaknesses: much of the edge is generic morning-continuation; CLV filter helps mainly at the narrow 0.3-0.7 band (PF ~1.9, only 0.26/d). Prior-day structure features alone show no edge. Single contract keeps DD low but pass rate low; scaling size raises busts. Weak 2023 Q3. Post-hoc selection of the continuation finding (multiple-comparison risk).

## v2 verdict: NO CERTIFIABLE EDGE
Design-window sweep: no size multiplier gives pass>=40% with bust<=30% (x2 27%/22%, x3 44%/53%). Validation PF 1.02 (train 1.55) indicates the post-hoc morning-continuation finding was largely overfit. Prior-day structure alone had no edge. Not certifiable; stopping.

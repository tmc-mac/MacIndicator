# NQ-7 research log (TRAIN only)
- H1/H2 (prior CLV extreme bias, flip on expansion), entry 09:35 hold to 15:55: PF 1.08, maxDD 5.7k, unstable. Rejected.
- Feature study (open->close normalised by 10d mean range) across CLV/expansion/inside/outside/5d trend/DOW: all means ~0.
- Afternoon (11:00->15:55) vs morning sign x prior structure: neutral-CLV days show continuation (+0.1 / -0.09 R). Amended prereg -> H3.
- H3 band 0.3-0.7 stop .35: PF1.75 n=151 (0.26/d) DD1628. Band 0..1: PF1.23 n=564. Band/stop grid: plateau (PF 1.4-1.9 across stop .15-.35).
- Chosen 0.1-0.9, stop .25 for trade-count margin: net 13674 PF1.55 n=387 (0.66/d) DD2004 (1 contract). Rolling 53 windows: pass 15%, bust 0%, pos 91%, median score 1.25.
- Risk 300/400: bust 15%/62%. Kept risk 150 (always 1 contract).
- v2: combine_team design (2021-09..2024-06): x1 pass .11/bust 0; x2 .27/.22; x3 .44/.53; x4 .42/.58; x6 .34/.66. Raw PF 1.34-1.43.
  No size meets pass>=40% with bust<=30%. Validation PF was 1.02 vs train 1.55: the morning-continuation edge was found post hoc and faded. Stopped, no further tuning.

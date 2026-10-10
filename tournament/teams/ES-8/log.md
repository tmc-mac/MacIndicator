# ES-8 log (design only)
- prereg written, strategy built (N-min agg, 9/26/52, cross+cloud+chikou, cloud/kijun stop, rmult target).
- N=15 default: PF 0.95, 0.20 trades/d; combine pass<=11%, bust 27% at x4.
- Sweep N{5,10,15,30} x rmult{1,2,3} x lookback{2,6}: only N=30 positive (PF1.1-1.36) but 0.16-0.25 trades/d (<0.5 required); N=24 PF1.00, N=36 PF1.45, N=45 PF1.25 -> not a plateau, thin sample.
- N=30,rmult2,lb6 combine: x4 pass .27 bust .40; x6 pass .30 bust .68; x3 pass .15 bust .10. Fails bar.

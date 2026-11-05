# Exact r1.5.6 original-assertion compatibility

The original 130 assertions remain unchanged. The candidate runner substitutes a fake that actually enforces the required reducing execution, same-ID amendment and exact history contract. Results: baseline 130/130, candidate 119/130. Eleven failures stay visible:

- L1e, L1j, L2b, L3d expect separately placed replacement stops and old-stop cancellation; candidate uses one same-ID native amendment.
- L9c expects stop cancellation before market close; candidate keeps protection through a reducing close.
- L4c expects a later explicit market exit after failed replacement; candidate already completed protected recovery.
- L15a/b/c expect indefinite oversized-stop retention/replacement retry; candidate makes bounded amendments then protected reducing exit.
- L41c requires resend after empty open-order snapshot. Candidate preserves the uncertain original request and refuses replay.
- L42a also checks the removed 300ms delay, shape/position probe and old journal marker. Its important no-resend outcome is preserved, but the candidate uses durable identity rather than that heuristic.

L42b/c and all L50 HTF checks pass. No assertion is relabeled as passing, and the compatibility runner still exits 1. This is not a full green original suite. No historical board/engine tests or performance replay were run.

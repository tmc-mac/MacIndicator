# Which terminal UNKNOWN each new field replaces (botfix-B, deadline scope)
| Terminal UNKNOWN (UNKNOWN-AUDIT.md) | New field |
|---|---|
| Header stamps: build stampId UNKNOWN / STALE until Review polls the journal | `build.stampId` |
| Header stamps: exe / cfg UNKNOWN for any stamp not in the page table | `build.executor`, `build.settingsHash` (8 chars) |
| Broker truth: "Broker read time: UNKNOWN" | `broker.readAt` (+ `positionReadAt`, `ordersReadAt`) |
| Broker truth: qty per protective order UNKNOWN | `broker.workingOrders[].qty` (+ `kind`, `price`) |
| Broker truth: set time per order UNKNOWN | `broker.workingOrders[].createdAt` / `updatedAt` |
| Broker truth: position side / qty / avg price not sent | `broker.position {side, qty, avgPrice}` |
| Control receipts: APPLIED inferred from effect (BOT-ASK 11) | `requests.lastAck`, `requests.appliedAt {flatten, pause, cancel}` |
| Still UNKNOWN (NEXT): exit reason, gross/fees/fill ids, balance age, checklist eval time, news row | not sent in this build |

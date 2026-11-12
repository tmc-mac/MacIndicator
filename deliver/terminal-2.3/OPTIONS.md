# Terminal 2.3: options for Mac (not in the build)

Each is off in 2.3. Mocks are in `shots/options/` (made by rearranging the 2.3 page in the test browser; they are pictures, not code that ships).

## 1. Checklist out of the tab bar (five tabs: Now · Trades · Levels · Review · Control)
- What: the Checklist tab leaves the bar; it opens from "Open the gates" / "Full checklist" on Now, as Risk rules opens from Trades.
- Why: six tabs at 390 px leave the "Checklist" label no padding (55 px label in a 55 px button, audit).
- Cost: one more tap to the full gate list. The tab order of the other five stays as it is.
- Mock: `shots/options/opt-1-five-tabs.png`

## 2. Header collapse and neutral build lines
- What: scrolled past 120 px the pinned header becomes one 56 px row (state, side and size, open P&L, Day P&L); scrolling to the top or a tap opens it. The build / exe / cfg lines turn grey ("build not reported by this bot") and go amber only on a mismatch.
- Why: the header takes 235 to 318 px of 844 on every tab.
- Cost: it lowers visual weight in the header, which is why it is an option and not a default.
- Mock: `shots/options/opt-2-header-collapsed.png`

## 3. Read the journal slice once after first paint (audit defect 2)
- What: the flight recorder's first line says "fill time unknown" until Review has been opened once in the page session; reading the journal slice after first paint on any tab removes that.
- Cost: it changes when a request is sent (one /signal-journal read earlier than today). It needs the requests gate and Mac's go.
- The other half of defect 2 (one duration line in the recorder header) needs no request change and can go in the next build without this.
- Mock: `shots/options/opt-3-recorder-header.png` (today's two lines, marked)

## 4. Sums that close (signature 2)
- What: every money and points figure painted through one resolver with its source and addends; a total whose parts do not close to the cent cannot paint as a number. 2.3 does this for one sum (the day tie on Trades and Review).
- Cost: three to five days, its own gate, touches every card.
- Mock: `shots/options/opt-4-day-tie.png` (the 2.3 tie line, as the seed)

## 5. Day time machine (signature 3)
- What: scrub the whole terminal to any moment of the day (cascade, gates, armed levels), with no look-ahead.
- Risk: depends on what the journal slice the phone receives carries; a one-day spike should answer that before anything is promised.
- Mock: none honest is possible without the spike; `shots/options/opt-5-today-recorder.png` shows today's one-trade recorder for reference.

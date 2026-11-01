# Team Mac quality bar

This is the standard for everything Team Mac ships: the phone terminal, artifacts, the TradingView indicators, studies, and bot changes. It turns Mac's expectations into engineering criteria, and every brief points here.

Every brief also states its own **acceptance criteria**, written in the terms below. "Make it impressive" is not an acceptance criterion; a frame budget, a contrast ratio, a witness, or a held-out test is.

---

## 0. The bar, in one paragraph

A deliverable should hold up in front of a senior engineer, a quant, and a designer at the same time:

- **Engineer:** it's fast, correct under bad inputs, and every claim is reproducible.
- **Quant:** every number has a source, and every result survives an honest test.
- **Designer:** it has a clear hierarchy, a coherent system and purposeful motion.

It also carries one **signature element**: something that shows real engineering depth, can be explained to an engineer in one sentence, and can be verified. Mac should never have to ask for more ambition, and never have to catch a shortcut.

## 1. Signature element (required for any UI or artifact)

Each UI deliverable names exactly one signature element in its design note, plus the test that proves it works. Examples of the right calibre:

- **Deterministic replay engine:** the same snapshot gives the same frames, at 60 fps, with scrubbing, and with no lookahead (it knows only what the bot knew at that moment).
- **Decision X-ray:** the bot's decision chain at any moment, each step with a source badge.
- **Collision-free label layout:** an interval-packing or force-relaxation layout with a proof of zero overlaps at 360 px.
- **A computed insight a person can't see by eye:** pattern mining over trades, shown with its sample size and confidence.
- **Live physics-feeling motion** (a spring or critically damped meter) driven by real data and degrading cleanly under `prefers-reduced-motion`.

Decoration is not a signature element: gradients, glow, or a big number on its own.

## 2. Phone terminal and web UI

**Design system**
- Colours are tokens only, with light and dark each designed, not inverted. Text contrast ≥ 4.5:1 and UI/graphics contrast ≥ 3:1 (WCAG AA), verified by script on both themes.
- Use one type scale. All numbers use `tabular-nums`. Spacing sits on a 4/8 px grid.
- Status colours (good, warn, crit) are reserved and always paired with a label or icon.
- Keep the terminal's existing tokens and components. Extend them; never fork them.

**Information design**
- Answer first: the card's main question is answered in the top line.
- Detail is one tap away (progressive disclosure).
- Charts are drawn to scale, with direct labels, units, a sample size where relevant, and no chart junk.
- Every money figure names its kind: broker net, estimate, or paper. An unknown value shows **UNKNOWN with its reason**, never a guess and never 0.

**Interaction**
- Touch targets are ≥ 44 px.
- Every view is driven by an explicit state machine: loading, live, stale (with its age), error, and empty, each one designed.
- Gestures (scrub, long-press for detail) must have tap equivalents.

**Motion**
- Animate only `transform` and `opacity`, 150–250 ms ease-out, or a spring for continuous values.
- Honour `prefers-reduced-motion`. No animation may delay information.

**Performance budgets** (mid-range phone, 4G)
- First useful paint < 1 s.
- No main-thread task > 50 ms, and interaction latency < 100 ms.
- During replay or animation, ≤ 8 ms of script per frame.
- Memory stays flat over a 6-hour session.
- Updates are incremental (diff, then patch), never a full re-render per poll.
- Measure these numbers and put them in REVIEW.

**Robustness**
- Missing or malformed fields never break a view.
- Fuzz the snapshot inputs, and include the result.
- Requests to the bot stay byte-identical unless the change is explicitly about requests.

**Proof**
- Every behaviour change has a **witness** test that fails on the previous version and passes on the new one.
- Every-tab screenshots at 360/375/390 in dark and light are read by a person before review.
- Run the counted replay gate on the exact frozen bytes. Announce the build sha before the freeze.

## 3. Charts and data visualisation (artifacts, Trade Review, briefs)

- Follow the dataviz method: pick the form first, assign colour by its job, run the palette validator, use thin marks, keep a single axis, give every chart a hover or tap layer, and design dark mode on purpose.
- Every figure on the page is reproduced from pinned files: name the commit, and re-run before publishing.
- A small sample is labelled small on the chart itself, not only in the text.

## 4. TradingView indicators (Pine)

- **Parity:** the bot mirrors the indicator (`lib/levelsPro.js`). A UI change must not alter any level, state, signal, plan, grade or alert. Prove it with a diff confined to the drawing code and re-run model checks.
- **No repaint:** confirmed-bar logic stays confirmed. Any intrabar display is labelled as intrabar.
- **Object budget:** lines, labels and boxes are pooled and reused, never created per bar. Stay well under the `max_*_count` limits, and state the budget.
- **Layout:** labels for nearby levels are laid out by an algorithm (merge, stack, or offset) with zero overlaps at phone width. Colours adapt to the chart background (`chart.bg_color`) so both themes stay legible.
- **Compile risk:** there's no Pine compiler on the desk. List every construct new to the file with its documented semantics. Mac's paste is the first compile, so always ship a fallback and a three-step paste sheet.

## 5. Studies and quant research

- **Predeclare:** hypotheses, definitions, metrics and the split are written down and timestamped before any result is computed. Report every variant tried, and say how many would look good by chance.
- **Out of sample:** keep an in-sample / out-of-sample split, or walk-forward. A result that only holds in-sample is a lead, not a finding.
- **Baselines:** compare against the unconditional baseline and against random entries matched on time of day.
- **Effect sizes with uncertainty:** bootstrap confidence intervals. A permutation test where that fits. Benjamini–Hochberg across many variants.
- **Execution realism:**
  - fees of $0.61 per side per contract, plus slippage;
  - no lookahead (completed candles only);
  - when a stop and a target fall in the same bar, assume the stop came first;
  - use 1m paths where they exist.
- **Results in the bot's own units:** TP1 +15 on 2 contracts, runner on 1, stops of 30–50, $2 per point per contract.
- **Reproducible:** scripts, data and outputs are pinned. Re-running from the pinned bytes reproduces every number.
- **Separate wording:** what the data shows, what it suggests, and what it cannot show.

## 6. Bot changes (lv1 and the prop bots)

- **Safety first:** the safety-stage contracts (durable close obligation, ownership provenance, strict defaults) apply. MacDot reviews before anything ships.
- **Strategy changes** pass Mac's do-no-harm replay gate on multi-seed means: more money pooled, no deeper drawdown, worse on at most 2 of 6 days. The rules are declared before testing.
- **Owner's go:** nothing reaches the live bot without Mac's explicit go, given in chat.

## 7. Delivery package

Every deliverable comes as a package ready for review:
- the frozen files plus SHA256SUMS;
- CHANGES (what changed, in plain words);
- REVIEW (claims, evidence, limits, and by-design exceptions);
- the witnesses and their outputs;
- reproducible build steps;
- for anything Mac installs or pastes, a plain-language sheet that says what he should see.

Limits are stated, not buried.

---
name: team-briefing
description: How MacArthur (head agent) writes briefs for Team Mac subagents and the bar every deliverable is held to. Use before launching or re-briefing any subagent (terminal/UI, artifacts, TradingView indicator, quant study, bot change), and when turning one of Mac's requests into work for the team.
---

# Briefing the team

Mac speaks in owner's terms ("futuristic", "impressive to engineers", "make it elite"). **Never forward those words as the spec.** The head agent's job is to translate owner intent into a precise engineering brief that a strong specialist can execute without guessing. Mac should never have to repeat the level of ambition: it is built into every brief through `QUALITY-BAR.md` (in this folder).

## Before writing

1. Identify the deliverable type: phone UI, artifact or visualisation, Pine indicator, study, or bot change. Open the matching sections of `QUALITY-BAR.md`.
   - For any UI, artifact or visual-design work, the brief also tells the agent to load and follow the `frontend-design` skill (`.claude/skills/frontend-design/SKILL.md`):
     - plan, then self-review against the brief, then build, then critique;
     - one signature move, with restraint everywhere else;
     - avoid the generated-design defaults it lists.
   - For existing surfaces (the phone terminal, Levels PRO), the established design system and Mac's rulings take precedence, per frontend-design's own rule that "the brief's own words always win". Apply its craft within that system; don't restyle the system unprompted.
   - For the phone terminal and other work screens, the brief also asks the agent to critique its result with `taste-skill`: the tells list, the critique loop and `references/app-screens.md`. Improvements stay inside our tokens and Mac's rulings.
   - For review of any page (terminal or artifact), the brief also asks for a `web-design-guidelines` pass (pinned rules) and lists its findings. For accessibility, use the AccessLint skills (`accessibility-scan` / `-inspect`) **only with MacArthur's go**, because they install npm packages. The rules for every third-party skill are in `.claude/skills/EXTERNAL-SKILLS.md`.
2. Gather the facts the agent can't get on its own: exact paths, commit and file shas, what is decided, what is live, reviewer findings (relayed verbatim, since subagents can't read #5), and Mac's rulings.
3. Decide the acceptance criteria before writing the brief. If you can't say how you'll verify it, the brief isn't ready.

## Brief structure (use these headings)

1. **Role & mission.** One sentence: who the agent is and the outcome it owns.
2. **Owner intent.** At most two lines quoting Mac, as context and not as spec. Then the intent translated: what the user must be able to see, decide or do, and why it matters for the payout goal.
3. **Current state.** Live versions, frozen candidates, decided rulings, open reviewer findings, leftover processes. Exact paths and shas.
4. **Objective & acceptance criteria.** Measurable, drawn from `QUALITY-BAR.md`:
   - functional behaviour and its witnesses;
   - quality budgets (frame time, contrast, interaction latency, object counts, out-of-sample tests, confidence intervals);
   - the **signature element** for UI work: name it, give its one-sentence engineering explanation, and the test that proves it;
   - data provenance and UNKNOWN handling.
5. **Design / method requirements.** The specific techniques expected, for example:
   - state-machine-driven views;
   - spring motion with a reduced-motion fallback;
   - interval-packing label layout;
   - bootstrap CIs with Benjamini–Hochberg correction;
   - walk-forward splits.
   Name techniques; don't describe moods.
6. **Constraints & non-goals.** Parity, no bot changes, owner gates, scope edges.
7. **Checkpoints.** Where the agent stops and waits: a design sketch, the sha announcement before a freeze, or a pitch. Say "wait for the reply".
8. **Verification & deliverables.** Exact files, the package contents (`QUALITY-BAR.md` §7), and re-running from the frozen bytes.
9. **House rules.** Point to the standard rules, and add only what's specific to this task:
   - CPU: nice 19, one browser at a time, pause above load 3;
   - no /opt, VPS, live bot or account;
   - no commits or posts by subagents;
   - `python3 -I` for untrusted data;
   - `rm -rf "${VAR:?}/…"` only;
   - no identifiers.
10. **Report format.** Milestone messages, and a final hand-back with shas, numbers and limits.

## Style

- Write like a tech lead writing a design ticket: specific, testable and terse.
- Quantify wherever possible: px, ms, %, n, CI, pts, $.
- Separate facts from hypotheses. Mark small samples as small.
- Prefer one strong ask over a list of soft ones. Rank when listing.
- Never pad a brief with enthusiasm. Ambition shows in the criteria.

## Re-briefing

When Mac adds or changes intent mid-task, send the agent an addendum with the same headings, covering only what changes. Quote reviewer findings verbatim. Say explicitly what is withdrawn.

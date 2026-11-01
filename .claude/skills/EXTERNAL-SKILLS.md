# Third-party skills in this folder

Mac asked for these on Nov 1, 2026: "add frontend-design to the team repo and add the skills from both repos to our team's skills."

## From anthropics/skills

Source: https://github.com/anthropics/skills at commit `ca45fc496a3436251f191354091d557da31c15b5`. Each skill was copied unchanged with its own `LICENSE.txt` (Apache 2.0). The repo's notices are in `ANTHROPIC-SKILLS-THIRD_PARTY_NOTICES.md`.

Added:

| Skill | Use |
|---|---|
| frontend-design | **Required reading for UI and visual design work** (see team-briefing) |
| theme-factory | Theming |
| canvas-design | Visual design |
| web-artifacts-builder | Building web artifacts |
| webapp-testing | Testing web apps |
| algorithmic-art | Generative art |
| mcp-builder | Building MCP servers |
| brand-guidelines | **Anthropic's own brand.** Never apply it to Mac's products. |
| internal-comms | Internal communications |
| slack-gif-creator | Slack GIFs |
| academy-guide | — |
| discernment-nudge | — |

Not copied, and why:

| Skill | Reason |
|---|---|
| docx, pdf, pptx, xlsx | Their licence ("© Anthropic, all rights reserved") doesn't allow redistribution, and this repository is public. They're already available to the team as built-in skills. |
| doc-coauthoring | It has no licence file. |
| claude-api, skill-creator | Already built into this environment. A second copy with the same name would compete with it. |

## From designed-by-ai/skills

Source: https://github.com/designed-by-ai/skills at commit `03c20aec6dcedb5fabfb03dc37982eb52ef19ed6`, MIT licence (copied as `design-mobile-apps/LICENSE`).

Added: `design-mobile-apps`.

**Team rule for design-mobile-apps.** This skill drives a paid outside service (sleek.design). It needs an API key, signs the user up through a device flow, and sends design briefs to that company's servers. Its skills.sh page also showed a failed Snyk security audit. So no agent may:
- start its device or sign-up flow;
- create or ask for a `SLEEK_API_KEY`;
- send any brief, screen, data or screenshot to sleek.design

without Mac's explicit go in chat for that specific use. Its React Native and styling notes (`implementing.md`, `styling/`) may be read as reference material.

## From Snyk's "Top 8 Claude Skills for UI/UX Engineers" (added Nov 1, 2026)

Mac asked on Nov 1 to "install all skills available on this page that's useful for our team": https://snyk.io/articles/top-claude-skills-ui-ux-engineers/ (article dated 2026-03-02). Every file added was security-scanned and its licence checked. The scan looked for network calls, process execution, file writes, shell lines in the frontmatter and prompt-injection phrases. The SKILL.md and Python scripts were read.

| Skill (folder) | Source repo @ commit | Licence | Use on Team Mac | Team changes / rules |
|---|---|---|---|---|
| `web-design-guidelines` | vercel-labs/agent-skills @ `1a2c79d4` + rules from vercel-labs/web-interface-guidelines @ `434b7f91` | MIT (agent-skills' README declares MIT but the repo has no LICENSE file; the guidelines' LICENSE is copied in) | A rules audit of terminal pages and artifacts (`file:line` findings) | **Changed:** the upstream skill fetches its rules from GitHub at run time, which is a remote-instruction vector. Here the rules are **vendored and pinned** in `guidelines/command.md`, and SKILL.md reads the local copy. MacArthur re-vendors them only after reading the diff. |
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill @ `3a13158f` | MIT | Searchable design data: styles, palettes, type pairings, UX rules (`scripts/search.py`) | The scripts are local only: no network, no subprocess. `--persist` writes `design-system/<slug>/` under the working directory, so **run it with `--persist` only inside the scratchpad, never in the repo root.** The upstream test fixtures were left out. |
| `bencium-innovative-ux-designer` | bencium/bencium-claude-code-design-skill @ `5de46a39` | MIT (the article said "not specified"; the repo now has an MIT LICENSE) | Concept rounds for a new visual language | Its "one author, no agents or panels" rule applies **only inside a concept round** an agent runs with it. It doesn't change how the team is organised. |
| `bencium-controlled-ux-designer` | same | MIT | Disciplined UI decisions: accessibility, responsive design and motion specs (the bundled reference docs) | Its "always ask before design decisions" means **ask MacArthur** (who carries Mac's rulings). Mac's rulings in QUALITY-BAR stand without re-asking. |
| `accessibility-scan`, `accessibility-inspect`, `accessibility-audit`, `accessibility-diff`, `accessibility-fix` (+ `accesslint-shared/`) | accesslint/claude-marketplace @ `2e9d7336` | MIT (README and plugin.json) | WCAG 2.2 checks of terminal pages and artifacts | **Changed:** the shared methodology lives in `accesslint-shared/`, and the links were rewritten from `../shared/`. **Rules:** these skills run `npx -y @accesslint/...@latest`, which installs unpinned npm packages and drives Chrome. **Don't run them without MacArthur's go, and pin a version first.** Point them only at local copies or fixtures, never at the live VPS page. **`accessibility-fix` edits files.** Never point it at the terminal's main script (the review build keeps it byte-identical), the bot, or the Pine engine; use it on prototypes and artifacts only. The article's AccessLint MCP server and agent are **not** installed. |

Already present: `frontend-design` (anthropics/skills, added earlier).

**Not installed, and why:**

| Skill | Reason |
|---|---|
| `react-best-practices`, `composition-patterns`, `react-native-skills` (Vercel) | Our stack is vanilla HTML / JS (the phone terminal and artifacts) plus Pine. These are React / Next.js / React Native rules and would only add noise. |
| `react-view-transitions`, `deploy-to-vercel`, `vercel-cli-with-tokens`, `vercel-optimize`, `writing-guidelines` (in the same repo, not in the article) | Not our stack. The deploy skills use Vercel tokens. |
| The article's AccessLint MCP server and agent | Not skills. Each would need its own security review and Mac's go. |

## From Leonxlnx/taste-skill (added Nov 1, 2026)

Mac shared https://github.com/Leonxlnx/taste-skill on Nov 1 so the team could push the phone terminal further. It's installed as `taste-skill/` (skill name `design-taste-frontend`), from commit `12af471f627f866411b4bd785b19646d3672784c`. The licence is MIT (copied in as `LICENSE`).

**What it gives the team:** an "anti-slop" art-direction method. It has a researched library (directions, type, palettes, motion), a "tells" list of generated-design habits, a critique loop, and **app-screen rules for dashboards and work screens** (`references/app-screens.md`). It also has a real-browser inspector (`scripts/inspect.mjs`) that measures a page against its house rules.

**Team rules** (scripts scanned; SKILL.md opening and frontmatter read):
- **`scripts/assets.mjs` fetches images and video from the internet** (Openverse, Wikimedia Commons, the Met, the Art Institute of Chicago, archive.org, NASA). Don't run it without MacArthur's go. Trading surfaces carry no photography anyway.
- **`scripts/inspect.mjs` and `scenes.mjs` start a local server on 127.0.0.1 and launch a headless Chrome.** They count against the one-browser-at-a-time rule: nice 19, and only after MacArthur clears the browser slot. Set `CHROME_PATH` to the pre-installed Chromium; never install another browser.
- **`scripts/draw.mjs` writes `~/.taste-skill/history.json` and a sheet into its output folder.** Run it with the output folder in the scratchpad, never the repo.
- **House style vs ours.** taste-skill's strict house style is a **reviewer's lens**, not a restyle order. On the phone terminal and Levels PRO, the existing tokens, the sacred level-state colours and Mac's rulings win (see Precedence). Use its tells list, critique loop and app-screen rules to find what to improve, then improve it inside our system.

## Precedence

The order is: Mac's own words, then the team's standing rules (`team-briefing/QUALITY-BAR.md`, which include sacred level-state colours and the bot as the single notification channel), then the existing terminal design system, then these skills.

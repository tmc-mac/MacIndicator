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

## Precedence

The order is: Mac's own words, then the team's standing rules (`team-briefing/QUALITY-BAR.md`, which include sacred level-state colours and the bot as the single notification channel), then the existing terminal design system, then these skills.

# Source and team notes

**Upstream.** K-Dense Scientific Agent Skills, https://github.com/K-Dense-AI/scientific-agent-skills,
commit 5f2bc0341354fd5590aef76a533ada1e1e5b4e62 (2026-10-26), MIT license (LICENSE.md in this folder).
Only `statistical-analysis` and `statistical-power` were taken, not the rest of the pack.

**Reviewed before vendoring (MacArthur, 10/30).** The scripts import only numpy, scipy, statsmodels, pandas and matplotlib.
They make no network, subprocess or shell calls, and they write a file only when a `save=` path is passed.

**Local changes.**
1. The "Citing Scientific Agent Skills" section at the end of each SKILL.md was removed. It told the agent to fetch a web
   page and add a paper citation to every report.
2. A short "Team Mac note" was added under each SKILL.md's front matter.

Nothing else was changed.

**Environment.** Use a separate environment in the session scratchpad, never in a repo:

    uv venv --python 3.13 <scratchpad>/.venv-stats
    uv pip install --python <scratchpad>/.venv-stats/bin/python "statsmodels==0.15.0" "scipy==1.18.1" "numpy==2.5.3" "pandas==2.3.3" "matplotlib==3.11.2"

## How the team uses these for trading studies

- **One unit is one trade.** Trades on the same TradeDay share the same market, so they are not independent.
  Always report the number of trades **and** the number of days. Check the result day by day (or bootstrap by
  day): a result that comes from one or two days is not a pattern.
- **Compare against a baseline, never against 0% or 50%.** With our exits (TP1 +15, the no-progress exit), even
  random entries close positive about half the time. The baseline is the same bot without the change, or the
  same entry type without the filter.
- **Every "is it profitable?" answer gives:**
  - trades and days;
  - the change against the baseline, with a 95% interval;
  - the chance it is luck (p-value, two-sided);
  - how many trades a clear answer needs (80% power at alpha 0.05, using the smallest effect that matters to Mac).
- **Do not compute post-hoc ("observed") power.** Report the interval, or the smallest effect the sample could
  have detected.
- **"Proven" means** p < 0.05 **and** the result holds in more than one market type or period.
- **Shipping is separate.** Even a proven edge ships only through Mac's do-no-harm replay rule: pooled result at
  least the baseline, max drawdown no worse, and not worse on more than 2 of the 6 days.

# System One: score, a position on a rubric you define

Use a score when the answer is a place on a spectrum you can describe in steps: severity, frustration, relevance, seniority, formality, how complete a report is. A rubric has 2 to 10 levels, written low to high. Level N is its place in the list, counted from 0.

The engine judges each level's description against the state by itself. It never sees the level numbers or the neighboring levels.

```bash
maestro-cli s1 rate 'How much does this bug report give an engineer to work with?' \
  "No detail; it only says something is broken" \
  "Names the feature, but no steps and no environment" \
  "Steps to reproduce or the environment, but not both" \
  "Steps to reproduce and the environment" -s @report.txt
```

The answer is a position that can fall between two levels (0.7 on level 1 and 0.3 on level 2 is 1.3), the level it is nearest to, and a confidence:

```text
2.21/3  conf=0.58  ≈ Steps to reproduce or the environment, but not both
```

## Rules

- **Describe situations.** "Broken, but a workaround exists" works. "Moderately bad" and a bare number do not. An example inside a level sharpens it only when it looks like a real input.
- **One dimension per rubric.** "Punctual and smart and experienced" cannot be placed. Ask three scores.
- **Give a rare extreme its own level** ("abusive or threatening"), so the top level is not shared with the merely bad.
- **A score is a position, not a measurement.** Do not read 1.3 as "30% of users". Use it to threshold, to rank, and to round.
- **The same score has different shapes.** 1.0 can be all of the weight on level 1, or half on level 0 and half on level 2. Read the confidence and the per-level probabilities beside it.
- **To combine scores**, divide each by its top level (levels minus 1) so it runs from 0 to 1, then weigh them in code: `priority = 0.6 * severity + 0.3 * frustration + 0.1 * report_quality`. A changed weight is a code change. It needs no second request.

## Confidence and exit codes

`--min-confidence P` makes `rate` exit 1 when the confidence is under P. Low confidence on a score means the levels overlap, the question measures more than one thing, or the state does not say enough.

Exit 0 is an answer at or above `--min-confidence`. Exit 1 is an answer under it. 2, 6 and 7 are a wrong command line, a refusal, and no answer.

The local judge names one whole level and reports no confidence, so its position never falls between levels and `--min-confidence` above 0 can never be met.

## With --json

`s1 rate --json` prints `score`, `top` (the highest level), `normalized` (the score over `top`, 0 to 1), `nearestLevel`, `nearest` (that level's text), `confidence`, `probabilities` (a list, one number per level), `verdict` and `minConfidence`, with the engine fields. In `s1 ask --json` the answer is `answers.<id>` with `score`, `probabilities` and `confidence`.

`s1 rank --levels ...` grades every candidate on a rubric in place of yes or no. Each result then has `score` (the position) and `p` (the position over the top level).

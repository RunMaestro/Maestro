# Phase 5 Rerun Shard B

- Command exit status: 1
- Passed: 1881
- Failed: 104
- Skipped: 21
- Timed out: not separately reported by Playwright; several failures are locator expectation timeouts.

## Artifacts

- HTML report: `playwright-report/phase5-rerun-b/index.html`
- Result output: `e2e-results/phase5-rerun-b/`
- Raw command log: `/tmp/maestro-phase5-rerun-b.log`
- Screenshots: `e2e-results/phase5-rerun-b/**/test-failed-1.png` (104 files)
- Error contexts: `e2e-results/phase5-rerun-b/**/error-context.md` (104 files)
- Traces: none produced (`0` `trace.zip` files)
- Videos: none produced (`0` `.webm` files)

## First Actionable Failure Cluster

All 104 failures are in `e2e/stats-graph-symphony.spec.ts`.

First failure: `SGS-A07 drills into Usage Dashboard Auto Run task and run tables`.

- Location: `e2e/stats-graph-symphony.spec.ts:1425`
- Assertion: `usageDashboard.getByTestId('section-autorun-stats')` expected visible.
- Error: element not found after clicking the Usage Dashboard `Auto Run` tab.
- Screenshot: `e2e-results/phase5-rerun-b/stats-graph-symphony-Stats-0baca-uto-Run-task-and-run-tables-electron/test-failed-1.png`
- Error context: `e2e-results/phase5-rerun-b/stats-graph-symphony-Stats-0baca-uto-Run-task-and-run-tables-electron/error-context.md`

The broader cluster repeatedly hits missing or unreachable Usage Dashboard, Document Graph, Symphony, and leaderboard UI elements, with many expectation timeouts around 10-32 seconds.

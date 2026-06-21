# Phase 4 Shard B Result

Run completed: 2026-06-16 00:50 EDT.

Command shape: direct Playwright execution with `--workers=1`, isolated `HOME`, isolated `MAESTRO_DATA_DIR`, `PLAYWRIGHT_HTML_REPORT=playwright-report/phase4-b`, `VITE_PORT=41742`, and `--output=e2e-results/phase4-b`.

Exit status: 1.

Counts:

- Passed: 1,481
- Failed: 504
- Skipped: 21
- Total terminal results: 2,006 / 2,006
- Remaining: 0

Artifacts:

- Log: `/tmp/maestro-phase4-b-run.log`
- Output: `e2e-results/phase4-b`
- HTML report: `playwright-report/phase4-b/index.html`
- Screenshots: 320 PNG files in `e2e-results/phase4-b`
- Error contexts: 131 Markdown files in `e2e-results/phase4-b`
- Traces/videos: none captured in this local no-retry run

First actionable failure clusters:

- `e2e/web-mobile.spec.ts`: 184 immediate failures before test logic because the isolated shard `HOME` made Playwright look for Chromium under `/tmp/maestro-e2e-phase4-b/home/Library/Caches/ms-playwright`. Future isolated-home browser shards should set `PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright` or install browsers into the isolated home.
- `e2e/wizard-settings-prompts.spec.ts`: 189 failures, primarily visible-state and timeout failures in wizard, Settings, Director's Notes, and Prompt Composer flows.
- `e2e/stats-graph-symphony.spec.ts`: 131 failures, primarily Document Graph, Usage Dashboard, and Symphony UI drift; closeout failures include strict-mode duplicate controls and Document Graph preview/layout handling.

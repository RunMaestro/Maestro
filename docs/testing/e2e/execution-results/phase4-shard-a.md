# Phase 4 Shard A Result

Run completed: 2026-06-16 00:50 EDT.

Command shape: direct Playwright execution with `--workers=1`, isolated `HOME`, isolated `MAESTRO_DATA_DIR`, `PLAYWRIGHT_HTML_REPORT=playwright-report/phase4-a`, `VITE_PORT=41741`, and `--output=e2e-results/phase4-a`.

Exit status: 1.

Counts:

- Passed: 953
- Failed: 32
- Skipped: 0
- Total terminal results: 985 / 985
- Remaining: 0

Artifacts:

- Log: `/tmp/maestro-phase4-a-run.log`
- Output: `e2e-results/phase4-a`
- HTML report: `playwright-report/phase4-a/index.html`
- Screenshots: 32 PNG files in `e2e-results/phase4-a`
- Error contexts: 1 Markdown file in `e2e-results/phase4-a`
- Traces/videos: none captured in this local no-retry run

First actionable failure cluster:

- `e2e/autorun-ai-terminal.spec.ts`: 31 failures, mostly Prompt Composer/Auto Run UI assertions and clipboard/image/link interactions.
- `e2e/app-shell.spec.ts`: 1 Document Graph context-menu copy timeout.

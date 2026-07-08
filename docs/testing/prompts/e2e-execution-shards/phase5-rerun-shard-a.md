# Phase 5 E2E Rerun Shard A

Run only the Shard A specs from the rebuilt Maestro artifacts. Do not edit source or tests. Write only the result summary requested below.

## Scope

- `e2e/app-shell.spec.ts`
- `e2e/autorun-ai-terminal.spec.ts`
- `e2e/autorun-batch.spec.ts`
- `e2e/autorun-editing.spec.ts`
- `e2e/autorun-sessions.spec.ts`
- `e2e/autorun-setup.spec.ts`

## Command

```bash
set -o pipefail
rm -rf /tmp/maestro-e2e-phase5-a e2e-results/phase5-rerun-a playwright-report/phase5-rerun-a
mkdir -p /tmp/maestro-e2e-phase5-a/home /tmp/maestro-e2e-phase5-a/data
HOME=/tmp/maestro-e2e-phase5-a/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-phase5-a/data \
PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright \
PLAYWRIGHT_HTML_REPORT=playwright-report/phase5-rerun-a \
VITE_PORT=41821 \
./node_modules/.bin/playwright test \
	e2e/app-shell.spec.ts \
	e2e/autorun-ai-terminal.spec.ts \
	e2e/autorun-batch.spec.ts \
	e2e/autorun-editing.spec.ts \
	e2e/autorun-sessions.spec.ts \
	e2e/autorun-setup.spec.ts \
	--workers=1 \
	--output=e2e-results/phase5-rerun-a \
	2>&1 | tee /tmp/maestro-phase5-rerun-a.log
```

## Result Capture

When the command exits, write a concise result summary to `docs/testing/e2e/execution-results/phase5-rerun-shard-a.md` with:

- Command exit status.
- Passed, failed, skipped, and timed-out counts when available.
- Paths to HTML report, traces, screenshots, and result output.
- The first actionable failure cluster, if any.

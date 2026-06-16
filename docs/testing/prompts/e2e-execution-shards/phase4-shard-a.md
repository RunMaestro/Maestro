# Phase 4 E2E Execution Shard A

Run only the Shard A specs from the rebuilt Maestro artifacts. Do not edit source files.

## Scope

- `e2e/app-shell.spec.ts`
- `e2e/autorun-ai-terminal.spec.ts`
- `e2e/autorun-batch.spec.ts`
- `e2e/autorun-editing.spec.ts`
- `e2e/autorun-sessions.spec.ts`
- `e2e/autorun-setup.spec.ts`

## Command

```bash
mkdir -p /tmp/maestro-e2e-phase4-a/home /tmp/maestro-e2e-phase4-a/data
HOME=/tmp/maestro-e2e-phase4-a/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-phase4-a/data \
PLAYWRIGHT_HTML_REPORT=playwright-report/phase4-a \
VITE_PORT=41741 \
./node_modules/.bin/playwright test \
	e2e/app-shell.spec.ts \
	e2e/autorun-ai-terminal.spec.ts \
	e2e/autorun-batch.spec.ts \
	e2e/autorun-editing.spec.ts \
	e2e/autorun-sessions.spec.ts \
	e2e/autorun-setup.spec.ts \
	--workers=1 \
	--output=e2e-results/phase4-a
```

## Result Capture

When the command exits, write a concise result summary to `docs/testing/e2e/execution-results/phase4-shard-a.md` with:

- Command exit status.
- Passed, failed, skipped, and timed-out counts when available.
- Paths to HTML report, traces, screenshots, and result output.
- The first actionable failure cluster, if any.

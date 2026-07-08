# Phase 4 E2E Execution Shard B

Run only the Shard B specs from the rebuilt Maestro artifacts. Do not edit source files.

## Scope

- `e2e/agent-crud-provider.spec.ts`
- `e2e/bionify-reading-mode.spec.ts`
- `e2e/debug-accessibility.spec.ts`
- `e2e/files-docs-history.spec.ts`
- `e2e/git-groupchat-playbooks.spec.ts`
- `e2e/group-chat.spec.ts`
- `e2e/stats-graph-symphony.spec.ts`
- `e2e/web-mobile.spec.ts`
- `e2e/wizard-settings-prompts.spec.ts`

## Command

```bash
mkdir -p /tmp/maestro-e2e-phase4-b/home /tmp/maestro-e2e-phase4-b/data
HOME=/tmp/maestro-e2e-phase4-b/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-phase4-b/data \
PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright \
PLAYWRIGHT_HTML_REPORT=playwright-report/phase4-b \
VITE_PORT=41742 \
./node_modules/.bin/playwright test \
	e2e/agent-crud-provider.spec.ts \
	e2e/bionify-reading-mode.spec.ts \
	e2e/debug-accessibility.spec.ts \
	e2e/files-docs-history.spec.ts \
	e2e/git-groupchat-playbooks.spec.ts \
	e2e/group-chat.spec.ts \
	e2e/stats-graph-symphony.spec.ts \
	e2e/web-mobile.spec.ts \
	e2e/wizard-settings-prompts.spec.ts \
	--workers=1 \
	--output=e2e-results/phase4-b
```

## Result Capture

When the command exits, write a concise result summary to `docs/testing/e2e/execution-results/phase4-shard-b.md` with:

- Command exit status.
- Passed, failed, skipped, and timed-out counts when available.
- Paths to HTML report, traces, screenshots, and result output.
- The first actionable failure cluster, if any.

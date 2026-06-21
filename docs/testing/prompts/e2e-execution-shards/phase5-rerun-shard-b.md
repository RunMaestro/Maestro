# Phase 5 E2E Rerun Shard B

Run only the Shard B specs from the rebuilt Maestro artifacts. Do not edit source or tests. Write only the result summary requested below.

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
set -o pipefail
rm -rf /tmp/maestro-e2e-phase5-b e2e-results/phase5-rerun-b playwright-report/phase5-rerun-b
mkdir -p /tmp/maestro-e2e-phase5-b/home /tmp/maestro-e2e-phase5-b/data
HOME=/tmp/maestro-e2e-phase5-b/home \
MAESTRO_DATA_DIR=/tmp/maestro-e2e-phase5-b/data \
PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright \
PLAYWRIGHT_HTML_REPORT=playwright-report/phase5-rerun-b \
VITE_PORT=41822 \
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
	--output=e2e-results/phase5-rerun-b \
	2>&1 | tee /tmp/maestro-phase5-rerun-b.log
```

## Result Capture

When the command exits, write a concise result summary to `docs/testing/e2e/execution-results/phase5-rerun-shard-b.md` with:

- Command exit status.
- Passed, failed, skipped, and timed-out counts when available.
- Paths to HTML report, traces, screenshots, and result output.
- The first actionable failure cluster, if any.

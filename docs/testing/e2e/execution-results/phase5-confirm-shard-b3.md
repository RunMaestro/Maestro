# Phase 5 Confirm Shard B3

- Command exit status: 0
- Passed: 1985
- Failed: 0
- Skipped: 21
- Duration: 1.4h

## Artifacts

- HTML report: `playwright-report/phase5-confirm-b3/index.html`
- Result output: `e2e-results/phase5-confirm-b3/`
- Raw stdout log: `/tmp/maestro-phase5-confirm-b3.out.log`
- Raw stderr log: `/tmp/maestro-phase5-confirm-b3.err.log`
- Screenshots: none produced (`0` `test-failed-1.png` files)
- Error contexts: none produced (`0` `error-context.md` files)
- Traces: none produced (`0` `trace.zip` files)
- Videos: none produced (`0` `.webm` files)

## Scope

Shard B covered:

- `e2e/agent-crud-provider.spec.ts`
- `e2e/bionify-reading-mode.spec.ts`
- `e2e/debug-accessibility.spec.ts`
- `e2e/files-docs-history.spec.ts`
- `e2e/git-groupchat-playbooks.spec.ts`
- `e2e/group-chat.spec.ts`
- `e2e/stats-graph-symphony.spec.ts`
- `e2e/web-mobile.spec.ts`
- `e2e/wizard-settings-prompts.spec.ts`

The rerun used one Playwright worker, isolated `HOME`, isolated `MAESTRO_DATA_DIR`, `PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright`, `PLAYWRIGHT_HTML_REPORT=playwright-report/phase5-confirm-b3`, `VITE_PORT=41895`, and `--output=e2e-results/phase5-confirm-b3`.

## Previously Failing Cases Verified

- `SGS-A137 closes Document Graph in-graph preview with Escape`
- `SGS-A323 shows Symphony blocked issue messaging from closeout tranche`
- `SGS-A327 keeps Symphony active tab current document metadata visible`
- `SGS-A329 keeps Symphony history tab completed contribution visible`

All four passed inside the broader Shard B rerun.

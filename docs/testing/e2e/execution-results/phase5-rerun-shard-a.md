# Phase 5 Rerun Shard A

Date: 2026-06-16

## Result

- Command exit status: 1
- Passed: 959
- Failed: 26
- Skipped: 0 reported
- Timed out: 0 test-timeout statuses reported; several failed assertions timed out waiting for UI conditions.
- Duration: 55.3m

## Artifacts

- Output log: `/tmp/maestro-phase5-rerun-a.log`
- Result output: `e2e-results/phase5-rerun-a`
- Last-run metadata: `e2e-results/phase5-rerun-a/.last-run.json`
- HTML report: `playwright-report/phase5-rerun-a/index.html`
- Screenshots: `e2e-results/phase5-rerun-a/**/test-failed-1.png` (26 files)
- Traces: none found under `e2e-results/phase5-rerun-a`
- Videos: none found under `e2e-results/phase5-rerun-a`

## First Actionable Failure Cluster

All failures were in `e2e/autorun-ai-terminal.spec.ts`.

First failure:
`e2e/autorun-ai-terminal.spec.ts:3698` - `removes inactive-tab Codex work from the queue browser without changing Main queued work`

Failure detail:
`getByText('Codex queued Main tab prompt sentinel')` hit a strict-mode violation because the text resolved to two elements: one queue/browser row and one matching terminal output row. The first actionable cluster is Codex lane queue/browser and related Codex Quick Actions behavior, followed by send-to-agent, transcript, lightbox, and Auto Run editor keyboard/autocomplete failures in the same spec.

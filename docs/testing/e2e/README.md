# E2E Testing

This directory owns the E2E coverage campaign state, lane ledgers, orchestration notes, and execution-sharding plan.

## Current State

- Matrix-backed authoring is complete: 3,025 / 3,025 active scenarios.
- One full PM2-sharded Playwright/Electron execution has completed after the campaign; it is not clean yet, and Phase 5 stabilization is in progress.
- The wizard/settings/prompts full-file rerun is now clean: 372 passed, 1 env-gated skip, and 0 failed.
- Execution should use PM2-managed Codex shards with one Playwright worker per process.

## Files

- [coverage-campaign.md](coverage-campaign.md): canonical E2E matrix and residual scenario scan.
- [parallel-campaign/README.md](parallel-campaign/README.md): parallel authoring and execution-sharding rules.
- [parallel-campaign/coverage-ledger.md](parallel-campaign/coverage-ledger.md): accepted lane counts and merge log.
- [parallel-campaign/orchestrator-status.md](parallel-campaign/orchestrator-status.md): lane state, launch history, and blockers.
- [parallel-campaign/agents/](parallel-campaign/agents/): per-lane progress logs.

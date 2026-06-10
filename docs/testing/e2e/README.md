# E2E Testing

This directory owns the E2E coverage campaign state, lane ledgers, orchestration notes, and execution-sharding plan.

## Current State

- Matrix-backed authoring is complete: 3,025 / 3,025 active scenarios.
- Full Playwright/Electron execution has not been run after the campaign.
- Execution should use PM2-managed Codex shards with one Playwright worker per process.

## Files

- [coverage-campaign.md](coverage-campaign.md): canonical E2E matrix and residual scenario scan.
- [parallel-campaign/README.md](parallel-campaign/README.md): parallel authoring and execution-sharding rules.
- [parallel-campaign/coverage-ledger.md](parallel-campaign/coverage-ledger.md): accepted lane counts and merge log.
- [parallel-campaign/orchestrator-status.md](parallel-campaign/orchestrator-status.md): lane state, launch history, and blockers.
- [parallel-campaign/agents/](parallel-campaign/agents/): per-lane progress logs.

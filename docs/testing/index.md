# Testing Documentation

This directory is the canonical home for Maestro test coverage documentation, campaign plans, prompts, audits, handoffs, and orchestration notes. The actual tests stay in their normal source locations such as `e2e/`, `src/**/__tests__/`, and package-level test files.

## Current Status

- Unit and integration coverage campaigns have historical artifacts here, but need a fresh post-rebase audit before their gap list is treated as current.
- E2E authoring reached the matrix target: 3,025 / 3,025 active matrix-backed scenarios with 0 matrix-backed scenarios remaining.
- The E2E suite has completed one full PM2-sharded Playwright/Electron execution after the authoring campaign; it is not clean yet, and Phase 5 stabilization is in progress.
- Recent Phase 5 focused reruns have cleared the web/mobile full-file bucket plus wizard/settings/prompts directory, Prompt Composer, inline-wizard exit, Settings/control, Director's Notes, and inline-wizard residual clusters.
- The latest full wizard/settings/prompts rerun is clean: 372 passed, 1 env-gated skip, and 0 failed.
- E2E execution should be sharded with separate PM2-managed Codex workers, one Playwright worker per process, and isolated data/report/output paths.

See [current-status.md](current-status.md) for the evidence-backed status snapshot and [game-plan.md](game-plan.md) for the next execution plan.

## Directory Structure

```text
docs/testing/
├── index.md
├── current-status.md
├── game-plan.md
├── session-handoff.md
├── audits/
│   └── test-coverage-audit.md
├── e2e/
│   ├── README.md
│   ├── coverage-campaign.md
│   └── parallel-campaign/
│       ├── README.md
│       ├── broadcasts.md
│       ├── coverage-ledger.md
│       ├── orchestrator-status.md
│       └── agents/
└── prompts/
    ├── full-test-coverage-campaign.md
    ├── e2e-parallel-campaign-plan.md
    └── e2e-agents/
```

## What Belongs Here

- Coverage strategy and gap audits for unit, integration, and E2E tests.
- Campaign prompts and orchestration instructions for agent-driven test work.
- Session handoffs and status snapshots for testing campaigns.
- E2E authoring ledgers, lane logs, and execution-sharding plans.

## What Does Not Belong Here

- Test implementation files.
- Build artifacts, Playwright reports, traces, screenshots, or `e2e-results/`.
- Product documentation that only mentions testing incidentally.

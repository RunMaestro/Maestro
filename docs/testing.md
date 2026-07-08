---
title: Testing
description: How Maestro organizes testing documentation and tracks the goal of maintaining 100% test coverage.
icon: shield-check
---

# Testing

Maestro keeps the testing playbook in [`docs/testing/`](./testing/). That folder is the canonical home for coverage status, campaign plans, audits, handoffs, E2E ledgers, and agent prompts. The actual test files stay with the code they exercise, such as `src/**/__tests__/`, `e2e/`, and package-level test files.

## Coverage Goal

The goal is to maintain 100% meaningful test coverage across the project. That means coverage work is not done when a number improves. It is done when the relevant unit, integration, and E2E evidence is recorded, the current gaps are understood, and the test suite continues to protect real user behavior.

For measured coverage, the standard target is 100% statements, branches, functions, and lines. For E2E work, the target is complete matrix-backed scenario coverage plus a verified Playwright/Electron execution pass.

## Testing Folder

Use [`docs/testing/current-status.md`](./testing/current-status.md) for the latest evidence-backed snapshot. Use [`docs/testing/game-plan.md`](./testing/game-plan.md) for the next execution plan. Historical audits and handoffs live beside those files so coverage campaigns can resume without rediscovering the same context.

The folder is organized around the testing workflow:

- `current-status.md`: current verified status, known risks, and next work.
- `game-plan.md`: ordered execution plan for the active testing campaign.
- `audits/`: coverage gap analysis and historical checkpoints.
- `e2e/`: E2E coverage campaign docs, matrix ledgers, and sharding plans.
- `prompts/`: reusable prompts for agent-driven testing work.
- `session-handoff.md`: handoff context for continuing long-running coverage campaigns.

## Working Rule

When adding or changing tests, update `docs/testing/` whenever the change affects coverage targets, scenario status, campaign scope, or the next handoff. Keep status claims tied to commands that actually ran.

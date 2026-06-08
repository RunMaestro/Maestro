# stats-graph-symphony

Status: pending launch

## Scope

Usage dashboard, stats, document graph, Symphony, leaderboard, achievements.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author first deterministic active scenario tranche.
- [x] Mock GitHub/network-backed states or mark them skipped/env-gated.
- [x] Record files touched and scenario counts.
- [ ] Commit lane work on `codex/e2e-stats-graph-symphony`.

## Progress

### 2026-06-08 - first tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - new deterministic Playwright authoring spec for stats/dashboard, document graph, Symphony, achievements, and leaderboard entry coverage.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - lane progress, counts, validation, and remaining work.

Scenario counts:

- Active: 5
- Skipped product-gap: 2
- Env-gated: 2

Validation:

- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: `git diff --check`

Execution note:

- No E2E or Playwright execution was run. The new scenarios are authored only.

Remaining work:

- Expand toward the full lane target for usage dashboard subviews, stats lifecycle/storage edges, document graph layouts and previews, Symphony contribution lifecycle, leaderboard submission/sync states, and achievement badge export/sharing.
- Keep live GitHub, live leaderboard, and host-specific badge artifact checks env-gated until the orchestrator approves those dependencies.

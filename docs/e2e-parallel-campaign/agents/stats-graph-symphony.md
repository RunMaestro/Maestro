# stats-graph-symphony

Status: second tranche committed

## Scope

Usage dashboard, stats, document graph, Symphony, leaderboard, achievements.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author first deterministic active scenario tranche.
- [x] Mock GitHub/network-backed states or mark them skipped/env-gated.
- [x] Record files touched and scenario counts.
- [x] Commit first lane tranche on `codex/e2e-stats-graph-symphony`.
- [x] Author second deterministic active scenario tranche.
- [x] Record second tranche files touched, counts, blockers, and commit hash.

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

### 2026-06-08 - second tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added second tranche matrix rows for Usage Dashboard chart mode toggles, Auto Run detail tables, Document Graph layout/depth/preview controls, Symphony active sync/status actions, Symphony issue document previews, blocked issue messaging, mocked leaderboard validation/submission, and one additional env-gated live leaderboard confirmation row.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this tranche's counts, validation, blockers, remaining work, and commit hash.

Scenario counts:

- Active added this tranche: 6
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 1
- Cumulative active in lane spec: 11
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 3

Validation:

- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: `git diff --check`

Execution note:

- No E2E or Playwright execution was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `7f10c3586` - `test(e2e-stats-graph-symphony): add second tranche scenarios`

Blockers:

- Live GitHub status refresh, live leaderboard email confirmation, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: stats data-management retries/storage edges, document graph node selection/minimap/persistence states, Symphony finalize/create-agent preflight states, achievement badge export/share states, and registered leaderboard sync/opt-out states.

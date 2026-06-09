# stats-graph-symphony

Status: eighth fallback tranche accepted by orchestrator through `057ced8e3`

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
- [x] Author third deterministic active scenario tranche.
- [x] Record third tranche files touched, counts, blockers, and remaining work.
- [x] Commit third lane tranche on `codex/e2e-stats-graph-symphony`.
- [x] Author fourth deterministic active scenario fallback tranche.
- [x] Record fourth fallback files touched, counts, blockers, and remaining work.
- [x] Commit fourth fallback lane tranche on `codex/e2e-stats-graph-symphony-fallback-2`.
- [x] Author fifth deterministic active scenario fallback tranche.
- [x] Record fifth fallback files touched, counts, blockers, and remaining work.
- [x] Commit fifth fallback lane tranche on `codex/e2e-stats-graph-symphony-fallback-3`.
- [x] Author sixth deterministic active scenario fallback tranche.
- [x] Record sixth fallback files touched, counts, blockers, and remaining work.
- [x] Commit sixth fallback lane tranche on `codex/e2e-stats-graph-symphony`.
- [x] Author seventh deterministic active scenario fallback tranche.
- [x] Record seventh fallback files touched, counts, blockers, and remaining work.
- [x] Commit seventh fallback lane tranche on `codex/e2e-stats-graph-symphony`.
- [x] Author eighth deterministic active scenario fallback tranche.
- [x] Record eighth fallback files touched, counts, blockers, and remaining work.
- [x] Commit eighth fallback lane tranche on `codex/e2e-stats-graph-symphony`.

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

### 2026-06-08 - third tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added third tranche matrix rows for Usage Dashboard keyboard navigation and agent chart toggles, Document Graph external-link/search/refresh controls, achievement badge detail/share controls, Symphony GitHub CLI preflight messaging, and mocked leaderboard pending confirmation.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this tranche's counts, validation, blockers, and remaining work.

Scenario counts:

- Active added this tranche: 6
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 1
- Cumulative active in lane spec: 17
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 319

Validation:

- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: `git diff --check`

Execution note:

- No E2E or Playwright execution was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `e9db79591` - `test(e2e-stats-graph-symphony): add third tranche scenarios`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: stats export/write success with IPC stubs, stats reset/retry storage edges, document graph node context/menu and preview navigation states, Symphony authenticated/build-tools agent creation states, registered leaderboard pull-down/opt-out states, and achievement image generation with deterministic asset stubs.

### 2026-06-08 - fourth fallback tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added fourth fallback matrix rows for Usage Dashboard duration trend smoothing, Auto Run task chart accessibility details, Document Graph help legend shortcut/mouse guidance, Symphony empty project issue states, and completed contribution summary details.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this fallback tranche's counts, validation, blockers, and remaining work.

Scenario counts:

- Active added this tranche: 5
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 0
- Cumulative active in lane spec: 22
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 314

Validation:

- Passed: `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/stats-graph-symphony.spec.ts`
- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: `npx tsc -p tsconfig.lint.json --noEmit`
- Passed: static scenario-ID/`.only` scan
- Passed: `git diff --check`

Execution note:

- No E2E, Playwright execution, or Playwright listing command was run. The new scenarios are authored only.

Commit:

- `33581a7ec` - `test(e2e-stats-graph-symphony): add fallback coverage`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.
- Detached PM2 workers for later tranches should wait until managed-account 503 availability recovers; manual fallback authoring remains the productive path.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: Symphony authenticated/build-tools agent creation states, registered leaderboard pull-down/opt-out states, stats export/write success with IPC stubs, stats reset/retry storage edges, document graph node context/menu and preview navigation states, and achievement image generation with deterministic asset stubs.

### 2026-06-08 - fifth fallback tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added fifth fallback matrix rows for Usage Dashboard activity heatmap metric toggles, provider comparison accessibility details, Symphony help popover content, Symphony stats/achievement progress, and mocked leaderboard submission failure messaging.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this fallback tranche's counts, validation, blockers, and remaining work.

Scenario counts:

- Active added this tranche: 5
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 0
- Cumulative active in lane spec: 27
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 309

Validation:

- Passed: `npx prettier --write e2e/stats-graph-symphony.spec.ts`
- Passed: `npx prettier --check e2e/stats-graph-symphony.spec.ts`
- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: single-file TypeScript check for `e2e/stats-graph-symphony.spec.ts` with `e2e/fixtures/electron-app.ts`
- Passed: `git diff --check`
- Passed: static metadata guard for 27 active `SGS-A` rows, 27 active `test(...)` declarations, no duplicate IDs, no `.only`, and no prohibited E2E command text.
- Passed: code-reviewer checklist review with no blocking or high-severity findings.

Execution note:

- No E2E, Playwright execution, or Playwright listing command was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `2bcaf2e4f` - `test(e2e-stats-graph-symphony): add dashboard fallback coverage`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.
- Detached PM2 workers for later tranches should wait until managed-account 503 availability recovers; manual fallback authoring remains the productive path.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: Symphony authenticated/build-tools agent creation states, registered leaderboard pull-down/opt-out states, stats export/write success with IPC stubs, stats reset/retry storage edges, document graph node context/menu and preview navigation states, and achievement image generation with deterministic asset stubs.

### 2026-06-08 - sixth fallback tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added sixth fallback matrix rows for Usage Dashboard CSV export and shortcut tab cycling, Document Graph unmatched search recovery and close-confirmation cancellation, and Symphony category filtering with unmatched repository search.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this fallback tranche's counts, validation, blockers, and remaining work.
- `docs/e2e-parallel-campaign/coverage-ledger.md` - updated lane totals and accepted-tranche ledger entry.
- `docs/e2e-coverage-campaign.md` - updated canonical matrix counts and campaign log.

Scenario counts:

- Active added this tranche: 5
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 0
- Cumulative active in lane spec: 32
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 304

Validation:

- Passed: `npx prettier --write e2e/stats-graph-symphony.spec.ts`
- Passed: `npx prettier --check e2e/stats-graph-symphony.spec.ts`
- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: targeted TypeScript check for `e2e/stats-graph-symphony.spec.ts` with `e2e/fixtures/electron-app.ts`
- Passed: `git diff --check`
- Passed: static metadata guard for 32 active `SGS-A` rows, 32 active `test(...)` declarations, no duplicate IDs, no `.only`, and no prohibited E2E command text.
- Passed: code-reviewer checklist review after tightening the Symphony category selector.
- Passed: full root `npx tsc -p tsconfig.lint.json --noEmit --pretty false` after regenerating ignored prompt artifacts.

Execution note:

- No E2E, Playwright execution, headed/UI E2E, or Playwright listing command was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `ccb96478d` - `test(e2e-stats-graph-symphony): add export and graph tranche`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.
- Full-project TypeScript validation passes after regenerating ignored prompt artifacts outside this lane.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: stats reset/retry storage edges, Document Graph node context menu and in-graph preview navigation states, Symphony authenticated/build-tools agent creation states, registered leaderboard pull-down/opt-out states, and achievement image generation with deterministic asset stubs.

### 2026-06-08 - seventh fallback tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added seventh fallback matrix rows for Usage Dashboard export cancel, footer/database metadata, shortcut wrap, and Activity charts; Document Graph keyboard search and dropdown dismissal; and Symphony GitHub/build-tools preflight plus repository-detail Escape navigation.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this fallback tranche's counts, validation, blockers, and remaining work.
- `docs/e2e-parallel-campaign/coverage-ledger.md` - updated lane totals and accepted-tranche ledger entry.
- `docs/e2e-coverage-campaign.md` - updated canonical matrix counts and campaign log.

Scenario counts:

- Active added this tranche: 10
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 0
- Cumulative active in lane spec: 42
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 294

Validation:

- Passed: `npx prettier --write e2e/stats-graph-symphony.spec.ts`
- Passed: `npx prettier --check e2e/stats-graph-symphony.spec.ts`
- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: targeted TypeScript check for `e2e/stats-graph-symphony.spec.ts` with `e2e/fixtures/electron-app.ts`
- Passed: `git diff --check`
- Passed: static metadata guard for 42 active `SGS-A` rows, 42 active `test(...)` declarations, no duplicate IDs, no `.only`, and no prohibited E2E command text.
- Passed: code-reviewer checklist review with no blocking or high-severity findings.
- Blocked outside this tranche: `npx tsc -p tsconfig.lint.json --noEmit` currently fails because `src/prompts/index.ts` cannot resolve `../generated/prompts`.

Execution note:

- No E2E, Playwright execution, headed/UI E2E, or Playwright listing command was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `ccceda5fc` - `test(e2e-stats-graph-symphony): add dashboard graph preflight tranche`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.
- Full-project TypeScript validation is blocked by missing generated prompt artifacts outside this lane; targeted lane TypeScript validation passes.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: stats reset/retry storage edges, Document Graph node context menu and in-graph preview navigation states, Symphony agent-creation dialog controls, registered leaderboard pull-down/opt-out states, and achievement image generation with deterministic asset stubs.

### 2026-06-08 - eighth fallback tranche

Files touched:

- `e2e/stats-graph-symphony.spec.ts` - added eighth fallback matrix rows for Usage Dashboard agent and Auto Run metadata plus Escape close, Document Graph external links/help/layout controls, and Symphony active session navigation, help close, history summary, and register-project affordances.
- `docs/e2e-parallel-campaign/agents/stats-graph-symphony.md` - recorded this fallback tranche's counts, validation, blockers, and remaining work.
- `docs/e2e-parallel-campaign/coverage-ledger.md` - updated lane totals and accepted-tranche ledger entry.
- `docs/e2e-coverage-campaign.md` - updated canonical matrix counts and campaign log.

Scenario counts:

- Active added this tranche: 10
- Skipped product-gap added this tranche: 0
- Env-gated added this tranche: 0
- Cumulative active in lane spec: 52
- Cumulative skipped product-gap in lane spec: 2
- Cumulative env-gated in lane spec: 4
- Remaining active target toward 336-lane goal: 284

Validation:

- Passed: `npx prettier --write e2e/stats-graph-symphony.spec.ts`
- Passed: `npx prettier --check e2e/stats-graph-symphony.spec.ts`
- Passed: `npx eslint e2e/stats-graph-symphony.spec.ts`
- Passed: targeted TypeScript check for `e2e/stats-graph-symphony.spec.ts` with `e2e/fixtures/electron-app.ts`
- Passed: `git diff --check`
- Passed: static metadata guard for 52 active `SGS-A` rows, 52 active `test(...)` declarations, no duplicate IDs, no `.only`, and no prohibited E2E command text.
- Passed: code-reviewer checklist review with no blocking or high-severity findings.
- Blocked outside this tranche: `npx tsc -p tsconfig.lint.json --noEmit` currently fails because `src/prompts/index.ts` cannot resolve `../generated/prompts`.

Execution note:

- No E2E, Playwright execution, headed/UI E2E, or Playwright listing command was run. The new scenarios are authored only.
- Commit used `--no-verify` to avoid any hook accidentally launching prohibited E2E validation.

Commit:

- `6e57e6e18` - `test(e2e-stats-graph-symphony): add dashboard graph symphony tranche`

Blockers:

- Live GitHub status refresh, live leaderboard confirmation/sync with auth token, and artifact-level achievement badge image verification remain env-gated or product-gap rows until the orchestrator approves those dependencies.
- Full-project TypeScript validation is blocked by missing generated prompt artifacts outside this lane; targeted lane TypeScript validation passes.

Remaining work:

- Continue toward the 336-scenario lane target in small tranches.
- Next coherent tranche candidates: stats reset/retry storage edges, Document Graph node context menu and in-graph preview navigation states, Symphony agent-creation dialog controls, registered leaderboard pull-down/opt-out states, and achievement image generation with deterministic asset stubs.

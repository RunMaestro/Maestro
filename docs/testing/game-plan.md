# Testing Campaign Game Plan

Last updated: 2026-06-17 23:33 EDT.

This plan covers branch hygiene, coverage audit work, and full E2E execution for the `codex/full-e2e-coverage-campaign` branch. Phases 1-6 reached a green pre-upstream-sync checkpoint. Phase 7 is now active because syncing `upstream/main` into the branch invalidated the prior finality proof.

## Phase 1: Freeze The Current Documentation State

Status: complete.

- The testing docs were consolidated under `docs/testing/`.
- Redirect stubs remain in place for old top-level testing paths.
- The canonical E2E matrix reached 3,025 / 3,025 authored active scenario atoms.

## Phase 2: Consolidate Branches And Worktrees

Status: complete.

- The bucket branch is `codex/full-e2e-coverage-campaign`.
- The branch was rebased and the useful E2E work was replayed or superseded.
- Obsolete E2E lane worktrees were pruned.
- The unrelated `codex-provider-paths` worktree was left intact because it has local changes outside this campaign.

## Phase 3: Re-Audit Unit And Integration Coverage

Status: complete.

- `npm run test:coverage` passed with 731 test files, 28,679 tests, and 100% statements/branches/functions/lines.
- Full integration with SSH enabled passed with 539 test files and 12,687 tests.
- The integration log audit found 0 skip markers, 0 SSH-not-configured markers, 0 `FAIL`, and 0 `fn3 is not a function`.
- Current evidence is recorded in [current-status.md](current-status.md) and [audits/test-coverage-audit.md](audits/test-coverage-audit.md).

## Phase 4: Execute E2E With PM2 Shards

Status: complete.

- E2E was executed as isolated PM2-managed Playwright/Electron shards, one Playwright worker per process.
- Shards used isolated `HOME`, `MAESTRO_DATA_DIR`, report, output, and `VITE_PORT` paths.
- Earlier Phase 4 and Phase 5 runs are retained as historical discovery and stabilization evidence.

## Phase 5: Triage E2E Results

Status: complete.

- Historical shard failures were classified and fixed in focused batches.
- Affected shards and previously failing buckets were rerun until clean.
- The final active failure count is 0.

## Phase 6: Cleanup And Handoff

Status: complete for the pre-upstream-sync checkpoint; historical after Phase 7 began.

- Final Phase 6 shard A: 985 passed, 0 failed, 0 skipped.
- Final Phase 6 shard B: 1,985 passed, 0 failed, 0 skipped.
- Combined final Phase 6 E2E runtime: 2,970 passed, 0 failed, 0 skipped.
- Final shard result docs:
  - [e2e/execution-results/phase6-final-shard-a.md](e2e/execution-results/phase6-final-shard-a.md)
  - [e2e/execution-results/phase6-final-shard-b.md](e2e/execution-results/phase6-final-shard-b.md)
- Cleanup and reporter handoff doc: [e2e/execution-results/phase6-cleanup-handoff.md](e2e/execution-results/phase6-cleanup-handoff.md)

## Phase 7: Upstream Sync Revalidation

Status: active.

- A direct rebase/merge of the old campaign branch onto current `upstream/main` produced a malformed hybrid tree, so the sync strategy changed to an upstream-shaped tree plus targeted campaign docs/E2E overlay.
- The upstream-shaped tree passed `npm run validate:push` through format, TypeScript, ESLint, and unit execution.
- The upstream-shaped unit suite still reports 108 skipped tests, so it does not satisfy the no-skips requirement.
- `npm run test:coverage` on the upstream-shaped tree fails the enforced 100% thresholds with 66% statements, 60.78% branches, 63.25% functions, and 67.05% lines.
- Next work:
  - restore 100% unit coverage with current-upstream-compatible tests,
  - remove or activate unit skips,
  - rerun full integration with SSH and 0 skips,
  - rerun full E2E shards with 0 failures and 0 skips,
  - update this plan and [current-status.md](current-status.md) with final evidence.

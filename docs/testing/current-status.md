# Testing Current Status

Last updated: 2026-06-10.

Verification basis: Phase 1 through Phase 3 of [game-plan.md](game-plan.md). This pass rebased the bucket branch, inspected branch/worktree state, ran the standard non-E2E gates, and did not run Playwright, `npm run test:e2e`, or `playwright test --list`.

## Branch State

- Current branch: `codex/full-e2e-coverage-campaign`.
- Current head before this status update: `6102e9196` (`docs(testing): centralize coverage campaign docs`).
- `upstream/main` at `f166b9309` is an ancestor of the bucket branch after rebase.
- The rebase replayed the useful E2E spec changes, skipped superseded legacy E2E docs records, and preserved the consolidated `docs/testing/` layout.
- `codex/e2e-autorun-ai-terminal` still reports many non-ancestor commits after rebase, but direct spec comparison found the bucket branch and that branch both contain 273 literal `e2e/autorun-ai-terminal.spec.ts` tests with 0 missing test titles. No autorun cherry-picks were needed.
- Phase 2 cleanup removed 23 clean `codex/e2e-*` worktrees under `/Users/jeffscottward/Github/tools/Maestro-worktrees/`.
- The unrelated `codex-provider-paths` worktree remains because it has local changes in `src/__tests__/renderer/components/NewInstanceModal.test.tsx` and `src/renderer/components/NewInstanceModal.tsx`.

## Unit Coverage

- Historical campaign material lives in [audits/test-coverage-audit.md](audits/test-coverage-audit.md) and [session-handoff.md](session-handoff.md).
- `npm run lint`: passed.
- `npm run lint:eslint`: passed.
- `npm run test`: passed, 730 test files passed, 1 skipped; 28,523 tests passed, 106 skipped.
- `npm run test:coverage`: executed the suite but failed the enforced 100% global threshold.
- Fresh coverage result: 99.91% statements, 99.84% branches, 99.89% functions, 99.92% lines.
- Top current missed-line targets are `src/renderer/hooks/tabs/useTabHandlers.ts`, `src/web/hooks/useMobileSessionManagement.ts`, `src/web/mobile/App.tsx`, `src/renderer/components/DocumentGraph/DocumentGraphView.tsx`, and `src/renderer/components/FilePreview.tsx`.

## Integration Coverage

- `codex/integration-coverage-campaign` exists and tracks `origin/codex/integration-coverage-campaign`.
- `main` currently tracks `upstream/main` at a commit labeled `[codex] Reach full integration coverage (#1053)`.
- Branch comparison after rebase:
  - `main`: 0 branch-only commits versus the bucket branch.
  - `codex/unit-coverage-campaign`: 4 branch-only commits remain (`test: add full unit coverage suite`, `ci: increase prettier heap for format check`, `chore: remove stale markdown screenshots`, `docs: refresh coverage campaign prompt`).
  - `codex/integration-coverage-campaign`: 1 branch-only commit remains (`test: reach full integration coverage`).
- Do not declare unit or integration coverage complete on the bucket branch until those remaining branch-only commits are reviewed or absorbed.

## E2E Coverage

- E2E authoring target: 3,025 active matrix-backed scenarios.
- Current canonical matrix: 3,025 / 3,025 active matrix-backed scenarios, 0 matrix-backed scenarios remaining.
- Stale-path scan for pre-consolidation testing doc paths passed.
- The count difference is expected: the E2E matrix counts scenario atoms, and one Playwright test can cover multiple scenario atoms.
- Full Playwright/Electron execution remains unverified.

Known non-active E2E residuals:

- Live provider/account-backed wizard handoff.
- Real operating-system default-app file handoff.
- Configured SSH file browsing.
- Live Symphony, GitHub, leaderboard, and backend polling paths.
- Downloadable achievement badge image verification.
- PDF page rendering.
- File-tree toolbar and multi-select product gaps.

## Current Risk

The documentation and matrix are centralized, the bucket branch is rebased, stale E2E worktrees are pruned, and the non-E2E lint/test gates are green except for the intentional coverage-threshold failure. The next high-value work is to review or absorb the remaining unit/integration coverage campaign commits, close the current 100% coverage gaps, and then run a sharded E2E validation pass.

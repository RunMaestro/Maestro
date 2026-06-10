# Testing Current Status

Last updated: 2026-06-09.

Verification basis: static repository inspection only. This pass did not run Playwright, `npm run test:e2e`, `playwright test --list`, unit tests, integration tests, or coverage commands.

## Branch State

- Current branch: `codex/full-e2e-coverage-campaign`.
- Current branch contains the accepted E2E lane branches except for the current head of `codex/e2e-autorun-ai-terminal`, which has 7 branch-only commits that are not ancestors of the bucket branch.
- Do not merge `codex/e2e-autorun-ai-terminal` wholesale without a targeted conflict review. Its branch head predates many accepted lane imports and a direct diff shows broad changes across already-accepted E2E files.
- Many E2E lane and fallback worktrees still exist under `/Users/jeffscottward/Github/tools/Maestro-worktrees/`. Treat them as cleanup candidates only after the bucket branch is committed, rebased, and verified.

## Unit Coverage

- Historical campaign material lives in [audits/test-coverage-audit.md](audits/test-coverage-audit.md) and [session-handoff.md](session-handoff.md).
- Current gap status is not verified in this pass.
- Next required step: run a fresh coverage audit after branch cleanup and upstream rebase, then replace stale unit gap lists with current evidence.

## Integration Coverage

- `codex/integration-coverage-campaign` exists and tracks `origin/codex/integration-coverage-campaign`.
- `main` currently tracks `upstream/main` at a commit labeled `[codex] Reach full integration coverage (#1053)`.
- Current integration gap status is not verified in this pass.
- Next required step: compare integration campaign branch, `main`, and current bucket branch after rebasing before declaring integration complete on this branch.

## E2E Coverage

- E2E authoring target: 3,025 active matrix-backed scenarios.
- Current canonical matrix: 3,025 / 3,025 active matrix-backed scenarios, 0 matrix-backed scenarios remaining.
- Static spec inventory: 15 spec files, 2,356 active Playwright `test(...)` functions, and 6 explicit `test.skip(...)` functions.
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

The documentation and matrix are now centralized, but runtime confidence still depends on fresh execution. The next high-value work is to commit this documentation consolidation, rebase the bucket branch from upstream, inspect the unabsorbed autorun commits, and then run a sharded E2E validation pass.

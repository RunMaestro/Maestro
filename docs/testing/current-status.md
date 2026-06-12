# Testing Current Status

Last updated: 2026-06-12.

Verification basis: Phase 1 through Phase 3 of [game-plan.md](game-plan.md), plus targeted Phase 4 E2E stabilization and focused reruns. The full sharded Playwright/Electron suite is still not verified.

## Branch State

- Current branch: `codex/full-e2e-coverage-campaign`.
- Current head before this status update: `e655f2a15` (`docs: add testing documentation hub`).
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
- `npm run test:e2e:stop` is the current stop mechanism. It reported no remaining Maestro E2E Playwright/Electron processes before and after the focused runs below.
- The initial Phase 4 PM2 shard run (`phase4-shards-20260611-040109`, `maestro-e2e-phase4-a`, `maestro-e2e-phase4-b`) was stopped and deleted after local source repairs made its logs stale. Treat that run as discovery only, not a full-suite result.
- Focused app-shell E2E check passed: 4/4 for `e2e/app-shell.spec.ts --grep 'command terminal Tab Switcher'`.
- Focused app-shell stabilization rerun passed: 10/10 for the patched app-shell cluster.
- Focused git/group-chat/playbooks rerun passed: 8/8 for `e2e/git-groupchat-playbooks.spec.ts` command panel and Playbook Exchange coverage.
- Focused debug/accessibility E2E check passed: 13/13 for `DA-074|DA-075|DA-078|DA-079|DA-080|DA-081|DA-086|DA-089|DA-102|DA-103|DA-104|DA-107|DA-108`.
- Focused debug/accessibility stabilization rerun passed: 2/2 for `DA-131 reports Keyboard Shortcuts mastery progress|DA-148 labels Keyboard Shortcuts search for filtering` (`phase4-debug-focus-20260611054233`).
- Focused Auto Run plus files/docs/history repair check passed: 6/6 for `saves Codex Auto Run edits from the expanded modal header|FDH-A04 |FDH-A07 |FDH-A08 |FDH-A11 |FDH-A13 `.
- Focused Auto Run expanded modal/worktree rerun passed: 5/5 for dirty-close, save-before-run, busy Run disabled, and create-new worktree setup (`phase4-autorun-cluster2-20260611054910`).
- Focused Auto Run stop-state rerun passed: 1/1 for graceful stop confirmation and Stopping state (`phase4-autorun-stop2-20260611054206`).
- Focused Auto Run/Codex context warning rerun passed: 5/5 for yellow, dismissal, below-threshold, red-threshold, and custom-threshold context warning coverage (`phase5-autorun-context-warning-20260612`).
- Focused Auto Run mixed repair rerun passed: 6/6 for duplicate document creation, busy prompt queueing, context warning, single-tab close disabled state, Review tab close, and session ID clipboard copy (`phase5-autorun-focused5-20260612`).
- Focused Auto Run failed-family rerun passed: 16/16 for active batch state, batch worktree targeting, stubbed dispatch, Enter-to-send, prompt composer draft/read-only/lightbox, and non-dispatch display toggles (`phase5-autorun-failedfamilies-20260612`).
- Focused Auto Run busy-state rerun passed: 3/3 for queued text prompts, built-in history synopsis spawning without queueing, and queued image prompts while the lane is busy (`phase5-autorun-busy-queue3-20260612`).
- Focused Auto Run prompt-composer gap rerun passed: 3/3 for `@` draft preservation, image attachment removal, and Control-S history toggling without dispatch (`phase5-autorun-promptcomposer-missing-20260612`).
- Focused files/docs/history dotfile and refresh drift check passed: 8/8 for `FDH-A44 |FDH-A53 |FDH-A350 |FDH-A351 |FDH-A112 |FDH-A114 |FDH-A136 |FDH-A138 `.
- Focused files/docs/history stabilization rerun passed: 3/3 for `FDH-A169|FDH-A299|FDH-A300` (`phase4-fdh-focus-20260611054254`).
- An accidental wider grep matched `FDH-A110+` quota cases and ran 26 tests: 20 passed, 6 failed. Those failures mapped to exact file-row collisions, visible-by-default dotfiles, and the refresh button title while auto-refresh is enabled; the directly affected cases were patched and rerun green in the focused checks above.
- Current build and static gates passed after the focused repairs: `npm run build:renderer`, `npm run build:main`, `npm run build:preload`, `npm run build:web`, `git diff --check`, and `npm run lint`. The renderer/web builds still emit existing bundle-size/Browserslist/CSS warnings.
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

The documentation and matrix are centralized, the bucket branch is rebased, stale E2E worktrees are pruned, stale PM2 shards are stopped, and focused E2E repairs are green. The non-E2E lint/test gates were green in the Phase 3 pass except for the intentional coverage-threshold failure. The next high-value work is to review or absorb the remaining unit/integration coverage campaign commits, close the current 100% coverage gaps, and then run a fresh sharded E2E validation pass from rebuilt artifacts.

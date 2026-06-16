# Testing Current Status

Last updated: 2026-06-16.

Verification basis: Phase 1 through Phase 3 of [game-plan.md](game-plan.md), plus targeted Phase 4 E2E stabilization, focused reruns, and one completed two-shard Playwright/Electron execution. The full sharded suite has run to completion but is not clean.

2026-06-16 continuation checkpoint: the canonical E2E authoring target remains complete at 3,025 / 3,025 matrix-backed active scenarios with 0 matrix-backed scenarios remaining. Current local inventory is 15 spec files, 2,375 active Playwright declarations, and 6 skipped declarations. Phase 4 execution ran through two PM2-managed shards with one Playwright worker per process and isolated `HOME`, `MAESTRO_DATA_DIR`, report, output, and `VITE_PORT` paths. Final shard checkpoint at 2026-06-16 00:50 EDT: 2,991 / 2,991 shard tests had terminal results and 0 remained; Shard A completed 985 / 985 with 953 passed, 32 failed, and 0 skipped; Shard B completed 2,006 / 2,006 with 1,481 passed, 504 failed, and 21 skipped. Combined result: 2,434 passed, 536 failed, 21 skipped. Both PM2 shards stopped with exit code 1 and `autorestart: false`.

## Branch State

- Current branch: `codex/full-e2e-coverage-campaign`.
- Current head before this status update: `2e67b3a41` (`test(e2e): stabilize phase 4 shard failures`).
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
- 2026-06-15 22:40 ET live Phase 4 checkpoint: `maestro-e2e-phase4-a` and `maestro-e2e-phase4-b` are online in PM2 with `autorestart: false`, each running direct Playwright commands with `--workers=1`. Shard logs are `/tmp/maestro-phase4-a-run.log` and `/tmp/maestro-phase4-b-run.log`; the three-hour status email cron is active through `/Users/jeffscottward/.codex/scripts/maestro-e2e-status-email.mjs`, which now reports live shard remaining counts.
- 2026-06-15 23:43 ET live Phase 4 checkpoint: `maestro-e2e-phase4-a` is stopped after completing 985 / 985 with 32 failures, mostly in Auto Run/Codex lane coverage plus one Document Graph context-menu case. `maestro-e2e-phase4-b` remains online with `autorestart: false`, at 1,335 / 2,006 and 671 tests left; all live Shard B failures so far are in `e2e/stats-graph-symphony.spec.ts`, split across Usage Dashboard, Document Graph, and Symphony UI drift.
- 2026-06-15 23:43 ET lightweight verification after in-flight fixes: `npx vitest run src/__tests__/renderer/components/PromptComposerModal.test.tsx` passed 94 / 94, and `git diff --check` passed.
- 2026-06-15 23:45 EDT focused E2E reruns after in-flight test-side fixes: `e2e/app-shell.spec.ts --grep 'copies a Document Graph node path from the context menu'` passed 1 / 1 (`focus-app-shell-context-menu`), and `e2e/stats-graph-symphony.spec.ts --grep 'SGS-A04 browses Symphony projects, status tabs, and achievements'` passed 1 / 1 (`focus-sgs-a04`).
- 2026-06-16 00:05 EDT live Phase 4 checkpoint: `maestro-e2e-phase4-a` remains stopped at 985 / 985, and `maestro-e2e-phase4-b` remains online with `autorestart: false`, at 1,736 / 2,006 and 270 tests left. Combined live shard progress is 2,721 / 2,991 terminal results, 2,326 passed, 375 failed, and 20 skipped.
- 2026-06-16 00:05 EDT mailer verification: the three-hour cron entry is active at `0 */3 * * * /Users/jeffscottward/.codex/scripts/maestro-e2e-status-email.mjs`, and a sparse cron-environment dry run of that script succeeded after pinning Node/PM2/Mutt resolution. The dry run reported live shard remaining counts.
- 2026-06-16 00:05 EDT lightweight verification after Document Graph Escape fixes: `git diff --check` passed, and `./node_modules/.bin/eslint src/renderer/components/DocumentGraph/DocumentGraphView.tsx e2e/stats-graph-symphony.spec.ts --max-warnings=0` passed. The product-side Document Graph Escape fix still needs rebuilt-artifact focused E2E verification after Shard B exits.
- 2026-06-16 00:18 EDT live Phase 4 checkpoint: `maestro-e2e-phase4-b` remains online with `autorestart: false`, at 1,837 / 2,006 and 169 tests left. Combined live shard progress is 2,822 / 2,991 terminal results, 2,386 passed, 416 failed, and 20 skipped. The current live failure stream is concentrated in `e2e/wizard-settings-prompts.spec.ts`; earlier Shard B failures included 184 immediate `e2e/web-mobile.spec.ts` failures that need the final Playwright failure detail before patching.
- 2026-06-16 00:19 EDT live count refresh: `maestro-e2e-phase4-b` is still online at 1,840 / 2,006 and 166 tests left. Combined live shard progress is 2,825 / 2,991 terminal results, 2,386 passed, 419 failed, and 20 skipped.
- 2026-06-16 00:25 EDT live count refresh: `maestro-e2e-phase4-b` is still online at 1,871 / 2,006 and 135 tests left. Combined live shard progress is 2,856 / 2,991 terminal results, 2,394 passed, 442 failed, and 20 skipped.
- 2026-06-16 00:30 EDT live count refresh: `maestro-e2e-phase4-b` is still online at 1,924 / 2,006 and 82 tests left. Combined live shard progress is 2,909 / 2,991 terminal results, 2,426 passed, 463 failed, and 20 skipped.
- 2026-06-16 00:35 EDT live count refresh: `maestro-e2e-phase4-b` is still online at 1,944 / 2,006 and 62 tests left. Combined live shard progress is 2,929 / 2,991 terminal results, 2,427 passed, 482 failed, and 20 skipped.
- 2026-06-16 00:50 EDT final Phase 4 shard checkpoint: `maestro-e2e-phase4-a` and `maestro-e2e-phase4-b` both stopped with `autorestart: false` and exit code 1. Shard A completed 985 / 985 with 953 passed, 32 failed, and 0 skipped. Shard B completed 2,006 / 2,006 with 1,481 passed, 504 failed, and 21 skipped. Combined shard execution completed 2,991 / 2,991 with 0 tests left, 2,434 passed, 536 failed, and 21 skipped.
- 2026-06-16 00:50 EDT artifact summaries were written to [e2e/execution-results/phase4-shard-a.md](e2e/execution-results/phase4-shard-a.md) and [e2e/execution-results/phase4-shard-b.md](e2e/execution-results/phase4-shard-b.md). Largest final failure buckets: `e2e/wizard-settings-prompts.spec.ts` 189 failures, `e2e/web-mobile.spec.ts` 184 immediate Chromium-cache failures caused by isolated `HOME`, `e2e/stats-graph-symphony.spec.ts` 131 failures, `e2e/autorun-ai-terminal.spec.ts` 31 failures, and `e2e/app-shell.spec.ts` 1 failure.
- 2026-06-16 00:50 EDT sharding doc correction: isolated-home browser shards now carry `PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright`, because Shard B's web/mobile tests tried to launch Chromium from `/tmp/maestro-e2e-phase4-b/home/Library/Caches/ms-playwright`.
- 2026-06-16 focused Phase 5 verification: rebuilt `build:main`, `build:renderer`, and `build:web` once after both shards stopped, then rebuilt `build:renderer` after the Document Graph Escape handler fix. Focused reruns passed for app-shell Document Graph context-menu copy 1 / 1 (`focus-app-shell-context-menu-20260616`), Auto Run markdown link plus discard-bottom-panel coverage 2 / 2 (`focus-autorun-link-discard-20260616`), Stats/Graph/Symphony Document Graph closeout plus `SGS-A04` and `SGS-A118` 10 / 10 (`focus-sgs-a04-closeout-rerun3-20260616`), and representative web/mobile browser-cache coverage 1 / 1 (`focus-web-mobile-browser-cache-20260616`).
- 2026-06-16 final local gates for this patch set passed: `git diff --check`, `npm run lint`, targeted ESLint for touched TS/E2E files with `--max-warnings=0`, `npx vitest run src/__tests__/renderer/components/PromptComposerModal.test.tsx` (94 / 94), `npm run build:main`, `npm run build:renderer`, and `npm run build:web`. Renderer/web builds still emit existing Browserslist, chunk-size, and CSS minifier warnings.
- 2026-06-16 01:34 EDT focused wizard/settings/prompts stabilization passed: direct Playwright run `wsp-smoke6-20260616013314` covered `WSP-002|WSP-005|WSP-011|WSP-022|WSP-041|WSP-062|WSP-068|WSP-069` with `--workers=1`, isolated `HOME`, isolated `MAESTRO_DATA_DIR`, `PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright`, `PLAYWRIGHT_HTML_REPORT=playwright-report/wsp-smoke6-20260616013314`, `VITE_PORT=41748`, and `--output=e2e-results/wsp-smoke6-20260616013314`; result: 8 / 8 passed. This locks in inline wizard state hydration, current Prompt Composer literal `@` behavior outside group chat, Settings toolbar scoping, Shell Configuration expansion for global env vars, invalid env-var validation retention, and env-var removal.
- 2026-06-16 01:34 EDT verification after the WSP stabilization passed: `npm run build:renderer` (`/tmp/maestro-build-renderer-envvars-20260616013252.log`, existing CSS/chunk warnings only), `npm run lint` (`/tmp/maestro-lint-ts-20260616013358.log`), targeted ESLint for `src/renderer/hooks/batch/useInlineWizard.ts`, `src/renderer/hooks/wizard/useWizardHandlers.ts`, `src/renderer/components/Settings/EnvVarsEditor.tsx`, and `e2e/wizard-settings-prompts.spec.ts` (`/tmp/maestro-eslint-targeted-20260616013412.log`), and `npx vitest run src/__tests__/renderer/hooks/useWizardHandlers.test.ts` (`/tmp/maestro-usewizardhandlers-test-20260616014346.log`, 103 / 103 passed).
- 2026-06-16 01:52 EDT full push gate passed: `npm run validate:push` (`/tmp/maestro-validate-push-shell-20260616014850.log`) completed `build:prompts`, `format:check:all`, `npm run lint`, `npm run lint:eslint`, and the full Vitest suite; result: 730 test files passed, 1 skipped; 28,573 tests passed, 106 skipped.
- 2026-06-16 01:34 EDT mailer check: the three-hour cron entry remains active at `0 */3 * * * /Users/jeffscottward/.codex/scripts/maestro-e2e-status-email.mjs >> /Users/jeffscottward/.codex/log/maestro-e2e-status-email.log 2>&1`.
- 2026-06-16 02:52 EDT focused wizard/settings/prompts stabilization passed after rebuilding the renderer for the wizard remote-command wiring fix: direct Playwright run `wsp-focused5-20260616025007` covered `WSP-054|WSP-070|WSP-160|WSP-164|WSP-118|WSP-119|WSP-120|WSP-121|WSP-122|WSP-123|WSP-124|WSP-125|WSP-192|WSP-193|WSP-194|WSP-195|WSP-196|WSP-197|WSP-198|WSP-199|WSP-200|WSP-201|WSP-225|WSP-226|WSP-227|WSP-228|WSP-229|WSP-230|WSP-231|WSP-232|WSP-233|WSP-234|WSP-235|WSP-236|WSP-237|WSP-238|WSP-239|WSP-240|WSP-305|WSP-306|WSP-364|WSP-365|WSP-366|WSP-367|WSP-368|WSP-369` with `--workers=1`, isolated `HOME`, isolated `MAESTRO_DATA_DIR`, `PLAYWRIGHT_BROWSERS_PATH=/Users/jeffscottward/Library/Caches/ms-playwright`, `PLAYWRIGHT_HTML_REPORT=playwright-report/wsp-focused5-20260616025007`, `VITE_PORT=41763`, and `--output=e2e-results/wsp-focused5-20260616025007`; result: 46 / 46 passed. This locks in Codex customization heading drift, SSH remote Settings tab routing/default badge targeting, range input React-state commits, native select option assertions, custom model blur persistence, and wizard remote-command rendering for SSH locations.
- 2026-06-16 02:52 EDT mailer check: the three-hour cron entry remains active at `0 */3 * * * /Users/jeffscottward/.codex/scripts/maestro-e2e-status-email.mjs >> /Users/jeffscottward/.codex/log/maestro-e2e-status-email.log 2>&1`.
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

The documentation and matrix are centralized, the bucket branch is rebased, stale E2E worktrees are pruned, and Phase 4 sharded execution has completed but failed. Rebuilding shared artifacts is now allowed because both PM2 shards have stopped. The next high-value work is to continue reducing the 536 failed shard results by largest remaining failure clusters, starting with broader wizard/settings/prompts reruns after the focused WSP fixes above, then stats/graph/Symphony and any web/mobile residuals not already covered by the browser-cache focused pass.

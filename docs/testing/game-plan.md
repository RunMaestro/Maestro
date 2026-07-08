# Testing Campaign Game Plan

Last updated: 2026-06-19 23:45 EDT.

This plan covers branch hygiene, coverage audit work, and full E2E execution for the `codex/full-e2e-coverage-campaign` branch. Phases 1-6 reached a green pre-upstream-sync checkpoint. Phase 7 is now active because syncing `upstream/main` into the branch invalidated the prior finality proof.

Reporting cadence: do not send routine progress emails during Phase 7. Email only after major completion milestones, roughly 6+ hour work blocks or gates such as unit coverage complete, full integration complete, full E2E complete, or final branch handoff. The local Phase 6 status mailer has no recurring cron entry and requires explicit `--milestone` plus `--milestone-hours >= 6` before sending. The legacy E2E and coverage mailers use the same guard for real sends, and the old scheduled-task wrapper now delegates to the milestone-gated E2E reporter.

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
- A fresh 2026-06-19 rebase attempt against `upstream/main` at `873a89137` started replaying 588 historical campaign commits and conflicted in old setup-hook/package commits, so it was aborted. The branch was then synced by merging `upstream/main`; merge commit `bcbe9a479` makes current `upstream/main` an ancestor of the campaign branch while preserving the upstream-shaped overlay strategy.
- The upstream-shaped tree passed `npm run validate:push` through format, TypeScript, ESLint, and unit execution.
- The current broad unit suite now passes with 1,247 files, 33,609 tests, and 0 skipped reported in the latest non-coverage and coverage runs after removing stale skip blocks, removing one optional native-SQLite skip path, replaying compatible restored unit files from the green backup, adapting current-upstream unit suites, merging the upstream queued-image thumbnail/carousel commit, adding queued thumbnail/lightbox unit coverage, expanding `tabHelpers.ts` browser/terminal unified-history coverage, expanding `LeaderboardRegistrationModal` registration/confirmation/token/sync coverage, adding focused 100% coverage for eight small CLI connectivity commands, expanding `FeedbackChatView` conversation/matching/submission coverage, and expanding `useRemoteIntegration` remote event/settings/git/Cue/gist bridge coverage.
- Focused restored integration tranches are green again: web-server/main integration is 5 files and 98 tests passed, and mobile integration is 10 files and 145 tests passed.
- Broad deterministic integration restoration is now green when the live provider probe is excluded: 534 files and 12,509 tests passed. Current local counts under the broad integration-file matcher show 32 tracked files, 536 working-tree files, and 540 files preserved on `backup/full-e2e-coverage-campaign-119a0997b`.
- Live provider integration is still blocked: `provider-integration.test.ts` fails on the first Claude Code live call because the provider result is not considered successful.
- The restored App/main/unit tranche is green with 5 files and 56 tests passed after adapting current-behavior App and main-process entrypoint coverage.
- Deterministic web/mobile integration coverage wrappers are green with 15 files and 246 tests passed after message-handler and web-server factory marketplace callback restoration.
- The DocumentGraph renderer suite is green with 12 files and 634 tests passed after adding behavior coverage for `DocumentGraphView`; the focused `DocumentGraphView.test.tsx` file now passes 183 tests after adding live progress, backlink update, preview-history, search Escape, context-menu, and load-more failure coverage.
- `npm run test:coverage` on the current upstream-shaped tree still fails the enforced 100% thresholds after the Claude handler edge tranche, FilePreview navigation/search/save/callback/search-adapter/clipboard/modal/editor-keyboard/markdown/scroll-sync/edge-format/helper tranche, isolated mobile panel tranche, mobile sheet tranche, expanded `LeftPanel` tranche, expanded `AutoRunInline` workflow/error-path tranche, mobile App AutoRun/group-chat/right-panel callback tranche, messageHandlers callback-failure/API-validation plus notification/marketplace/tab/session/Auto Run/Cue tranche, TerminalOutput tool/recovery tranche plus unreachable terminal-branch cleanup, DocumentGraphView live-behavior tranche, settingsStore direct-setter/non-React action-helper tranche, main-process context handler tranche, CLI entrypoint tranche, agents IPC handler tranche, App shell tranche, expanded `useInputProcessing` workflow/edge tranche, expanded Auto Run IPC handler tranches, group-chat router timeout/auto-add lifecycle tranche, Symphony registry/star-count/issue-count/PR-discovery tranche, queued thumbnail/lightbox tranche, `tabHelpers.ts` browser/terminal unified-history tranche, expanded `LeaderboardRegistrationModal` workflow tranche, CLI connectivity command tranche, expanded `FeedbackChatView` conversation/matching/submission tranche, and expanded `useRemoteIntegration` bridge/async response tranche with 81.88% statements, 74.67% branches, 80.69% functions, and 83.19% lines. The run itself is test-clean with 1,247 files passed, 33,609 tests passed, 0 skipped reported, and fails only the coverage thresholds. Log: `/tmp/maestro-unit-coverage-202606192341.log`.
- Restored/adapted focused coverage now includes `DocumentGraph/MindMap.test.ts` at 13 tests passed, `DocumentGraphView.test.tsx` at 183 tests passed, `agentSessions.test.ts` at 26 tests passed, `ImageAnnotator/AnnotatorCanvas.test.tsx` at 5 tests passed, `maestro-p/index.test.ts` at 7 tests passed, `TerminalOutput.test.tsx` at 126 tests passed, `TerminalOutput.integration.test.tsx` at 16 tests passed, `FilePreview.test.tsx` at 137 tests passed, `web-server-factory.test.ts` at 91 tests passed, `messageHandlers.test.ts` at 225 tests passed, `useMainKeyboardHandler.test.ts` at 119 tests passed, `WebServer.test.ts` at 8 tests passed, `web/mobile/App.test.tsx` at 103 tests passed, `claude.test.ts` at 89 tests passed, `AchievementsPanel.test.tsx` at 3 tests passed, `CuePanel.test.tsx` at 3 tests passed, `UsageDashboardPanel.test.tsx` at 3 tests passed, `GroupChatPanel.test.tsx` at 3 tests passed, `GitDiffViewer.test.tsx` at 2 tests passed, `AgentCreationSheet.test.tsx` at 3 tests passed, `GroupChatSetupSheet.test.tsx` at 3 tests passed, `NotificationSettingsSheet.test.tsx` at 3 tests passed, `LeftPanel.test.tsx` at 7 tests passed, `AutoRunInline.test.tsx` at 20 tests passed, `settingsStore.test.ts` at 215 tests passed, `maestro-cli-manager.test.ts` at 6 tests passed, `context.test.ts` at 28 tests passed with focused 100% context handler coverage, `cli/index.test.ts` at 4 tests passed with focused 100% `src/cli/index.ts` coverage, `agents.test.ts` at 155 tests passed with focused 100% `src/main/ipc/handlers/agents.ts` coverage, `App.test.tsx` at 25 tests passed, `useInputProcessing.test.ts` at 104 tests passed with 100% statements/functions/lines and 92.71% branches for `useInputProcessing.ts`, `group-chat-router.test.ts` at 75 tests passed with focused `group-chat-router.ts` coverage of 73.09% statements, 62.43% branches, 79.03% functions, and 74.29% lines, `symphony.test.ts` at 228 tests passed with focused `symphony.ts` coverage of 88.60% statements, 78.70% branches, 93.33% functions, and 88.48% lines, `QueuedItemsList.test.tsx` at 9 tests passed with queued thumbnail expansion plus shared lightbox callback coverage, `tabHelpers.test.ts` at 269 tests passed with focused `tabHelpers.ts` coverage of 80.71% statements, 74.91% branches, 83.50% functions, and 81.30% lines, `LeaderboardRegistrationModal.test.tsx` at 52 tests passed with focused `LeaderboardRegistrationModal.tsx` coverage of 98.72% statements, 89.16% branches, 100% functions, and 100% lines, `connectivity-commands.test.ts` at 45 tests passed with focused 100% coverage for `open-terminal.ts`, `refresh-files.ts`, `refresh-auto-run.ts`, `status.ts`, `open-browser.ts`, `notify-flash.ts`, `notify-toast.ts`, and `prompts-get.ts`, `FeedbackChatView.test.tsx` at 12 tests passed with focused `FeedbackChatView.tsx` coverage of 83.51% statements, 71.88% branches, 76.12% functions, and 86.75% lines, and `useRemoteIntegration.test.ts` at 42 tests passed with focused `useRemoteIntegration.ts` coverage of 87.04% statements, 62.01% branches, 90.38% functions, and 89.74% lines.
- Focused `autorun.ts` coverage improved after the Auto Run IPC handler tranche: `autorun.test.ts` now passes 139 tests, and focused coverage is 97.93% statements, 90.71% branches, 100% functions, and 97.89% lines. `autorun.ts` remains a unit-coverage gap until it reaches 100% across all enforced categories.
- `useMainKeyboardHandler.ts` is still not complete, but its missed coverage counter dropped from 608 to 354 after the latest shortcut branch tranche.
- `web-server-factory.ts` dropped from 881 missed counters to 458 after the timeout/fallback tranche.
- `messageHandlers.ts` dropped to 246 branch-aware missed counters and 0 missed functions after the Auto Run parity, session/group/git, group-chat/context, dashboard/director validation, unconfigured-callback, validation, callback-failure/API-validation, notification/marketplace, tab/session, Auto Run success, and Cue success tranches.
- `FilePreview.tsx` dropped from 608 missed counters to 101 statement/branch/function missed counters after the navigation/search/save, callback/search-adapter/clipboard/modal/editor-keyboard, markdown/scroll-sync, edge-format, and helper cleanup tranches.
- Focused `FilePreview.tsx` coverage after the helper/scroll-sync tranche is 96.73% statements, 88.54% branches, 100% functions, and 98.45% lines with 137 tests passed. Logs: `/tmp/maestro-filepreview-focused-scrollbranches2-20260618223444.log` and `/tmp/maestro-filepreview-coverage-scrollbranches-20260618223454.log`.
- `TerminalOutput.tsx` dropped to 179 missed counters after the tool-detail, completed-output, session-recovery tranche, and removal of unreachable terminal-specific rendering branches from the AI-mode `TerminalOutput` surface.
- `DocumentGraphView.tsx` dropped from 480 missed counters to 303 after the live-behavior tranche.
- `agents.ts` is complete after the remote SSH/OpenCode/config/snapshot/usage bridge tranche: focused coverage is 100% statements, branches, functions, and lines with 155 tests passed.
- The current top remaining coverage gaps after the fresh broad coverage run are `main/index.ts`, `web/mobile/App.tsx`, `MainPanel.tsx`, `useMainKeyboardHandler.ts`, `web-server-factory.ts`, `TerminalOutput.tsx`, `useAppRemoteEventListeners.ts`, `claude-session-storage.ts`, `SessionList.tsx`, `group-chat-router.ts`, `DocumentGraphView.tsx`, `XTerminal.tsx`, `git.ts`, and `settingsStore.ts`.
- `useRemoteIntegration.ts` dropped out of the top 20 missed-counter list after the remote bridge tranche, but still needs follow-up to reach 100% thresholds.
- `tabHelpers.ts` dropped out of the top 25 missed-counter list after the browser/terminal unified-history tranche.
- `settingsStore.ts` dropped from 473 missed counters to 294 after the direct-setter and non-React action-helper tranche, and `getSettingsActions()` now exposes the newer settings actions.
- `LeftPanel.tsx` dropped from 413 missed counters to 218 after the expanded web/mobile side-panel tranche.
- `WebServer.ts` is almost complete after the delegation tranche: its missed coverage counter dropped from 311 to 16.
- `src/cli/index.ts` is complete after the command-tree/wrapper-action tranche: its missed coverage counter dropped from 115 statements, 23 functions, and 2 branches to 0 across all categories.
- Next work:
  - restore 100% unit coverage with current-upstream-compatible tests, continuing through the top uncovered files (`main/index.ts`, `web/mobile/App.tsx`, `MainPanel.tsx`, `useMainKeyboardHandler.ts`, `web-server-factory.ts`, `TerminalOutput.tsx`, `useAppRemoteEventListeners.ts`, `claude-session-storage.ts`, `SessionList.tsx`, `group-chat-router.ts`, `DocumentGraphView.tsx`, `XTerminal.tsx`, `git.ts`, and `settingsStore.ts`),
  - classify the remaining live provider integration gate and rerun it with configured providers/SSH if it remains in final deterministic scope,
  - rerun full E2E shards with 0 failures and 0 skips,
  - update this plan and [current-status.md](current-status.md) with final evidence.

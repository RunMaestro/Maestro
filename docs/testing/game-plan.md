# Testing Campaign Game Plan

Last updated: 2026-06-18 19:34 EDT.

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
- The upstream-shaped tree passed `npm run validate:push` through format, TypeScript, ESLint, and unit execution.
- The current broad unit suite now passes with 1,246 files, 33,233 tests, and 0 skipped in the latest coverage run after removing stale skip blocks, removing one optional native-SQLite skip path, replaying compatible restored unit files from the green backup, and adapting current-upstream unit suites.
- Focused restored integration tranches are green again: web-server/main integration is 5 files and 98 tests passed, and mobile integration is 10 files and 145 tests passed.
- Full integration restoration is not complete yet: current local counts under the integration-file matcher show 36 tracked files, 36 working-tree files, and 543 files preserved on `backup/full-e2e-coverage-campaign-119a0997b`.
- The restored App/main/unit tranche is green with 5 files and 56 tests passed after adapting current-behavior App and main-process entrypoint coverage.
- Deterministic web/mobile integration coverage wrappers are green with 15 files and 246 tests passed after message-handler and web-server factory marketplace callback restoration.
- The DocumentGraph renderer suite is green with 12 files and 634 tests passed after adding behavior coverage for `DocumentGraphView`; the focused `DocumentGraphView.test.tsx` file now passes 183 tests after adding live progress, backlink update, preview-history, search Escape, context-menu, and load-more failure coverage.
- `npm run test:coverage` on the current upstream-shaped tree still fails the enforced 100% thresholds after the Claude handler edge tranche, FilePreview navigation/search/save tranche, isolated mobile panel tranche, mobile sheet tranche, expanded `LeftPanel` tranche, expanded `AutoRunInline` workflow/error-path tranche, mobile App AutoRun/group-chat/right-panel callback tranche, messageHandlers callback-failure/API-validation tranche, TerminalOutput tool/recovery tranche, DocumentGraphView live-behavior tranche, settingsStore direct-setter/non-React action-helper tranche, main-process context handler tranche, and CLI entrypoint tranche with 80.26% statements, 72.92% branches, 79.37% functions, and 81.55% lines. The run itself is test-clean and fails only the coverage thresholds.
- Restored/adapted focused coverage now includes `DocumentGraph/MindMap.test.ts` at 13 tests passed, `DocumentGraphView.test.tsx` at 183 tests passed, `agentSessions.test.ts` at 26 tests passed, `ImageAnnotator/AnnotatorCanvas.test.tsx` at 5 tests passed, `maestro-p/index.test.ts` at 7 tests passed, `TerminalOutput.test.tsx` at 126 tests passed, `TerminalOutput.integration.test.tsx` at 16 tests passed, `FilePreview.test.tsx` at 103 tests passed, `web-server-factory.test.ts` at 91 tests passed, `messageHandlers.test.ts` at 214 tests passed, `useMainKeyboardHandler.test.ts` at 119 tests passed, `WebServer.test.ts` at 8 tests passed, `web/mobile/App.test.tsx` at 103 tests passed, `claude.test.ts` at 89 tests passed, `AchievementsPanel.test.tsx` at 3 tests passed, `CuePanel.test.tsx` at 3 tests passed, `UsageDashboardPanel.test.tsx` at 3 tests passed, `GroupChatPanel.test.tsx` at 3 tests passed, `GitDiffViewer.test.tsx` at 2 tests passed, `AgentCreationSheet.test.tsx` at 3 tests passed, `GroupChatSetupSheet.test.tsx` at 3 tests passed, `NotificationSettingsSheet.test.tsx` at 3 tests passed, `LeftPanel.test.tsx` at 7 tests passed, `AutoRunInline.test.tsx` at 20 tests passed, `settingsStore.test.ts` at 215 tests passed, `maestro-cli-manager.test.ts` at 6 tests passed, `context.test.ts` at 28 tests passed with focused 100% context handler coverage, and `cli/index.test.ts` at 4 tests passed with focused 100% `src/cli/index.ts` coverage.
- `useMainKeyboardHandler.ts` is still not complete, but its missed coverage counter dropped from 608 to 354 after the latest shortcut branch tranche.
- `web-server-factory.ts` dropped from 881 missed counters to 458 after the timeout/fallback tranche.
- `messageHandlers.ts` dropped to 421 missed counters after the Auto Run parity, session/group/git, group-chat/context, dashboard/director validation, unconfigured-callback, validation, and callback-failure/API-validation tranches.
- `FilePreview.tsx` dropped from 608 missed counters to 413 after the navigation/search/save tranche.
- `TerminalOutput.tsx` dropped to 452 missed counters after the tool-detail, completed-output, and session-recovery tranche.
- `DocumentGraphView.tsx` dropped from 480 missed counters to 303 after the live-behavior tranche.
- `AchievementsPanel.tsx`, `CuePanel.tsx`, `UsageDashboardPanel.tsx`, `GroupChatPanel.tsx`, `GitDiffViewer.tsx`, `AgentCreationSheet.tsx`, `GroupChatSetupSheet.tsx`, `NotificationSettingsSheet.tsx`, `AutoRunInline.tsx`, `web/mobile/App.tsx`, and `context.ts` are improved after the isolated mobile panel/sheet/inline/App callback and context handler tranches; the current top remaining coverage gaps are `messageHandlers.ts`, `agents.ts`, `group-chat-router.ts`, `main/index.ts`, `symphony.ts`, `renderer/App.tsx`, `claude-session-storage.ts`, `TerminalOutput.tsx`, `FilePreview.tsx`, and `autorun.ts`.
- `settingsStore.ts` dropped from 473 missed counters to 294 after the direct-setter and non-React action-helper tranche, and `getSettingsActions()` now exposes the newer settings actions.
- `LeftPanel.tsx` dropped from 413 missed counters to 218 after the expanded web/mobile side-panel tranche.
- `WebServer.ts` is almost complete after the delegation tranche: its missed coverage counter dropped from 311 to 16.
- `src/cli/index.ts` is complete after the command-tree/wrapper-action tranche: its missed coverage counter dropped from 115 statements, 23 functions, and 2 branches to 0 across all categories.
- Next work:
  - restore 100% unit coverage with current-upstream-compatible tests, continuing through the top uncovered files (`messageHandlers.ts`, `agents.ts`, `group-chat-router.ts`, `main/index.ts`, `symphony.ts`, `renderer/App.tsx`, `claude-session-storage.ts`, `TerminalOutput.tsx`, `FilePreview.tsx`, and `autorun.ts`),
  - restore/port the missing pre-sync integration suite from `backup/full-e2e-coverage-campaign-119a0997b`,
  - rerun full integration with SSH and 0 skips,
  - rerun full E2E shards with 0 failures and 0 skips,
  - update this plan and [current-status.md](current-status.md) with final evidence.

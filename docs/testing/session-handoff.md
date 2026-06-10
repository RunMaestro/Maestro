# Full Test Coverage Session Handoff

Historical handoff. Use `docs/testing/current-status.md` for the current source of truth, then use this file only for older campaign context.

Last updated: 2026-05-21

## How To Resume In A New Trusted-Hooks Session

The active goal in the old Codex thread is a compressed summary. It captures the
mission, but it does not contain every operational rule from the original
campaign prompt. Use this file plus `docs/testing/prompts/full-test-coverage-campaign.md`
as the handoff.

Start the new Codex session from the repository and trust hooks when prompted:

```bash
cd /Users/jeffscottward/Github/tools/Maestro
```

Paste this prompt into the new session:

```text
Continue the Maestro full test coverage campaign in /Users/jeffscottward/Github/tools/Maestro on branch full-test-coverage.

Read these files first:
- docs/testing/prompts/full-test-coverage-campaign.md
- docs/testing/audits/test-coverage-audit.md
- docs/testing/session-handoff.md

Treat docs/testing/prompts/full-test-coverage-campaign.md as the canonical original prompt. Preserve unrelated dirty/untracked files. Do not commit unless explicitly instructed. Do not add or widen coverage exclusions without explicit approval except generated, type-only, or pure barrel files. Keep tests meaningful, update the audit after each checkpoint, and run targeted tests plus broader validation before moving on.

Current first action:
1. Run git status --short --branch.
2. Confirm the "Upstream Sync Recovery Checkpoint" in docs/testing/audits/test-coverage-audit.md is present.
3. Continue from the post-sync unit-coverage state. Unit coverage is at 100% with thresholds enabled after merging upstream/main.
4. Do not start integration or E2E unless the user explicitly approves that next phase.
```

## Current State

Repository:

- Path: `/Users/jeffscottward/Github/tools/Maestro`
- Branch: `full-test-coverage`
- Do not assume the worktree is clean. It contains many existing modified and
  untracked files from this campaign and possibly unrelated user work.
- User authorized commits for the upstream sync checkpoint.
- Pre-sync checkpoint commit: `ec5bce785 test: reach full coverage checkpoint`.
- Upstream merge commit: `c1f56704f merge upstream main into coverage branch`.
- Post-sync repair validation is green for the current checkpoint; check
  `git log --oneline -3` for the latest checkpoint commit.

Canonical prompt:

- `docs/testing/prompts/full-test-coverage-campaign.md` contains the original campaign
  prompt in repo-local form.
- `docs/testing/audits/test-coverage-audit.md` is the running audit.

Latest full coverage run:

- Command: `npm run test:coverage`
- Result: passed
- Thresholds: global 100% statements, branches, functions, and lines enforced in `vitest.config.mts`
- Coverage:
  - Statements: 100% (63,667/63,667)
  - Branches: 100% (44,693/44,693)
  - Functions: 100% (13,680/13,680)
  - Lines: 100% (59,568/59,568)

Post-upstream sync status:

- `upstream/main` from `https://github.com/RunMaestro/Maestro` has been merged
  into `full-test-coverage` with no conflicts.
- Unit coverage has been restored to 100% after the merge.
- Formatting, lint, ESLint, full unit test, and full unit coverage validation are green.
- A first post-sync test-signal cleanup slice removed `act(...)` warnings from
  `useWorktreeValidation.test.ts`, `ProcessMonitor.test.tsx`, and
  `AutoRun.test.tsx` in isolation while keeping 100% coverage green.
- A second cleanup slice removed `useBatchProcessor.test.ts` stdout leakage and
  React `act(...)` warnings in isolation; full unit coverage remains at 100%.
- A third cleanup slice removed `UpdateCheckModal.test.tsx` React `act(...)`
  warnings in isolation; full unit coverage remains at 100%.
- A fourth cleanup slice removed `WizardIntegration.test.tsx` missing-session
  mock stderr, expected error-path logs, and React `act(...)` warnings in
  isolation; full unit coverage remains at 100%.
- A fifth cleanup slice removed `session-storage.test.ts` storage logger output
  in isolation by suppressing and verifying expected storage-layer `info`,
  `warn`, and `error` messages; full unit coverage remains at 100%.
- A sixth cleanup slice removed `AutoRunBlurSaveTiming.test.tsx` React
  `act(...)` warnings in isolation by wrapping edit/save/key/rerender flows in
  local `act` helpers; full unit coverage remains at 100%.
- A seventh cleanup slice removed `AutoRunContentSync.test.tsx` and
  `AutoRunSessionIsolation.test.tsx` React `act(...)` warnings in isolation by
  keeping unrelated token/image async work pending and wrapping async save
  clicks in `act`; full unit coverage remains at 100%.
- An eighth cleanup slice removed `WizardThemeStyles.test.tsx` React
  `act(...)` warnings in isolation by using React Testing Library `waitFor`
  for wizard async updates and waiting for resume-modal validation to settle;
  full unit coverage remains at 100%.
- A ninth cleanup slice removed `useSummarizeHandler.test.ts` React `act(...)`
  warnings in isolation by using React Testing Library `waitFor`, wrapping
  direct `startSummarize()` calls in `act`, and wrapping operation-store state
  seeding for cancellation coverage; full unit coverage remains at 100%.
- A tenth cleanup slice removed `useMergeSession.test.ts` React `act(...)`
  warnings in isolation by wrapping long-running merge launch points in `act`
  for concurrent-merge and cancel-merge coverage; full unit coverage remains
  at 100%.
- A latest cleanup slice removed `HistoryPanel.test.tsx` expected TanStack
  Virtual smooth-scroll stderr output in isolation by suppressing and verifying
  only the known dynamic-size smooth-scroll warning; full unit coverage remains
  at 100%.
- A latest cleanup slice removed `LeaderboardRegistrationModal.test.tsx`
  manual-token fallback `act(...)` warnings in isolation and stabilized two
  `ProcessMonitor.test.tsx` assertions that raced the post-load expand-all
  effect during full-suite runs; full unit coverage remains at 100%.
- Integration and E2E have not been started after the sync checkpoint per user instruction.
- Remaining near-term work is to continue unit-test signal cleanup, likely
  App shell tests, AgentSessionsModal, batch reducer failure-path tests,
  DocumentGraphView, WorktreeRunSection, or explicitly approve the next
  integration/E2E phase.

## Latest Completed Checkpoints

The latest checkpoints have been recorded in `docs/testing/audits/test-coverage-audit.md`.

Completed after the old filesystem handoff:

- Tab export exhaustive source helpers:
  `src/renderer/utils/tabExport.ts` reached 100.00% statements, branches,
  functions, and lines after removing unreachable exhaustive switch defaults.
- Web notifications missing storage fallback:
  `src/web/hooks/useNotifications.ts` reached 100.00% statements, branches,
  functions, and lines through a storage-unavailable hook test.
- Web unread badge missing storage fallback:
  `src/web/hooks/useUnreadBadge.ts` reached 100.00% statements, branches,
  functions, and lines through a storage-unavailable load/save hook test.
- Settings lifecycle bridge optionality:
  `src/renderer/hooks/settings/useSettings.ts` reached 100.00% statements,
  branches, functions, and lines through optional bridge callback and external
  change listener tests.
- Wizard filler phrase queues:
  `src/renderer/components/Wizard/services/fillerPhrases.ts` reached 100.00%
  statements, branches, functions, and lines through direct queue exhaustion and
  reshuffle tests.
- Session CRUD error and sync branches:
  `src/renderer/hooks/session/useSessionCrud.ts` reached 100.00% statements,
  branches, functions, and lines through creation failure, worktree group
  deletion recovery, removed path updater, and provider-name-sync tests.
- Auto Run undo sparse history branches:
  `src/renderer/hooks/batch/useAutoRunUndo.ts` reached 100.00% statements,
  branches, functions, and lines through sparse undo/redo stack handling and
  missing-textarea redo cursor restoration tests.
- Context usage token fallbacks:
  `src/renderer/utils/contextUsage.ts` reached 100.00% statements, branches,
  functions, and lines through Codex missing-token, unknown-agent window, and
  zero-token display tests.
- Input key down dropdown edge branches:
  `src/renderer/hooks/input/useInputKeyDown.ts` reached 100.00% statements,
  branches, functions, and lines through tab completion, @ mention, and slash
  command dropdown edge-case tests.
- Tab export handler blank context branches:
  `src/renderer/hooks/tabs/useTabExportHandlers.ts` reached 100.00%
  statements, branches, functions, and lines through blank formatted
  copy/publish warning paths and the missing-theme export guard.
- Offline queue retry and resume branches:
  `src/web/hooks/useOfflineQueue.ts` reached 100.00% statements, branches,
  functions, and lines through thrown-command retry coverage, in-flight resume
  coverage, and removal of a stale mid-loop connection check.
- Group management updater preservation branches:
  `src/renderer/hooks/session/useGroupManagement.ts` reached 100.00%
  statements, branches, functions, and lines by exercising updater branches that
  preserve non-target groups and sessions.
- Activity bus listener lifecycle:
  `src/renderer/utils/activityBus.ts` reached 100.00% statements, branches,
  functions, and lines through direct listener lifecycle and subscriber tests.
- Live overlay tunnel error and reset paths:
  `src/renderer/hooks/remote/useLiveOverlay.ts` reached 100.00% statements,
  branches, functions, and lines through copy flash, click-outside, tunnel
  error, stop failure, no-op, and live-mode reset tests.
- Shell detector Windows command mapping:
  `src/main/utils/shellDetector.ts` reached 100.00% statements, branches,
  functions, and lines through direct Windows command mapping tests.
- Batch reducer state machine cleanup:
  `src/renderer/hooks/batch/batchReducer.ts` reached 100.00% statements,
  branches, functions, and lines through optional progress field, guard,
  paused-error abort, and finalization-path tests, plus removal of unreachable
  reducer-private transition event builders.
- Wizard prompt continuation and fallback parsing:
  `src/renderer/components/Wizard/services/wizardPrompts.ts` reached 100.00%
  statements, branches, functions, and lines through existing-document
  continuation prompt, parsed-null validation, and out-of-range fallback
  confidence tests.
- Stats cache IO helpers:
  `src/main/utils/statsCache.ts` reached 100.00% statements, branches,
  functions, and lines through project/global path, load, stale-version,
  unreadable-cache, save, and save-failure logging tests.
- Session filter mode preference fallbacks:
  `src/renderer/hooks/session/useSessionFilterMode.ts` reached 100.00%
  statements, branches, functions, and lines after simplifying unreachable
  save-on-open guards and testing late-added groups plus unavailable bookmark
  preference fallback behavior.
- Long press defensive gesture branches:
  `src/web/hooks/useLongPress.ts` reached 100.00% statements, branches,
  functions, and lines through no-element long-press/context-menu coverage,
  below-threshold movement coverage, and the pending-timer scroll guard.
- Document processor expansion and synopsis branches:
  `src/renderer/hooks/batch/useDocumentProcessor.ts` reached 100.00%
  statements, branches, functions, and lines through direct document read,
  template expansion, spawn/registration, synopsis extraction, and failure
  summary tests, plus removal of an unreachable first-paragraph fallback.
- App initialization startup guard branches:
  `src/renderer/hooks/ui/useAppInitialization.ts` reached 100.00% statements,
  branches, functions, and lines through splash callback absence, Windows
  warning once-only guard, leaderboard no-data response, and longest-run
  fallback tests.
- Cycle session worktree and group chat branches:
  `src/renderer/hooks/session/useCycleSession.ts` reached 100.00% statements,
  branches, functions, and lines through bookmark sorting, worktree child name
  fallback, stale group-chat cycle-position recovery, and removal of an
  unreachable local helper guard.
- Remark file links AST guard and inline filename branches:
  `src/renderer/utils/remarkFileLinks.ts` reached 100.00% statements,
  branches, functions, and lines through malformed root-level text/inline-code
  AST guard coverage, plus removal of unreachable project-root and inline
  filename fallback branches.
- Markdown link parser private path branches:
  `src/renderer/utils/markdownLinkParser.ts` reached 100.00% statements,
  branches, functions, and lines through a dot-only path boundary test, plus
  removal of unreachable private helper guards.
- Worktree manager setup and PR branches:
  `src/renderer/hooks/batch/useWorktreeManager.ts` reached 100.00% statements,
  branches, functions, and lines through direct setup, checkout, PR creation,
  default branch, commit-log, and error-path tests.
- Keyboard visibility viewport event branches:
  `src/web/hooks/useKeyboardVisibility.ts` reached 100.00% statements,
  branches, functions, and lines through viewport resize, scroll hidden,
  scroll visible, and missing-viewport event tests, plus removal of redundant
  effect-only server guards.
- File preview markdown image branches:
  `src/renderer/components/FilePreview.tsx` moved to 55.07% statements,
  51.87% branches, 62.10% functions, and 55.76% lines through markdown image
  tests for empty sources, data URLs, remote blocking/toggle, local filesystem
  loading with `sshRemoteId`, cache reuse, image load dimensions, and invalid
  or rejected local image data.
- Document graph rendered state branches:
  `src/renderer/components/DocumentGraph/DocumentGraphView.tsx` moved to
  61.52% statements, 51.67% branches, 34.42% functions, and 62.63% lines
  through rendered tests for graph loading, watcher setup, cached external link
  toggling, selected document stats/tasks, in-graph preview file-tree data,
  preview link navigation, load-more pagination, SSH remote propagation, and
  error retry.
- File preview metadata save clipboard branches:
  `src/renderer/components/FilePreview.tsx` moved to 58.29% statements,
  55.88% branches, 66.94% functions, and 59.19% lines through tests for
  file stat/token success, stat/token fallbacks, save success/failure, path copy
  success, and text-content copy failure.
- File preview image clipboard branches:
  `src/renderer/components/FilePreview.tsx` moved to 59.56% statements,
  56.57% branches, 66.94% functions, and 60.54% lines through tests for image
  blob clipboard copy, blob-copy fallback to data URL, and image fetch plus data
  URL fallback failure.
- FilePreview markdown image and file-tree branches:
  `src/renderer/components/FilePreview.tsx` moved to 59.79% statements,
  57.68% branches, 66.94% functions, and 60.78% lines through tests for empty
  alt markdown images, `http://` remote image toggling, absolute local markdown
  image loading, and file-tree/cwd `remarkFileLinks` plugin wiring.
- FilePreview code search navigation branches:
  `src/renderer/components/FilePreview.tsx` moved to 62.56% statements,
  58.78% branches, 68.55% functions, and 63.73% lines through a rendered
  code-preview search test that verifies initial match highlighting, next-match
  navigation, and previous-match navigation.
- FilePreview clipboard outcome branches:
  `src/renderer/components/FilePreview.tsx` moved to 62.56% statements,
  59.34% branches, 68.55% functions, and 63.73% lines through tests for failed
  path copy, successful text copy, failed image data URL fallback after blob
  copy failure, and successful image data URL fallback after image fetch failure.
- FilePreview navigation history branches:
  `src/renderer/components/FilePreview.tsx` moved to 64.52% statements,
  61.96% branches, 74.19% functions, and 65.56% lines through rendered tests for
  back/forward controls, history popups, selected history-index navigation, and
  pending popup-close timer clearing.
- FilePreview edit-mode search branches:
  `src/renderer/components/FilePreview.tsx` moved to 67.17% statements,
  63.49% branches, 74.19% functions, and 68.38% lines through rendered tests for
  no-match edit-mode search, multiple edit-mode matches, and next-match
  navigation selecting the active textarea match.
- MindMap conversion and canvas interaction branches:
  `src/renderer/components/DocumentGraph/MindMap.tsx` moved to 82.07%
  statements, 62.01% branches, 85.96% functions, and 84.03% lines through
  tests for graph-to-mind-map conversion, duplicate nodes and links, fallback
  labels/previews, canvas rendering with a mocked 2D context, focused document
  actions, node dragging, context menus, background panning, and wheel zoom.
- Codex session storage legacy and search branches:
  `src/main/storage/codex-session-storage.ts` moved to 80.54% statements,
  65.42% branches, 94.59% functions, and 81.77% lines through tests for legacy
  local session metadata, cache invalidation/save failure, file filtering,
  message fallback formats, and protected searchable-message extraction for
  local and remote metadata-ID lookups.
- OpenCode session storage SQLite branches:
  `src/main/storage/opencode-session-storage.ts` initially moved to 86.26% statements,
  65.61% branches, 91.04% functions, and 87.99% lines through a mocked
  `better-sqlite3` test for SQLite project/session/message/part reads,
  dedicated and global session merging, JSON-only preservation, preview and
  token aggregation, SQLite message reads, path resolution, and read-only
  deletion rejection.
- Marketplace modal rendered state:
  `src/renderer/components/MarketplaceModal.tsx` moved to 57.14% statements,
  48.89% branches, 65.67% functions, and 58.54% lines through rendered tests for
  open/closed modal behavior, category and search controls, loading/error/empty
  states, detail navigation, README/document loading, local folder browsing,
  successful import, remote-session browse disabling, and import failure logging.
- Merge session modal current behavior:
  `src/renderer/components/MergeSessionModal.tsx` moved to 92.59% statements,
  87.21% branches, 91.53% functions, and 94.17% lines through a current-behavior
  suite for open/closed modal behavior, layer registration, grouped tab search,
  source-tab exclusion, pasted ID validation, keyboard mode switching, keyboard
  selection, merge options, successful merges, and merge failure logging.
- Leaderboard registration recovery and sync:
  `src/renderer/components/LeaderboardRegistrationModal.tsx` moved to 74.38%
  statements, 69.79% branches, 73.68% functions, and 75.85% lines through tests
  for missing auth-token recovery, manual token fallback, auth-token-required
  retry submission, resend confirmation, server stats pull-down, and opt-out
  confirmation.
- SSH remote modal rendered configuration:
  `src/renderer/components/Settings/SshRemoteModal.tsx` moved to 88.46%
  statements, 75.32% branches, 86.96% functions, and 88.89% lines through tests
  for SSH config host loading/import/filtering, connection test success/failure,
  save failure, edit-mode environment variables, enabled-state toggling, and
  validation-driven disabled states.
- Batched session updates:
  `src/renderer/hooks/session/useBatchedSessionUpdates.ts` moved to 94.53%
  statements, 79.11% branches, 100.00% functions, and 97.91% lines through tests
  for AI log chunk grouping, transient versus sticky thinking logs, delivered and
  unread tab markers, shell stdout/stderr grouping, context/cycle updates, usage
  aggregation, interval flushing, missing-session identity preservation, empty-log
  no-op behavior, and unmount flushing.
- Input processing built-ins and queue bypass:
  `src/renderer/hooks/input/useInputProcessing.ts` moved to 60.71% statements,
  57.19% branches, 41.94% functions, and 64.93% lines through tests for
  `/history` error logging, `/skills` interception and fallback behavior, inline
  wizard active-message routing, staged image forwarding, wizard send failure
  logging, and write-mode queue bypass when all busy and queued work is
  read-only.
- Input processing terminal CWD branches:
  `src/renderer/hooks/input/useInputProcessing.ts` moved to 71.70% statements,
  70.65% branches, 54.83% functions, and 76.82% lines through tests for terminal
  `clear` interception, local `cd ..` resolution and git refresh, SSH `cd ~/src`
  remote-CWD expansion and git refresh, failed `cd` directory verification, and
  terminal `runCommand` rejection recovery.
- Input processing naming and AI error branches:
  `src/renderer/hooks/input/useInputProcessing.ts` moved to 84.89% statements,
  78.74% branches, 90.32% functions, and 90.55% lines through tests for batch
  spawn failure recovery, stdin write failure recovery, pending merged-context
  injection and clearing, quick-path tab-name updater behavior, null generated
  names, and skipped name overwrite after manual rename.
- Tab handlers file preview branches:
  `src/renderer/hooks/tabs/useTabHandlers.ts` moved to 88.06% statements,
  72.73% branches, 96.40% functions, and 96.71% lines through tests for stale
  active file-tab fallback, current-tab file replacement, navigation history
  truncation and deduping, adjacent/fallback unified tab insertion, missing close
  no-ops, and non-target session/tab preservation for edit/search/scroll updates.
- Tab handler edge branches:
  `src/renderer/hooks/tabs/useTabHandlers.ts` moved to 89.32% statements,
  74.94% branches, 97.74% functions, and 97.96% lines through tests for sibling
  preservation on existing file-tab updates, extensionless file-tab creation,
  missing active-session file-open no-ops, missing AI-tab selection no-ops,
  rename requests while name generation is active, and delete-log previous user
  command fallback.
- Tab handler persistence and navigation branches:
  `src/renderer/hooks/tabs/useTabHandlers.ts` moved to 90.97% statements,
  75.75% branches, 100.00% functions, and 100.00% lines through tests for
  unsaved file-tab and wizard-tab confirmation callbacks, delete-message
  unsuccessful/rejected logging, Claude and non-Claude tab-star persistence
  failure logging, non-Claude star persistence, no-active-tab close-current
  behavior, auto-refresh stat failures, and file navigation read failures.
- Document editor rendered editing and paste branches:
  `src/renderer/components/Wizard/shared/DocumentEditor.tsx` moved to 88.59%
  statements, 73.37% branches, 81.82% functions, and 90.96% lines through tests
  for image preview/removal, markdown image loading, header and locked/hidden
  toolbar states, attachment expansion, keyboard shortcuts, list continuation,
  trimmed text paste, mocked image paste/save, preview fallback content, and
  preview keyboard return to edit mode.
- Main keyboard handler general and tab shortcut branches:
  `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts` moved to 95.17%
  statements, 88.91% branches, 85.41% functions, and 98.02% lines through tests
  for modal/overlay shortcut gating, keyboard mastery tracking, guarded general
  shortcut behavior, group chat right-bar routing, image carousel source
  selection, focus handling, contextual `Cmd+F`, primary action shortcuts, bulk
  tab close guards, rename gating, tab flag updaters, thinking toggles, unread
  utilities, and remaining keyboard navigation delegation branches.
- Agent listener thinking, tool, SSH, and usage branches:
  `src/renderer/hooks/agent/useAgentListeners.ts` moved to 73.42% statements,
  53.93% branches, 72.72% functions, and 75.10% lines through tests for paused
  agent-error recovery on successful AI data, usage fan-out and accumulated
  context-growth fallback, RAF-buffered thinking chunks, tool execution logs,
  hidden-thinking/malformed-ID guards, SSH remote clearing, and unchanged remote
  identity preservation.
- Agent listener process exit branches:
  `src/renderer/hooks/agent/useAgentListeners.ts` moved to 79.73% statements,
  64.04% branches, 80.80% functions, and 81.27% lines through tests for active
  process exit safety, process-list failure fallback, error-state preservation,
  queued message handoff, query-stat recording, and terminal exit behavior while
  an AI tab remains busy.
- Agent listener session ID and error branches:
  `src/renderer/hooks/agent/useAgentListeners.ts` moved to 81.83% statements,
  68.76% branches, 81.81% functions, and 83.40% lines through tests for legacy
  provider-session ID assignment, conflicting provider-session no-op behavior,
  session-level fallback, missing-session no-op behavior, `session_not_found`
  system-log handling, Auto Run error history, already-paused batch no-op,
  group-chat `session_not_found` suppression, and synopsis error ignoring.
- Agent listener synopsis and git branches:
  `src/renderer/hooks/agent/useAgentListeners.ts` moved to 90.43% statements,
  74.83% branches, 91.91% functions, and 92.97% lines through tests for SSH git
  detection and failure logging, remote branch/tag caching, synopsis history
  creation, `NOTHING_TO_REPORT` and failed synopsis outcomes, terminal git-ref
  refresh with SSH remote IDs, and non-git terminal no-op behavior.
- Symphony modal shell and tab branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 43.01% statements,
  40.99% branches, 40.86% functions, and 43.62% lines with 249 remaining branch
  gaps through tests for closed rendering, cached/refreshing header state, help
  popover toggling, refresh callback, active tab count, and Active/History/Stats
  tab shell states.
- Symphony modal active contribution card branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 51.07% statements,
  47.15% branches, 51.30% functions, and 51.92% lines with 223 remaining branch
  gaps through tests for non-empty Active tab rendering, linked session
  navigation, draft/deferred PR states, progress/token/error display, GitHub sync
  messaging, and finalize action wiring.
- Symphony modal completed contribution card branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 53.49% statements,
  50.23% branches, 54.78% functions, and 54.59% lines with 210 remaining branch
  gaps through tests for non-empty History tab rendering, merged/legacy
  merged/closed/open PR states, completed-card token/cost formatting, history
  stats summary, and PR link opening.
- Symphony modal issue document preview branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 58.06% statements,
  56.16% branches, 63.47% functions, and 59.34% lines with 185 remaining branch
  gaps through tests for issue detail rendering, available/blocked/in-progress
  issue sections, local document preview fallback, document dropdown selection,
  external document fetch success, and issue link opening.
- Symphony modal PR status branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 63.17% statements,
  59.71% branches, 64.34% functions, and 64.98% lines with 170 remaining branch
  gaps through tests for merged/closed PR status output, up-to-date and empty
  status outcomes, and rejected status-check error reporting.
- Symphony modal achievement card branches:
  `src/renderer/components/SymphonyModal.tsx` moved to 63.70% statements,
  62.32% branches, 66.08% functions, and 65.57% lines with 159 remaining branch
  gaps through tests for Stats tab values, earned achievements, locked
  achievements with progress, locked achievements without progress, and earned
  checkmark rendering.
- FilePreview task counts and polling branches:
  `src/renderer/components/FilePreview.tsx` moved to 67.39% statements, 64.03%
  branches, 74.19% functions, and 68.50% lines with 260 remaining branch gaps
  through tests for markdown task-count metadata, missing `modifiedAt` polling
  stats, and unchanged-mtime polling stats that keep the reload banner hidden.
- FilePreview file type helper branches:
  `src/renderer/components/FilePreview.tsx` moved to 67.85% statements, 64.73%
  branches, 74.19% functions, and 68.62% lines with 255 remaining branch gaps
  through tests for fallback text handling, binary extension preview behavior,
  binary-looking content, and zero-byte file stats formatting.
- FilePreview file-tree image branches:
  `src/renderer/components/FilePreview.tsx` moved to 68.77% statements, 65.83%
  branches, 74.19% functions, and 69.60% lines with 247 remaining branch gaps
  through tests for file-tree markdown image project-root resolution using both
  full-`cwd` and first-segment fallback matches.
- FilePreview markdown link callback branches:
  `src/renderer/components/FilePreview.tsx` moved to 69.47% statements, 66.25%
  branches, 75.80% functions, and 70.34% lines with 244 remaining branch gaps
  through tests for local file, web, mailto, and relative markdown link
  callbacks; `src/renderer/utils/markdownConfig.ts` remains at 100.00% while
  gaining direct file-url routing coverage.
- FilePreview keyboard shortcut branches:
  `src/renderer/components/FilePreview.tsx` moved to 77.53% statements, 77.04%
  branches, 79.03% functions, and 78.30% lines with 166 remaining branch gaps
  through tests for container save/copy/toggle shortcuts, preview arrow
  scrolling, history navigation, graph/fuzzy search shortcuts, edit-mode
  suppression, and image copy via keyboard.
- FilePreview textarea search key branches:
  `src/renderer/components/FilePreview.tsx` moved to 83.41% statements, 81.05%
  branches, 79.83% functions, and 84.43% lines with 137 remaining branch gaps
  through tests for textarea save/Escape handling, option/alt page movement,
  and search input Enter/Shift+Enter/Escape handling.
- FilePreview Gist publish button branches:
  `src/renderer/components/FilePreview.tsx` moved to 84.21% statements, 83.26%
  branches, 80.64% functions, and 85.29% lines with 121 remaining branch gaps
  through tests for visible/clickable publish state, already-published state,
  and hidden states for unavailable GitHub CLI, missing callback, edit mode, and
  image previews.
- ProcessMonitor group chat detail branches:
  `src/renderer/components/ProcessMonitor.tsx` moved to 86.77% statements,
  82.51% branches, 75.96% functions, and 88.60% lines with 68 remaining branch
  gaps through tests for group chat moderator/participant process rendering,
  group-chat navigation, unparseable participant fallback, and process detail
  views for Auto Run and fallback command states, plus a nested-button markup
  fix and child-key guard for the group-chat row.
- MarketplaceModal state keyboard branches:
  `src/renderer/components/MarketplaceModal.tsx` moved to 80.82% statements,
  82.22% branches, 79.10% functions, and 82.92% lines with 40 remaining branch
  gaps through tests for cache/live/refresh states, empty manifest category
  counts, detail document dropdown fallbacks, preview scroll shortcuts, and
  list/detail keyboard navigation.
- GroupChatMessages rendering branches:
  `src/renderer/components/GroupChatMessages.tsx` moved to 98.76% statements,
  87.85% branches, 100.00% functions, and 100.00% lines with 13 remaining
  branch gaps through tests for empty and active states, sender rendering,
  markdown/raw modes, copy and toggle actions, collapse/expand behavior, wheel
  propagation, unlimited output, and `scrollToMessage`.
- GitWorktreeSection UI branches:
  `src/renderer/components/GitWorktreeSection.tsx` moved to 95.45% statements,
  96.93% branches, 100.00% functions, and 100.00% lines with 3 remaining
  branch gaps through tests for GitHub CLI states, worktree toggling and fields,
  folder browsing, remote browse suppression, validation warnings, PR toggling,
  branch selection, empty branch lists, and outside-click dropdown closing.
- AgentCreationDialog Symphony branches:
  `src/renderer/components/AgentCreationDialog.tsx` moved to 88.88%
  statements, 89.32% branches, 80.39% functions, and 88.80% lines with 11
  remaining branch gaps through tests for modal state, compatible-agent states,
  defaults, beta labels, folder browse success/cancel, model loading/cache,
  refresh failures, custom config payloads, and create error handling.
- SendToAgentModal session branches:
  `src/renderer/components/SendToAgentModal.tsx` moved to 96.19% statements,
  89.54% branches, 97.95% functions, and 96.36% lines with 16 remaining branch
  gaps through active tests for current session-based filtering, fallbacks,
  search, empty states, source-tab naming, send success/failure, in-flight send
  UI, layer-stack Escape, keyboard selection, and quick-select labels. The 25
  skipped legacy tests in that file were pre-existing and were not widened.
- WorktreeConfigModal configuration branches:
  `src/renderer/components/WorktreeConfigModal.tsx` moved to 92.13% statements,
  92.22% branches, 100.00% functions, and 94.11% lines with 7 remaining branch
  gaps through active tests for local/remote config validation, GitHub CLI
  warnings, folder browsing, watch toggling, create/disable flows, create
  failures, and layer-stack Escape handling.
- SessionActivityGraph interaction branches:
  `src/renderer/components/SessionActivityGraph.tsx` moved to 100.00%
  statements, 98.87% branches, 100.00% functions, and 100.00% lines with 1
  remaining branch gap through tests for deterministic buckets, visible-entry
  filtering, summary titles, axis labels, hover tooltips, bar clicks, lookback
  menu selection, and menu dismissal.
- CollapsibleJsonViewer rendering branches:
  `src/renderer/components/CollapsibleJsonViewer.tsx` moved to 98.36%
  statements, 95.00% branches, 100.00% functions, and 98.18% lines with 4
  remaining branch gaps through tests for primitive rendering, string escaping
  and truncation, object and array previews, expand/collapse behavior, root
  primitive rendering, non-JSON primitive stringification, and copy-button
  success/failure paths.
- ParticipantCard interaction branches:
  `src/renderer/components/ParticipantCard.tsx` moved to 96.29% statements,
  96.25% branches, 100.00% functions, and 100.00% lines with 3 remaining branch
  gaps through tests for pending/default participants, status labels, SSH and
  session pills, activity/cost/context display, session-id copy feedback, async
  reset/remove states, confirmation/cancel behavior, and live-output peek
  fallback/truncation.
- AgentErrorModal recovery branches:
  `src/renderer/components/AgentErrorModal.tsx` moved to 100.00% statements,
  98.48% branches, 100.00% functions, and 100.00% lines with 1 remaining branch
  gap through tests for error type title/icon mappings, recoverable/error
  coloring, context labels, parsed JSON details, recovery actions, primary
  focus, empty actions, dismiss controls, and non-dismissible errors.
- OpenSpecCommandsPanel command branches:
  `src/renderer/components/OpenSpecCommandsPanel.tsx` moved to 98.76%
  statements, 98.38% branches, 100.00% functions, and 100.00% lines with 1
  remaining branch gap through tests for loading, empty and metadata states,
  external links, command expansion/collapse, prompt truncation, reset, edit,
  autocomplete key handling, save, cancel, refresh, and failure responses.
- SpecKitCommandsPanel command branches:
  `src/renderer/components/SpecKitCommandsPanel.tsx` moved to 98.76%
  statements, 98.38% branches, 100.00% functions, and 100.00% lines with 1
  remaining branch gap through tests for loading, empty and metadata states,
  external links, command expansion/collapse, prompt truncation, reset, edit,
  autocomplete key handling, save, cancel, refresh, and failure responses.
- MergeProgressModal progress branches:
  `src/renderer/components/MergeProgressModal.tsx` moved to 100.00%
  statements, 98.03% branches, 100.00% functions, and 100.00% lines with 1
  remaining branch gap through tests for closed rendering, stage/progress
  display, fallback labels, elapsed-time updates, cancel confirmation, Escape
  handling, complete-state controls, and Escape handler refresh after rerender.
- ConversationManager runtime branches:
  `src/renderer/components/Wizard/services/conversationManager.ts` moved to
  98.78% statements, 86.95% branches, 100.00% functions, and 98.75% lines with
  24 remaining branch gaps through tests for session replacement and state,
  send-message errors, SSH availability bypass, prompt history, Windows stdin
  flags, spawn cleanup, timeout cleanup, mismatched exits, stream output
  extraction, provider/generic errors, and message/log helper exports.
- Codex session storage failure branches:
  `src/main/storage/codex-session-storage.ts` moved to 94.79% statements,
  81.68% branches, 100.00% functions, and 95.58% lines with 98 remaining branch
  gaps through tests for local and remote stat/read/oversize failures, missing
  session directories, current response-item parsing, rich remote metadata and
  usage parsing, local/remote modified-date sorting, remote empty reads, and
  delete write failure reporting.
- OpenCode session storage JSON/SQLite edge branches:
  `src/main/storage/opencode-session-storage.ts` reached 100.00% statements,
  82.93% branches, 100.00% functions, and 100.00% lines with 70 remaining
  branch gaps through tests for SQLite schema/error fallbacks, local JSON hash
  and parent-worktree discovery, malformed JSON, global-session filtering,
  deletion errors, remote hash/parent/global filtering, remote listing failures,
  remote token aggregation, and Windows `APPDATA` path resolution.
- Group Chat router prompting, Auto Run, and synthesis branches:
  `src/main/group-chat/group-chat-router.ts` moved to 74.92% statements,
  67.21% branches, 83.93% functions, and 75.41% lines with 121 remaining branch
  gaps through tests for router state helpers, user-route failure paths,
  moderator prompt customization, available-session context, custom environment
  propagation, Auto Run directive triggering/failure warnings, synthesis prompt
  spawning, and synthesis early-return/error paths.
- CLI agent spawner JSON-line batch branches:
  `src/cli/services/agent-spawner.ts` moved to 97.90% statements, 88.48%
  branches, 100.00% functions, and 99.42% lines with 19 remaining branch gaps
  through tests for non-Claude wrapper exports, Codex/OpenCode/Factory Droid
  JSON-line batch argument construction, parser integration, usage aggregation,
  stdin closure, error precedence, stderr fallback, spawn errors, and
  unsupported batch-mode agents.
- Wizard preparing plan branches:
  `src/renderer/components/Wizard/screens/PreparingPlanScreen.tsx` moved to
  100.00% statements, 99.03% branches, 100.00% functions, and 100.00% lines
  with 1 remaining branch gap through tests for document generation, disk-loaded
  documents, saving with SSH remote forwarding, retry/recovery, status display,
  file expansion, elapsed-time updates, rotating facts, external links, and
  auto-advance behavior.
- Wizard conversation rendered branches:
  `src/renderer/components/Wizard/screens/ConversationScreen.tsx` moved to
  78.68% statements, 74.58% branches, 75.32% functions, and 80.39% lines with
  75 remaining branch gaps through rendered tests for resumed messages,
  existing-doc startup, continuation prompts, structured responses, deferred
  auto-continue, detected errors, debug logs, loading states, thinking content,
  and live tool execution. This checkpoint also fixed two timer/ref-order bugs
  that prevented intended auto-send behavior from firing.

Current scoped service/hook/util/store files with five-or-fewer branch gaps: 0.
Next broader branch-gap candidates from the latest artifact:

- `src/renderer/App.tsx`: missing 329/329 branches.
- `src/renderer/components/DocumentGraph/DocumentGraphView.tsx`: missing
  202/418 branches.
- `src/renderer/components/NewInstanceModal.tsx`: missing 199/437 branches.
- `src/renderer/components/AutoRun.tsx`: missing 182/621 branches.
- `src/renderer/components/SymphonyModal.tsx`: missing 159/422 branches.
- `src/renderer/hooks/batch/useBatchProcessor.ts`: missing 128/389 branches.
- `src/renderer/components/Wizard/screens/AgentSelectionScreen.tsx`: missing
  128/288 branches.
- `src/renderer/components/FilePreview.tsx`: missing 121/723 branches.
- `src/main/group-chat/group-chat-router.ts`: missing 121/369 branches.
- `src/renderer/hooks/tabs/useTabHandlers.ts`: missing 120/495 branches.
- `src/renderer/components/DocumentsPanel.tsx`: missing 117/325 branches.
- `src/renderer/components/FileExplorerPanel.tsx`: missing 113/323 branches.
- `src/renderer/hooks/agent/useAgentListeners.ts`: missing 112/445 branches.
- `src/renderer/components/PromptComposerModal.tsx`: missing 112/205 branches.
- `src/renderer/components/TerminalOutput.tsx`: missing 110/516 branches.
- `src/renderer/components/DocumentGraph/MindMap.tsx`: missing 106/279 branches.
- `src/renderer/components/QuickActionsModal.tsx`: missing 101/292 branches.
- `src/main/storage/codex-session-storage.ts`: missing 98/535 branches.
- `src/renderer/components/Wizard/services/phaseGenerator.ts`: missing 98/208
  branches.
- `src/renderer/services/inlineWizardConversation.ts`: missing 95/166 branches.

`src/renderer/components/Wizard/screens/ConversationScreen.tsx` now sits below
the top broader branch-gap list with 75 remaining branch gaps out of 295
branches.

`src/renderer/components/Wizard/screens/PreparingPlanScreen.tsx` now sits below
the top broader branch-gap list with 1 remaining branch gap out of 103 branches.

`src/cli/services/agent-spawner.ts` now sits below the top broader branch-gap
list with 19 remaining branch gaps out of 165 branches.

`src/renderer/components/ProcessMonitor.tsx` now sits below the top broader
branch-gap list with 68 remaining branch gaps out of 389 branches.

`src/renderer/components/MarketplaceModal.tsx` now sits below the top broader
branch-gap list with 40 remaining branch gaps out of 225 branches.

`src/renderer/components/GroupChatMessages.tsx` now sits below the top broader
branch-gap list with 13 remaining branch gaps out of 107 branches.

`src/renderer/components/GitWorktreeSection.tsx` now sits below the top broader
branch-gap list with 3 remaining branch gaps out of 98 branches.

`src/renderer/components/AgentCreationDialog.tsx` now sits below the top broader
branch-gap list with 11 remaining branch gaps out of 103 branches.

`src/renderer/components/SendToAgentModal.tsx` now sits below the top broader
branch-gap list with 16 remaining branch gaps out of 153 branches.

`src/renderer/components/WorktreeConfigModal.tsx` now sits below the top broader
branch-gap list with 7 remaining branch gaps out of 90 branches.

`src/renderer/components/SessionActivityGraph.tsx` now sits below the top
broader branch-gap list with 1 remaining branch gap out of 89 branches.

`src/renderer/components/CollapsibleJsonViewer.tsx` now sits below the top
broader branch-gap list with 4 remaining branch gaps out of 80 branches.

`src/renderer/components/ParticipantCard.tsx` now sits below the top broader
branch-gap list with 3 remaining branch gaps out of 80 branches.

`src/renderer/components/AgentErrorModal.tsx` now sits below the top broader
branch-gap list with 1 remaining branch gap out of 66 branches.

`src/renderer/components/OpenSpecCommandsPanel.tsx` now sits below the top
broader branch-gap list with 1 remaining branch gap out of 62 branches.

`src/renderer/components/SpecKitCommandsPanel.tsx` now sits below the top
broader branch-gap list with 1 remaining branch gap out of 62 branches.

`src/renderer/components/MergeProgressModal.tsx` now sits below the top broader
branch-gap list with 1 remaining branch gap out of 51 branches.

`src/renderer/components/Wizard/services/conversationManager.ts` now sits below
the top broader branch-gap list with 24 remaining branch gaps out of 184
branches.

`src/main/storage/codex-session-storage.ts` now sits below the top broader
branch-gap list with 98 remaining branch gaps out of 535 branches.

`src/main/storage/opencode-session-storage.ts` now sits below the top broader
branch-gap list with 70 remaining branch gaps out of 410 branches.

`src/renderer/hooks/input/useInputProcessing.ts` now sits below the top broader
branch-gap list with 71 remaining branch gaps out of 334 branches.

## Known Test-Signal Noise Still Present

Full coverage still passes but emits existing noise, including:

- React `act(...)` warnings in renderer hook/component tests outside the
  cleaned `useWorktreeValidation`, `ProcessMonitor`, `AutoRun`,
  `useBatchProcessor`, `UpdateCheckModal`, and `WizardIntegration` files.
- Expected error stack traces in `ErrorBoundary` and provider/theme tests.
- `useSymphony` tests logging `getIssueCounts is not a function` from incomplete
  window API mocks.
- Settings and remote integration tests logging expected stdout/stderr.
- SSH command builder tests logging full wrapped command metadata.
- A post-sync unit audit exposed a flaky `TabSwitcherModal.test.tsx` search
  assertion caused by random `agentSessionId` values matching the search query.
  The test now uses explicit IDs for that scenario.

Do not silence these globally. Prefer local spies/assertions where the test
expects the log.

## Suggested Next Work

Current state as of 2026-05-21:

- `npm run test:coverage` passes with global 100% thresholds enabled.
- Latest coverage totals: statements `100% (63,667/63,667)`, branches
  `100% (44,693/44,693)`, functions `100% (13,680/13,680)`, lines
  `100% (59,568/59,568)`.
- Latest full unit run passes: 730 files passed, 1 skipped; 28,519 tests
  passed, 106 skipped.
- Latest checkpoint is recorded in `docs/testing/audits/test-coverage-audit.md` under
  `Test Signal Cleanup Checkpoint: Leaderboard Modal And ProcessMonitor Harnesses`.
- Latest full-suite signal counts: stdout sections 879; stderr sections 44;
  React `Warning:` lines 164; `act(...)` mentions 326.
- Bare `useInlineWizardContext` missing-provider error stacks are now 0.
- Upstream sync status: `upstream/main` from
  `https://github.com/RunMaestro/Maestro.git` was fetched and merged with
  `-X theirs`; the merge was a no-op because this branch was already current
  with upstream. Local unit-signal checkpoint commits have continued after that
  sync.
- No coverage exclusions were added or widened for this checkpoint.
- Integration and E2E remain deferred until explicitly approved by the user.

Next work is unit-test signal cleanup unless the user explicitly approves the
integration/E2E phase:

1. Continue with the next largest noisy unit areas, likely App shell tests,
   history/leaderboard component tests, AgentSessionsModal, batchReducer tests,
   ConversationScreen rendered tests, DocumentGraphView tests, WorktreeRunSection
   tests, ErrorBoundary tests, or useRemoteHandlers tests.
2. Keep each cleanup local: prefer `act` wrappers, pending/deferred async helpers,
   and local log spies/assertions for expected failures.
3. Rerun targeted tests plus `npm run test` and `npm run test:coverage` after
   each checkpoint that changes shared test behavior.
4. Run formatting/lint gates after doc or test edits:
   `npm run format:check:all`, `npm run lint`, and `npm run lint:eslint`.
5. Review and document remaining noisy expected-error output. Do not silence it
   globally; prefer local spies/assertions where the test expects the log.
6. Perform the final code-review pass and complete the final response required by
   `docs/testing/prompts/full-test-coverage-campaign.md`.

## Final Completion Reminder

Do not mark the campaign done until the completion audit proves every
requirement in `docs/testing/prompts/full-test-coverage-campaign.md` is satisfied:

- 100% coverage across statements, branches, functions, and lines, or every
  remaining item has documented, justified, user-approved narrow exclusions.
- Thresholds in `vitest.config.mts` enforce the achieved level appropriately.
- Critical workflows have integration/E2E coverage where unit tests are
  insufficient.
- Required final commands pass or have documented environment blockers.
- Final audit identifies tested behavior, remaining risk, exclusions, threshold
  status, and test-quality assessment.

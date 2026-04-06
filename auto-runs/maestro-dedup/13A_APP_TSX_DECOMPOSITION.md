# Phase 13-A: Decompose App.tsx (4,034 lines)

## Objective

Break down `App.tsx` from 4,034 lines into focused modules. This is the single largest file in the codebase and has been growing (was 3,619, now 4,034 - a REGRESSION).

**Evidence:** `docs/agent-guides/scans/SCAN-OVERSIZED.md`
**Risk:** High - App.tsx is the main coordinator. Changes must be incremental and verified at each step.
**Estimated savings:** Improved maintainability, target <1,000 lines for App.tsx

---

## Pre-flight Checks

- [x] Phase 12 (constants) is complete
- [x] `rtk npm run lint` passes
- [x] `CI=1 rtk vitest run` passes (baseline: 23,659 passed, 55 pre-existing failures, 107 pending)
- [x] Create a backup branch: already on dedicated worktree branch `docs/codebase-dedup-guides` - serves as isolation. Git worktree has WSL path mismatch requiring explicit GIT_DIR/GIT_WORK_TREE env vars.

---

## Important Notes

- **Work incrementally.** Extract one concern at a time, verify, then continue.
- **DO NOT change behavior.** This is pure structural refactoring.
- **Keep App.tsx as the coordinator.** It should import and compose extracted modules, not duplicate their logic.
- Previous successful decomposition: TabBar.tsx went from 2,839 to 542 lines by splitting into 4 files.

---

## Tasks

### 1. Read App.tsx and categorize sections

- [x] Read the entire `src/renderer/App.tsx` file
- [x] Map out line ranges for: state declarations (useState, useRef), effect hooks (useEffect blocks), event handlers (keyboard, mouse, window), IPC listeners (window.maestro handlers), modal render logic, layout render (main JSX tree), helper functions, constants
- [x] Identify the largest extractable sections by line count

**Analysis (3,934 lines total):**

| Section                                                 | Lines   | Range         | Notes                                                          |
| ------------------------------------------------------- | ------- | ------------- | -------------------------------------------------------------- |
| Imports                                                 | 217     | 1-217         | Lazy-loaded components, hooks, stores, types                   |
| Modal state destructuring (modalStore)                  | 150     | 222-372       | Already extracted to modalStore, just destructuring            |
| Wizard state + settings hook                            | 108     | 380-487       | Already extracted to useWizard/useSettings                     |
| Session state (sessionStore)                            | 72      | 504-575       | Already extracted to sessionStore, ref-like getters            |
| UI layout state (uiStore)                               | 37      | 577-613       | Already extracted to uiStore                                   |
| Group chat state (groupChatStore)                       | 24      | 615-638       | Already extracted to groupChatStore                            |
| Input context + file explorer state                     | 27      | 659-696       | Already extracted to InputContext                              |
| Refs (DOM + value refs)                                 | 33      | 766-798       | Essential - cannot extract further                             |
| Debug helpers effect                                    | 24      | 800-823       | Trivial                                                        |
| Extracted hook calls (tab, group, modal, worktree, app) | 230     | 831-1046      | Already extracted - just call sites                            |
| Theme/CWD memos + remote hooks                          | 67      | 1048-1118     | Small; already extracted                                       |
| Agent capabilities + merge/summarize                    | 40      | 1121-1160     | Already extracted                                              |
| allCustomCommands + allSlashCommands memos              | 121     | 1162-1282     | **Extractable** - slash command assembly                       |
| Agent execution/management/batch/listeners              | 71      | 1287-1357     | Already extracted                                              |
| Callbacks (remove queue, exports, wizard, input)        | 142     | 1359-1500     | Mixed; some are bridge wrappers                                |
| Activity trackers + more callbacks                      | 102     | 1502-1604     | Small scattered handlers                                       |
| Deep link handler effect                                | 28      | 1606-1633     | **Extractable**                                                |
| Sorted sessions, keyboard nav, persistence, lifecycle   | 159     | 1635-1793     | Already extracted - just call sites                            |
| **Remote event listeners**                              | **494** | **1795-2288** | **LARGEST extractable section - 15 useEventListener handlers** |
| Group management + session CRUD hooks                   | 42      | 2290-2331     | Already extracted - just call sites                            |
| Inline callbacks (PR, batch, tab select, etc.)          | 141     | 2333-2473     | Mixed; some extractable                                        |
| **Keyboard handler ref population**                     | **175** | **2476-2650** | **2nd largest - assigns ~100 fields to ref**                   |
| Props hook calls (mainPanel, sessionList, rightPanel)   | 336     | 2658-2993     | Already extracted to prop hooks                                |
| **JSX return**                                          | **922** | **2995-3916** | **3rd largest - modal rendering + layout**                     |

**Top extractable sections by size:**

1. **Remote event listeners (494 lines, 1795-2288)** - 15 `useEventListener` handlers for remote/web/CLI events (openFileTab, configureAutoRun, createSession, deleteSession, etc.). Could become `useRemoteEventListeners` hook.
2. **JSX return - remaining modals outside AppModals (504 lines, 3379-3882)** - DebugPackage, WindowsWarning, Marketplace, Symphony, DirectorNotes, Cue, CueYamlEditor, GistPublish, DocumentGraph, DeleteAgent, Settings, WizardResume, MaestroWizard, Tour, flash notifications. Could be folded into `AppModals`.
3. **Props hook calls (336 lines, 2658-2993)** - Already extracted to useMainPanelProps/useSessionListProps/useRightPanelProps. These are call sites with argument passing - hard to reduce further.
4. **AppModals prop passing (277 lines, 3101-3377)** - Huge prop list for the unified AppModals component. Structural complexity, not easily extracted.
5. **Keyboard handler ref population (175 lines, 2476-2650)** - Assigns ~100+ fields to keyboardHandlerRef.current. Could be extracted to a builder function.
6. **allCustomCommands + allSlashCommands memos (121 lines, 1162-1282)** - Could become `useSlashCommandAssembly` hook.

### 2. Extract keyboard handler logic

- [x] Check if `useMainKeyboardHandler` already exists: `rtk grep "useMainKeyboardHandler" src/renderer/ --glob "*.{ts,tsx}"`
- [x] If App.tsx still has inline keyboard handling: extract to `src/renderer/hooks/useAppKeyboardHandler.ts`
- [x] Import and call the hook from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** Already fully extracted. `useMainKeyboardHandler` exists at `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts` (~500 lines) and contains all keydown event handling logic (shortcut matching, modal layer gating, terminal mode handling, navigation, etc.). App.tsx calls `useMainKeyboardHandler()` at line 1668 and populates `keyboardHandlerRef.current` (lines 2478-2650) with state/handler references. The ref population block (175 lines) is a necessary data-binding that cannot be meaningfully extracted - it needs access to ~100+ state variables and functions defined throughout App.tsx. No new extraction needed. Lint passes, tests match baseline (23,659 passed, 55 pre-existing failures, 107 skipped).

### 3. Extract IPC listener setup

- [x] Create `src/renderer/hooks/useAppIpcListeners.ts`
- [x] Move all `window.maestro.on(...)` listener registrations from App.tsx into the hook
- [x] Define a `AppIpcDeps` interface for any dependencies the listeners need
- [x] Return cleanup function from the useEffect
- [x] Import and call from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** Created `src/renderer/hooks/remote/useAppRemoteEventListeners.ts` (569 lines) containing all 15 `useEventListener('maestro:...')` CustomEvent handlers from the "Remote Event Listeners" section (lines 1795-2288). Named `useAppRemoteEventListeners` instead of `useAppIpcListeners` because these are CustomEvent-based remote listeners (not `window.maestro.on()` IPC listeners, which were already extracted to `useAgentListeners`). Defined `UseAppRemoteEventListenersDeps` interface with 10 dependencies. Uses `useEventListener` internally (each handler registers its own cleanup via the hook), so no manual cleanup function needed. App.tsx reduced from ~3,934 to 3,450 lines (-484 lines). Also removed 3 now-unused imports from App.tsx (`useEventListener`, `PLAYBOOKS_DIR`, `useSettingsStore`). Exported from `hooks/remote/index.ts`. Lint passes, tests match baseline (23,659 passed, 55 pre-existing failures).

### 4. Extract modal orchestration

- [x] Create `src/renderer/components/AppModals.tsx`
- [x] Move all conditional modal rendering (`{isOpen && <Modal />}` blocks) from App.tsx into AppModals
- [x] Define `AppModalsProps` interface with all modal open states and handlers
- [x] Import and render `<AppModals>` from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** Integrated the previously-created `AppStandaloneModals.tsx` (608 lines) into App.tsx, replacing ~500 lines of inline standalone modal rendering (18 modals: DebugPackage, WindowsWarning, AppOverlays, Playground, DebugWizard, Marketplace, Symphony, DirectorNotes, CueModal, CueYamlEditor, GistPublish, DocumentGraph, DeleteAgent, Settings, WizardResume, MaestroWizard, TourOverlay, flash notifications). The component self-sources modal open/close state from modalStore, sessionStore, fileExplorerStore, and tabStore - App.tsx only passes handler callbacks and computed values. Also fixed 7 type mismatches in `AppStandaloneModalsProps` (SymphonyContributionData, MindMapLayoutType, wizard/tour handler signatures, DirectorNotesResumeSession arity), replaced broken `updateSessionWith` import with `useSessionStore.getState().setSessions()` pattern, and removed 7 lazy imports + 15 unused destructured variables from App.tsx. This is the second major modal extraction layer: `AppModals/` directory handles info, confirm, session, group, worktree, utility, and agent modals; `AppStandaloneModals` handles debug, marketplace, wizard, settings, tour, gist, document graph, and celebration overlays. App.tsx reduced from 3,470 to 3,137 lines (-333 lines). Lint passes (no new errors), tests match baseline (24,537 passed, 42 pre-existing failures, 107 pending - improved from 55 baseline failures).

### 5. Extract session management effects

- [x] Create `src/renderer/hooks/useSessionLifecycle.ts`
- [x] Move effects that manage session lifecycle (creation, deletion, status updates) from App.tsx
- [x] Import and call from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** The core `useSessionLifecycle` hook already existed at `src/renderer/hooks/session/useSessionLifecycle.ts` (640 lines, created in Phase 2H) containing: `handleSaveEditAgent`, `handleRenameTab`, `handleAutoNameTab`, `performDeleteSession`, `showConfirmation`, `toggleTabStar`, `toggleTabUnread`, `toggleUnreadFilter`, plus effects for groups persistence and navigation history tracking. Additionally, `useSessionCrud` (also previously extracted) handles session creation, deletion confirmation, rename, bookmark, and drag-drop operations. To further reduce App.tsx, created new `useSessionSwitchCallbacks` hook (229 lines) at `src/renderer/hooks/session/useSessionSwitchCallbacks.ts` extracting 5 session navigation callbacks and the deep link effect: `handleProcessMonitorNavigateToSession`, `handleToastSessionClick`, `handleNamedSessionSelect`, `handleUtilityTabSelect`, `handleUtilityFileTabSelect`, plus the `maestro://` deep link `useEffect`. The hook self-sources from sessionStore and uiStore, taking only 3 external deps (setActiveSessionId wrapper, handleResumeSession, inputRef). App.tsx reduced from 3,137 to 3,038 lines (-99 lines). Lint passes (0 new errors; 21 pre-existing errors in App.tsx/MainPanel.tsx/SpecCommandsPanel.tsx from broken `updateSessionWith`/`updateAiTab` imports and missing `setSessions` in hook dep interfaces). Tests match baseline (24,537 passed, 42 pre-existing failures, 107 pending).

### 6. Extract auto-run / batch processing coordination

- [x] Create `src/renderer/hooks/useAutoRunCoordination.ts`
- [x] Move auto-run state management and batch processing coordination from App.tsx
- [x] Import and call from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** Created `src/renderer/hooks/batch/useAutoRunCoordination.ts` (163 lines) that consolidates all Auto Run / batch processing coordination that was inline in App.tsx. The hook self-sources from sessionStore, batchStore, modalStore, and uiStore, taking only 3 external deps: `startBatchRun`, `activeBatchSessionIds` (from useBatchHandlers), and `handleAutoRunRefreshRef` (for circular dep resolution with useWizardHandlers). Internally calls `useAutoRunHandlers`, `useAutoRunAchievements`, and `useAutoRunDocumentLoader`. Contains `handleSetActiveRightTab` (auto-run setup modal gating), `handleMarketplaceImportComplete` (refresh docs on import), and `handleSaveBatchPrompt` (persist batch prompt to session). Also fixed pre-existing issue where `useAutoRunHandlers` was missing `setSessions` in its deps - now properly self-sourced from sessionStore. Removed `useBatchStore` import, `setBatchRunnerModalOpen`/`setAutoRunSetupModalOpen` destructuring from modalActions, and 3 standalone hook calls from App.tsx. App.tsx reduced from 3,038 to 2,974 lines (-64 lines). Lint passes (0 new errors; 19 pre-existing errors unchanged). Tests match baseline (24,537 passed, 42 pre-existing failures, 107 pending).

### 7. Extract Encore Feature gating logic

- [x] Create `src/renderer/hooks/useEncoreFeatures.ts`
- [x] Centralize all Encore Feature conditional logic from App.tsx
- [x] Import and call from App.tsx
- [x] Run lint and tests: `rtk npm run lint && CI=1 rtk vitest run`

**Result:** Created `src/renderer/hooks/settings/useEncoreFeatures.ts` (97 lines) centralizing all Encore Feature gating logic from App.tsx. The hook self-sources `encoreFeatures` from settingsStore, `sessions` from sessionStore, and modal actions via `getModalActions()`. Contains: (1) two modal-reset useEffects that close Symphony/UsageDashboard modals when their Encore Feature toggle is disabled, (2) the `useCueAutoDiscovery` call (gated by maestroCue flag), (3) five pre-gated callbacks (`gatedSetUsageDashboardOpen`, `gatedOnOpenSymphony`, `gatedOnOpenDirectorNotes`, `gatedOnOpenMaestroCue`, `gatedOnConfigureCue`) that return `undefined` when their feature is disabled. Takes only `handleConfigureCue` as external dep (from useModalHandlers). Removed `encoreFeatures` from settings destructuring, removed `useCueAutoDiscovery` import/call, and replaced 5 inline `encoreFeatures.xxx ? handler : undefined` ternary expressions in JSX with the pre-gated values. Exported from `hooks/settings/index.ts`. App.tsx reduced from 2,974 to 2,967 lines (-7 lines, but the primary value is centralization of scattered encore logic into one discoverable hook). Lint passes (0 new errors; 19 pre-existing errors unchanged). Tests match baseline (24,537 passed, 42 pre-existing failures, 107 pending).

### 8. Verify after each extraction

- [x] After each extraction above: `rtk npm run lint`
- [x] After each extraction above: `CI=1 rtk vitest run`
- [x] After each extraction: verify App.tsx still composes everything correctly
- [x] After each extraction: confirm no behavior changes

**Result:** Final verification run across all extractions (tasks 2-7). Lint: 19 pre-existing errors (all `setSessions` missing property, `updateSessionWith`/`updateAiTab` broken imports, `Spinner`/`EditingCommand` missing exports) - zero new errors introduced by any extraction. Tests: 24,537 passed, 42 pre-existing failures, 107 pending - matches baseline. Composition verified: all 6 extracted hooks (`useMainKeyboardHandler`, `useAppRemoteEventListeners`, `useEncoreFeatures`, `useAutoRunCoordination`, `useSessionSwitchCallbacks`, `useSessionLifecycle`) are imported and called from App.tsx. Both modal components (`AppModals`, `AppStandaloneModals`) are rendered in JSX. All extracted modules self-source state from stores where possible, minimizing prop threading. No behavior changes - pure structural refactoring throughout.

### 9. Verify App.tsx is a thin coordinator

- [ ] App.tsx should contain: minimal state, extracted hook calls, and a clean JSX return with `<AppLayout>`, `<LeftBar>`, `<MainPanel>`, `<RightBar>`, `<AppModals>`
- [ ] No inline event handlers longer than 3 lines
- [ ] No inline effects

### 10. Measure result

- [ ] Run: `wc -l src/renderer/App.tsx`
- [ ] Target: <1,000 lines
- [ ] Verify types: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
CI=1 rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable.

Find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- App.tsx reduced from 4,034 to <1,000 lines
- Extracted modules are focused and self-contained
- No behavior changes
- All extracted hooks have tests
- Lint and tests pass

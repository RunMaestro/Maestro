# App.tsx Inventory

This document provides a detailed map of `src/renderer/App.tsx` (~9,700 lines) to guide safe extraction during refactoring.

---

## 1. useState Declarations (lines 231-600)

The `MaestroConsoleInner` component starts at line 231. State declarations are organized by category below.

### Hook Dependencies (not useState but extracted from hooks/contexts)

These states come from external hooks/contexts, not local useState:

```typescript
// From useLayerStack()
hasOpenLayers, hasOpenModal

// From useToast()
addToast, setDefaultDuration, setAudioFeedback, setOsNotifications

// From useMobileLandscape()
isMobileLandscape

// From useNavigationHistory()
pushNavigation, navigateBack, navigateForward

// From useWizard()
wizardState, openWizardModal, restoreWizardState, loadResumeState, clearResumeState,
completeWizard, closeWizardModal, wizardGoToStep

// From useSettings() - 60+ settings values destructured (lines 260-311)
// See AppModals.tsx documentation for full list

// From useSession() (SessionContext)
sessions, setSessions, groups, setGroups, activeSessionId, setActiveSessionIdFromContext,
setActiveSessionIdInternal, sessionsLoaded, setSessionsLoaded, initialLoadComplete,
sessionsRef, groupsRef, activeSessionIdRef, batchedUpdater, activeSession,
cyclePositionRef, removedWorktreePaths, setRemovedWorktreePaths, removedWorktreePathsRef

// From useGroupChat() (GroupChatContext)
groupChats, setGroupChats, activeGroupChatId, setActiveGroupChatId,
groupChatMessages, setGroupChatMessages, groupChatState, setGroupChatState,
groupChatStagedImages, setGroupChatStagedImages, groupChatReadOnlyMode, setGroupChatReadOnlyMode,
groupChatExecutionQueue, setGroupChatExecutionQueue, groupChatRightTab, setGroupChatRightTab,
groupChatParticipantColors, setGroupChatParticipantColors, moderatorUsage, setModeratorUsage,
participantStates, setParticipantStates, groupChatStates, setGroupChatStates,
allGroupChatParticipantStates, setAllGroupChatParticipantStates, groupChatError, setGroupChatError,
groupChatInputRef, groupChatMessagesRef, clearGroupChatError

// From useInputContext() (InputContext)
slashCommandOpen, setSlashCommandOpen, selectedSlashCommandIndex, setSelectedSlashCommandIndex,
tabCompletionOpen, setTabCompletionOpen, selectedTabCompletionIndex, setSelectedTabCompletionIndex,
tabCompletionFilter, setTabCompletionFilter, atMentionOpen, setAtMentionOpen,
atMentionFilter, setAtMentionFilter, atMentionStartIndex, setAtMentionStartIndex,
selectedAtMentionIndex, setSelectedAtMentionIndex, commandHistoryOpen, setCommandHistoryOpen,
commandHistoryFilter, setCommandHistoryFilter, commandHistorySelectedIndex, setCommandHistorySelectedIndex

// From useAutoRun() (AutoRunContext)
autoRunDocumentList, setAutoRunDocumentList, autoRunDocumentTree, setAutoRunDocumentTree,
autoRunIsLoadingDocuments, setAutoRunIsLoadingDocuments, autoRunDocumentTaskCounts, setAutoRunDocumentTaskCounts
```

### Local useState Declarations

#### Spec Kit Commands
```typescript
// Line 333
const [speckitCommands, setSpeckitCommands] = useState<SpecKitCommand[]>([]);
```

#### UI Layout State (lines 337-393)
```typescript
const [groupChatsExpanded, setGroupChatsExpanded] = useState(true);  // Line 337
const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);        // Line 388
const [rightPanelOpen, setRightPanelOpen] = useState(true);          // Line 389
const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>('files');  // Line 390
const [activeFocus, setActiveFocus] = useState<FocusArea>('main');   // Line 391
const [bookmarksCollapsed, setBookmarksCollapsed] = useState(false); // Line 392
const [showUnreadOnly, setShowUnreadOnly] = useState(false);         // Line 393
```

#### Input State (lines 368-369)
```typescript
const [terminalInputValue, setTerminalInputValue] = useState('');
const [aiInputValueLocal, setAiInputValueLocal] = useState('');
```

#### File Explorer State (lines 398-402)
```typescript
// Note: previewFile state removed - file preview now uses tab-based system via session.filePreviewTabs
const [selectedFileIndex, setSelectedFileIndex] = useState(0);
const [flatFileList, setFlatFileList] = useState<any[]>([]);
const [fileTreeFilter, setFileTreeFilter] = useState('');
const [fileTreeFilterOpen, setFileTreeFilterOpen] = useState(false);
```

#### Git Diff State (line 405)
```typescript
const [gitDiffPreview, setGitDiffPreview] = useState<string | null>(null);
```

#### Tour Overlay State (lines 408-409)
```typescript
const [tourOpen, setTourOpen] = useState(false);
const [tourFromWizard, setTourFromWizard] = useState(false);
```

#### Git Log Viewer State (line 412)
```typescript
const [gitLogOpen, setGitLogOpen] = useState(false);
```

#### Renaming State (lines 415-416)
```typescript
const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
```

#### Drag and Drop State (lines 419-420)
```typescript
const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
const [isDraggingImage, setIsDraggingImage] = useState(false);
```

#### Modal Open States (lines 424-456)
```typescript
// Settings & Config Modals
const [settingsModalOpen, setSettingsModalOpen] = useState(false);           // Line 424
const [newInstanceModalOpen, setNewInstanceModalOpen] = useState(false);     // Line 425
const [editAgentModalOpen, setEditAgentModalOpen] = useState(false);         // Line 426
const [editAgentSession, setEditAgentSession] = useState<Session | null>(null); // Line 427
const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);           // Line 428
const [_shortcutsSearchQuery, setShortcutsSearchQuery] = useState('');       // Line 429

// Quick Actions
const [quickActionOpen, setQuickActionOpen] = useState(false);               // Line 430
const [quickActionInitialMode, setQuickActionInitialMode] = useState<'main' | 'move-to-group'>('main'); // Line 431
const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');      // Line 432

// Lightbox (Image Viewer)
const [lightboxImage, setLightboxImage] = useState<string | null>(null);     // Line 433
const [lightboxImages, setLightboxImages] = useState<string[]>([]);          // Line 434
const [_lightboxSource, setLightboxSource] = useState<'staged' | 'history'>('history'); // Line 435

// Info Modals
const [aboutModalOpen, setAboutModalOpen] = useState(false);                 // Line 438
const [updateCheckModalOpen, setUpdateCheckModalOpen] = useState(false);     // Line 439
const [leaderboardRegistrationOpen, setLeaderboardRegistrationOpen] = useState(false); // Line 440

// Celebration/Achievement Modals
const [standingOvationData, setStandingOvationData] = useState<{...} | null>(null);    // Lines 441-445
const [firstRunCelebrationData, setFirstRunCelebrationData] = useState<{...} | null>(null); // Lines 446-450
const [pendingKeyboardMasteryLevel, setPendingKeyboardMasteryLevel] = useState<number | null>(null); // Line 453

// Developer Tools Modals
const [logViewerOpen, setLogViewerOpen] = useState(false);                   // Line 451
const [processMonitorOpen, setProcessMonitorOpen] = useState(false);         // Line 452
const [playgroundOpen, setPlaygroundOpen] = useState(false);                 // Line 454
const [debugWizardModalOpen, setDebugWizardModalOpen] = useState(false);     // Line 455
const [debugPackageModalOpen, setDebugPackageModalOpen] = useState(false);   // Line 456
```

#### Confirmation Modal State (lines 479-481)
```typescript
const [confirmModalOpen, setConfirmModalOpen] = useState(false);
const [confirmModalMessage, setConfirmModalMessage] = useState('');
const [confirmModalOnConfirm, setConfirmModalOnConfirm] = useState<(() => void) | null>(null);
```

#### Quit Confirmation Modal State (line 484)
```typescript
const [quitConfirmModalOpen, setQuitConfirmModalOpen] = useState(false);
```

#### Rename Instance Modal State (lines 487-489)
```typescript
const [renameInstanceModalOpen, setRenameInstanceModalOpen] = useState(false);
const [renameInstanceValue, setRenameInstanceValue] = useState('');
const [renameInstanceSessionId, setRenameInstanceSessionId] = useState<string | null>(null);
```

#### Rename Tab Modal State (lines 492-494)
```typescript
const [renameTabModalOpen, setRenameTabModalOpen] = useState(false);
const [renameTabId, setRenameTabId] = useState<string | null>(null);
const [renameTabInitialName, setRenameTabInitialName] = useState('');
```

#### Rename Group Modal State (line 497)
```typescript
const [renameGroupModalOpen, setRenameGroupModalOpen] = useState(false);
```

#### Agent Sessions Browser State (lines 500-501)
```typescript
const [agentSessionsOpen, setAgentSessionsOpen] = useState(false);
const [activeAgentSessionId, setActiveAgentSessionId] = useState<string | null>(null);
```

#### Execution Queue Browser Modal State (line 506)
```typescript
const [queueBrowserOpen, setQueueBrowserOpen] = useState(false);
```

#### Batch Runner Modal State (line 509)
```typescript
const [batchRunnerModalOpen, setBatchRunnerModalOpen] = useState(false);
```

#### Auto Run Setup Modal State (line 512)
```typescript
const [autoRunSetupModalOpen, setAutoRunSetupModalOpen] = useState(false);
```

#### Wizard Resume Modal State (lines 515-516)
```typescript
const [wizardResumeModalOpen, setWizardResumeModalOpen] = useState(false);
const [wizardResumeState, setWizardResumeState] = useState<SerializableWizardState | null>(null);
```

#### Agent Error Modal State (line 519)
```typescript
const [agentErrorModalSessionId, setAgentErrorModalSessionId] = useState<string | null>(null);
```

#### Worktree Modal State (lines 522-528)
```typescript
const [worktreeConfigModalOpen, setWorktreeConfigModalOpen] = useState(false);
const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
const [createWorktreeSession, setCreateWorktreeSession] = useState<Session | null>(null);
const [createPRModalOpen, setCreatePRModalOpen] = useState(false);
const [createPRSession, setCreatePRSession] = useState<Session | null>(null);
const [deleteWorktreeModalOpen, setDeleteWorktreeModalOpen] = useState(false);
const [deleteWorktreeSession, setDeleteWorktreeSession] = useState<Session | null>(null);
```

#### Tab Switcher Modal State (line 531)
```typescript
const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
```

#### Fuzzy File Search Modal State (line 534)
```typescript
const [fuzzyFileSearchOpen, setFuzzyFileSearchOpen] = useState(false);
```

#### Prompt Composer Modal State (line 537)
```typescript
const [promptComposerOpen, setPromptComposerOpen] = useState(false);
```

#### Merge Session Modal State (line 540)
```typescript
const [mergeSessionModalOpen, setMergeSessionModalOpen] = useState(false);
```

#### Send to Agent Modal State (line 543)
```typescript
const [sendToAgentModalOpen, setSendToAgentModalOpen] = useState(false);
```

#### Group Chat Modal State (lines 546-554)
```typescript
const [showNewGroupChatModal, setShowNewGroupChatModal] = useState(false);
const [showDeleteGroupChatModal, setShowDeleteGroupChatModal] = useState<string | null>(null);
const [showRenameGroupChatModal, setShowRenameGroupChatModal] = useState<string | null>(null);
const [showEditGroupChatModal, setShowEditGroupChatModal] = useState<string | null>(null);
const [showGroupChatInfo, setShowGroupChatInfo] = useState(false);

const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
const [renameGroupValue, setRenameGroupValue] = useState('');
const [renameGroupEmoji, setRenameGroupEmoji] = useState('📂');
const [_renameGroupEmojiPickerOpen, _setRenameGroupEmojiPickerOpen] = useState(false);
```

#### Output Search State (lines 558-559)
```typescript
const [outputSearchOpen, setOutputSearchOpen] = useState(false);
const [outputSearchQuery, setOutputSearchQuery] = useState('');
```

#### Flash Notification State (lines 565-567)
```typescript
const [flashNotification, setFlashNotification] = useState<string | null>(null);
const [successFlashNotification, setSuccessFlashNotification] = useState<string | null>(null);
```

#### Global Live Mode State (lines 573-574)
```typescript
const [isLiveMode, setIsLiveMode] = useState(false);
const [webInterfaceUrl, setWebInterfaceUrl] = useState<string | null>(null);
```

---

## Summary Statistics

### Local useState Count by Category

| Category | Count |
|----------|-------|
| Spec Kit Commands | 1 |
| UI Layout State | 7 |
| Input State | 2 |
| File Explorer State | 5 |
| Git Diff/Log State | 2 |
| Tour State | 2 |
| Renaming State | 2 |
| Drag and Drop State | 2 |
| Modal Open States | 35+ |
| Confirmation Modals | 5 |
| Rename Modals | 9 |
| Agent/Session States | 4 |
| Worktree Modals | 7 |
| Group Chat Modals | 9 |
| Search/Browser States | 4 |
| Flash Notifications | 2 |
| Live Mode | 2 |
| **Total** | **~95** |

### Notes

1. **Input State Optimization**: Lines 366-369 explain that input values (`terminalInputValue`, `aiInputValueLocal`) stay in App.tsx local state to avoid context re-renders on every keystroke.

2. **Refs in this section**:
   - `preFilterActiveTabIdRef` (line 395) - tracks active tab before unread filter mode
   - `dragCounterRef` (line 421) - tracks nested drag enter/leave events
   - `lightboxIsGroupChatRef` (line 436) - tracks if lightbox opened from group chat
   - `lightboxAllowDeleteRef` (line 437) - tracks if delete should be allowed

3. **Stable Callbacks**: Lines 458-464 define stable callbacks (`handleCloseGitDiff`, `handleCloseGitLog`, `handleCloseSettings`, `handleCloseDebugPackage`) using `useCallback` to prevent modal re-renders.

---

## 2. Process Event Listeners (lines 1163-2257)

This section documents the main `useEffect` block (lines 1163-2257) that sets up event listeners for process output. The effect runs once on mount (empty dependency array) and returns a cleanup function.

### Event Handlers Summary

| Handler | Lines | Purpose |
|---------|-------|---------|
| `onData` | 1169-1269 | Process output data (BATCHED) - routes AI/terminal output to correct session/tab |
| `onExit` | 1272-1735 | Process exit - handles toast notifications, queue processing, synopsis, error cleanup |
| `onSessionId` | 1738-1811 | Claude session ID capture - stores agent session IDs on tabs |
| `onSlashCommands` | 1815-1831 | Slash commands from Claude Code init - populates `agentCommands` |
| `onStderr` | 1835-1865 | stderr output (BATCHED) - routes to correct session/tab as system logs |
| `onCommandExit` | 1868-1906 | runCommand exit - handles terminal command completion |
| `onUsage` | 1909-1957 | Usage statistics (BATCHED) - tracks token usage, context %, global stats |
| `onAgentError` | 1961-2093 | Agent errors (auth, tokens, rate limits) - shows error modal, pauses batch |
| `onThinkingChunk` | 2098-2198 | Thinking/streaming content (RAF-throttled) - appends to logs if showThinking enabled |
| `onToolExecution` | 2202-2235 | Tool execution events - appends tool logs if showThinking enabled |

### Detailed Handler Breakdown

#### `onData` (lines 1169-1269)
- Parses session ID format: `{id}-ai-{tabId}`, `{id}-terminal`, `{id}-batch-{timestamp}`
- Ignores terminal PTY output (uses plain session ID instead)
- Ignores batch task output (handled separately)
- For AI output: uses `batchedUpdater.appendLog()` for performance
- Clears error state if session receives successful data after error
- Marks tabs as unread based on visibility (active tab, active session, scroll position)

#### `onExit` (lines 1272-1735)
- **Most complex handler** (~460 lines)
- Safety check: verifies process is actually gone before transitioning to idle
- Gathers toast data BEFORE state update (React 18 StrictMode safety)
- Handles execution queue: processes next queued item after completion
- Synopsis generation: spawns background synopsis for `/commit` and similar commands
- Toast notifications: suppressed if user is viewing the completed tab
- Git ref refresh: updates branches/tags after git commands in terminal

#### `onSessionId` (lines 1738-1811)
- Ignores batch sessions (`-batch-` prefix)
- Parses tab ID from session ID format
- Registers session origin with `agentSessions.registerSessionOrigin()`
- Updates tab's `agentSessionId` and clears `awaitingSessionId` flag
- Backward compatible: also stores at session-level

#### `onSlashCommands` (lines 1815-1831)
- Converts command strings to `{ command, description }` objects
- Uses `getSlashCommandDescription()` helper for known commands
- Stores in `session.agentCommands`

#### `onStderr` (lines 1835-1865)
- Filters empty stderr
- Routes AI process stderr to correct tab with `[stderr]` prefix
- Routes terminal command stderr to shell logs

#### `onCommandExit` (lines 1868-1906)
- Handles `runCommand` exits (uses plain session ID)
- Preserves busy state if AI tabs are still busy
- Only shows exit code log if non-zero (error)

#### `onUsage` (lines 1909-1957)
- Calculates context window usage percentage
- Agent-specific context calculation (Claude vs others)
- Uses `batchedUpdater` for performance
- Updates global stats via `updateGlobalStatsRef`

#### `onAgentError` (lines 1961-2093)
- Handles group chat errors separately (moderator/participant patterns)
- Creates error log entry with `source: 'error'`
- Sets session to error state with `agentErrorPaused: true`
- Pauses active batch runs on error
- Opens error modal via `setAgentErrorModalSessionId()`

#### `onThinkingChunk` (lines 2098-2198)
- **RAF-throttled** (Phase 6.4) - batches rapid chunk arrivals to ~60fps
- Uses `thinkingChunkBufferRef` to accumulate chunks
- Only appends if `tab.showThinking` is enabled
- Detects and skips malformed content (concatenated tool names)
- Appends to existing thinking log or creates new one

#### `onToolExecution` (lines 2202-2235)
- Only shows if `tab.showThinking` is enabled
- Creates tool log entry with `source: 'tool'`
- Includes tool state in metadata

### Cleanup Function (lines 2238-2256)
- Unsubscribes all 10 event listeners
- Cancels pending thinking chunk RAF
- Clears thinking chunk buffer

---

## 3. Group Chat Event Listeners & Related Code (lines 2259-3200)

This section documents group chat event listeners, refs, error handlers, hooks integration, and input state management.

### Group Chat Event Listeners useEffect (lines 2259-2337)

Main useEffect that subscribes to group chat IPC events. Re-runs when `activeGroupChatId` changes.

| Listener | Lines | Purpose |
|----------|-------|---------|
| `onMessage` | 2262-2266 | New messages - appends to `groupChatMessages` if chat is active |
| `onStateChange` | 2268-2279 | State changes - updates both global `groupChatStates` Map and active chat state |
| `onParticipantsChanged` | 2281-2286 | Participant list updates - updates the `participants` array in `groupChats` |
| `onModeratorUsage` | 2288-2292 | Moderator usage stats - updates `moderatorUsage` for active chat |
| `onParticipantState` | 2295-2319 | Per-participant state (thinking/idle) - updates both `allGroupChatParticipantStates` and `participantStates` |
| `onModeratorSessionIdChanged` | 2321-2326 | Moderator agent session ID - stores the Claude Code session UUID on the group chat |

**Cleanup** (lines 2328-2335): Unsubscribes all 6 listeners.

### Group Chat Execution Queue useEffect (lines 2339-2360)

Processes queued messages when group chat state becomes idle:
- Triggered when `groupChatState === 'idle'` and queue is non-empty
- Takes first item from `groupChatExecutionQueue`
- Sets state to `'moderator-thinking'` (both local and in global Map)
- Calls `window.maestro.groupChat.sendToModerator()`
- Dependencies: `[groupChatState, groupChatExecutionQueue, activeGroupChatId]`

### Refs (lines 2363-2401)

#### UI Refs (lines 2363-2371)
```typescript
logsEndRef: HTMLDivElement         // Scroll anchor for AI output
inputRef: HTMLTextAreaElement      // Main input field
terminalOutputRef: HTMLDivElement  // Terminal scroll container
sidebarContainerRef: HTMLDivElement // Left sidebar scroll
fileTreeContainerRef: HTMLDivElement // File tree scroll
fileTreeFilterInputRef: HTMLInputElement // File filter input
fileTreeKeyboardNavRef: boolean    // Tracks keyboard vs mouse selection
rightPanelRef: RightPanelHandle    // Right panel imperative handle
mainPanelRef: MainPanelHandle      // Main panel imperative handle
```

#### Callback Refs (lines 2375-2382)
```typescript
addToastRef           // Latest addToast for async callbacks
updateGlobalStatsRef  // Latest updateGlobalStats for event handlers
customAICommandsRef   // Latest custom AI commands
speckitCommandsRef    // Latest spec-kit commands
```
These refs are updated every render to capture latest values for use in event handlers.

#### Processing Refs (lines 2387-2401)
```typescript
processQueuedItemRef         // Batch exit handler queue processing
_pendingRemoteCommandRef     // Web interface command routing
pauseBatchOnErrorRef         // Batch processor error handling (Phase 5.10)
getBatchStateRef             // Batch state getter
thinkingChunkBufferRef       // RAF-throttled thinking chunk buffer (Phase 6.4)
thinkingChunkRafIdRef        // RAF ID for cleanup
```

### Debug Window Exposure useEffect (lines 2403-2422)

Exposes `window.__maestroDebug` for testing:
- `addToast(type, title, message)` - trigger toast from console
- `testToast()` - quick test with sample notification

### State & Memos (lines 2424-2589)

#### Keyboard Navigation (lines 2424-2429)
```typescript
selectedSidebarIndex  // Current sidebar selection index
activeTabForError     // Memoized active tab for error modal display
```

#### Slash Command Discovery useEffect (lines 2431-2522)
- Runs when active session changes
- Only for `claude-code` agent type
- Fetches custom commands from `.claude/commands/` directories (fast, file reads)
- Discovers built-in agent commands (slower, spawns Claude briefly)
- Merges commands without duplicates

#### File Preview History (lines 2524-2551)
```typescript
filePreviewHistory      // Memoized from activeSession
filePreviewHistoryIndex // Memoized from activeSession
setFilePreviewHistory   // Updates session's history array
setFilePreviewHistoryIndex // Updates session's history index
```

#### Theme & Memos (lines 2553-2589)
```typescript
theme              // Computed theme (custom vs standard)
gitViewerCwd       // Memoized CWD for git viewers
sessionsForValidation // Memoized sessions only when modal open (PERF)
hasNoAgents        // Memoized boolean for settings modal
errorSession       // Memoized session with active error
```

### Agent Error Handlers (lines 2592-2706)

| Handler | Lines | Purpose |
|---------|-------|---------|
| `handleCloseAgentErrorModal` | 2592-2594 | Closes modal without clearing error |
| `handleClearAgentError` | 2596-2620 | Clears error state, resets session to idle, notifies main process |
| `handleStartNewSessionAfterError` | 2623-2640 | Creates new tab after error recovery |
| `handleRetryAfterError` | 2643-2649 | Clears error and focuses input for retry |
| `handleRestartAgentAfterError` | 2652-2669 | Kills existing process (respawn on next message) |
| `handleAuthenticateAfterError` | 2671-2682 | Switches to terminal mode for OAuth/auth flows |

#### Error Recovery Hooks (lines 2685-2706)
- `useAgentErrorRecovery` for session errors - generates recovery action buttons
- `useAgentErrorRecovery` for group chat errors - uses `handleClearGroupChatError`

### Completion Hooks & Integration (lines 2709-2760)

| Hook | Lines | Purpose |
|------|-------|---------|
| `useTabCompletion` | 2709 | Terminal mode tab completion |
| `useAtMentionCompletion` | 2712 | AI mode @ mention completion |
| `useRemoteIntegration` | 2715-2724 | Web interface communication |
| `useWebBroadcasting` | 2727-2729 | External history change notifications |
| `useCliActivityMonitoring` | 2732-2734 | CLI playbook run tracking |
| Quit confirmation useEffect | 2737-2754 | Shows modal for busy agent quit attempts |
| `useThemeStyles` | 2757-2759 | CSS variables and scrollbar animations |
| `useAgentCapabilities` | 2762 | Active session agent capabilities |

### Merge Session Hook (lines 2765-2842)

`useMergeSessionWithSessions` - Context merge operations:
- `mergeState`, `mergeProgress`, `mergeError`, `mergeStartTime`
- `executeMerge`, `cancelMergeTab`, `clearMergeTabState`, `resetMerge`
- `onSessionCreated` callback: navigates to merged session, shows toast
- `onMergeComplete` callback: shows toast for merge into existing tab

### Send to Agent Hook (lines 2845-2883)

`useSendToAgentWithSessions` - Cross-agent context transfer:
- State tracking: `transferSourceAgent`, `transferTargetAgent`
- `transferState`, `transferProgress`, `executeTransfer`, `cancelTransfer`, `resetTransfer`
- `onSessionCreated` callback: navigates to session, shows toast & desktop notification

### Summarize & Continue Hook (lines 2885-2954)

`useSummarizeAndContinue` - Context compaction:
- `summarizeState`, `summarizeProgress`, `summarizeResult`
- `startSummarize`, `cancelTab`, `clearTabState`
- `canSummarize`, `minContextUsagePercent`
- `handleSummarizeAndContinue` callback: validates context usage, starts summarization, updates session, shows toast

### Slash Command Aggregation (lines 2956-2984)

`allSlashCommands` memo - Combines all command sources:
1. Built-in `slashCommands`
2. Custom AI commands (`customCommandsAsSlash`)
3. Spec-kit commands (`speckitCommandsAsSlash`)
4. Agent-specific commands (if `supportsSlashCommands` capability)

### Input State Management (lines 2986-3200)

#### Mode Detection (lines 2986-3001)
```typescript
isAiMode          // activeSession?.inputMode === 'ai'
activeTab         // Memoized getActiveTab(activeSession)
isResumingSession // Boolean: has agentSessionId
canAttachImages   // Capability check (resume vs new)
```

#### Tab Switching useEffects (lines 3003-3087)
- **Tab switch** (3011-3051): Saves AI input to previous tab, loads from new tab, clears unread
- **Session switch** (3069-3087): Saves terminal input to previous session, loads from new

#### Input Sync Hooks (lines 3053-3065)
- `useInputSync` - AI and terminal input synchronization
- `useSessionNavigation` - Back/forward navigation handlers

#### Input Value Derivation (lines 3089-3119)
```typescript
inputValue       // isAiMode ? aiInputValueLocal : terminalInputValue
setInputValue    // isAiMode ? setAiInputValueLocal : setTerminalInputValue
stagedImages     // Memoized from activeTab
setStagedImages  // Updates activeTab's stagedImages
```

#### Log Helpers (lines 3121-3168)
```typescript
addLogToTab(sessionId, logEntry, tabId?)  // Routes log to specific tab
addLogToActiveTab(sessionId, logEntry)    // Convenience wrapper for active tab
```

#### Completion Suggestions (lines 3170-3210)
```typescript
tabCompletionSuggestions  // Memoized terminal tab completion results
atMentionSuggestions      // Memoized AI @ mention results
syncFileTreeToTabCompletion // Highlights file in tree during tab completion
```

---

## 4. Render Section Helper Functions (lines 6749-7102)

This section documents helper functions and hooks at the start of the render section, handling file tree operations, group management, keyboard handler registration, and file explorer navigation.

### Render Section Marker (line 6749)
```typescript
// --- RENDER ---
```

### File Interaction Helpers (lines 6753-6844)

#### `handleFileClick` (lines 6753-6795)
```typescript
const handleFileClick = useCallback(async (node: any, path: string) => { ... }, [...]);
```
**Purpose**: Handles file selection in the file explorer tree.

**Behavior**:
- Guards against null session
- For files with external associations (images, docs, etc.), shows confirmation modal via `setConfirmModalMessage/setConfirmModalOnConfirm/setConfirmModalOpen`, then opens with `window.maestro.shell.openExternal()`
- For text files, reads content via `window.maestro.fs.readFile(fullPath)`
- Opens file in tab-based preview system via `onOpenFileTab` callback
- Updates `activeFocus` to main panel

**Dependencies**: `activeSession`, confirmation modal setters, `setActiveFocus`, `onOpenFileTab`

#### `updateSessionWorkingDirectory` (lines 6798-6812)
```typescript
const updateSessionWorkingDirectory = async () => { ... };
```
**Purpose**: Opens folder picker to change session's working directory.

**Behavior**:
- Opens native folder dialog via `window.maestro.dialog.selectFolder()`
- Updates session's `cwd`, `fullPath`, clears `fileTree` and `fileTreeError`

**Not memoized**: Simple async function, no deps.

#### `toggleFolder` (lines 6814-6826)
```typescript
const toggleFolder = useCallback((path: string, sessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => { ... }, []);
```
**Purpose**: Toggles folder expansion state in file tree.

**Behavior**:
- Finds session by `sessionId`
- Toggles path in `fileExplorerExpanded` Set

**Stable**: Empty dependency array.

#### `expandAllFolders` (lines 6828-6836)
```typescript
const expandAllFolders = (sessionId: string, session: Session, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => { ... };
```
**Purpose**: Expands all folders in file tree using `getAllFolderPaths()` utility.

**Not memoized**: Uses `getAllFolderPaths` from `./utils/fileExplorer`.

#### `collapseAllFolders` (lines 6838-6844)
```typescript
const collapseAllFolders = (sessionId: string, setSessions: React.Dispatch<React.SetStateAction<Session[]>>) => { ... };
```
**Purpose**: Collapses all folders by setting `fileExplorerExpanded` to empty array.

**Not memoized**: Simple state update.

### Extracted Hooks (lines 6846-6886)

#### `useFileTreeManagement` Hook (lines 6848-6860)
```typescript
const {
  refreshFileTree,
  refreshGitFileState,
  filteredFileTree,
} = useFileTreeManagement({ ... });
```
**Provides**:
- `refreshFileTree` - Fetches file tree from disk
- `refreshGitFileState` - Updates git status of files
- `filteredFileTree` - Memoized filtered tree based on `fileTreeFilter`

**Dependencies**: `sessions`, `sessionsRef`, `setSessions`, `activeSessionId`, `activeSession`, `fileTreeFilter`, `rightPanelRef`

#### `useGroupManagement` Hook (lines 6862-6880)
```typescript
const {
  toggleGroup,
  startRenamingGroup,
  finishRenamingGroup,
  createNewGroup,
  handleDropOnGroup,
  handleDropOnUngrouped,
  modalState: groupModalState,
} = useGroupManagement({ ... });
```
**Provides**:
- Group CRUD operations: `toggleGroup`, `startRenamingGroup`, `finishRenamingGroup`, `createNewGroup`
- Drag-drop handlers: `handleDropOnGroup`, `handleDropOnUngrouped`
- Modal state: `{ createGroupModalOpen, setCreateGroupModalOpen }`

**Dependencies**: `groups`, `setGroups`, `setSessions`, `draggingSessionId`, `setDraggingSessionId`, `editingGroupId`, `setEditingGroupId`

### Keyboard Handler Registration (lines 6888-6929)

```typescript
keyboardHandlerRef.current = { ... };
```
**Purpose**: Synchronously updates the keyboard handler ref during render (before effects run).

**Contains ~100+ fields** organized by category:
- **Navigation state**: `shortcuts`, `activeFocus`, `activeRightTab`, etc.
- **Modal states**: All modal open booleans
- **Session data**: `sessions`, `activeSession`, `groups`, etc.
- **Modal setters**: All modal open setters
- **Navigation handlers**: `cycleSession`, `toggleInputMode`, etc.
- **Tab operations**: `createTab`, `closeTab`, `reopenClosedTab`, etc.
- **Group chat context**: `activeGroupChatId`, `groupChatInputRef`, etc.
- **Merge/transfer modals**: `setMergeSessionModalOpen`, `setSendToAgentModalOpen`
- **Summarize helpers**: `canSummarizeActiveTab`, `summarizeAndContinue`
- **Gamification**: `recordShortcutUsage`, `onKeyboardMasteryLevelUp`

**Note**: This must be placed after all handler functions are defined to avoid TDZ (temporal dead zone) errors.

### Flat File List Management (lines 6931-6955)

```typescript
useEffect(() => {
  // Update flat file list when active session's tree, expanded folders, filter, or hidden files setting changes
  ...
}, [activeSession?.fileExplorerExpanded, filteredFileTree, showHiddenFiles]);
```
**Purpose**: Flattens hierarchical file tree into linear list for keyboard navigation.

**Behavior**:
- Guards for null session or missing `fileExplorerExpanded`
- Applies hidden files filter (`.` prefix) based on `showHiddenFiles` setting
- Uses `flattenTree()` utility from `./utils/fileExplorer`

### Pending Jump Path Handler (lines 6957-6988)

```typescript
useEffect(() => {
  if (!activeSession || activeSession.pendingJumpPath === undefined || flatFileList.length === 0) return;
  // Handle pending jump path from /jump command
  ...
}, [activeSession?.pendingJumpPath, flatFileList, activeSession?.id]);
```
**Purpose**: Handles `/jump` command navigation to specific folder.

**Behavior**:
- Finds target folder index in `flatFileList`
- Sets `fileTreeKeyboardNavRef.current = true` to trigger scroll
- Updates `selectedFileIndex`
- Clears `pendingJumpPath` from session

### Scroll-to-Selection Handler (lines 6990-7020)

```typescript
useEffect(() => {
  // Scroll to selected file item when selection changes via keyboard
  ...
}, [selectedFileIndex, activeFocus, activeRightTab, flatFileList, tabCompletionOpen]);
```
**Purpose**: Scrolls file tree to bring selected item into view.

**Behavior**:
- Only scrolls on keyboard navigation (checks `fileTreeKeyboardNavRef.current`)
- Allows scroll when: (a) right panel focused on files, OR (b) tab completion open on files
- Uses `scrollIntoView({ block: 'center' })` to avoid sticky header overlap

### File Explorer Keyboard Navigation (lines 7022-7102)

```typescript
useEffect(() => {
  const handleFileExplorerKeys = (e: KeyboardEvent) => { ... };
  window.addEventListener('keydown', handleFileExplorerKeys);
  return () => window.removeEventListener('keydown', handleFileExplorerKeys);
}, [...]);
```
**Purpose**: Handles keyboard navigation in file explorer.

**Key Bindings**:
| Key Combo | Action |
|-----------|--------|
| `Cmd/Ctrl+↑` | Jump to top |
| `Cmd/Ctrl+↓` | Jump to bottom |
| `Alt+↑` | Page up (10 items) |
| `Alt+↓` | Page down (10 items) |
| `↑` | Move up one item |
| `↓` | Move down one item |
| `←` | Collapse folder or navigate to parent |
| `→` | Expand folder |
| `Enter` | Toggle folder or open file |

**Dependencies**: `activeFocus`, `activeRightTab`, `flatFileList`, `selectedFileIndex`, `activeSession?.fileExplorerExpanded`, `activeSessionId`, `setSessions`, `toggleFolder`, `handleFileClick`, `hasOpenModal`

### JSX Render Start (line 7104)

```typescript
return (
  <GitStatusProvider sessions={sessions} activeSessionId={activeSessionId}>
    <div className={`flex h-screen w-full font-mono overflow-hidden ...`}
         ...>
```

---

## Summary: Render Section Helper Functions

| Function/Hook | Lines | Type | Purpose |
|---------------|-------|------|---------|
| `handleFileClick` | 6753-6795 | `useCallback` | Open file in preview or external app |
| `updateSessionWorkingDirectory` | 6798-6812 | `async function` | Change session working directory |
| `toggleFolder` | 6814-6826 | `useCallback` | Toggle folder expansion |
| `expandAllFolders` | 6828-6836 | `function` | Expand all folders |
| `collapseAllFolders` | 6838-6844 | `function` | Collapse all folders |
| `useFileTreeManagement` | 6848-6860 | Hook | File tree refresh and filtering |
| `useGroupManagement` | 6862-6880 | Hook | Group CRUD and drag-drop |
| Keyboard handler ref | 6888-6929 | Ref assignment | Centralized keyboard handler state |
| Flat file list effect | 6931-6955 | `useEffect` | Flatten tree for keyboard nav |
| Jump path effect | 6957-6988 | `useEffect` | Handle /jump command |
| Scroll-to-selection effect | 6990-7020 | `useEffect` | Scroll to keyboard selection |
| File explorer keys effect | 7022-7102 | `useEffect` | Keyboard navigation bindings |

### Imported Utilities (from `./utils/fileExplorer`)

- `shouldOpenExternally(filename)` - Check if file should open in external app
- `getAllFolderPaths(nodes, currentPath)` - Get all folder paths for expand-all
- `flattenTree(nodes, expandedSet, prefix)` - Flatten tree for keyboard navigation

---

## 5. Modal Component JSX Inventory (lines 7194-9639)

This section catalogs all modal components rendered in the JSX, their open state variables, and line ranges.

### Modal Checklist

| # | Modal Component | Open State Variable | Lines | Conditional Guard | Notes |
|---|-----------------|-------------------|-------|-------------------|-------|
| 1 | `QuickActionsModal` | `quickActionOpen` | 7194-7353 | `{quickActionOpen && ...}` | Opens via Cmd+K, many setters passed |
| 2 | `LightboxModal` | `lightboxImage` (string) | 7354-7380 | `{lightboxImage && ...}` | Image viewer, uses `lightboxImages` array |
| 3 | `GitDiffViewer` | `gitDiffPreview` (string) | 7383-7390 | `{gitDiffPreview && activeSession && ...}` | Not a modal but overlay viewer |
| 4 | `GitLogViewer` | `gitLogOpen` | 7393-7399 | `{gitLogOpen && activeSession && ...}` | Not a modal but overlay viewer |
| 5 | `ShortcutsHelpModal` | `shortcutsHelpOpen` | 7402-7411 | `{shortcutsHelpOpen && ...}` | Simple props |
| 6 | `AboutModal` | `aboutModalOpen` | 7414-7426 | `{aboutModalOpen && ...}` | Opens leaderboard modal |
| 7 | `LeaderboardRegistrationModal` | `leaderboardRegistrationOpen` | 7429-7443 | `{leaderboardRegistrationOpen && ...}` | Registration form |
| 8 | `UpdateCheckModal` | `updateCheckModalOpen` | 7446-7451 | `{updateCheckModalOpen && ...}` | Simple props |
| 9 | `DebugPackageModal` | `debugPackageModalOpen` | 7454-7458 | Always rendered (isOpen prop) | Uses isOpen pattern |
| 10 | `AgentErrorModal` (session) | `errorSession?.agentError` | 7461-7471 | `{errorSession?.agentError && ...}` | Error recovery modal |
| 11 | `AgentErrorModal` (group chat) | `groupChatError` | 7474-7484 | `{groupChatError && ...}` | Reuses same component |
| 12 | `WorktreeConfigModal` | `worktreeConfigModalOpen` | 7487-7751 | `{worktreeConfigModalOpen && activeSession && ...}` | Complex: session scanning, worktree creation |
| 13 | `CreateWorktreeModal` | `createWorktreeModalOpen` | 7753-7882 | `{createWorktreeModalOpen && createWorktreeSession && ...}` | Creates worktree + new session |
| 14 | `MergeSessionModal` | `mergeSessionModalOpen` | 7885-7922 | `{mergeSessionModalOpen && activeSession && activeSession.activeTabId && ...}` | Context merge UI |
| 15 | `TransferProgressModal` | Derived from `transferState` | 7925-7946 | `{(transferState === 'grooming' \|\| ...) && ...}` | Progress indicator |
| 16 | `SendToAgentModal` | `sendToAgentModalOpen` | 7949-8039 | `{sendToAgentModalOpen && activeSession && activeSession.activeTabId && ...}` | Agent transfer UI |
| 17 | `CreatePRModal` | `createPRModalOpen` | 8042-8083 | `{createPRModalOpen && (createPRSession \|\| activeSession) && ...}` | PR creation form |
| 18 | `DeleteWorktreeModal` | `deleteWorktreeModalOpen` | 8086-8107 | `{deleteWorktreeModalOpen && deleteWorktreeSession && ...}` | Delete confirmation |
| 19 | `FirstRunCelebration` | `firstRunCelebrationData` (object) | 8110-8120 | `{firstRunCelebrationData && ...}` | Celebration overlay |
| 20 | `KeyboardMasteryCelebration` | `pendingKeyboardMasteryLevel` | 8123-8130 | `{pendingKeyboardMasteryLevel !== null && ...}` | Achievement overlay |
| 21 | `StandingOvationOverlay` | `standingOvationData` (object) | 8133-8149 | `{standingOvationData && ...}` | Achievement overlay |
| 22 | `ProcessMonitor` | `processMonitorOpen` | 8151-8176 | `{processMonitorOpen && ...}` | Developer tool |
| 23 | `PlaygroundPanel` | `playgroundOpen` | 8178-8185 | `{playgroundOpen && ...}` | Developer tool |
| 24 | `DebugWizardModal` | `debugWizardModalOpen` | 8188-8192 | Always rendered (isOpen prop) | Uses isOpen pattern |
| 25 | `NewGroupChatModal` | `showNewGroupChatModal` | 8195-8201 | `{showNewGroupChatModal && ...}` | Group chat creation |
| 26 | `DeleteGroupChatModal` | `showDeleteGroupChatModal` (string\|null) | 8204-8211 | `{showDeleteGroupChatModal && ...}` | Delete confirmation |
| 27 | `RenameGroupChatModal` | `showRenameGroupChatModal` (string\|null) | 8214-8221 | `{showRenameGroupChatModal && ...}` | Rename input |
| 28 | `EditGroupChatModal` | `showEditGroupChatModal` (string\|null) | 8224-8231 | `{showEditGroupChatModal && ...}` | Edit participants |
| 29 | `GroupChatInfoOverlay` | `showGroupChatInfo` | 8234-8243 | `{showGroupChatInfo && activeGroupChatId && ...}` | Info overlay |
| 30 | `CreateGroupModal` | `createGroupModalOpen` | 8246-8255 | `{createGroupModalOpen && ...}` | Session group creation |
| 31 | `ConfirmModal` | `confirmModalOpen` | 8258-8265 | `{confirmModalOpen && ...}` | Generic confirmation |
| 32 | `QuitConfirmModal` | `quitConfirmModalOpen` | 8268-8288 | `{quitConfirmModalOpen && ...}` | IIFE pattern for busyAgents |
| 33 | `RenameSessionModal` | `renameInstanceModalOpen` | 8291-8306 | `{renameInstanceModalOpen && ...}` | Rename session |
| 34 | `RenameTabModal` | `renameTabModalOpen` | 8309-8357 | `{renameTabModalOpen && renameTabId && ...}` | Rename tab + persist |
| 35 | `RenameGroupModal` | `renameGroupModalOpen` | 8360-8372 | `{renameGroupModalOpen && renameGroupId && ...}` | Rename session group |
| 36 | `AutoRunSetupModal` | `autoRunSetupModalOpen` | 9249-9257 | `{autoRunSetupModalOpen && ...}` | Folder selection |
| 37 | `BatchRunnerModal` | `batchRunnerModalOpen` | 9260-9282 | `{batchRunnerModalOpen && activeSession && activeSession.autoRunFolderPath && ...}` | Batch run config |
| 38 | `TabSwitcherModal` | `tabSwitcherOpen` | 9285-9307 | `{tabSwitcherOpen && activeSession?.aiTabs && ...}` | Tab selection |
| 39 | `FileSearchModal` | `fuzzyFileSearchOpen` | 9310-9323 | `{fuzzyFileSearchOpen && activeSession && ...}` | Fuzzy file search |
| 40 | `PromptComposerModal` | `promptComposerOpen` | 9326-9433 | Always rendered (isOpen prop) | Complex: dual context (session/group chat) |
| 41 | `ExecutionQueueBrowser` | `queueBrowserOpen` | 9436-9463 | Always rendered (isOpen prop) | Queue management |
| 42 | `NewInstanceModal` | `newInstanceModalOpen` | 9468-9474 | Always rendered (isOpen prop) | New session creation |
| 43 | `EditAgentModal` | `editAgentModalOpen` | 9477-9492 | Always rendered (isOpen prop) | Edit session config |
| 44 | `SettingsModal` | `settingsModalOpen` | 9495-9564 | Always rendered (isOpen prop) | Large: ~70 props |
| 45 | `WizardResumeModal` | `wizardResumeModalOpen` | 9567-9626 | `{wizardResumeModalOpen && wizardResumeState && ...}` | Resume wizard prompt |
| 46 | `MaestroWizard` | `wizardState.isOpen` | 9630-9638 | `{wizardState.isOpen && ...}` | Full wizard overlay |

### Summary Statistics

| Metric | Count |
|--------|-------|
| Total modal-like components | 46 |
| Conditional render (`{condition && <Modal />}`) | 37 |
| Always rendered (uses `isOpen` prop) | 9 |
| Simple modals (≤5 props + theme/onClose) | 12 |
| Medium complexity (5-15 props) | 18 |
| Complex modals (>15 props or inline handlers) | 16 |
| Overlay/celebration components | 4 |
| Developer tools | 4 |
| Git-related modals | 5 |
| Group chat modals | 5 |
| Rename modals | 4 |

### Open State Variable Patterns

1. **Boolean states** (most common): `settingsModalOpen`, `shortcutsHelpOpen`, etc.
2. **String/null states**: `lightboxImage`, `showDeleteGroupChatModal` (stores ID)
3. **Object/null states**: `standingOvationData`, `firstRunCelebrationData`
4. **Derived states**: `errorSession?.agentError`, `wizardState.isOpen`

### Modals Using `isOpen` Prop Pattern (always rendered)

These 9 modals are always in the DOM and use the `isOpen` prop to control visibility:
- `DebugPackageModal`
- `DebugWizardModal`
- `PromptComposerModal`
- `ExecutionQueueBrowser`
- `NewInstanceModal`
- `EditAgentModal`
- `SettingsModal`
- `TransferProgressModal` (conditionally rendered but also uses isOpen)

---

## 6. Modal JSX Line Count & Complexity Analysis

This section provides detailed line counts and complexity analysis for the modal render section.

### Total Modal JSX Lines

The modal section spans from line 7192 (`{/* --- MODALS --- */}`) to line 9689 (end of flash notifications), totaling **~2,497 lines** of JSX dedicated to modals and overlays.

| Section | Lines | Line Count | % of Modal Section |
|---------|-------|------------|-------------------|
| Modals marker + QuickActionsModal | 7192-7353 | 161 | 6.4% |
| LightboxModal | 7354-7380 | 26 | 1.0% |
| Git viewers (Diff + Log) | 7383-7399 | 16 | 0.6% |
| Info modals (Shortcuts, About, Leaderboard, Update) | 7402-7451 | 49 | 2.0% |
| Debug modals | 7454-7458, 8188-8192 | 9 | 0.4% |
| Error modals (Session + Group Chat) | 7461-7484 | 23 | 0.9% |
| **Worktree modals** | 7487-7882 | **395** | **15.8%** |
| Merge/Transfer modals | 7885-8039 | 154 | 6.2% |
| PR/Delete worktree modals | 8042-8107 | 65 | 2.6% |
| Celebration overlays | 8110-8149 | 39 | 1.6% |
| Developer tools | 8151-8185 | 34 | 1.4% |
| Group chat modals | 8195-8243 | 48 | 1.9% |
| Session group/confirm modals | 8246-8288 | 42 | 1.7% |
| Rename modals | 8291-8372 | 81 | 3.2% |
| EmptyStateView | 8375-8387 | 12 | 0.5% |
| SessionList (left sidebar) | 8389-8501 | 112 | 4.5% |
| LogViewer section | 8503-8520 | 17 | 0.7% |
| GroupChatPanel + RightPanel | 8522-8606 | 84 | 3.4% |
| MainPanel + RightPanel | 8608-9246 | 638 | 25.6% |
| Auto Run modals | 9249-9282 | 33 | 1.3% |
| Tab/File modals | 9285-9323 | 38 | 1.5% |
| **PromptComposerModal** | 9326-9433 | **107** | **4.3%** |
| ExecutionQueueBrowser | 9436-9463 | 27 | 1.1% |
| NewInstance + EditAgent | 9468-9492 | 24 | 1.0% |
| **SettingsModal** | 9495-9564 | **69** | **2.8%** |
| WizardResumeModal | 9567-9626 | 59 | 2.4% |
| MaestroWizard + TourOverlay | 9630-9657 | 27 | 1.1% |
| Flash notifications | 9659-9688 | 29 | 1.2% |

### Modals with Complex Inline Handlers

These modals contain substantial inline logic (>10 lines of inline code) that could be extracted:

| Modal | Lines | Handler Description | Extraction Priority |
|-------|-------|---------------------|---------------------|
| **QuickActionsModal** | 7194-7353 | 5 inline handlers: `onRenameTab`, `onToggleReadOnlyMode`, `onToggleTabShowThinking`, `onOpenTabSwitcher`, `onRefreshGitFileState`, `onDebugReleaseQueuedItem`, `onEditAgent`, `onNewGroupChat`, `onOpenCreatePR`, `onToggleRemoteControl`, `onAutoRunResetTasks` | HIGH - can extract to `useQuickActionsHandlers` |
| **WorktreeConfigModal** | 7487-7751 | 2 massive inline handlers: `onSaveConfig` (~135 lines), `onCreateWorktree` (~112 lines) - both create sessions with full config | HIGH - extract to `useWorktreeHandlers` |
| **CreateWorktreeModal** | 7753-7882 | 1 inline handler: `onCreateWorktree` (~105 lines) - duplicates logic from WorktreeConfigModal | HIGH - share handler with WorktreeConfigModal |
| **SendToAgentModal** | 7949-8039 | 1 inline handler: `onSend` (~80 lines) - creates new tab, transfers context | MEDIUM - extract to `useContextTransferHandlers` |
| **CreatePRModal** | 8042-8083 | 1 inline handler: `onPRCreated` (~25 lines) - history entry creation | LOW - simple enough |
| **RenameTabModal** | 8309-8357 | 1 inline handler: `onRename` (~35 lines) - persists to multiple storages | MEDIUM - extract to `useTabRenameHandler` |
| **PromptComposerModal** | 9326-9433 | 5 inline handlers with dual context (session vs group chat) | MEDIUM - refactor for cleaner context handling |

### Modals with Simple Props (Easy Extraction)

These modals receive only `theme`, `isOpen`/condition, `onClose`, and 0-3 additional props:

| Modal | Props Count | Notes |
|-------|-------------|-------|
| `UpdateCheckModal` | 2 | Only `theme`, `onClose` |
| `DebugPackageModal` | 3 | Uses `isOpen` pattern |
| `DebugWizardModal` | 3 | Uses `isOpen` pattern |
| `NewGroupChatModal` | 4 | Simple `onCreate` callback |
| `DeleteGroupChatModal` | 5 | ID-based `onConfirm` |
| `RenameGroupChatModal` | 5 | ID + new name `onRename` |
| `EditGroupChatModal` | 5 | Passthrough `onSave` |
| `CreateGroupModal` | 4 | Simple group creation |
| `ConfirmModal` | 4 | Generic confirmation |
| `PlaygroundPanel` | 3 | Developer tool |
| `KeyboardMasteryCelebration` | 4 | Achievement overlay |
| `FirstRunCelebration` | 6 | Celebration overlay |

### Handler Extraction Opportunities

| Handler Pattern | Occurrences | Suggested Hook |
|----------------|-------------|----------------|
| Session creation with full config | 3 (WorktreeConfig x2, CreateWorktree) | `useSessionFactory` |
| Context transfer (tabs/sessions) | 2 (MergeSession, SendToAgent) | `useContextTransfer` |
| Git operations (branches, tags) | 3 (WorktreeConfig, CreateWorktree, CreatePR) | Already have `gitService` |
| Toast + history entry | 4+ (CreatePR, worktree ops, merge) | `useOperationWithHistory` |
| Dual context (session/group chat) | 3 (PromptComposer, input handlers, lightbox) | `useContextAwareState` |

### Inline Handler Code Volume

Estimated lines of inline handler code in modal JSX:

| Complexity Level | Modal Count | Avg Lines per Modal | Total Lines |
|-----------------|-------------|---------------------|-------------|
| Complex (>50 lines inline) | 5 | ~120 | ~600 |
| Medium (20-50 lines inline) | 8 | ~35 | ~280 |
| Simple (<20 lines inline) | 12 | ~8 | ~96 |
| No inline handlers | 21 | 0 | 0 |
| **Total inline handler code** | | | **~976 lines** |

This represents approximately **39%** of the modal section consisting of inline handlers that could be extracted to separate hooks or utilities.

---

## 7. Self-Contained Extractions

Components that can be extracted with minimal dependencies. These are ideal first candidates for refactoring because they have clean interfaces and don't require access to internal App.tsx state.

### 7.1 Simple Modals (Only `theme`, `isOpen`, `onClose`, and Simple Callbacks)

These modals have self-contained logic and minimal prop requirements:

| Modal | Props | Lines | Extraction Notes |
|-------|-------|-------|------------------|
| `UpdateCheckModal` | `theme`, `onClose` | 7446-7451 | ✅ Ready - simplest modal |
| `DebugPackageModal` | `theme`, `isOpen`, `onClose` | 7454-7458 | ✅ Ready - uses isOpen pattern |
| `DebugWizardModal` | `theme`, `isOpen`, `onClose` | 8188-8192 | ✅ Ready - uses isOpen pattern |
| `PlaygroundPanel` | `theme`, `themeMode`, `onClose` | 8178-8185 | ✅ Ready - developer tool |
| `ConfirmModal` | `theme`, `message`, `onConfirm`, `onClose` | 8258-8265 | ✅ Ready - generic confirmation |
| `NewGroupChatModal` | `theme`, `isOpen`, `onClose`, `onCreate` | 8195-8201 | ✅ Ready - simple callback |
| `DeleteGroupChatModal` | `theme`, `isOpen`, `groupChatName`, `onClose`, `onConfirm` | 8204-8211 | ✅ Ready - ID-based |
| `RenameGroupChatModal` | `theme`, `isOpen`, `currentName`, `onClose`, `onRename` | 8214-8221 | ✅ Ready - simple rename |
| `EditGroupChatModal` | `theme`, `isOpen`, `groupChat`, `onClose`, `onSave` | 8224-8231 | ✅ Ready - passthrough save |
| `CreateGroupModal` | `theme`, `onClose`, `groups`, `setGroups` | 8246-8255 | ⚠️ Needs state setters |

**Extraction Strategy**: These modals can be rendered from a dedicated `<AppModals />` component that receives the minimal required props via a context or prop drilling.

### 7.2 Overlay Components (Celebrations, Flash Notifications)

Self-contained overlays that only need display data and dismiss callbacks:

| Component | Props | Lines | Extraction Notes |
|-----------|-------|-------|------------------|
| `FirstRunCelebration` | `theme`, `elapsedTimeMs`, `completedTasks`, `totalTasks`, `onClose`, `onOpenLeaderboardRegistration`, `isLeaderboardRegistered` | 8110-8120 | ✅ Ready - data + callbacks |
| `KeyboardMasteryCelebration` | `theme`, `level`, `onClose`, `shortcuts` | 8123-8130 | ✅ Ready - level + shortcuts |
| `StandingOvationOverlay` | `theme`, `themeMode`, `badge`, `isNewRecord`, `recordTimeMs`, `cumulativeTimeMs`, `onClose`, `onOpenLeaderboardRegistration`, `isLeaderboardRegistered` | 8133-8149 | ✅ Ready - achievement data |
| Flash Notification (warning) | Inline JSX | 9659-9671 | ⚠️ Extract to `FlashNotification` component |
| Flash Notification (success) | Inline JSX | 9673-9685 | ⚠️ Extract to `FlashNotification` component |
| `ToastContainer` | `theme`, `onSessionClick` | 9687-9688 | ✅ Already extracted |

**Extraction Strategy**: Create `<CelebrationOverlays />` component that handles all three celebration types. Extract inline flash notifications to a reusable `<FlashNotification variant="warning|success" message={...} />` component.

### 7.3 Helper Functions (No Component State Dependencies)

Pure functions and constants that can be moved to `src/renderer/constants/app.ts` or `src/renderer/utils/`:

| Item | Type | Lines | Target Location |
|------|------|-------|-----------------|
| `KNOWN_TOOL_NAMES` | Constant array | 145-150 | `src/renderer/constants/toolNames.ts` |
| `CLAUDE_BUILTIN_COMMANDS` | Constant object | 197-208 | `src/renderer/constants/slashCommands.ts` |
| `isLikelyConcatenatedToolNames()` | Pure function | 156-193 | `src/renderer/utils/toolNames.ts` |
| `getSlashCommandDescription()` | Pure function | 210-227 | `src/renderer/utils/slashCommands.ts` |

**Dependencies Analysis**:
- `isLikelyConcatenatedToolNames()` only uses `KNOWN_TOOL_NAMES` constant
- `getSlashCommandDescription()` only uses `CLAUDE_BUILTIN_COMMANDS` constant
- Neither function accesses React state, refs, or callbacks

**Extraction Strategy**:
1. Create `src/renderer/constants/toolNames.ts` with `KNOWN_TOOL_NAMES`
2. Create `src/renderer/utils/toolNames.ts` with `isLikelyConcatenatedToolNames()`
3. Create `src/renderer/constants/slashCommands.ts` with `CLAUDE_BUILTIN_COMMANDS`
4. Create `src/renderer/utils/slashCommands.ts` with `getSlashCommandDescription()`
5. Update imports in App.tsx

### 7.4 Git Viewers (Overlay Pattern)

These viewers follow the overlay pattern and have minimal state dependencies:

| Component | Props | Lines | Extraction Notes |
|-----------|-------|-------|------------------|
| `GitDiffViewer` | `theme`, `diff`, `cwd`, `onClose` | 7383-7390 | ✅ Ready - only needs diff string and cwd |
| `GitLogViewer` | `theme`, `cwd`, `onClose` | 7393-7399 | ✅ Ready - fetches own data |

**Extraction Strategy**: These can be wrapped in a `<GitOverlays />` component.

### 7.5 Info & Help Modals

Modals that display information with minimal interactivity:

| Modal | Props | Lines | Extraction Notes |
|-------|-------|-------|------------------|
| `ShortcutsHelpModal` | `theme`, `shortcuts`, `tabShortcuts`, `onClose`, `hasNoAgents`, `keyboardMasteryStats` | 7402-7411 | ⚠️ Needs shortcuts config |
| `AboutModal` | `theme`, `sessions`, `autoRunStats`, `onClose`, `onOpenLeaderboardRegistration`, `isLeaderboardRegistered` | 7414-7426 | ⚠️ Needs sessions for stats |
| `LeaderboardRegistrationModal` | `theme`, `autoRunStats`, `keyboardMasteryStats`, `existingRegistration`, `onClose`, `onSave`, `onOptOut` | 7429-7443 | ⚠️ Needs stats data |
| `GroupChatInfoOverlay` | `theme`, `isOpen`, `groupChat`, `messages`, `onClose`, `onOpenModeratorSession` | 8234-8243 | ⚠️ Needs groupChat data |

**Extraction Strategy**: These modals need some App-level data but can still be grouped. Pass required data via props rather than direct state access.

### 7.6 Summary: Extraction Priority

| Priority | Category | Count | Estimated Lines Saved |
|----------|----------|-------|----------------------|
| **P0** | Helper functions (pure) | 4 items | ~80 lines |
| **P1** | Simple modals (no state) | 10 modals | ~150 lines |
| **P2** | Overlay components | 5 components | ~60 lines |
| **P3** | Git viewers | 2 components | ~20 lines |
| **P4** | Info modals (need data) | 4 modals | ~50 lines |
| **Total** | | **25 items** | **~360 lines** |

### 7.7 Recommended First Extraction

Start with the **P0 helper functions** as they have zero risk:

```typescript
// src/renderer/constants/toolNames.ts
export const KNOWN_TOOL_NAMES = ['Task', 'TaskOutput', 'Bash', ...];

// src/renderer/utils/toolNames.ts
import { KNOWN_TOOL_NAMES } from '../constants/toolNames';
export function isLikelyConcatenatedToolNames(text: string): boolean { ... }

// src/renderer/constants/slashCommands.ts
export const CLAUDE_BUILTIN_COMMANDS: Record<string, string> = { ... };

// src/renderer/utils/slashCommands.ts
import { CLAUDE_BUILTIN_COMMANDS } from '../constants/slashCommands';
export function getSlashCommandDescription(cmd: string): string { ... }
```

Then proceed with **P1 simple modals** which can be rendered from a new `<AppModals />` container component.

---

## 8. Complex Extractions

Components that have heavy dependencies and require careful extraction. These modals modify session state directly, need multiple refs, or contain complex inline handlers.

### 8.1 Modals That Modify Sessions State Directly

These modals contain inline handlers that call `setSessions()` to modify session state. They cannot be simply extracted without passing the `setSessions` callback or refactoring to use a context/hook pattern.

| Modal | Lines | State Modifications | Complexity |
|-------|-------|---------------------|------------|
| **QuickActionsModal** | 7194-7353 | Multiple `setSessions()` calls in inline handlers: `onToggleReadOnlyMode`, `onToggleTabShowThinking`, `onDebugReleaseQueuedItem` | HIGH - 11 inline handlers |
| **WorktreeConfigModal** | 7487-7751 | `onSaveConfig` (~135 lines): Creates multiple Session objects, calls `setSessions` 3x | HIGH - session factory logic |
| **CreateWorktreeModal** | 7753-7882 | `onCreateWorktree` (~105 lines): Creates Session object, calls `setSessions` 4x | HIGH - duplicates WorktreeConfigModal logic |
| **SendToAgentModal** | 7949-8039 | `onSend` (~80 lines): Creates AITab, modifies target session's `aiTabs` | MEDIUM - tab manipulation |
| **RenameTabModal** | 8309-8357 | `onRename` (~35 lines): Updates `aiTabs[].name`, persists to agent storage, updates history | MEDIUM - multiple storage systems |
| **PromptComposerModal** | 9326-9433 | 4 inline handlers modify sessions: `onToggleTabSaveToHistory`, `onToggleTabReadOnlyMode`, `onToggleTabShowThinking`, `onSend` | HIGH - dual context (session/group chat) |
| **ExecutionQueueBrowser** | 9436-9463 | `onRemoveItem`, `onReorderItems`: Modifies `executionQueue` arrays | LOW - simple queue ops |
| **EditAgentModal** | 9477-9492 | `onSave`: Updates 7 session fields (name, nudgeMessage, customPath, etc.) | LOW - simple field updates |
| **ProcessMonitor** | 8151-8176 | `onNavigateToSession`: Modifies `activeTabId` | LOW - simple tab switch |
| **DeleteWorktreeModal** | 8086-8107 | `onConfirm`, `onConfirmAndDelete`: Removes session from array | LOW - filter operation |
| **RenameSessionModal** | 8291-8306 | Via `sessions`/`setSessions` props: Renames session | LOW - wrapped operation |
| **RenameGroupModal** | 8360-8372 | Via `groups`/`setGroups` props: Renames group | LOW - groups not sessions |
| **CreateGroupModal** | 8246-8255 | Via `groups`/`setGroups` props: Creates group | LOW - groups not sessions |

**Summary**: 13 modals directly modify session or group state via inline handlers.

### 8.2 Modals That Need Multiple Refs

These modals require access to React refs, making extraction more complex as refs need to be passed through or accessed via context.

| Modal | Lines | Refs Used | Purpose |
|-------|-------|-----------|---------|
| **LightboxModal** | 7354-7380 | `inputRef`, `lightboxIsGroupChatRef`, `lightboxAllowDeleteRef` | Focus return, source tracking, delete permission |
| **PromptComposerModal** | 9326-9433 | `inputRef` (via onClose callback) | Focus return after close |
| **QuickActionsModal** | 7194-7353 | `mainPanelRef`, `rightPanelRef` (indirect via callbacks) | Git refresh, Auto Run reset |
| **CreatePRModal** | 8042-8083 | `rightPanelRef` (via `onPRCreated` callback) | History panel refresh |

**Note**: Most modals don't directly use refs - they receive ref-derived values or callbacks as props. The main challenge is `inputRef` for focus management.

### 8.3 Components with Complex Inline Handlers

These components have substantial business logic embedded in their JSX props (>30 lines of inline code per handler).

| Component | Lines | Handler | Inline Lines | Logic Summary |
|-----------|-------|---------|--------------|---------------|
| **WorktreeConfigModal** | 7493-7627 | `onSaveConfig` | ~135 | Scans directories, creates Session objects with full config, fetches git branches/tags, adds toast |
| **WorktreeConfigModal** | 7628-7748 | `onCreateWorktree` | ~120 | Git worktree setup, creates Session object, fetches git refs, updates parent session, adds toast |
| **CreateWorktreeModal** | 7762-7879 | `onCreateWorktree` | ~115 | Nearly identical to above - duplicated logic |
| **SendToAgentModal** | 7957-8037 | `onSend` | ~80 | Creates new tab, transfers logs, estimates tokens, shows toast with token info |
| **QuickActionsModal** | 7241-7275 | Multiple toggles | ~35 each | Read-only mode, show thinking toggles - all modify aiTabs |
| **RenameTabModal** | 8318-8354 | `onRename` | ~36 | Updates session state, persists to Claude storage, updates history entries |
| **PromptComposerModal** | 9347-9361 | `onSend` | ~15 | Dual context send (session vs group chat) |
| **PromptComposerModal** | 9374-9404 | Toggle handlers | ~10 each x3 | Save-to-history, read-only, show-thinking toggles |
| **WizardResumeModal** | 9571-9608 | `onResume` | ~35 | Handles invalid directory/agent, restores wizard state |
| **MergeSessionModal** | 7896-7919 | `onMerge` | ~23 | Executes merge, handles error toast |

### 8.4 Session Factory Pattern

The following modals all contain similar session creation logic that should be extracted to a shared utility:

```typescript
// Pattern: Full Session object construction with all required fields
const worktreeSession: Session = {
  id: newId,
  name: branchName,
  groupId: parentSession.groupId,
  toolType: parentSession.toolType,
  state: 'idle',
  cwd: worktreePath,
  fullPath: worktreePath,
  projectRoot: worktreePath,
  isGitRepo: true,
  gitBranches, gitTags, gitRefsCacheTime,
  parentSessionId: parentSession.id,
  worktreeBranch: branchName,
  aiLogs: [], shellLogs: [...],
  workLog: [], contextUsage: 0,
  inputMode: '...',
  aiPid: 0, terminalPid: 0, port: ...,
  isLive: false, changedFiles: [],
  fileTree: [], fileExplorerExpanded: [],
  fileExplorerScrollPos: 0,
  fileTreeAutoRefreshInterval: 180,
  shellCwd: worktreePath,
  aiCommandHistory: [], shellCommandHistory: [],
  executionQueue: [], activeTimeMs: 0,
  aiTabs: [initialTab], activeTabId: initialTabId,
  closedTabHistory: [],
  // Inherit parent config
  customPath, customArgs, customEnvVars,
  customModel, customContextWindow,
  nudgeMessage, autoRunFolderPath
};
```

**Occurrences**: 3 (WorktreeConfigModal x2, CreateWorktreeModal x1)

**Suggested Extraction**: `src/renderer/utils/sessionFactory.ts`
```typescript
export function createWorktreeSession(
  parent: Session,
  worktreePath: string,
  branchName: string,
  gitRefs?: { branches?: string[]; tags?: string[] },
  defaults?: { saveToHistory?: boolean }
): Session { ... }
```

### 8.5 Dual-Context Pattern

These components behave differently based on whether a group chat or session is active:

| Component | Lines | Behavior |
|-----------|-------|----------|
| **PromptComposerModal** | 9326-9433 | Uses `activeGroupChatId` to switch between: session input vs group chat draft, session images vs group chat images, session toggles vs group chat toggles |
| **LightboxModal** | 7354-7380 | Uses `lightboxIsGroupChatRef` to determine which staged images array to update on delete |

**Suggested Extraction**: Create a `useActiveContext()` hook that provides a unified API:
```typescript
const {
  inputValue, setInputValue,
  stagedImages, setStagedImages,
  readOnlyMode, setReadOnlyMode,
  contextType: 'session' | 'groupChat',
  contextName: string,
} = useActiveContext();
```

### 8.6 Extraction Dependencies Summary

| Dependency Type | Count | Impact |
|-----------------|-------|--------|
| `setSessions` direct access | 13 modals | Must pass callback or use context |
| Ref access | 4 modals | Must pass refs or use ref context |
| `addToast` access | 8 modals | Must pass callback or use ToastContext |
| Dual context (session/group chat) | 2 modals | Must handle both contexts |
| Session factory (create Session) | 3 modals | Should share factory function |
| History API access | 3 modals | `window.maestro.history.*` calls |
| Git service access | 3 modals | `window.maestro.git.*` calls |
| Agent session storage access | 2 modals | `window.maestro.agentSessions.*` calls |

### 8.7 Recommended Extraction Order for Complex Components

1. **Phase 1: Create shared utilities**
   - `src/renderer/utils/sessionFactory.ts` - Session object construction
   - `src/renderer/hooks/useActiveContext.ts` - Unified session/group chat context

2. **Phase 2: Extract worktree modals** (most duplicated code)
   - Create `useWorktreeOperations` hook with `createWorktree`, `scanWorktrees`, `deleteWorktree`
   - Refactor `WorktreeConfigModal` and `CreateWorktreeModal` to use hook

3. **Phase 3: Extract tab operations**
   - Create `useTabOperations` hook with `renameTab`, `toggleReadOnly`, `toggleShowThinking`
   - Refactor `RenameTabModal`, `QuickActionsModal` inline handlers

4. **Phase 4: Extract context transfer**
   - Create `useContextTransfer` hook (already partially exists as `useSendToAgentWithSessions`)
   - Consolidate `SendToAgentModal`, `MergeSessionModal` handlers

5. **Phase 5: Refactor dual-context components**
   - Implement `useActiveContext` hook
   - Refactor `PromptComposerModal`, `LightboxModal` to use hook

---

## 9. Shared Refs

This section documents all refs (`useRef`) in App.tsx and identifies which are used across multiple handlers, making them key dependencies for extraction.

### 9.1 Complete Ref Inventory

All refs are declared between lines 395-6053. They fall into these categories:

#### UI Element Refs (lines 2363-2371)
| Ref | Type | Line | Purpose |
|-----|------|------|---------|
| `logsEndRef` | `HTMLDivElement` | 2363 | Scroll anchor for AI output |
| `inputRef` | `HTMLTextAreaElement` | 2364 | Main input field |
| `terminalOutputRef` | `HTMLDivElement` | 2365 | Terminal scroll container |
| `sidebarContainerRef` | `HTMLDivElement` | 2366 | Left sidebar scroll container |
| `fileTreeContainerRef` | `HTMLDivElement` | 2367 | File tree scroll container |
| `fileTreeFilterInputRef` | `HTMLInputElement` | 2368 | File filter input |
| `fileTreeKeyboardNavRef` | `boolean` | 2369 | Tracks keyboard vs mouse selection |
| `rightPanelRef` | `RightPanelHandle` | 2370 | Right panel imperative handle |
| `mainPanelRef` | `MainPanelHandle` | 2371 | Main panel imperative handle |

#### Callback Refs - Updated Every Render (lines 2375-2382)
| Ref | Type | Line | Purpose |
|-----|------|------|---------|
| `addToastRef` | `Function` | 2375 | Latest `addToast` for async callbacks |
| `updateGlobalStatsRef` | `Function` | 2376 | Latest `updateGlobalStats` for event handlers |
| `customAICommandsRef` | `Array` | 2377 | Latest custom AI commands |
| `speckitCommandsRef` | `Array` | 2378 | Latest spec-kit commands |

#### Processing Refs (lines 2387-2401)
| Ref | Type | Line | Purpose |
|-----|------|------|---------|
| `processQueuedItemRef` | `Function \| null` | 2387 | Batch exit handler queue processing |
| `_pendingRemoteCommandRef` | `Object \| null` | 2391 | Web interface command routing |
| `pauseBatchOnErrorRef` | `Function \| null` | 2395 | Batch processor error handling |
| `getBatchStateRef` | `Function \| null` | 2396 | Batch state getter |
| `thinkingChunkBufferRef` | `Map<string, string>` | 2400 | RAF-throttled thinking chunk buffer |
| `thinkingChunkRafIdRef` | `number \| null` | 2401 | RAF ID for cleanup |

#### State Tracking Refs (lines 395-790, 3004-6053)
| Ref | Type | Line | Purpose |
|-----|------|------|---------|
| `preFilterActiveTabIdRef` | `string \| null` | 395 | Tracks active tab before unread filter |
| `dragCounterRef` | `number` | 421 | Tracks nested drag enter/leave events |
| `lightboxIsGroupChatRef` | `boolean` | 436 | Tracks if lightbox opened from group chat |
| `lightboxAllowDeleteRef` | `boolean` | 437 | Tracks if delete should be allowed |
| `sessionLoadStarted` | `boolean` | 790 | Guards against double session load |
| `prevActiveTabIdRef` | `string \| undefined` | 3004 | Previous active tab ID for input sync |
| `prevActiveSessionIdRef` | `string \| undefined` | 3007 | Previous active session ID for input sync |
| `autoRunProgressRef` | `{ lastUpdateTime: number }` | 3716 | Auto run progress tracking |
| `processedQueuesOnStartup` | `boolean` | 6053 | Guards against double queue processing |

### 9.2 Multi-Handler Ref Usage Analysis

The following refs are used across 3 or more locations, making them critical extraction dependencies:

#### `inputRef` - **14 usages** (Most Shared)
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Focus fallback      | 595-597   | Initial focus setup
Error recovery      | 2639      | Focus after handleRetryAfterError
Error recovery      | 2648      | Focus after handleRestartAgentAfterError
Error recovery      | 2668      | Focus after handleRestartAgentAfterError (branch)
Auth recovery       | 2681      | Focus after handleAuthenticateAfterError
Input sync          | 5021      | Focus after setTabCompletionOpen
Session operations  | 5170      | Focus after session deletion
Session operations  | 5288      | Focus after cycleSession
Lightbox close      | 7365      | Focus after LightboxModal close
Tab switcher close  | 9303      | Focus after TabSwitcherModal
Prompt composer     | 9330      | Focus after PromptComposerModal close
Keyboard handler    | 6471      | Focus on Escape
Keyboard handler    | 6504      | Focus on mode switch
Keyboard handler    | 6535      | Focus on panel toggle
```
**Extraction Impact**: Any modal or handler that manages focus return needs access to this ref. Consider creating a `useFocusReturn()` hook.

#### `sessionsRef` - **12 usages** (Context State)
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
onData handler      | 1209, 1230, 1258 | Find session by ID in event handler
onExit handler      | 1345, 1615, 1665 | Find session for toast/exit logic
onUsage handler     | 1926      | Find session for usage update
Tab input sync      | 3256, 3273, 3281, 3290, 3299 | Find session by active ID
Auto run            | 3790      | Get current sessions
Worktree discovery  | 3934, 3949, 3955 | Filter/find worktree sessions
Queued item         | 5492, 5812 | Get session for queue processing
Keyboard handler    | 6121, 6259 | Get current session state
```
**Note**: This is from SessionContext, not a local ref. Used to avoid stale closures in event handlers.

#### `rightPanelRef` - **5 usages**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
onExit handler      | 1727-1728 | Refresh history panel after synopsis
History update      | 3341      | Refresh history panel
QuickActionsModal   | 7348      | Get Auto Run completed count
QuickActionsModal   | 7350      | Open Auto Run reset modal
CreatePRModal       | 8078      | Refresh history panel after PR
```
**Extraction Impact**: Modals that need history refresh or Auto Run access need this ref.

#### `mainPanelRef` - **1 usage**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
QuickActionsModal   | 7287      | Refresh git info
```
**Extraction Impact**: Only QuickActionsModal uses this directly.

#### `addToastRef` - **5 usages**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Ref update          | 2379      | Updated every render
onExit handler      | 1670, 1714 | Show toast in async callbacks
Debug exposure      | 2407, 2410 | Test toast from console
Batch error         | 3485      | Show error toast
```
**Extraction Impact**: Any async handler that shows toasts needs this ref or access to ToastContext.

#### `fileTreeKeyboardNavRef` - **9 usages**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Tab completion sync | 3206      | Mark as keyboard nav
Jump path handler   | 6980      | Mark as keyboard nav
Scroll-to-selection | 6993-6994 | Check and reset flag
Keyboard nav effect | 7036-7076 | Set flag on various key presses
```
**Extraction Impact**: File tree keyboard navigation logic should be extracted together.

#### `fileTreeContainerRef` - **3 usages**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Session switch      | 4465-4466 | Restore scroll position
Scroll-to-selection | 7005      | Get container for scrollIntoView
```
**Extraction Impact**: Coupled with file tree operations.

#### `thinkingChunkBufferRef` / `thinkingChunkRafIdRef` - **9 usages (combined)**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
onThinkingChunk     | 1165, 2108-2109, 2113-2125 | Buffer and RAF throttle
Cleanup             | 2250-2252 | Cancel pending RAF
```
**Extraction Impact**: These are tightly coupled and only used in onThinkingChunk handler. Can be extracted together.

#### `dragCounterRef` - **6 usages**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Drag end            | 6655      | Reset to 0
Drag enter          | 6708      | Increment
Drag leave          | 6718-6721 | Decrement and check
Drop                | 6734      | Reset to 0
```
**Extraction Impact**: All usages are in drag handlers - can extract to `useImageDrag()` hook.

#### `lightboxIsGroupChatRef` / `lightboxAllowDeleteRef` - **6 usages (combined)**
```
Location            | Line(s)   | Purpose
--------------------|-----------|----------------------------------
Set on lightbox open| 4215-4216 | Set context before state update
LightboxModal close | 7362-7363 | Reset on close
LightboxModal delete| 7370-7372 | Check source and context
```
**Extraction Impact**: Tightly coupled to LightboxModal. Should extract together.

### 9.3 Extraction Recommendations by Ref Coupling

| Coupling Group | Refs | Suggested Extraction |
|---------------|------|---------------------|
| **Focus Management** | `inputRef`, `terminalOutputRef` | `useFocusReturn()` hook |
| **File Tree Navigation** | `fileTreeContainerRef`, `fileTreeKeyboardNavRef`, `fileTreeFilterInputRef` | `useFileTreeNavigation()` hook |
| **Image Drag** | `dragCounterRef`, `isDraggingImage` state | `useImageDrag()` hook |
| **Lightbox Context** | `lightboxIsGroupChatRef`, `lightboxAllowDeleteRef`, `lightboxImage` state | `useLightbox()` hook |
| **Thinking Chunks** | `thinkingChunkBufferRef`, `thinkingChunkRafIdRef` | Keep in process event handler |
| **Batch Processing** | `pauseBatchOnErrorRef`, `getBatchStateRef`, `processQueuedItemRef` | Already partially extracted in `useBatchProcessor` |
| **Panel Operations** | `rightPanelRef`, `mainPanelRef` | Pass refs to extracted components, or use context |

### 9.4 Refs Safe to Extract (Single Handler)

These refs are only used in one handler and can be easily extracted with that handler:

| Ref | Handler | Line | Notes |
|-----|---------|------|-------|
| `preFilterActiveTabIdRef` | Unread filter toggle | 5318-5329 | Self-contained |
| `sessionLoadStarted` | Session load useEffect | 790 | Guard ref |
| `processedQueuesOnStartup` | Queue startup effect | 6053 | Guard ref |
| `prevActiveTabIdRef` | Tab switch useEffect | 3004-3029 | Input sync |
| `prevActiveSessionIdRef` | Session switch useEffect | 3007-3084 | Input sync |
| `autoRunProgressRef` | Auto run progress effect | 3716-3734 | Progress timing |

---

## 10. Shared Callbacks

This section documents callbacks that are passed to multiple child components, identifying dependencies for extraction. These are the functions passed via `onSomething={handler}` props in JSX.

### 10.1 Most Shared Callbacks (5+ Components)

These callbacks are passed to the most components, making them critical dependencies:

#### `setSessions` - **30+ usages in JSX props**
```
Component               | Prop Name          | Notes
------------------------|--------------------|---------------------------------
QuickActionsModal       | setSessions        | Direct state setter
SessionList             | setSessions        | Direct state setter
MainPanel               | N/A (inline)       | Various inline handlers
RightPanel              | setSessions        | Direct state setter
WorktreeConfigModal     | Inline handlers    | Session creation
CreateWorktreeModal     | Inline handlers    | Session creation
ProcessMonitor          | Inline handler     | Tab navigation
RenameSessionModal      | Inline handler     | Rename persistence
RenameTabModal          | Inline handler     | Tab rename
TabSwitcherModal        | Inline handler     | Tab/session selection
PromptComposerModal     | Inline handlers    | Toggle handlers
ExecutionQueueBrowser   | Inline handlers    | Queue management
EditAgentModal          | Inline handler     | Config update
SettingsModal           | N/A (no direct)    | Via callbacks
```
**Extraction Impact**: Core state setter - must be passed via context or prop. All session mutations depend on this.

#### `setActiveSessionId` - **12+ usages**
```
Component               | Prop Name             | Notes
------------------------|-----------------------|----------------------------------
QuickActionsModal       | setActiveSessionId    | Session switching
SessionList             | setActiveSessionId    | Session selection
MainPanel               | setActiveSessionId    | Tab bar navigation
ProcessMonitor          | onNavigateToSession   | Wrapped callback
ExecutionQueueBrowser   | onSwitchSession       | Wrapped callback
WorktreeConfigModal     | Inline                | After worktree creation
EmptyStateView          | N/A                   | No direct usage
```
**Extraction Impact**: Session navigation - could be wrapped in `useSessionNavigation` hook.

#### `handleOpenGroupChat` - **5 usages**
```
Component               | Prop Name             | Notes
------------------------|-----------------------|----------------------------------
QuickActionsModal       | onOpenGroupChat       | Group chat switching
SessionList             | onOpenGroupChat       | Group chat selection
```
**Definition**: Line 4225 - Opens group chat, loads messages, sets states.

#### `handleCloseGroupChat` - **4 usages**
```
Component               | Prop Name             | Notes
------------------------|-----------------------|----------------------------------
QuickActionsModal       | onCloseGroupChat      | Close from Cmd+K
GroupChatPanel          | onClose               | Close button
```
**Definition**: Line 4269 - Closes group chat, clears active state.

#### `setSettingsModalOpen` / `setSettingsTab` - **6+ usages each**
```
Component               | Notes
------------------------|----------------------------------
QuickActionsModal       | Opens settings via Cmd+K
SessionList             | Opens from hamburger menu
EmptyStateView          | Opens from empty state
SettingsModal           | onClose handler
```
**Extraction Impact**: Modal opening pattern - could use modal context.

#### `handleSetLightboxImage` / `onOpenLightbox` - **5 usages**
```
Component               | Prop Name             | Notes
------------------------|-----------------------|----------------------------------
GroupChatPanel          | onOpenLightbox        | Image preview
MainPanel               | setLightboxImage      | Image preview
RightPanel              | N/A (not passed)      |
PromptComposerModal     | onOpenLightbox        | Image preview
```
**Definition**: Line 4211 - Sets lightbox image and context (staged/history).

### 10.2 Moderately Shared Callbacks (3-4 Components)

#### Navigation & Panel Callbacks
| Callback | Components | Definition Line | Purpose |
|----------|------------|-----------------|---------|
| `setShortcutsHelpOpen` | QuickActionsModal, SessionList, EmptyStateView | 428 (useState) | Open shortcuts modal |
| `setAboutModalOpen` | QuickActionsModal, SessionList, EmptyStateView, MainPanel, RightPanel | 438 (useState) | Open about modal |
| `setUpdateCheckModalOpen` | QuickActionsModal, SessionList, EmptyStateView | 439 (useState) | Open update check |
| `setLogViewerOpen` | QuickActionsModal, SessionList, MainPanel | 451 (useState) | Open log viewer |
| `setProcessMonitorOpen` | QuickActionsModal, SessionList | 452 (useState) | Open process monitor |
| `setActiveFocus` | MainPanel, RightPanel | 391 (useState) | Focus area tracking |

#### Session & Agent Callbacks
| Callback | Components | Definition Line | Purpose |
|----------|------------|-----------------|---------|
| `addNewSession` | QuickActionsModal, SessionList, EmptyStateView | 4900 | Create new session |
| `deleteSession` | QuickActionsModal, SessionList | 4786 | Delete session |
| `openWizardModal` | QuickActionsModal, SessionList, EmptyStateView, WizardResumeModal | 251 (useWizard) | Open wizard |
| `handleResumeSession` | MainPanel, RightPanel (x2), TabSwitcherModal | 3240 (hook) | Resume agent session |

#### File & Tree Callbacks
| Callback | Components | Definition Line | Purpose |
|----------|------------|-----------------|---------|
| `handleFileClick` | RightPanel, FileSearchModal, File tree effect | 6753 | Handle file selection |
| `toggleFolder` | RightPanel, File explorer effect | 6814 | Toggle folder expansion |
| `handlePaste` | GroupChatPanel, MainPanel | 6601 | Paste handling (images) |
| `handleDrop` | GroupChatPanel, MainPanel, Root div | 6653 | Drop handling (images) |

#### Batch & Auto Run Callbacks
| Callback | Components | Definition Line | Purpose |
|----------|------------|-----------------|---------|
| `handleStopBatchRun` | MainPanel, RightPanel | 4149 | Stop batch run |
| `handleSummarizeAndContinue` | QuickActionsModal, MainPanel | 2900 | Context summarization |

### 10.3 Specialized Callbacks (2 Components)

#### Modal Opening Patterns
| Callback | Components | Notes |
|----------|------------|-------|
| `onEditAgent` | QuickActionsModal, SessionList | Opens EditAgentModal |
| `onOpenCreatePR` | QuickActionsModal, SessionList, MainPanel | Opens CreatePRModal |
| `onNewGroupChat` | QuickActionsModal, SessionList | Opens NewGroupChatModal |
| `setMergeSessionModalOpen` | QuickActionsModal (indirect), MainPanel | Merge context modal |
| `setSendToAgentModalOpen` | QuickActionsModal (indirect), MainPanel | Transfer modal |

#### Group Chat Callbacks
| Callback | Components | Notes |
|----------|------------|-------|
| `handleDropOnGroup` | SessionList, useGroupManagement | Drag-drop to group |
| `handleDropOnUngrouped` | SessionList, useGroupManagement | Drag-drop to ungrouped |

#### Tab Callbacks
| Callback | Components | Notes |
|----------|------------|-------|
| `onToggleTabReadOnlyMode` | QuickActionsModal, MainPanel, PromptComposerModal | Toggle read-only |
| `onToggleTabShowThinking` | QuickActionsModal, MainPanel, PromptComposerModal | Toggle thinking display |
| `onToggleTabSaveToHistory` | MainPanel, PromptComposerModal | Toggle history saving |

### 10.4 Flash Notification Callbacks

These callbacks show temporary notifications and follow a pattern:

| Callback | Components | Pattern |
|----------|------------|---------|
| `setSuccessFlashNotification` | QuickActionsModal, GroupChatPanel, MainPanel, RightPanel | Direct setter |
| `showSuccessFlash` | RightPanel | Wrapper function (line 6595) |
| `showFlashNotification` | GroupChatPanel (prop), MainPanel (prop) | Inline wrapper |

**Pattern**: All wrap `setSuccessFlashNotification` with auto-clear timeout:
```typescript
const showSuccessFlash = useCallback((message: string) => {
  setSuccessFlashNotification(message);
  setTimeout(() => setSuccessFlashNotification(null), 4000);
}, [setSuccessFlashNotification]);
```

### 10.5 Shortcut Recording Callback

`recordShortcutUsage` - Passed to 3 components for gamification:
```
Component       | Usage
----------------|------------------------------------------
LogViewer       | onShortcutUsed prop
MainPanel       | onShortcutUsed prop
Keyboard handler| Direct call in handler
```
**Definition**: From `useSettings()` at line 309.

### 10.6 Callback Dependencies Summary

| Dependency Type | Count | Extraction Recommendation |
|-----------------|-------|---------------------------|
| Direct state setters (`setX`) | 15+ | Keep in App or use context |
| Handler callbacks (`handleX`) | 20+ | Extract to hooks where possible |
| Modal opening (`setXModalOpen`) | 12+ | Create modal context |
| Navigation (`setActiveX`) | 3 | Create navigation hook |
| Group chat (`handleGroupChat*`) | 4 | Keep grouped |
| Batch/Auto Run | 6 | Already in `useBatchProcessor` |
| Tab operations | 5 | Extract to `useTabOperations` |

### 10.7 Extraction Recommendations

1. **Create `useModalOpenState` hook** - Consolidate 12+ modal open/close setters:
   ```typescript
   const { openSettings, openAbout, openShortcuts, ... } = useModalOpenState();
   ```

2. **Create `useSessionActions` hook** - Consolidate session operations:
   ```typescript
   const { addSession, deleteSession, setActive, ... } = useSessionActions();
   ```

3. **Create `useNotifications` hook** - Consolidate flash notifications:
   ```typescript
   const { showSuccess, showWarning } = useNotifications();
   ```

4. **Enhance `useTabOperations`** - Add toggle callbacks:
   ```typescript
   const { toggleReadOnly, toggleShowThinking, toggleSaveToHistory } = useTabOperations();
   ```

5. **Create `useLightbox` hook** - Consolidate image preview:
   ```typescript
   const { openLightbox, closeLightbox, navigateImage } = useLightbox();
   ```

### 10.8 Callbacks Safe to Extract (Single Handler Pattern)

These callbacks are passed to only one or two components and can be extracted with those components:

| Callback | Component(s) | Extraction Target |
|----------|--------------|-------------------|
| `handleAutoRefreshChange` | RightPanel | `useFileTreeManagement` |
| `handleAutoRunContentChange` | RightPanel | `useAutoRun` context |
| `handleAutoRunModeChange` | RightPanel | `useAutoRun` context |
| `handleJumpToGroupChatMessage` | GroupChatRightPanel | `useGroupChat` context |
| `handleGroupChatDraftChange` | GroupChatPanel | `useGroupChat` context |
| `handleRemoveGroupChatQueueItem` | GroupChatPanel | `useGroupChat` context |
| `handleNewAgentSession` | MainPanel | `useAgentSessions` |
| `handleTabSelect` | MainPanel | `useTabOperations` |
| `handleTabClose` | MainPanel | `useTabOperations` |
| `handleNewTab` | MainPanel | `useTabOperations` |

---

## 11. Extraction Order

This section provides the prioritized, numbered extraction order for breaking up App.tsx (~9,700 lines). The order minimizes risk by starting with zero-dependency items and progressively tackling more complex extractions.

### Phase 1: Constants and Helper Functions
**Target:** Move to `src/renderer/constants/app.ts`
**Risk:** Very Low | **Estimated Lines Saved:** ~50 lines

| # | Item | Current Location | Notes |
|---|------|------------------|-------|
| 1.1 | `KNOWN_TOOL_NAMES` constant | Lines ~14-35 | Array of 19 known tool names |
| 1.2 | `CLAUDE_BUILTIN_COMMANDS` constant | Lines ~37-49 | Array of 10 builtin commands |
| 1.3 | `isLikelyConcatenatedToolNames()` | Lines ~51-65 | Pure function, no deps |
| 1.4 | `getSlashCommandDescription()` | Lines ~67-100 | Pure function, no deps |

**Verification:** After moving, confirm all 4 items are importable and functions work with test inputs.

---

### Phase 2: Simple Overlay Components
**Target:** Extract to dedicated component files
**Risk:** Low | **Estimated Lines Saved:** ~150 lines

| # | Item | Open State | Target File |
|---|------|------------|-------------|
| 2.1 | FirstRunCelebration | `firstRunCelebrationData` | Already separate component, just move JSX |
| 2.2 | KeyboardMasteryCelebration | `pendingKeyboardMasteryLevel` | Already separate component, just move JSX |
| 2.3 | StandingOvationOverlay | `standingOvationData` | Already separate component, just move JSX |
| 2.4 | Flash Notifications (inline) | `successFlashNotification`, `warningFlashNotification` | Create `FlashNotifications.tsx` |
| 2.5 | ToastContainer | Always rendered | Already separate, verify no inline handlers |

**Dependencies to Pass:** `theme`, open state, close callback, data object

---

### Phase 3: Modal Components with Simple Props
**Target:** Move JSX to `AppModals.tsx` or dedicated modal files
**Risk:** Low to Medium | **Estimated Lines Saved:** ~800 lines

#### 3A. Zero-Handler Modals (simplest)
| # | Modal | Open State | Props Needed |
|---|-------|------------|--------------|
| 3.1 | UpdateCheckModal | `updateCheckModalOpen` | theme, isOpen, onClose |
| 3.2 | DebugPackageModal | `debugPackageModalOpen` | theme, isOpen, onClose |
| 3.3 | DebugWizardModal | `debugWizardModalOpen` | theme, isOpen, onClose, wizardState, onRestore, onClear |
| 3.4 | AboutModal | `aboutModalOpen` | theme, isOpen, onClose, onOpenDocs |
| 3.5 | ConfirmModal | `confirmModalOpen` | theme, isOpen, message, onConfirm, onClose |

#### 3B. Single-Data Modals
| # | Modal | Open State | Data Needed |
|---|-------|------------|-------------|
| 3.6 | ShortcutsHelpModal | `shortcutsHelpOpen` | theme, isOpen, shortcuts, onClose |
| 3.7 | PlaygroundPanel | `playgroundOpen` | theme, isOpen, onClose |
| 3.8 | LogViewer | `logViewerOpen` | theme, isOpen, onClose |
| 3.9 | QuitConfirmModal | `quitConfirmModalOpen` | theme, isOpen, onConfirm, onClose |
| 3.10 | LeaderboardRegistrationModal | `leaderboardRegistrationOpen` | theme, isOpen, onClose |

#### 3C. Group Chat Modals (minimal session deps)
| # | Modal | Open State | Dependencies |
|---|-------|------------|--------------|
| 3.11 | NewGroupChatModal | `newGroupChatModalOpen` | theme, sessions, onClose, onCreate |
| 3.12 | DeleteGroupChatModal | `deleteGroupChatModalOpen` | theme, chat, onClose, onDelete |
| 3.13 | RenameGroupChatModal | `renameGroupChatModalOpen` | theme, chat, onClose, onRename |
| 3.14 | EditGroupChatModal | `editGroupChatModalOpen` | theme, chat, sessions, onClose, onSave |
| 3.15 | GroupChatInfoOverlay | `groupChatInfoOpen` | theme, chat, participants, onClose |
| 3.16 | CreateGroupModal | `createGroupModalOpen` | theme, isOpen, onClose, onCreateGroup |

#### 3D. Git Viewers
| # | Modal | Open State | Dependencies |
|---|-------|------------|--------------|
| 3.17 | GitDiffViewer | `gitDiffPreview !== null` | theme, diff, onClose |
| 3.18 | GitLogViewer | `gitLogOpen` | theme, session, onClose |

---

### Phase 4: Complex Modals with Handlers
**Target:** Extract to dedicated component files with handler hooks
**Risk:** Medium | **Estimated Lines Saved:** ~1,200 lines

#### 4A. Session Management Modals
| # | Modal | Open State | Handler Extraction |
|---|-------|------------|-------------------|
| 4.1 | NewInstanceModal | `newInstanceModalOpen` | Extract session creation to `useSessionFactory` |
| 4.2 | EditAgentModal | `editAgentModalOpen` | Extract config update handler |
| 4.3 | RenameSessionModal | `renameInstanceModalOpen` | Extract rename handler |
| 4.4 | RenameTabModal | `renameTabModalOpen` | Extract tab rename handler |
| 4.5 | RenameGroupModal | `renameGroupModalOpen` | Extract group rename handler |
| 4.6 | TabSwitcherModal | `tabSwitcherOpen` | Uses existing `useTabOperations` |

#### 4B. Worktree Modals (High Complexity)
| # | Modal | Lines | Key Dependencies |
|---|-------|-------|-----------------|
| 4.7 | WorktreeConfigModal | ~130 lines | sessions, setSessions, worktree APIs |
| 4.8 | CreateWorktreeModal | ~100 lines | session creation, git worktree |
| 4.9 | WorktreeInfoModal | ~40 lines | worktree info display |
| 4.10 | WorktreeSelectorModal | ~80 lines | worktree list, selection |
| 4.11 | DeleteWorktreeModal | ~40 lines | worktree deletion |
| 4.12 | WorktreeCleanupModal | ~50 lines | cleanup logic |
| 4.13 | MergeWorktreeModal | ~60 lines | merge confirmation |

**Recommendation:** Create `useWorktreeOperations` hook to consolidate all worktree handlers.

#### 4C. Navigation & Action Modals
| # | Modal | Lines | Handler Extraction |
|---|-------|-------|-------------------|
| 4.14 | QuickActionsModal | ~150 lines | Extract to `useQuickActions` hook |
| 4.15 | SendToAgentModal | ~80 lines | Extract send-to handler |
| 4.16 | MergeSessionModal | ~60 lines | Extract merge handler |
| 4.17 | CreatePRModal | ~100 lines | Uses existing PR creation flow |
| 4.18 | PromptComposerModal | ~200 lines | Extract compose handlers |
| 4.19 | FileSearchModal | ~100 lines | Uses file selection callbacks |

#### 4D. Browser & List Modals
| # | Modal | Lines | Handler Extraction |
|---|-------|-------|-------------------|
| 4.20 | AgentSessionsBrowserModal | ~80 lines | Extract browse/restore handlers |
| 4.21 | ExecutionQueueBrowser | ~60 lines | Uses queue state |
| 4.22 | LightboxModal | ~100 lines | Extract to `useLightbox` hook |
| 4.23 | ProcessMonitor | ~80 lines | Uses process list |

---

### Phase 5: Panel Composition
**Target:** Reduce App.tsx to orchestration only
**Risk:** Medium-High | **Estimated Lines Saved:** ~2,500 lines

| # | Panel | Current Location | Strategy |
|---|-------|------------------|----------|
| 5.1 | Left Bar Integration | App.tsx render | Move SessionList props to `useSessionListProps` hook |
| 5.2 | Right Bar Integration | App.tsx render | Move RightPanel props to `useRightPanelProps` hook |
| 5.3 | Main Panel Integration | App.tsx render | Move MainPanel props to `useMainPanelProps` hook |
| 5.4 | Group Chat Panel Integration | App.tsx render | Move GroupChatPanel props to context |
| 5.5 | Empty State View | App.tsx render | Simplify with extracted callbacks |

---

### Phase 6: Remaining Handlers into Hooks
**Target:** Extract all remaining inline handlers
**Risk:** Medium-High | **Estimated Lines Saved:** ~1,500 lines

#### 6A. Create New Hooks
| # | Hook Name | Source Handlers | Lines |
|---|-----------|-----------------|-------|
| 6.1 | `useSessionFactory` | Session creation patterns (3 occurrences) | ~150 |
| 6.2 | `useModalOpenState` | 12+ modal open/close setters | ~100 |
| 6.3 | `useNotifications` | Flash notification handlers | ~50 |
| 6.4 | `useFocusReturn` | `lastFocusedElementRef` usage | ~80 |
| 6.5 | `useLightbox` | Lightbox state and navigation | ~100 |
| 6.6 | `useProcessEvents` | Event listener registration | ~1,100 |

#### 6B. Enhance Existing Hooks
| # | Hook | Enhancement | Lines Moved |
|---|------|-------------|-------------|
| 6.7 | `useTabOperations` | Add toggle callbacks (readOnly, showThinking, saveToHistory) | ~100 |
| 6.8 | `useFileTreeManagement` | Add file interaction callbacks | ~150 |
| 6.9 | `useBatchProcessor` | Already handles batch operations | N/A |

---

### Summary Statistics

| Phase | Items | Est. Lines | Risk Level |
|-------|-------|------------|------------|
| Phase 1: Constants | 4 | ~50 | Very Low |
| Phase 2: Overlays | 5 | ~150 | Low |
| Phase 3: Simple Modals | 18 | ~800 | Low-Medium |
| Phase 4: Complex Modals | 23 | ~1,200 | Medium |
| Phase 5: Panels | 5 | ~2,500 | Medium-High |
| Phase 6: Hooks | 9 | ~1,500 | Medium-High |
| **Total** | **64 items** | **~6,200 lines** | Progressive |

**Target Result:** App.tsx reduced from ~9,700 lines to ~3,500 lines (orchestration, state declarations, and remaining integration code).

### Extraction Dependencies Graph

```
Phase 1 (Constants)
    └── No dependencies, extract first

Phase 2 (Overlays)
    └── Depends on: theme only

Phase 3 (Simple Modals)
    ├── 3A: No handler dependencies
    ├── 3B: Single data dependencies
    ├── 3C: Group chat context (existing)
    └── 3D: Git utilities (existing)

Phase 4 (Complex Modals)
    ├── 4A: Depends on Phase 6.1 (useSessionFactory)
    ├── 4B: Create useWorktreeOperations first
    ├── 4C: Depends on Phase 6.2 (useModalOpenState)
    └── 4D: Depends on Phase 6.5 (useLightbox)

Phase 5 (Panels)
    └── Depends on: Phase 3, Phase 4, and Phase 6 hooks

Phase 6 (Hooks)
    ├── 6.1-6.6: Can be created incrementally
    └── 6.7-6.9: Enhance as modals are extracted
```

### Recommended Execution Order

For safe, incremental extraction:

1. **Week 1:** Phase 1 + Phase 2 + Phase 3A (constants, overlays, zero-handler modals)
2. **Week 2:** Phase 3B + Phase 3C + Phase 3D (remaining simple modals)
3. **Week 3:** Phase 6.1-6.2 (useSessionFactory, useModalOpenState) + Phase 4A (session modals)
4. **Week 4:** Phase 6.3-6.5 (notifications, focus, lightbox hooks) + Phase 4B (worktree modals)
5. **Week 5:** Phase 4C + Phase 4D (remaining complex modals)
6. **Week 6:** Phase 5 (panel composition) + Phase 6.6-6.9 (remaining hooks)

Each extraction should:
1. Create the target file
2. Move code with minimal changes
3. Update imports in App.tsx
4. Run type-check (`npm run lint`)
5. Test affected UI flows
6. Commit incrementally

---

## 12. Line Coverage Verification

This section validates that the inventory document covers all major sections of `App.tsx` by verifying line count estimates add up to the actual file size.

### Actual File Size

```
App.tsx total lines: 9,716 (verified via wc -l)
```

### Line Range Coverage

| Section | Line Range | Lines | Status | Notes |
|---------|------------|-------|--------|-------|
| Imports & Constants | 1-230 | 230 | ✅ Documented in AppModals.tsx | 48 component imports, 30 hooks, 8 contexts |
| useState Declarations | 231-600 | 370 | ✅ Section 1 | ~95 local useState, hook dependencies |
| Settings sync & restoreSession | 600-790 | 190 | ⚠️ Partially covered | useEffects for settings, restoreSession function |
| Session Loading & Initialization | 791-1162 | 372 | ⚠️ Not detailed | Session load, persistence, initial state |
| Process Event Listeners | 1163-2257 | 1,095 | ✅ Section 2 | 10 event handlers documented in detail |
| Group Chat Events & Related | 2259-3200 | 942 | ✅ Section 3 | 6 listeners, refs, handlers, hooks |
| Agent Execution & Batch Processing | 3201-4500 | ~1,300 | ⚠️ Not detailed | useAgentExecution, useBatchProcessor, callbacks |
| Session Operations & Handlers | 4501-5800 | ~1,300 | ⚠️ Not detailed | addNewSession, deleteSession, cycleSession, etc. |
| Keyboard Handler Setup | 5801-6703 | ~903 | ⚠️ Not detailed | keyboardHandlerRef setup, useKeyboardShortcuts |
| Drag Event Handlers | 6704-6748 | 45 | ⚠️ Not detailed | Image drag enter/leave/over/drop handlers |
| Render Helper Functions | 6749-7102 | 354 | ✅ Section 4 | handleFileClick, toggleFolder, useEffects |
| Layout JSX Setup | 7103-7191 | 89 | ⚠️ Not detailed | GitStatusProvider wrapper, main div setup |
| Modal JSX Section | 7192-9689 | 2,497 | ✅ Sections 5 & 6 | 46 modals cataloged with complexity analysis |
| Context Wrapper | 9690-9716 | 27 | ⚠️ Minimal | MaestroConsole wrapper with providers |

### Coverage Summary

| Coverage Level | Lines | % of File |
|----------------|-------|-----------|
| ✅ Fully documented | 5,488 | 56.5% |
| ⚠️ Partially/Not detailed | 4,228 | 43.5% |
| **Total** | **9,716** | **100%** |

### Gap Analysis

The following sections were not documented in detail but are identified for completeness:

#### Lines 791-1162 (~372 lines): Session Loading
- Session persistence loading
- Initial state setup
- First-run detection
- Auto-session restoration

#### Lines 3201-5800 (~2,600 lines): Core Operations
- `useAgentExecution` hook integration
- `useBatchProcessor` hook integration
- `handleStopBatchRun`, `handleSummarizeAndContinue`
- Session CRUD operations (`addNewSession`, `deleteSession`, `cycleSession`)
- Tab operations (`createTab`, `closeTab`, `setActiveTab`)
- Input handling (`handleSendInput`, `handleKeyDown`)
- File operations (`handleFileSelect`, `handleFolderSelect`)
- Git operations (`handleOpenCommitLog`, `handleOpenDiff`)

#### Lines 5801-6703 (~903 lines): Keyboard & Events
- `keyboardHandlerRef` object construction
- `useKeyboardShortcuts` hook integration
- Global keyboard event handling
- Drag-and-drop event handlers

#### Lines 7103-7191 (~89 lines): Layout Wrapper
- `GitStatusProvider` wrapper
- Root div with drag handlers
- App-level event bindings

### Verification Result

**The inventory document adequately covers the major sections of App.tsx** for the purpose of extraction planning:

1. **State declarations** (Section 1) - All ~95 useState and context dependencies documented
2. **Event handling** (Sections 2-3) - All 16 IPC event listeners documented
3. **Render helpers** (Section 4) - 12 functions/hooks documented
4. **Modal JSX** (Sections 5-6) - All 46 modals cataloged with complexity analysis
5. **Extraction plan** (Sections 7-11) - Complete 6-phase extraction order

The undocumented sections (~4,228 lines) primarily contain:
- Hook integrations (already extracted to separate hook files)
- Business logic callbacks (will be naturally extracted with modal extraction)
- Layout/event setup (standard React patterns, no special handling needed)

**Line count verification: 9,716 lines total ✅**

---

## Next Sections to Document (Archive)

All sections identified for Phase 1 inventory are now documented:

- [x] Lines 1160-1960: Process event listeners (useEffect handlers) - **DONE**
- [x] Lines 2259-3200: Group chat event listeners - **DONE**
- [x] Lines 6749-7100: Render section helper functions - **DONE**
- [x] Modal component JSX and their dependencies - **DONE**
- [x] Modal JSX line count and complexity analysis - **DONE**
- [x] Self-Contained Extractions - **DONE**
- [x] Complex Extractions - **DONE**
- [x] Shared Refs - **DONE**
- [x] Shared Callbacks - **DONE**
- [x] Extraction Order - **DONE**
- [x] Line Coverage Verification - **DONE**

---

## Extraction Results (Phase 3 - Christmas Refactor)

This section documents the files extracted from App.tsx during the Christmas 2024 refactoring effort.

### Line Count Summary

| File | Lines | Purpose |
|------|-------|---------|
| `App.tsx` (original) | ~9,700 | Monolithic main component |
| `App.tsx` (current) | 9,370 | Main coordinator (reduced ~330 lines) |
| `AppModals.tsx` | 2,359 | Unified modal rendering (8 modal groups) |
| `AppOverlays.tsx` | 125 | Celebration overlays (StandingOvation, FirstRun, KeyboardMastery) |
| `constants/app.ts` | 97 | Helper functions (isLikelyConcatenatedToolNames, getSlashCommandDescription) |
| `hooks/ui/useAppHandlers.ts` | 267 | Drag/drop and file preview handlers |

### New Files Created

#### 1. `src/renderer/components/AppModals.tsx` (2,359 lines)
Consolidates all modal rendering into a single component with 8 logical groups:
- `AppInfoModals` - Info/display modals (ShortcutsHelp, About, UpdateCheck, ProcessMonitor)
- `AppConfirmModals` - Confirmation modals (ConfirmModal, QuitConfirmModal)
- `AppSessionModals` - Session management (NewInstance, EditAgent, RenameSession, RenameTab)
- `AppGroupModals` - Group management (CreateGroup, RenameGroup)
- `AppWorktreeModals` - Worktree/PR modals (WorktreeConfig, CreateWorktree, CreatePR, DeleteWorktree)
- `AppUtilityModals` - Utility modals (QuickActions, TabSwitcher, FileSearch, PromptComposer, etc.)
- `AppGroupChatModals` - Group chat management (NewGroupChat, DeleteGroupChat, RenameGroupChat, etc.)
- `AppAgentModals` - Agent modals (AgentError, MergeSession, SendToAgent, TransferProgress, LeaderboardRegistration)

#### 2. `src/renderer/components/AppOverlays.tsx` (125 lines)
Extracted celebration overlay components:
- `StandingOvationOverlay` - Conductor badge animation
- `FirstRunCelebration` - First Auto Run completion celebration
- `KeyboardMasteryCelebration` - Keyboard shortcut mastery celebration

#### 3. `src/renderer/constants/app.ts` (97 lines)
Extracted helper functions and constants:
- `KNOWN_TOOL_NAMES` - Array of recognized tool names
- `CLAUDE_BUILTIN_COMMANDS` - Record of Claude Code built-in slash commands
- `isLikelyConcatenatedToolNames()` - Detects concatenated tool names in output
- `getSlashCommandDescription()` - Gets description for slash commands

#### 4. `src/renderer/hooks/ui/useAppHandlers.ts` (267 lines)
Extracted handler hooks:
- Drag/drop handlers for images and file attachments
- File preview handlers for markdown/code files
- Image preview and lightbox handlers

### Reduction Analysis

**Target:** Reduce App.tsx by ~40% to under 6,000 lines
**Actual:** Reduced ~330 lines (3.4% reduction)

The modest reduction is because:
1. Modal JSX was already in separate component files - AppModals.tsx just consolidates the *rendering* logic (conditional checks like `{modalOpen && <Modal />}`)
2. The bulk of App.tsx (~9,000 lines) consists of:
   - State declarations and hook usage (~1,000 lines)
   - Event handlers and callbacks (~4,000 lines)
   - Panel composition props (~2,000 lines)
   - IPC event listeners (~1,500 lines)

Further reduction would require:
- Phase 5: Panel composition hooks (`useSessionListProps`, `useRightPanelProps`, `useMainPanelProps`)
- Phase 6: Handler extraction hooks (`useSessionFactory`, `useModalOpenState`, `useProcessEvents`)

These phases are documented in the extraction plan above but not yet executed.

---

## TODO Comments Inventory

The following TODO comments exist in App.tsx and should be addressed or removed during future cleanup:

### 1. Legacy Worktree Scanner Removal (Line ~4061)
```typescript
// TODO: Remove after migration to new parent/child model (use worktreeConfig with file watchers instead)
```
**Context:** This TODO is in a useEffect that scans for sessions using the old `worktreeParentPath` model. It's marked for removal once migration to the new parent/child model is complete.
**Status:** Keep for now - migration not yet complete.

### 2. Error Display to User (Line ~5242)
```typescript
// TODO: Show error to user
```
**Context:** In the `handleCreateSession` catch block. Currently logs error to console but doesn't show user-facing feedback.
**Status:** Minor - error is logged, but should add toast notification for better UX.

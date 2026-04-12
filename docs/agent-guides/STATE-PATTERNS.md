<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# State Patterns Reference

Complete reference for Maestro's frontend state management: all Zustand stores, the Session data model, common patterns, and hook conventions.

---

## Store Architecture

Maestro uses Zustand stores to replace React Context providers. Each store:

- Uses **selector-based subscriptions** (components only re-render when their slice changes)
- Supports **non-React access** via `useStore.getState()` and `getState()/getActions()` helpers
- Supports **functional updaters** matching React's `setState` signature

All stores are in `src/renderer/stores/`.

---

## Store Inventory

| Store                 | File                   | Hook                   | Purpose                                                                                     |
| --------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| **sessionStore**      | `sessionStore.ts`      | `useSessionStore`      | Sessions, groups, active session, bookmarks, worktree tracking, initialization              |
| **uiStore**           | `uiStore.ts`           | `useUIStore`           | UI layout: sidebars, focus, notifications, search, drag-and-drop, editing                   |
| **tabStore**          | `tabStore.ts`          | `useTabStore`          | Tab operations (CRUD, navigation, metadata), gist state. Wraps tabHelpers.ts + sessionStore |
| **agentStore**        | `agentStore.ts`        | `useAgentStore`        | Agent detection cache, error recovery, queue processing, agent lifecycle                    |
| **modalStore**        | `modalStore.ts`        | `useModalStore`        | Modal visibility via registry pattern. Single Map replaces 90+ boolean fields               |
| **groupChatStore**    | `groupChatStore.ts`    | `useGroupChatStore`    | Group chat state: chats list, messages, moderator, participants, execution queue            |
| **settingsStore**     | `settingsStore.ts`     | `useSettingsStore`     | App settings (theme, font, shortcuts, agent configs, etc.)                                  |
| **fileExplorerStore** | `fileExplorerStore.ts` | `useFileExplorerStore` | File explorer panel state                                                                   |
| **batchStore**        | `batchStore.ts`        | `useBatchStore`        | Batch/Auto Run execution state                                                              |
| **notificationStore** | `notificationStore.ts` | `useNotificationStore` | In-app notification queue                                                                   |
| **operationStore**    | `operationStore.ts`    | `useOperationStore`    | Long-running operation tracking                                                             |

---

## sessionStore (Core)

**File:** `src/renderer/stores/sessionStore.ts`
**Hook:** `useSessionStore`

### State

```typescript
interface SessionStoreState {
	sessions: Session[]; // All sessions (agents)
	groups: Group[]; // Session groups
	activeSessionId: string; // Currently selected session
	sessionsLoaded: boolean; // Loaded from disk
	initialLoadComplete: boolean; // First load finished
	initialFileTreeReady: boolean; // File tree hydrated on startup
	removedWorktreePaths: Set<string>; // Prevent worktree re-discovery
	cyclePosition: number; // Cmd+J/K navigation position
}
```

### Key Actions

| Action                       | Signature                            | Notes                                             |
| ---------------------------- | ------------------------------------ | ------------------------------------------------- |
| `setSessions`                | `(Session[] \| (prev => Session[]))` | Supports functional updater. Skips no-op updates. |
| `addSession`                 | `(Session)`                          | Append to end.                                    |
| `removeSession`              | `(id: string)`                       | Filter by ID.                                     |
| `updateSession`              | `(id: string, Partial<Session>)`     | Efficient single-session update.                  |
| `setActiveSessionId`         | `(id: string)`                       | Resets cycle position.                            |
| `setActiveSessionIdInternal` | `(string \| (prev => string))`       | For cycling - does NOT reset cycle position.      |
| `setGroups`                  | `(Group[] \| (prev => Group[]))`     | Functional updater support.                       |
| `toggleBookmark`             | `(sessionId: string)`                | Toggle session bookmark flag.                     |
| `addLogToTab`                | `(sessionId, logEntry, tabId?)`      | Add log to specific tab (or active tab).          |

### Selectors

```typescript
// Use with: const value = useSessionStore(selector);
selectActiveSession; // (state) => Session | null
selectSessionById(id); // (state) => Session | undefined
selectBookmarkedSessions; // (state) => Session[]
selectSessionsByGroup(id); // (state) => Session[]
selectUngroupedSessions; // (state) => Session[]
selectGroupById(id); // (state) => Group | undefined
selectSessionCount; // (state) => number
selectIsReady; // (state) => boolean (loaded + initialized)
selectIsAnySessionBusy; // (state) => boolean
```

### Non-React Access

```typescript
import { getSessionState, getSessionActions } from './stores/sessionStore';

// Read current state (snapshot)
const { sessions, activeSessionId } = getSessionState();

// Get stable action references
const { setSessions, setActiveSessionId } = getSessionActions();
```

---

## uiStore

**File:** `src/renderer/stores/uiStore.ts`
**Hook:** `useUIStore`

### State Slices

| Slice                      | Type             | Default   | Purpose                       |
| -------------------------- | ---------------- | --------- | ----------------------------- |
| `leftSidebarOpen`          | `boolean`        | `true`    | Left sidebar visibility       |
| `rightPanelOpen`           | `boolean`        | `true`    | Right panel visibility        |
| `activeFocus`              | `FocusArea`      | `'main'`  | Current keyboard focus area   |
| `activeRightTab`           | `RightPanelTab`  | `'files'` | Active tab in right panel     |
| `bookmarksCollapsed`       | `boolean`        | `false`   | Bookmarks section collapsed   |
| `groupChatsExpanded`       | `boolean`        | `true`    | Group chats section expanded  |
| `showUnreadOnly`           | `boolean`        | `false`   | Filter session list to unread |
| `flashNotification`        | `string \| null` | `null`    | Error flash message           |
| `successFlashNotification` | `string \| null` | `null`    | Success flash message         |
| `outputSearchOpen`         | `boolean`        | `false`   | Output search bar visible     |
| `outputSearchQuery`        | `string`         | `''`      | Current search query          |
| `sessionFilterOpen`        | `boolean`        | `false`   | Sidebar agent filter visible  |
| `draggingSessionId`        | `string \| null` | `null`    | Session being dragged         |
| `editingGroupId`           | `string \| null` | `null`    | Group being renamed inline    |
| `editingSessionId`         | `string \| null` | `null`    | Session being renamed inline  |

All actions support functional updaters and have toggle variants where appropriate (e.g., `toggleLeftSidebar`, `toggleRightPanel`, `toggleShowUnreadOnly`).

---

## tabStore

**File:** `src/renderer/stores/tabStore.ts`
**Hook:** `useTabStore`

Tab data lives inside Session objects in sessionStore. This store provides orchestration actions that compose `tabHelpers.ts` pure functions with sessionStore mutations.

### Own State

```typescript
interface TabStoreState {
	tabGistContent: { filename: string; content: string } | null;
	fileGistUrls: Record<string, GistInfo>;
}
```

### Tab CRUD Actions

| Action            | Signature                                     | Notes                           |
| ----------------- | --------------------------------------------- | ------------------------------- |
| `createTab`       | `(options?) => CreateTabResult \| null`       | Create AI tab in active session |
| `closeTab`        | `(tabId, options?) => CloseTabResult \| null` | Close AI tab                    |
| `closeFileTab`    | `(tabId) => CloseFileTabResult \| null`       | Close file preview tab          |
| `reopenClosedTab` | `() => ReopenUnifiedClosedTabResult \| null`  | Reopen most recently closed tab |

### Tab Navigation Actions

| Action            | Signature                                                 | Notes                     |
| ----------------- | --------------------------------------------------------- | ------------------------- |
| `selectTab`       | `(tabId) => SetActiveTabResult \| null`                   | Set active AI tab         |
| `selectFileTab`   | `(tabId) => void`                                         | Set active file tab       |
| `navigateToNext`  | `(showUnreadOnly?) => NavigateToUnifiedTabResult \| null` | Next tab in unified order |
| `navigateToPrev`  | `(showUnreadOnly?) => NavigateToUnifiedTabResult \| null` | Previous tab              |
| `navigateToIndex` | `(index) => NavigateToUnifiedTabResult \| null`           | Tab by position           |
| `navigateToLast`  | `() => NavigateToUnifiedTabResult \| null`                | Last tab                  |

### Tab Metadata Actions

| Action                | Signature          | Notes                             |
| --------------------- | ------------------ | --------------------------------- |
| `starTab`             | `(tabId)`          | Toggle starred flag               |
| `markUnread`          | `(tabId, unread?)` | Set hasUnread flag                |
| `updateTabName`       | `(tabId, name)`    | Update tab display name           |
| `toggleReadOnly`      | `(tabId)`          | Toggle read-only mode             |
| `toggleSaveToHistory` | `(tabId)`          | Toggle history saving             |
| `cycleThinkingMode`   | `(tabId)`          | Cycle: off -> on -> sticky -> off |

### Tab Selectors (use with useSessionStore)

```typescript
selectActiveTab; // Active AI tab from active session
selectActiveFileTab; // Active file tab from active session
selectUnifiedTabs; // All tabs (AI + file) in order
selectTabById(id); // Specific AI tab
selectFileTabById(id); // Specific file tab
selectTabCount; // AI tab count
selectAllTabs; // All AI tabs
selectAllFileTabs; // All file tabs
```

---

## agentStore

**File:** `src/renderer/stores/agentStore.ts`
**Hook:** `useAgentStore`

### State

```typescript
interface AgentStoreState {
	availableAgents: AgentConfig[]; // Cached detection results
	agentsDetected: boolean; // Detection completed at least once
}
```

### Key Actions

| Action                      | Signature                                  | Purpose                                  |
| --------------------------- | ------------------------------------------ | ---------------------------------------- |
| `refreshAgents`             | `(sshRemoteId?) => Promise<void>`          | Detect agents and cache results          |
| `getAgentConfig`            | `(agentId) => AgentConfig \| undefined`    | Look up cached agent config              |
| `clearAgentError`           | `(sessionId, tabId?)`                      | Clear error state, reset to idle         |
| `startNewSessionAfterError` | `(sessionId, options?)`                    | Clear error + create fresh tab           |
| `retryAfterError`           | `(sessionId)`                              | Clear error, let user retry              |
| `restartAgentAfterError`    | `(sessionId) => Promise<void>`             | Kill process + clear error               |
| `authenticateAfterError`    | `(sessionId)`                              | Switch to terminal for re-auth           |
| `processQueuedItem`         | `(sessionId, item, deps) => Promise<void>` | Build spawn config and dispatch to agent |
| `killAgent`                 | `(sessionId, suffix?) => Promise<void>`    | Kill agent process                       |
| `interruptAgent`            | `(sessionId) => Promise<void>`             | Send CTRL+C to agent                     |

---

## modalStore

**File:** `src/renderer/stores/modalStore.ts`
**Hook:** `useModalStore`

### Registry Pattern

Replaces 90+ boolean fields with a `Map<ModalId, ModalEntry>`:

```typescript
interface ModalEntry<T = unknown> {
	open: boolean;
	data?: T;
}
```

### ModalId Union

The current union in `src/renderer/stores/modalStore.ts` lists ~55 modal identifiers (exact list grows as features land — check the source):

- **Chrome / global:** `settings`, `shortcutsHelp`, `about`, `feedback`, `updateCheck`
- **Agent lifecycle:** `newAgentChoice`, `newInstance`, `editAgent`, `deleteAgent`, `renameInstance`, `agentError`
- **Navigation / command:** `quickAction`, `tabSwitcher`, `fuzzyFileSearch`, `promptComposer`
- **Tab / group edit:** `renameTab`, `renameGroup`
- **Session actions:** `mergeSession`, `sendToAgent`, `agentSessions`, `queueBrowser`, `batchRunner`, `autoRunSetup`, `marketplace`
- **Worktree:** `worktreeConfig`, `createWorktree`, `createPR`, `deleteWorktree`
- **Group chat:** `newGroupChat`, `deleteGroupChat`, `renameGroupChat`, `editGroupChat`, `groupChatInfo`
- **Git:** `gitDiff`, `gitLog`
- **Wizard / onboarding:** `wizardResume`, `tour`
- **Debug / diagnostic:** `debugWizard`, `debugPackage`, `playground`, `logViewer`, `processMonitor`, `usageDashboard`
- **Confirm / celebration:** `confirm`, `quitConfirm`, `standingOvation`, `firstRunCelebration`, `keyboardMastery`, `leaderboard`, `lightbox`
- **Feature-specific:** `symphony`, `windowsWarning`, `directorNotes`, `cueModal`, `cueYamlEditor`

### Core Actions

```typescript
openModal<T extends ModalId>(id: T, data?: ModalDataFor<T>): void
closeModal(id: ModalId): void
toggleModal<T extends ModalId>(id: T, data?: ModalDataFor<T>): void
updateModalData<T extends ModalId>(id: T, data: Partial<ModalDataFor<T>>): void
isOpen(id: ModalId): boolean
getData<T extends ModalId>(id: T): ModalDataFor<T> | undefined
closeAll(): void
```

### Typed Data Map

Modals with associated data have type-safe access:

```typescript
interface ModalDataMap {
	settings: { tab: SettingsTab };
	newInstance: { duplicatingSessionId: string | null };
	editAgent: { session: Session };
	quickAction: { initialMode: 'main' | 'move-to-group' };
	confirm: { message: string; onConfirm: () => void; title?; destructive? };
	lightbox: { image: string | null; images: string[]; source; isGroupChat; allowDelete };
	agentError: { sessionId: string; historicalError?: AgentError };
	// ...and more
}
```

### Selectors

```typescript
selectModalOpen(id); // (state) => boolean
selectModalData(id); // (state) => ModalDataFor<T> | undefined
selectModal(id); // (state) => ModalEntry<ModalDataFor<T>> | undefined
```

### ModalContext Compatibility

`getModalActions()` returns a compatibility layer with the old ModalContext API shape (e.g., `setSettingsModalOpen(true)`). `useModalActions()` hook provides the same reactive API for components still using the old pattern.

---

## groupChatStore

**File:** `src/renderer/stores/groupChatStore.ts`
**Hook:** `useGroupChatStore`

### State

```typescript
interface GroupChatStoreState {
	groupChats: GroupChat[];
	activeGroupChatId: string | null;
	groupChatMessages: GroupChatMessage[];
	groupChatState: GroupChatState; // 'idle' | 'running' | 'paused' | ...
	participantStates: Map<string, 'idle' | 'working'>;
	moderatorUsage: { contextUsage; totalCost; tokenCount } | null;
	groupChatStates: Map<string, GroupChatState>; // All chats (for sidebar indicators)
	allGroupChatParticipantStates: Map<string, Map<string, 'idle' | 'working'>>;
	groupChatExecutionQueue: QueuedItem[];
	groupChatReadOnlyMode: boolean;
	groupChatRightTab: 'participants' | 'history';
	groupChatParticipantColors: Record<string, string>;
	groupChatStagedImages: string[];
	groupChatError: GroupChatErrorState | null;
}
```

### Convenience Actions

- `clearGroupChatError()` - Clear error state
- `resetGroupChatState()` - Reset to initial values (close chat view)

---

## Common Patterns

### 1. Functional Updaters

All stores accept both direct values and updater functions, matching React's `setState`:

```typescript
// Direct value
setSessions(newSessions);

// Functional updater (access previous state)
setSessions((prev) => prev.filter((s) => s.id !== deletedId));

// Boolean toggle
setLeftSidebarOpen((prev) => !prev);
```

Implementation pattern used across all stores:

```typescript
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}
```

### 2. No-Op Skipping

Stores skip state updates when nothing changes:

```typescript
setSessions: (v) => set((s) => {
	const newSessions = resolve(v, s.sessions);
	if (newSessions === s.sessions) return s; // Skip - same reference
	return { sessions: newSessions };
}),
```

### 3. Non-React Access

Every store provides `getState()` and `getActions()` helpers for use outside React:

```typescript
// Pattern: read state outside React
const { sessions } = getSessionState();

// Pattern: call actions outside React (services, orchestrators, IPC handlers)
const { setSessions, addSession } = getSessionActions();
setSessions((prev) => [...prev, newSession]);
```

### 4. Granular Selectors

Subscribe to specific slices to minimize re-renders:

```typescript
// GOOD: Only re-renders when activeSessionId changes
const activeId = useSessionStore((state) => state.activeSessionId);

// GOOD: Derived selector with stable reference
const activeSession = useSessionStore(selectActiveSession);

// BAD: Subscribes to entire store (re-renders on any change)
const store = useSessionStore();
```

### 5. getState() for Event Handlers

Inside event handlers and callbacks, use `getState()` instead of hook values to avoid stale closures:

```typescript
// GOOD: Always reads current state
const handleClick = () => {
	const { activeSessionId, sessions } = useSessionStore.getState();
	// ...
};

// BAD: May capture stale closure
const activeId = useSessionStore((s) => s.activeSessionId);
const handleClick = () => {
	// activeId might be stale if component hasn't re-rendered
};
```

### 6. Cross-Store Composition

Stores compose by reading each other's state. tabStore reads from sessionStore:

```typescript
// tabStore reads active session from sessionStore
function getActiveSession(): Session | null {
	return selectActiveSession(useSessionStore.getState());
}

// tabStore writes back to sessionStore
function updateActiveSession(updated: Session): void {
	const { activeSessionId } = useSessionStore.getState();
	useSessionStore
		.getState()
		.setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? updated : s)));
}
```

### 7. Immutable Updates

All store updates create new objects. Never mutate:

```typescript
// CORRECT: New array, new object
updateSession: (id, updates) => set(s => ({
	sessions: s.sessions.map(session =>
		session.id === id ? { ...session, ...updates } : session
	),
})),

// WRONG: Mutation
updateSession: (id, updates) => set(s => {
	const session = s.sessions.find(s => s.id === id);
	Object.assign(session, updates); // NEVER DO THIS
	return { sessions: s.sessions };
}),
```

---

## Session Data Model

The `Session` interface (defined in `src/renderer/types/index.ts`) represents an agent in the Left Bar. Key fields:

| Field                    | Type                     | Purpose                                |
| ------------------------ | ------------------------ | -------------------------------------- |
| `id`                     | `string`                 | Unique session identifier              |
| `name`                   | `string`                 | Display name                           |
| `toolType`               | `ToolType`               | Agent type (claude-code, codex, etc.)  |
| `state`                  | `SessionState`           | `'idle' \| 'busy' \| 'connecting'`     |
| `cwd`                    | `string`                 | Working directory                      |
| `projectRoot`            | `string`                 | Project root path                      |
| `groupId`                | `string?`                | Group membership                       |
| `bookmarked`             | `boolean?`               | Bookmark flag                          |
| `inputMode`              | `'ai' \| 'terminal'`     | Current input mode                     |
| `aiTabs`                 | `AITab[]`                | AI conversation tabs                   |
| `activeTabId`            | `string?`                | Active AI tab                          |
| `filePreviewTabs`        | `FilePreviewTab[]`       | File preview tabs                      |
| `activeFileTabId`        | `string?`                | Active file tab                        |
| `unifiedTabOrder`        | `UnifiedTabRef[]`        | Combined tab ordering                  |
| `agentError`             | `AgentError?`            | Current error state                    |
| `agentErrorTabId`        | `string?`                | Tab that has the error                 |
| `sshRemoteId`            | `string?`                | SSH remote config ID (set after spawn) |
| `sessionSshRemoteConfig` | `AgentSshRemoteConfig?`  | SSH config (set before spawn)          |
| `customPath`             | `string?`                | Per-session agent path override        |
| `customArgs`             | `string?`                | Per-session custom args                |
| `customEnvVars`          | `Record<string,string>?` | Per-session env vars                   |
| `customModel`            | `string?`                | Per-session model override             |
| `customContextWindow`    | `number?`                | Per-session context window             |
| `isGitRepo`              | `boolean?`               | Whether cwd is a git repo              |
| `contextUsage`           | `number?`                | Context window usage percentage        |
| `usageStats`             | `UsageStats?`            | Token/cost statistics                  |

### AITab

Each AI tab within a session:

| Field            | Type           | Purpose                        |
| ---------------- | -------------- | ------------------------------ |
| `id`             | `string`       | Tab identifier                 |
| `name`           | `string?`      | Custom tab name                |
| `logs`           | `LogEntry[]`   | Conversation log entries       |
| `agentSessionId` | `string?`      | Provider session ID for resume |
| `state`          | Tab state      | Idle/busy per-tab              |
| `readOnlyMode`   | `boolean?`     | Read-only/plan mode            |
| `saveToHistory`  | `boolean`      | Whether to save completions    |
| `showThinking`   | `ThinkingMode` | `'off' \| 'on' \| 'sticky'`    |
| `starred`        | `boolean?`     | Starred tab flag               |
| `hasUnread`      | `boolean?`     | Unread indicator               |
| `agentError`     | `AgentError?`  | Per-tab error state            |

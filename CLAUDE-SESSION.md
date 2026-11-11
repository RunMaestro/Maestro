# CLAUDE-SESSION.md

Session interface (agent data model) and code conventions for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

> **Terminology:** In code, the `Session` interface represents what users see as an **agent** in the Left Bar. The name is historical. Within each agent, "provider sessions" refer to individual conversation contexts (tabs). See [[CLAUDE.md#terminology-agent-vs-session]] for the full distinction.

## Session Interface (Agent Data Model)

Key fields on the Session object (abbreviated - see `src/renderer/types/index.ts` for full definition):

```typescript
interface Session {
	// Identity
	id: string;
	name: string;
	groupId?: string; // Agent grouping
	toolType: ToolType; // One of the 13 ids in AGENT_IDS (src/shared/agentIds.ts), e.g. 'claude-code' | 'codex' | 'terminal'
	state: SessionState; // 'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error'
	inputMode: 'ai' | 'terminal'; // Which process receives input
	bookmarked?: boolean; // Pinned to top

	// Paths
	cwd: string; // Current working directory (can change via cd)
	projectRoot: string; // Working directory root (used for provider session storage). Moves ONLY through withWorkingDirectory() in src/renderer/utils/agentWorkingDirectory.ts
	fullPath: string; // Full resolved path

	// Processes
	aiPid: number; // AI process ID
	terminalPid: number; // DEPRECATED: replaced by terminalTabs[].pid
	port: number; // Web server communication port

	// Multi-Tab Support (AI Tabs)
	aiTabs: AITab[]; // Multiple conversation tabs
	activeTabId: string; // Currently active AI tab
	closedTabHistory: ClosedTab[]; // Undo stack for closed AI tabs
	orphanedThinkingTabs?: AITab[]; // Tabs closed mid-turn, kept so the Thinking pill keeps counting
	snoozedTabs?: SnoozedTabEntry[]; // Parked tabs (see snoozeHelpers / snoozeActions)

	// File / Terminal / Browser Tabs
	filePreviewTabs: FilePreviewTab[]; // Open file preview tabs
	activeFileTabId: string | null; // Active file tab (null if AI tab active)
	terminalTabs: TerminalTab[]; // PTY shell tabs (types/index.ts ~1004)
	activeTerminalTabId: string | null;
	browserTabs: BrowserTab[]; // In-app browser tabs (types/index.ts ~1031)
	activeBrowserTabId: string | null;
	unifiedTabOrder: UnifiedTabRef[]; // Visual order of ALL tab kinds
	unifiedClosedTabHistory: ClosedTabEntry[]; // Unified undo stack for Cmd+Shift+T
	tabGroups: TabGroup[]; // Tiled groups (see Tab groups below)
	activeGroupId: string | null; // Group owning the panel, or null for a single tab
	terminalDraftInput?: string; // Draft text for the terminal composer

	// Logs
	aiLogs: LogEntry[]; // Legacy session-level AI log; per-tab logs live on AITab.logs
	shellLogs: LogEntry[]; // DEPRECATED: terminal tabs stream straight from the PTY via xterm.js

	// Execution Queue
	executionQueue: QueuedItem[]; // Sequential execution queue

	// Usage & Stats
	usageStats?: UsageStats; // Token usage and cost
	contextUsage: number; // Context window usage percentage
	workLog: WorkLogItem[]; // Work tracking

	// Git Integration
	isGitRepo: boolean; // Git features enabled
	changedFiles: FileArtifact[]; // Git change tracking
	gitBranches?: string[]; // Branch cache for completion
	gitTags?: string[]; // Tag cache for completion

	// File Explorer
	fileTree: any[]; // File tree structure
	fileExplorerExpanded: string[]; // Expanded folder paths
	fileExplorerScrollPos: number; // Scroll position

	// Web/Live Sessions
	isLive: boolean; // Accessible via web interface
	liveUrl?: string; // Live session URL

	// Auto Run
	autoRunFolderPath?: string; // Auto Run document folder
	autoRunSelectedFile?: string; // Selected document
	autoRunMode?: 'edit' | 'preview'; // Current mode

	// Command History
	aiCommandHistory?: string[]; // AI input history
	shellCommandHistory?: string[]; // Terminal input history

	// Error Handling
	agentError?: AgentError; // Current agent error (auth, tokens, rate limit, etc.)
	agentErrorPaused?: boolean; // Input blocked while error modal shown
	agentErrorTabId?: string; // Which AI tab raised the error

	// SSH remote (see CLAUDE-PLATFORM.md; read through getSessionSshRemoteId() / isSessionRemote())
	sshRemoteId?: string; // Set AFTER the agent spawns
	sessionSshRemoteConfig?: { enabled; remoteId; ... }; // User configuration, set BEFORE spawn
	sshRemote?: { ... }; // Resolved remote info
	remoteCwd?: string; // Working directory on the remote host

	// Worktrees
	worktreeConfig?: SessionWorktreeConfig;
	parentSessionId?: string; // Links a worktree agent back to its parent
	worktreeBranch?: string;

	// Overrides and misc
	customModel?: string; // Agent-level model override (AITab.customModel wins per tab)
	customEffort?: string;
	enableMaestroP?: boolean; // Adaptive Mode; maestroPMode?: 'interactive' | 'dynamic'
	cliActivity?: SessionCliActivity; // A playbook run holding this agent's cwd
	symphonyMetadata?: SymphonySessionMetadata;
}

interface AITab {
	// Full definition: src/renderer/types/index.ts ~810-918
	id: string;
	name: string | null; // null = show the session-id octet (getTabDisplayName)
	logs: LogEntry[]; // Tab-specific conversation history
	agentSessionId: string | null; // Provider session ID (null for a new tab)
	starred: boolean;
	inputValue: string; // Pending composer text (there is no draftInput)
	commandMode?: ComposerCommandMode | boolean; // Read through normalizeComposerCommandMode()
	stagedImages: string[];
	usageStats?: UsageStats;
	createdAt: number;
	state: 'idle' | 'busy';
	permissionMode?: 'full' | 'standard' | 'readonly'; // Kept in lockstep with readOnlyMode
	customModel?: string; // Per-tab overrides; customEffort?: string
	hidden?: boolean; // Consult tab: no chip, never counted (see isAiTabHidden)
	consultOrigin?: { ... }; // Which source tab's @mention created this consult tab
	providerSessions?: Partial<Record<ToolType, ProviderTabSession>>;
	turnProvider?: ToolType; // Codified at send; turnModel?, turnEffort?
	agentError?: AgentError; // Tab-specific error banner
	scrollTop?: number;
}

interface FilePreviewTab {
	// Full definition: src/renderer/types/index.ts ~961-997
	id: string; // Unique tab ID (UUID)
	path: string; // Full file path
	name: string; // Filename without extension
	customName?: string; // User-assigned label
	extension: string; // File extension with dot (e.g., '.md')
	content: string; // File content
	scrollTop: number; // Preserved scroll position
	searchQuery: string; // Preserved search query
	editMode: boolean; // Whether tab was in edit mode
	editContent: string | undefined; // Unsaved edit content (undefined = none pending)
	createdAt: number; // Timestamp for ordering
	lastModified: number; // File modification time
	sshRemoteId?: string; // SSH remote ID for remote files
	isLoading?: boolean; // True while loading remote content
	loadRequestId?: string; // In-flight fs:readFile request while isLoading
	navigationHistory?: FilePreviewHistoryEntry[]; // Back/forward stack; navigationIndex?: number
	previewTierOverride?: 'rich' | 'fast' | 'giant';
	htmlRenderMode?: boolean;
	pendingScrollToLine?: number;
}

// Unified tab references for ordering: five kinds, 'group' is a tiled TabGroup
type UnifiedTabRef = { type: 'ai' | 'file' | 'terminal' | 'browser' | 'group'; id: string };
```

**Other tab types** (not restated here, read them in `src/renderer/types/index.ts`):

- `TerminalTab` (~line 1004): `id`, `name | null` ("Terminal N" when null), `shellType`, `pid` (0 until the PTY spawns), `cwd`, `state: 'idle' | 'busy' | 'exited'`, `exitCode?`. Helpers in `src/renderer/utils/terminalTabHelpers.ts`.
- `BrowserTab` (~line 1031): `id`, `url`, `title`, `customTitle?` (locks the label against page-set titles), `partition?`, `canGoBack` / forward state.
- Tab groups (~line 1090-1180): `PanelLayoutNode` is a `leaf` (one `UnifiedTabRef`) or a `split` (`row` | `column` with children); `TabGroup` holds a layout plus an optional emoji; `ClosedTabEntry` is the unified undo entry. Activating a standalone tab must clear `activeGroupId` (see `resolveActiveTabRef` in `utils/panelLayout.ts`).

---

## Code Conventions

### TypeScript

- Strict mode enabled
- Interface definitions for all data structures
- The IPC bridge is `src/main/preload/` (one module per `window.maestro.*` namespace, assembled in `preload/index.ts`); the renderer-side `window.maestro` typings live in `src/renderer/global.d.ts`

### React Components

- Functional components with hooks
- Tailwind for layout, inline styles for theme colors
- `tabIndex={-1}` + `outline-none` for programmatic focus

### Commit Messages

```
feat: new feature
fix: bug fix
docs: documentation
refactor: code refactoring
```

**IMPORTANT**: Do NOT create a `CHANGELOG.md` file. This project does not use changelogs - all change documentation goes in commit messages and PR descriptions only.

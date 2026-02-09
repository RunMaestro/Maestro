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
  groupId?: string;             // Agent grouping
  toolType: ToolType;           // 'claude-code' | 'codex' | 'opencode' | 'terminal'
  state: SessionState;          // 'idle' | 'busy' | 'error' | 'connecting'
  inputMode: 'ai' | 'terminal'; // Which process receives input
  bookmarked?: boolean;         // Pinned to top

  // Paths
  cwd: string;                  // Current working directory (can change via cd)
  projectRoot: string;          // Initial directory (never changes, used for session storage)
  fullPath: string;             // Full resolved path

  // Processes
  aiPid: number;                // AI process ID
  port: number;                 // Web server communication port

  // Multi-Tab Support (AI Tabs)
  aiTabs: AITab[];              // Multiple conversation tabs
  activeTabId: string;          // Currently active AI tab
  closedTabHistory: ClosedTab[]; // Undo stack for closed AI tabs

  // File Preview Tabs
  filePreviewTabs: FilePreviewTab[]; // Open file preview tabs
  activeFileTabId: string | null;    // Active file tab (null if AI tab active)
  unifiedTabOrder: UnifiedTabRef[];  // Visual order of all tabs (AI + file)
  closedUnifiedTabHistory: ClosedUnifiedTab[]; // Unified undo stack for Cmd+Shift+T

  // Logs (per-tab)
  shellLogs: LogEntry[];        // Terminal output history

  // Execution Queue
  executionQueue: QueuedItem[]; // Sequential execution queue

  // Usage & Stats
  usageStats?: UsageStats;      // Token usage and cost
  contextUsage: number;         // Context window usage percentage
  workLog: WorkLogItem[];       // Work tracking

  // Git Integration
  isGitRepo: boolean;           // Git features enabled
  changedFiles: FileArtifact[]; // Git change tracking
  gitBranches?: string[];       // Branch cache for completion
  gitTags?: string[];           // Tag cache for completion

  // File Explorer
  fileTree: any[];              // File tree structure
  fileExplorerExpanded: string[]; // Expanded folder paths
  fileExplorerScrollPos: number; // Scroll position

  // Web/Live Sessions
  isLive: boolean;              // Accessible via web interface
  liveUrl?: string;             // Live session URL

  // Auto Run
  autoRunFolderPath?: string;   // Auto Run document folder
  autoRunSelectedFile?: string; // Selected document
  autoRunMode?: 'edit' | 'preview'; // Current mode

  // Command History
  aiCommandHistory?: string[];  // AI input history
  shellCommandHistory?: string[]; // Terminal input history

  // Error Handling
  agentError?: AgentError;        // Current agent error (auth, tokens, rate limit, etc.)
  agentErrorPaused?: boolean;     // Input blocked while error modal shown
}

interface AITab {
  id: string;
  name: string;
  logs: LogEntry[];             // Tab-specific conversation history
  agentSessionId?: string;      // Provider session ID for this tab
  scrollTop?: number;
  draftInput?: string;
}

interface FilePreviewTab {
  id: string;                   // Unique tab ID (UUID)
  path: string;                 // Full file path
  name: string;                 // Filename without extension
  extension: string;            // File extension with dot (e.g., '.md')
  content: string;              // File content
  scrollTop: number;            // Preserved scroll position
  searchQuery: string;          // Preserved search query
  editMode: boolean;            // Whether tab was in edit mode
  editContent?: string;         // Unsaved edit content
  createdAt: number;            // Timestamp for ordering
  lastModified: number;         // File modification time
  sshRemoteId?: string;         // SSH remote ID for remote files
  isLoading?: boolean;          // True while loading remote content
}

// Unified tab references for ordering
type UnifiedTabRef = { type: 'ai' | 'file'; id: string };
```

---

## Code Conventions

### TypeScript
- Strict mode enabled
- Interface definitions for all data structures
- Types exported via `preload.ts` for renderer

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

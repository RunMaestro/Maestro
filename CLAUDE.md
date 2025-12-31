# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Standardized Vernacular

Use these terms consistently in code, comments, and documentation:

### UI Components
- **Left Bar** - Left sidebar with session list and groups (`SessionList.tsx`)
- **Right Bar** - Right sidebar with Files, History, Auto Run tabs (`RightPanel.tsx`)
- **Main Window** - Center workspace (`MainPanel.tsx`)
  - **AI Terminal** - Main window in AI mode (interacting with AI agents)
  - **Command Terminal** - Main window in terminal/shell mode
  - **System Log Viewer** - Special view for system logs (`LogViewer.tsx`)

### Session States (color-coded)
- **Green** - Ready/idle
- **Yellow** - Agent thinking/busy
- **Red** - No connection/error
- **Pulsing Orange** - Connecting

## Project Overview

Maestro is an Electron desktop app for managing multiple AI coding assistants (Claude Code, OpenAI Codex, Gemini CLI, Qwen3 Coder) simultaneously with a keyboard-first interface.

## Quick Commands

```bash
npm run dev           # Development with hot reload (isolated data, can run alongside production)
npm run dev:prod-data # Development using production data (close production app first)
npm run dev:web       # Web interface development
npm run build         # Full production build
npm run clean         # Clean build artifacts
npm run lint          # TypeScript type checking (all configs)
npm run lint:eslint   # ESLint code quality checks
npm run package       # Package for all platforms
npm run test          # Run test suite
npm run test:watch    # Run tests in watch mode
```

## Architecture at a Glance

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts            # Entry point, IPC handlers
│   ├── process-manager.ts  # Process spawning (PTY + child_process)
│   ├── preload.ts          # Secure IPC bridge
│   ├── agent-detector.ts   # Agent detection and configuration
│   ├── agent-capabilities.ts # Agent capability definitions
│   ├── agent-session-storage.ts # Session storage interface
│   ├── parsers/            # Agent output parsers
│   │   ├── agent-output-parser.ts  # Parser interface
│   │   ├── claude-output-parser.ts # Claude Code parser
│   │   ├── opencode-output-parser.ts # OpenCode parser
│   │   └── error-patterns.ts # Error detection patterns
│   ├── storage/            # Session storage implementations
│   │   ├── claude-session-storage.ts
│   │   └── opencode-session-storage.ts
│   ├── tunnel-manager.ts   # Cloudflare tunnel support
│   ├── web-server.ts       # Fastify server for web/mobile interface
│   └── utils/execFile.ts   # Safe command execution
│
├── renderer/               # React frontend (desktop)
│   ├── App.tsx            # Main coordinator
│   ├── components/        # UI components
│   ├── hooks/             # Custom React hooks
│   ├── services/          # IPC wrappers (git.ts, process.ts)
│   ├── constants/         # Themes, shortcuts, priorities
│   └── contexts/          # Layer stack context
│
├── web/                    # Web/mobile interface
│   ├── mobile/            # Mobile-optimized React app
│   ├── components/        # Shared web components
│   └── hooks/             # Web-specific hooks
│
├── cli/                    # CLI tooling for batch automation
│   ├── commands/          # CLI command implementations
│   ├── services/          # Playbook and batch processing
│   └── index.ts           # CLI entry point
│
├── prompts/                # System prompts (editable .md files)
│   ├── wizard-*.md        # Wizard conversation prompts
│   ├── autorun-*.md       # Auto Run default prompts
│   └── index.ts           # Central exports
│
├── shared/                 # Shared types and utilities
│   ├── types.ts           # Common type definitions
│   └── templateVariables.ts # Template variable processing
│
└── docs/                   # Mintlify documentation (docs.runmaestro.ai)
    ├── docs.json          # Navigation and configuration
    ├── screenshots/       # All documentation screenshots
    └── *.md               # Documentation pages
```

### Key Files for Common Tasks

| Task | Primary Files |
|------|---------------|
| Add IPC handler | `src/main/index.ts`, `src/main/preload.ts` |
| Add UI component | `src/renderer/components/` |
| Add web/mobile component | `src/web/components/`, `src/web/mobile/` |
| Add keyboard shortcut | `src/renderer/constants/shortcuts.ts`, `App.tsx` |
| Add theme | `src/renderer/constants/themes.ts` |
| Add modal | Component + `src/renderer/constants/modalPriorities.ts` |
| Add tab overlay menu | See Tab Hover Overlay Menu pattern in `src/renderer/components/TabBar.tsx` |
| Add setting | `src/renderer/hooks/useSettings.ts`, `src/main/index.ts` |
| Add template variable | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts` |
| Modify system prompts | `src/prompts/*.md` (wizard, Auto Run, etc.) |
| Add Spec-Kit command | `src/prompts/speckit/`, `src/main/speckit-manager.ts` |
| Add OpenSpec command | `src/prompts/openspec/`, `src/main/openspec-manager.ts` |
| Add CLI command | `src/cli/commands/`, `src/cli/index.ts` |
| Configure agent | `src/main/agent-detector.ts`, `src/main/agent-capabilities.ts` |
| Add agent output parser | `src/main/parsers/`, `src/main/parsers/index.ts` |
| Add agent session storage | `src/main/storage/`, `src/main/agent-session-storage.ts` |
| Add agent error patterns | `src/main/parsers/error-patterns.ts` |
| Add playbook feature | `src/cli/services/playbooks.ts` |
| Modify wizard flow | `src/renderer/components/Wizard/` (see Onboarding Wizard section) |
| Add tour step | `src/renderer/components/Wizard/tour/tourSteps.ts` |
| Modify file linking | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links) |
| Add documentation page | `docs/*.md`, `docs/docs.json` (navigation) |
| Add documentation screenshot | `docs/screenshots/` (PNG, kebab-case naming) |
| MCP server integration | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server) |
| Add stats/analytics feature | `src/main/stats-db.ts`, `src/main/ipc/handlers/stats.ts` |
| Add Usage Dashboard chart | `src/renderer/components/UsageDashboard/` |
| Add Document Graph feature | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts` |
| Add colorblind palette | `src/renderer/constants/colorblindPalettes.ts` |
| Add performance metrics | `src/shared/performance-metrics.ts` |
| Add power management | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts` |

## Core Patterns

### 1. Process Management

Each session runs **two processes** simultaneously:
- AI agent process (Claude Code, etc.) - spawned with `-ai` suffix
- Terminal process (PTY shell) - spawned with `-terminal` suffix

```typescript
// Session stores both PIDs
session.aiPid       // AI agent process
session.terminalPid // Terminal process
```

### 2. Security Requirements

**Always use `execFileNoThrow`** for external commands:
```typescript
import { execFileNoThrow } from './utils/execFile';
const result = await execFileNoThrow('git', ['status'], cwd);
// Returns: { stdout, stderr, exitCode } - never throws
```

**Never use shell-based command execution** - it creates injection vulnerabilities. The `execFileNoThrow` utility is the safe alternative.

### 3. Settings Persistence

Add new settings in `useSettings.ts`:
```typescript
// 1. Add state
const [mySetting, setMySettingState] = useState(defaultValue);

// 2. Add wrapper that persists
const setMySetting = (value) => {
  setMySettingState(value);
  window.maestro.settings.set('mySetting', value);
};

// 3. Load in useEffect
const saved = await window.maestro.settings.get('mySetting');
if (saved !== undefined) setMySettingState(saved);
```

### 4. Adding Modals

1. Create component in `src/renderer/components/`
2. Add priority in `src/renderer/constants/modalPriorities.ts`
3. Register with layer stack:

```typescript
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

const { registerLayer, unregisterLayer } = useLayerStack();
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;

useEffect(() => {
  if (isOpen) {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.YOUR_MODAL,
      onEscape: () => onCloseRef.current(),
    });
    return () => unregisterLayer(id);
  }
}, [isOpen, registerLayer, unregisterLayer]);
```

### 5. Theme Colors

Themes have 13 required colors. Use inline styles for theme colors:
```typescript
style={{ color: theme.colors.textMain }}  // Correct
className="text-gray-500"                  // Wrong for themed text
```

### 6. Multi-Tab Sessions

Sessions support multiple AI conversation tabs:
```typescript
// Each session has an array of tabs
session.aiTabs: AITab[]
session.activeTabId: string

// Each tab maintains its own conversation
interface AITab {
  id: string;
  name: string;
  logs: LogEntry[];           // Tab-specific history
  agentSessionId?: string;    // Agent session continuity
}

// Tab operations
const activeTab = session.aiTabs.find(t => t.id === session.activeTabId);
```

### 7. Execution Queue

Messages are queued when the AI is busy:
```typescript
// Queue items for sequential execution
interface QueuedItem {
  type: 'message' | 'slashCommand';
  content: string;
  timestamp: number;
}

// Add to queue instead of sending directly when busy
session.executionQueue.push({ type: 'message', content, timestamp: Date.now() });
```

### 8. Auto Run

File-based document automation system:
```typescript
// Auto Run state on session
session.autoRunFolderPath?: string;    // Document folder path
session.autoRunSelectedFile?: string;  // Currently selected document
session.autoRunMode?: 'edit' | 'preview';

// API for Auto Run operations
window.maestro.autorun.listDocuments(folderPath);
window.maestro.autorun.readDocument(folderPath, filename);
window.maestro.autorun.saveDocument(folderPath, filename, content);
```

**Worktree Support:** Auto Run can operate in a git worktree, allowing users to continue interactive editing in the main repo while Auto Run processes tasks in the background. When `batchRunState.worktreeActive` is true, read-only mode is disabled and a git branch icon appears in the UI. See `useBatchProcessor.ts` for worktree setup logic.

### 9. Tab Hover Overlay Menu

AI conversation tabs display a hover overlay menu after a 400ms delay when hovering over tabs with an established session. The overlay includes tab management and context operations:

**Menu Structure:**
```typescript
// Tab operations (always shown)
- Copy Session ID (if session exists)
- Star/Unstar Session (if session exists)
- Rename Tab
- Mark as Unread

// Context management (shown when applicable)
- Context: Compact (if tab has 5+ messages)
- Context: Merge Into (if session exists)
- Context: Send to Agent (if session exists)

// Tab close actions (always shown)
- Close (disabled if only one tab)
- Close Others (disabled if only one tab)
- Close Tabs to the Left (disabled if first tab)
- Close Tabs to the Right (disabled if last tab)
```

**Implementation Pattern:**
```typescript
const [overlayOpen, setOverlayOpen] = useState(false);
const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(null);

const handleMouseEnter = () => {
  if (!tab.agentSessionId) return; // Only for established sessions

  hoverTimeoutRef.current = setTimeout(() => {
    if (tabRef.current) {
      const rect = tabRef.current.getBoundingClientRect();
      setOverlayPosition({ top: rect.bottom + 4, left: rect.left });
    }
    setOverlayOpen(true);
  }, 400);
};

// Render overlay via portal to escape stacking context
{overlayOpen && overlayPosition && createPortal(
  <div style={{ top: overlayPosition.top, left: overlayPosition.left }}>
    {/* Overlay menu items */}
  </div>,
  document.body
)}
```

**Key Features:**
- Appears after 400ms hover delay (only for tabs with `agentSessionId`)
- Fixed positioning at tab bottom
- Mouse can move from tab to overlay without closing
- Disabled states with visual feedback (opacity-40, cursor-default)
- Theme-aware styling
- Dividers separate action groups

See `src/renderer/components/TabBar.tsx` (Tab component) for implementation details.

### 10. SSH Remote Sessions

Sessions can execute commands on remote hosts via SSH. **Critical:** There are two different SSH identifiers with different lifecycles:

```typescript
// Set AFTER AI agent spawns (via onSshRemote callback)
session.sshRemoteId: string | undefined

// Set BEFORE spawn (user configuration)
session.sessionSshRemoteConfig: {
  enabled: boolean;
  remoteId: string | null;      // The SSH config ID
  workingDirOverride?: string;
}
```

**Common pitfall:** `sshRemoteId` is only populated after the AI agent spawns. For terminal-only SSH sessions (no AI agent), it remains `undefined`. Always use both as fallback:

```typescript
// WRONG - fails for terminal-only SSH sessions
const sshId = session.sshRemoteId;

// CORRECT - works for all SSH sessions
const sshId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId;
```

This applies to any operation that needs to run on the remote:
- `window.maestro.fs.readDir(path, sshId)`
- `gitService.isRepo(path, sshId)`
- Directory existence checks for `cd` command tracking

Similarly for checking if a session is remote:
```typescript
// WRONG
const isRemote = !!session.sshRemoteId;

// CORRECT
const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
```

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

## Session Interface

Key fields on the Session object (abbreviated - see `src/renderer/types/index.ts` for full definition):

```typescript
interface Session {
  // Identity
  id: string;
  name: string;
  groupId?: string;             // Session grouping
  toolType: ToolType;           // 'claude-code' | 'aider' | 'terminal' | etc.
  state: SessionState;          // 'idle' | 'busy' | 'error' | 'connecting'
  inputMode: 'ai' | 'terminal'; // Which process receives input
  bookmarked?: boolean;         // Pinned to top

  // Paths
  cwd: string;                  // Current working directory (can change via cd)
  projectRoot: string;          // Initial directory (never changes, used for Claude session storage)
  fullPath: string;             // Full resolved path

  // Processes
  aiPid: number;                // AI process ID
  port: number;                 // Web server communication port

  // Multi-Tab Support (NEW)
  aiTabs: AITab[];              // Multiple Claude Code conversation tabs
  activeTabId: string;          // Currently active tab
  closedTabHistory: ClosedTab[]; // Undo stack for closed tabs

  // Logs (per-tab)
  shellLogs: LogEntry[];        // Terminal output history

  // Execution Queue (replaces messageQueue)
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

  // Web/Live Sessions (NEW)
  isLive: boolean;              // Accessible via web interface
  liveUrl?: string;             // Live session URL

  // Auto Run (NEW)
  autoRunFolderPath?: string;   // Auto Run document folder
  autoRunSelectedFile?: string; // Selected document
  autoRunMode?: 'edit' | 'preview'; // Current mode

  // Command History
  aiCommandHistory?: string[];  // AI input history
  shellCommandHistory?: string[]; // Terminal input history

  // Error Handling (NEW)
  agentError?: AgentError;        // Current agent error (auth, tokens, rate limit, etc.)
  agentErrorPaused?: boolean;     // Input blocked while error modal shown
}

interface AITab {
  id: string;
  name: string;
  logs: LogEntry[];             // Tab-specific conversation history
  agentSessionId?: string;      // Agent session for this tab
  scrollTop?: number;
  draftInput?: string;
}
```

## IPC API Surface

The `window.maestro` API exposes:

### Core APIs
- `settings` - Get/set app settings
- `sessions` / `groups` - Persistence
- `process` - Spawn, write, kill, resize
- `fs` - readDir, readFile
- `dialog` - Folder selection
- `shells` - Detect available shells
- `logger` - System logging

### Agent & Agent Sessions
- `agents` - Detect, get, config, refresh, custom paths, getCapabilities
- `agentSessions` - Generic agent session storage API (list, read, search, delete)
- `agentError` - Agent error handling (clearError, retryAfterError)
- `claude` - (Deprecated) Claude Code sessions - use `agentSessions` instead

### Git Integration
- `git` - Status, diff, isRepo, numstat, branches, tags, info
- `git` - Worktree support: worktreeInfo, getRepoRoot, worktreeSetup, worktreeCheckout
- `git` - PR creation: createPR, checkGhCli, getDefaultBranch

### Web & Live Sessions
- `web` - Broadcast user input, Auto Run state, tab changes to web clients
- `live` - Toggle live sessions, get status, dashboard URL, connected clients
- `webserver` - Get URL, connected client count
- `tunnel` - Cloudflare tunnel: isCloudflaredInstalled, start, stop, getStatus

### Automation
- `autorun` - Document and image management for Auto Run
- `playbooks` - Batch run configuration management
- `history` - Per-session execution history (see History API below)
- `cli` - CLI activity detection for playbook runs
- `tempfile` - Temporary file management for batch processing

### Analytics & Visualization
- `stats` - Usage statistics: recordQuery, getAggregatedStats, exportCsv, clearOldData, getDatabaseSize
- `stats` - Auto Run tracking: startAutoRun, endAutoRun, recordTask, getAutoRunSessions
- `stats` - Real-time updates via `stats:updated` event broadcast
- `documentGraph` - File watching: watchFolder, unwatchFolder
- `documentGraph` - Real-time updates via `documentGraph:filesChanged` event

### History API

Per-session history storage with 5,000 entries per session (up from 1,000 global). Each session's history is stored as a JSON file in `~/Library/Application Support/Maestro/history/{sessionId}.json`.

```typescript
window.maestro.history = {
  getAll: (projectPath?, sessionId?) => Promise<HistoryEntry[]>,
  add: (entry) => Promise<boolean>,
  clear: (projectPath?, sessionId?) => Promise<boolean>,
  delete: (entryId, sessionId?) => Promise<boolean>,
  update: (entryId, updates, sessionId?) => Promise<boolean>,
  // For AI context integration:
  getFilePath: (sessionId) => Promise<string | null>,
  listSessions: () => Promise<string[]>,
  // External change detection:
  onExternalChange: (handler) => () => void,
  reload: () => Promise<boolean>,
};
```

**AI Context Integration**: Use `getFilePath(sessionId)` to get the path to a session's history file. This file can be passed directly to AI agents as context, giving them visibility into past completed tasks, decisions, and work patterns.

### Power Management
- `power` - Sleep prevention: setEnabled, isEnabled, getStatus, addReason, removeReason

### Utilities
- `fonts` - Font detection
- `notification` - Desktop notifications, text-to-speech
- `devtools` - Developer tools: open, close, toggle
- `attachments` - Image attachment management

## Available Agents

| ID | Name | Status | Notes |
|----|------|--------|-------|
| `claude-code` | Claude Code | Active | Primary agent, uses `--print --verbose --output-format stream-json` |
| `opencode` | OpenCode | Stub | Output parser implemented, session storage stub ready |
| `terminal` | Terminal | Internal | Hidden from UI, used for shell sessions |
| `openai-codex` | OpenAI Codex | Planned | Coming soon |
| `gemini-cli` | Gemini CLI | Planned | Coming soon |
| `qwen3-coder` | Qwen3 Coder | Planned | Coming soon |

Additional `ToolType` values (`aider`, `claude`) are defined in types but not yet implemented in `agent-detector.ts`.

### Agent Capabilities

Each agent declares capabilities that control UI feature availability. See `src/main/agent-capabilities.ts` for the full interface.

| Capability | Description | UI Feature Controlled |
|------------|-------------|----------------------|
| `supportsResume` | Can resume previous sessions | Resume button |
| `supportsReadOnlyMode` | Has plan/read-only mode | Read-only toggle |
| `supportsJsonOutput` | Emits structured JSON | Output parsing |
| `supportsSessionId` | Emits session ID | Session ID pill |
| `supportsImageInput` | Accepts image attachments | Attach image button |
| `supportsSlashCommands` | Has discoverable commands | Slash autocomplete |
| `supportsSessionStorage` | Persists browsable sessions | Sessions browser |
| `supportsCostTracking` | Reports token costs | Cost widget |
| `supportsUsageStats` | Reports token counts | Context window widget |
| `supportsBatchMode` | Runs per-message | Batch processing |
| `supportsStreaming` | Streams output | Real-time display |
| `supportsResultMessages` | Distinguishes final result | Message classification |

For detailed agent integration guide, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

## Onboarding Wizard

The wizard (`src/renderer/components/Wizard/`) guides new users through first-run setup, creating AI sessions with Auto Run documents.

### Wizard Architecture

```
src/renderer/components/Wizard/
├── MaestroWizard.tsx           # Main orchestrator, screen transitions
├── WizardContext.tsx           # State management (useReducer pattern)
├── WizardResumeModal.tsx       # Resume incomplete wizard dialog
├── WizardExitConfirmModal.tsx  # Exit confirmation dialog
├── ScreenReaderAnnouncement.tsx # Accessibility announcements
├── screens/                    # Individual wizard steps
│   ├── AgentSelectionScreen.tsx    # Step 1: Choose AI agent
│   ├── DirectorySelectionScreen.tsx # Step 2: Select project folder
│   ├── ConversationScreen.tsx      # Step 3: AI project discovery
│   └── PhaseReviewScreen.tsx       # Step 4: Review generated plan
├── services/                   # Business logic
│   ├── wizardPrompts.ts           # System prompts, response parser
│   ├── conversationManager.ts     # AI conversation handling
│   └── phaseGenerator.ts          # Document generation
└── tour/                       # Post-setup walkthrough
    ├── TourOverlay.tsx            # Spotlight overlay
    ├── TourStep.tsx               # Step tooltip
    ├── tourSteps.ts               # Step definitions
    └── useTour.tsx                # Tour state management
```

### Wizard Flow

1. **Agent Selection** → Select available AI (Claude Code, etc.) and project name
2. **Directory Selection** → Choose project folder, validates Git repo status
3. **Conversation** → AI asks clarifying questions, builds confidence score (0-100)
4. **Phase Review** → View/edit generated Phase 1 document, choose to start tour

When confidence reaches 80+ and agent signals "ready", user proceeds to Phase Review where Auto Run documents are generated and saved to `Auto Run Docs/`.

### Triggering the Wizard

```typescript
// From anywhere with useWizard hook
const { openWizard } = useWizard();
openWizard();

// Keyboard shortcut (default)
Cmd+Shift+N  // Opens wizard

// Also available in:
// - Command K menu: "New Agent Wizard"
// - Hamburger menu: "New Agent Wizard"
```

### State Persistence (Resume)

Wizard state persists to `wizardResumeState` in settings when user advances past step 1. On next app launch, if incomplete state exists, `WizardResumeModal` offers "Resume" or "Start Fresh".

```typescript
// Check for saved state
const hasState = await hasResumeState();

// Load saved state
const savedState = await loadResumeState();

// Clear saved state
clearResumeState();
```

#### State Lifecycle

The Wizard maintains two types of state:

1. **In-Memory State** (React `useReducer`)
   - Managed in `WizardContext.tsx`
   - Includes: `currentStep`, `isOpen`, `isComplete`, conversation history, etc.
   - Lives only during the app session
   - Must be reset when opening wizard after completion

2. **Persisted State** (Settings)
   - Stored in `wizardResumeState` via `window.maestro.settings`
   - Enables resume functionality across app restarts
   - Automatically saved when advancing past step 1
   - Cleared on completion or when user chooses "Just Quit"

**State Save Triggers:**
- Auto-save: When `currentStep` changes (step > 1) - `WizardContext.tsx:791`
- Manual save: User clicks "Save & Exit" - `MaestroWizard.tsx:147`

**State Clear Triggers:**
- Wizard completion: `App.tsx:4681` + `WizardContext.tsx:711`
- User quits: "Just Quit" button - `MaestroWizard.tsx:168`
- User starts fresh: "Start Fresh" in resume modal - `App.tsx` resume handlers

**Opening Wizard Logic:**
The `openWizard()` function in `WizardContext.tsx:528-535` handles state initialization:
```typescript
// If previous wizard was completed, reset in-memory state first
if (state.isComplete === true) {
  dispatch({ type: 'RESET_WIZARD' });  // Clear stale state
}
dispatch({ type: 'OPEN_WIZARD' });  // Show wizard UI
```

This ensures:
- **Fresh starts**: Completed wizards don't contaminate new runs
- **Resume works**: Abandoned wizards (isComplete: false) preserve state
- **No race conditions**: Persisted state is checked after wizard opens

**Important:** The persisted state and in-memory state are independent. Clearing one doesn't automatically clear the other. Both must be managed correctly to prevent state contamination (see Issue #89).

### Tour System

The tour highlights UI elements with spotlight cutouts:

```typescript
// Add data-tour attribute to spotlight elements
<div data-tour="autorun-panel">...</div>

// Tour steps defined in tourSteps.ts
{
  id: 'autorun-panel',
  title: 'Auto Run in Action',
  description: '...',
  selector: '[data-tour="autorun-panel"]',
  position: 'left',  // tooltip position
  uiActions: [       // UI state changes before spotlight
    { type: 'setRightTab', value: 'autorun' },
  ],
}
```

### Customization Points

| What | Where |
|------|-------|
| Add wizard step | `WizardContext.tsx` (WIZARD_TOTAL_STEPS, WizardStep type, STEP_INDEX) |
| Modify wizard prompts | `src/prompts/wizard-*.md` (content), `services/wizardPrompts.ts` (logic) |
| Change confidence threshold | `READY_CONFIDENCE_THRESHOLD` in wizardPrompts.ts (default: 80) |
| Add tour step | `tour/tourSteps.ts` array |
| Modify Auto Run document format | `src/prompts/wizard-document-generation.md` |
| Change wizard keyboard shortcut | `shortcuts.ts` → `openWizard` |

### Related Settings

```typescript
// In useSettings.ts
wizardCompleted: boolean    // First wizard completion
tourCompleted: boolean      // First tour completion
firstAutoRunCompleted: boolean  // Triggers celebration modal
```

## Usage Dashboard

The Usage Dashboard (`src/renderer/components/UsageDashboard/`) provides analytics and visualizations for AI agent usage.

### Architecture

```
src/renderer/components/UsageDashboard/
├── UsageDashboardModal.tsx      # Main modal with view tabs (Overview, Agents, Activity, AutoRun)
├── SummaryCards.tsx             # Metric cards (queries, duration, cost, Auto Runs)
├── AgentComparisonChart.tsx     # Bar chart comparing agent usage
├── SourceDistributionChart.tsx  # Pie chart for user vs auto queries
├── ActivityHeatmap.tsx          # Weekly activity heatmap (GitHub-style)
├── DurationTrendsChart.tsx      # Line chart for duration over time
├── AutoRunStats.tsx             # Auto Run-specific statistics
├── ChartSkeletons.tsx           # Loading skeleton components
├── ChartErrorBoundary.tsx       # Error boundary with retry
└── EmptyState.tsx               # Empty state when no data
```

### Backend Components

```
src/main/
├── stats-db.ts                  # SQLite database (better-sqlite3) with WAL mode
│   ├── query_events table       # AI queries with duration, tokens, cost
│   ├── auto_run_sessions table  # Auto Run session tracking
│   ├── auto_run_tasks table     # Individual task tracking
│   └── _migrations table        # Schema migration tracking
├── ipc/handlers/stats.ts        # IPC handlers for stats operations
└── utils/statsCache.ts          # Query result caching
```

### Key Patterns

**Real-time Updates:**
```typescript
// Backend broadcasts after each database write
mainWindow?.webContents.send('stats:updated');

// Frontend subscribes with debouncing
useEffect(() => {
  const unsubscribe = window.maestro.stats.onStatsUpdated(() => {
    debouncedRefresh();
  });
  return () => unsubscribe?.();
}, []);
```

**Colorblind-Friendly Palettes:**
```typescript
import { COLORBLIND_AGENT_PALETTE, getColorBlindAgentColor } from '../constants/colorblindPalettes';
// Wong-based palette with high contrast for accessibility
```

**Chart Error Boundaries:**
```typescript
<ChartErrorBoundary chartName="Agent Comparison" onRetry={handleRetry}>
  <AgentComparisonChart data={data} colorBlindMode={colorBlindMode} />
</ChartErrorBoundary>
```

### Related Settings

```typescript
// In useSettings.ts
statsCollectionEnabled: boolean           // Enable/disable stats collection (default: true)
defaultStatsTimeRange: 'day' | 'week' | 'month' | 'year' | 'all'  // Default time filter
colorBlindMode: boolean                   // Use accessible color palettes
preventSleepEnabled: boolean              // Prevent system sleep while agents are busy (default: false)
```

## Document Graph

The Document Graph (`src/renderer/components/DocumentGraph/`) visualizes markdown file relationships and wiki-link connections using React Flow.

### Architecture

```
src/renderer/components/DocumentGraph/
├── DocumentGraphView.tsx        # Main modal with React Flow canvas
├── DocumentNode.tsx             # Document file node component
├── ExternalLinkNode.tsx         # External URL domain node
├── NodeContextMenu.tsx          # Right-click context menu
├── NodeBreadcrumb.tsx           # Path breadcrumb for selected node
├── GraphLegend.tsx              # Collapsible legend explaining node/edge types
├── graphDataBuilder.ts          # Scans directory, extracts links, builds graph data
└── layoutAlgorithms.ts          # Force-directed and hierarchical layout algorithms

src/renderer/utils/
├── markdownLinkParser.ts        # Parses [[wiki-links]] and [markdown](links)
└── documentStats.ts             # Computes document statistics (word count, etc.)

src/main/ipc/handlers/
└── documentGraph.ts             # Chokidar file watcher for real-time updates
```

### Key Patterns

**Building Graph Data:**
```typescript
import { buildGraphData } from './graphDataBuilder';
const { nodes, edges, stats } = await buildGraphData(
  rootPath,
  showExternalLinks,
  maxNodes,
  offset,
  progressCallback
);
```

**Layout Algorithms:**
```typescript
import { applyForceLayout, applyHierarchicalLayout, animateLayoutTransition } from './layoutAlgorithms';
const positionedNodes = layoutMode === 'force'
  ? applyForceLayout(nodes, edges)
  : applyHierarchicalLayout(nodes, edges);
animateLayoutTransition(currentNodes, positionedNodes, setNodes, savePositions);
```

**Node Animation (additions/removals):**
```typescript
import { diffNodes, animateNodesEntering, animateNodesExiting } from './layoutAlgorithms';
const { added, removed, stable } = diffNodes(previousNodes, newNodes);
animateNodesExiting(removed, () => animateNodesEntering(added));
```

**Real-time File Watching:**
```typescript
// Backend watches for .md file changes
window.maestro.documentGraph.watchFolder(rootPath);
window.maestro.documentGraph.onFilesChanged((changes) => {
  debouncedRebuildGraph();
});
// Cleanup on modal close
window.maestro.documentGraph.unwatchFolder(rootPath);
```

**Keyboard Navigation:**
```typescript
// Arrow keys navigate to connected nodes (spatial detection)
// Enter opens selected node
// Tab cycles through connected nodes
// Escape closes modal
```

### Large File Handling

Files over 1MB are truncated to first 100KB for link extraction to prevent UI blocking:
```typescript
const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024;  // 1MB
const LARGE_FILE_PARSE_LIMIT = 100 * 1024;      // 100KB
```

### Pagination

Default limit of 50 nodes with "Load more" for large directories:
```typescript
const DEFAULT_MAX_NODES = 50;
const LOAD_MORE_INCREMENT = 25;
```

### Related Settings

```typescript
// In useSettings.ts
documentGraphShowExternalLinks: boolean            // Show external link nodes (default: false)
documentGraphMaxNodes: number                      // Initial pagination limit (50-1000, default: 50)
```

## Debugging

### Focus Not Working
1. Add `tabIndex={0}` or `tabIndex={-1}`
2. Add `outline-none` class
3. Use `ref={(el) => el?.focus()}` for auto-focus

### Settings Not Persisting
1. Check wrapper function calls `window.maestro.settings.set()`
2. Check loading code in `useSettings.ts` useEffect

### Modal Escape Not Working
1. Register with layer stack (don't handle Escape locally)
2. Check priority is set correctly

## MCP Server

Maestro provides a hosted MCP (Model Context Protocol) server for AI applications to search the documentation.

**Server URL:** `https://docs.runmaestro.ai/mcp`

**Available Tools:**
- `SearchMaestro` - Search the Maestro knowledge base for documentation, code examples, API references, and guides

**Connect from Claude Desktop/Code:**
```json
{
  "mcpServers": {
    "maestro": {
      "url": "https://docs.runmaestro.ai/mcp"
    }
  }
}
```

See [MCP Server documentation](https://docs.runmaestro.ai/mcp-server) for full details.

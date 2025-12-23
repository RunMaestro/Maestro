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
npm run dev        # Development with hot reload
npm run dev:web    # Web interface development
npm run build      # Full production build
npm run clean      # Clean build artifacts
npm run lint       # TypeScript type checking (all configs)
npm run lint:eslint # ESLint code quality checks
npm run package    # Package for all platforms
npm run test       # Run test suite
npm run test:watch # Run tests in watch mode
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
└── shared/                 # Shared types and utilities
    ├── types.ts           # Common type definitions
    └── templateVariables.ts # Template variable processing
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
| Add setting | `src/renderer/hooks/useSettings.ts`, `src/main/index.ts` |
| Add template variable | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts` |
| Modify system prompts | `src/prompts/*.md` (wizard, Auto Run, etc.) |
| Add CLI command | `src/cli/commands/`, `src/cli/index.ts` |
| Configure agent | `src/main/agent-detector.ts`, `src/main/agent-capabilities.ts` |
| Add agent output parser | `src/main/parsers/`, `src/main/parsers/index.ts` |
| Add agent session storage | `src/main/storage/`, `src/main/agent-session-storage.ts` |
| Add agent error patterns | `src/main/parsers/error-patterns.ts` |
| Add playbook feature | `src/cli/services/playbooks.ts` |
| Modify wizard flow | `src/renderer/components/Wizard/` (see Onboarding Wizard section) |
| Add tour step | `src/renderer/components/Wizard/tour/tourSteps.ts` |
| Modify file linking | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links) |

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

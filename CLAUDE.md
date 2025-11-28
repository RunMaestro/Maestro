# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Standardized Vernacular

Use these terms consistently in code, comments, and documentation:

### UI Components
- **Left Bar** - Left sidebar with session list and groups (`SessionList.tsx`)
- **Right Bar** - Right sidebar with Files, History, Scratchpad tabs (`RightPanel.tsx`)
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

Maestro is an Electron desktop app for managing multiple AI coding assistants (Claude Code, Aider, Qwen Coder) simultaneously with a keyboard-first interface.

## Quick Commands

```bash
npm run dev        # Development with hot reload
npm run build      # Full production build
npm run clean      # Clean build artifacts
npm run package    # Package for all platforms
```

## Architecture at a Glance

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts            # Entry point, IPC handlers
│   ├── process-manager.ts  # Process spawning (PTY + child_process)
│   ├── preload.ts          # Secure IPC bridge
│   └── utils/execFile.ts   # Safe command execution
│
└── renderer/               # React frontend
    ├── App.tsx            # Main coordinator
    ├── components/        # UI components
    ├── hooks/             # Custom React hooks
    ├── services/          # IPC wrappers (git.ts, process.ts)
    ├── constants/         # Themes, shortcuts, priorities
    └── contexts/          # Layer stack context
```

### Key Files for Common Tasks

| Task | Primary Files |
|------|---------------|
| Add IPC handler | `src/main/index.ts`, `src/main/preload.ts` |
| Add UI component | `src/renderer/components/` |
| Add keyboard shortcut | `src/renderer/constants/shortcuts.ts`, `App.tsx` |
| Add theme | `src/renderer/constants/themes.ts` |
| Add slash command | `src/renderer/slashCommands.ts` |
| Add modal | Component + `src/renderer/constants/modalPriorities.ts` |
| Add setting | `src/renderer/hooks/useSettings.ts`, `src/main/index.ts` |
| Add template variable | `src/renderer/utils/templateVariables.ts` |

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

Themes have 12 required colors. Use inline styles for theme colors:
```typescript
style={{ color: theme.colors.textMain }}  // Correct
className="text-gray-500"                  // Wrong for themed text
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

## Session Interface

Key fields on the Session object:
```typescript
interface Session {
  id: string;
  name: string;
  toolType: ToolType;           // 'claude-code' | 'aider' | 'terminal' | etc.
  state: SessionState;          // 'idle' | 'busy' | 'error' | 'connecting'
  inputMode: 'ai' | 'terminal'; // Which process receives input
  cwd: string;                  // Working directory
  aiPid: number;                // AI process ID
  terminalPid: number;          // Terminal process ID
  aiLogs: LogEntry[];           // AI output history
  shellLogs: LogEntry[];        // Terminal output history
  usageStats?: UsageStats;      // Token usage and cost
  claudeSessionId?: string;     // For conversation continuity
  isGitRepo: boolean;           // Git features enabled
  fileTree: any[];              // File explorer tree
  fileExplorerExpanded: string[]; // Expanded folder paths
  messageQueue: LogEntry[];     // Messages queued while AI is busy
}
```

## IPC API Surface

The `window.maestro` API exposes:
- `settings` - Get/set app settings
- `sessions` / `groups` - Persistence
- `process` - Spawn, write, kill, resize
- `git` - Status, diff, isRepo, numstat
- `fs` - readDir, readFile
- `agents` - Detect, get, config
- `claude` - List/read/search Claude Code sessions
- `logger` - System logging
- `dialog` - Folder selection
- `shells` - Detect available shells

## Available Agents

| ID | Name | Notes |
|----|------|-------|
| `claude-code` | Claude Code | Batch mode with `--print` |
| `aider-gemini` | Aider (Gemini) | Uses gemini-2.0-flash-exp |
| `qwen-coder` | Qwen Coder | If installed |
| `terminal` | CLI Terminal | PTY shell session |

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

---

## Current Work Items

Prioritized list of tasks that need implementation. Each includes suggested branch name for PRs.

### High Priority

#### 1. User Error Notifications (TODO)
**Files:** `src/renderer/App.tsx:1805`, `src/renderer/hooks/useSessionManager.ts:254`

Session creation errors only log to console - users see no feedback. Need toast/notification system.

**Branch:** `fix/user-error-notifications`

#### 2. Phase 6: Remote Access Implementation
**File:** `src/main/web-server.ts`

WebSocket and API endpoints have placeholder implementations:
- Lines 62-68: WebSocket echoes only - needs real session streaming
- Lines 86-92: `/api/sessions` returns `[]` - needs ProcessManager integration
- Lines 96-104: `/api/sessions/:id` returns stub data

**Branch:** `feat/phase6-remote-access`

### Medium Priority

#### 3. Tunnel Provider Integration
**Files:** `src/main/index.ts:653-678`, `src/main/session-web-server.ts`

Settings UI and IPC handlers exist but no actual ngrok/Cloudflare provider code.

**Branch:** `feat/tunnel-providers`

#### 4. Error Handling Improvements
Services log errors without user feedback:
- `src/renderer/services/git.ts`
- `src/renderer/services/process.ts`
- `src/renderer/hooks/useFileExplorer.ts`
- `src/renderer/hooks/useBatchProcessor.ts`

**Branch:** `fix/error-feedback`

### Low Priority / Backburner

#### 5. LLM Settings Panel (Disabled Feature)
**File:** `src/renderer/components/SettingsModal.tsx:8-11`

```typescript
const FEATURE_FLAGS = {
  LLM_SETTINGS: false,  // OpenRouter, Anthropic, Ollama integration
};
```

Fully implemented but disabled. See [BACKBURNER.md](BACKBURNER.md) for details.

---

## Contributing Workflow

### Feature Branch Naming Convention

```
feat/short-description    # New features
fix/short-description     # Bug fixes
docs/short-description    # Documentation
refactor/short-description # Code refactoring
```

### Fork and Setup (First Time Only)

1. **Fork on GitHub:**
   - Go to https://github.com/pedramamini/Maestro
   - Click "Fork" button (top right)
   - This creates `https://github.com/YOUR-USERNAME/Maestro`

2. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR-USERNAME/Maestro.git
   cd Maestro
   ```

3. **Add upstream remote:**
   ```bash
   git remote add upstream https://github.com/pedramamini/Maestro.git
   git remote -v  # Verify: origin=your-fork, upstream=original
   ```

4. **Install dependencies:**
   ```bash
   npm install
   ```

### Creating a PR

1. **Sync with upstream first:**
   ```bash
   git checkout main
   git fetch upstream
   git merge upstream/main
   git push origin main  # Keep your fork's main in sync
   ```

2. **Create feature branch:**
   ```bash
   git checkout -b feat/your-feature
   ```

3. **Make changes following code patterns** (see Core Patterns above)

4. **Test your changes:**
   ```bash
   npm run dev    # Test in development
   npm run build  # Verify build works
   ```

5. **Commit with conventional messages:**
   ```bash
   git add .
   git commit -m "feat: add user error notifications"
   ```

6. **Push to your fork:**
   ```bash
   git push -u origin feat/your-feature
   ```

7. **Create PR via GitHub CLI or web:**
   ```bash
   # Using gh CLI (recommended)
   gh pr create --repo pedramamini/Maestro \
     --title "feat: Add user error notifications" \
     --body "Description of changes..."

   # Or via web: Go to your fork on GitHub, click "Compare & pull request"
   ```

### Keeping Your Fork Updated

```bash
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

### Error Handling Patterns

| Layer | Pattern |
|-------|---------|
| IPC Handlers | Throw critical errors, catch optional ones |
| Services | Never throw, return safe defaults |
| ProcessManager | Throw spawn failures, emit runtime events |
| Components | Try-catch async, show UI errors |
| Hooks | Internal catch, expose error state |

```typescript
// Service pattern - never throw
export const gitService = {
  async isRepo(cwd: string): Promise<boolean> {
    try {
      return await window.maestro.git.isRepo(cwd);
    } catch (error) {
      console.error('Git isRepo error:', error);
      return false;
    }
  },
};

// Component pattern - user-friendly errors
const handleFileLoad = async (path: string) => {
  try {
    const content = await window.maestro.fs.readFile(path);
    setFileContent(content);
  } catch (error) {
    console.error('Failed to load file:', error);
    setError('Failed to load file');  // Show to user
  }
};
```

---

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep technical architecture details
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development setup and contribution process
- [BACKBURNER.md](BACKBURNER.md) - Disabled features and feature flags
- [README.md](README.md) - User-facing documentation and features

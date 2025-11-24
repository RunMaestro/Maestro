# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Maestro is a unified, highly-responsive Electron desktop application for managing multiple AI coding assistants (Claude Code, Aider, OpenCode, etc.) simultaneously. It provides a Linear/Superhuman-level responsive interface with keyboard-first navigation, dual-mode input (terminal vs AI), and remote web access capabilities.

## Development Commands

### Running the Application

```bash
# Development mode with hot reload
npm run dev

# Build and run production
npm run build
npm start
```

### Building

```bash
# Build both main and renderer processes
npm run build

# Build main process only (Electron backend)
npm run build:main

# Build renderer only (React frontend)
npm run build:renderer
```

### Packaging

```bash
# Package for all platforms
npm run package

# Platform-specific builds
npm run package:mac    # macOS (.dmg, .zip)
npm run package:win    # Windows (.exe, portable)
npm run package:linux  # Linux (.AppImage, .deb, .rpm)
```

### Utilities

```bash
# Clean build artifacts and cache
npm run clean
```

## Architecture

### Dual-Process Model

Maestro uses Electron's main/renderer architecture with strict context isolation:

**Main Process (`src/main/`)** - Node.js backend with full system access
- `index.ts` - Application entry point, IPC handler registration, window management
- `process-manager.ts` - Core primitive for spawning and managing CLI processes
- `web-server.ts` - Fastify-based HTTP/WebSocket server for remote access
- `agent-detector.ts` - Auto-detects available AI tools (Claude Code, Aider, etc.) via PATH
- `preload.ts` - Secure IPC bridge via contextBridge (no direct Node.js exposure to renderer)

**Renderer Process (`src/renderer/`)** - React frontend with no direct Node.js access
- `App.tsx` - Main UI component
- `main.tsx` - Renderer entry point
- `components/` - React components (modals, panels, UI elements)

### Process Management System

The `ProcessManager` class is the core architectural primitive that abstracts two process types:

1. **PTY Processes** (via `node-pty`) - For terminal sessions with full shell emulation
   - Used for `toolType: 'terminal'`
   - Supports resize, ANSI escape codes, interactive shell

2. **Child Processes** (via `child_process`) - For AI assistants
   - Used for all non-terminal tool types (claude-code, aider, etc.)
   - Direct stdin/stdout/stderr capture without shell interpretation
   - **Security**: Uses `spawn()` with `shell: false` to prevent command injection

All process operations go through IPC handlers in `src/main/index.ts`:
- `process:spawn` - Start a new process
- `process:write` - Send data to stdin
- `process:kill` - Terminate a process
- `process:resize` - Resize PTY terminal (terminal mode only)

Events are emitted back to renderer via:
- `process:data` - Stdout/stderr output
- `process:exit` - Process exit code

### Session Model

Each "session" is a unified abstraction with these attributes:
- `sessionId` - Unique identifier
- `toolType` - Agent type (claude-code, aider, terminal, custom)
- `cwd` - Working directory
- `state` - Current state (idle, busy, error)
- `stdinMode` - Input routing mode (terminal vs AI)

### IPC Security Model

All renderer-to-main communication goes through the preload script:
- **Context isolation**: Enabled (renderer has no direct Node.js access)
- **Node integration**: Disabled (no `require()` in renderer)
- **Preload script**: Exposes minimal API via `contextBridge.exposeInMainWorld('maestro', ...)`

The `window.maestro` API provides type-safe access to:
- Settings management
- Process control
- Git operations
- File system access
- Tunnel management
- Agent detection

### Git Integration

Git operations use the safe `execFileNoThrow` utility (located in `src/main/utils/execFile.ts`) to prevent shell injection vulnerabilities:
- `git:status` - Get porcelain status
- `git:diff` - Get diff for files
- `git:isRepo` - Check if directory is a Git repository

### Web Server Architecture

Fastify server (`src/main/web-server.ts`) provides:
- REST API endpoints (`/api/sessions`, `/health`)
- WebSocket endpoint (`/ws`) for real-time updates
- CORS enabled for mobile/remote access
- Binds to `0.0.0.0:8000` for LAN access

### Agent Detection

`AgentDetector` class auto-discovers CLI tools in PATH:
- Uses `which` (Unix) or `where` (Windows) via `execFileNoThrow`
- Caches results for performance
- Pre-configured agents: Claude Code, Aider, Qwen Coder, CLI Terminal
- Extensible via `AGENT_DEFINITIONS` array in `src/main/agent-detector.ts`

## Key Design Patterns

### Dual-Mode Input Router

Sessions toggle between two input modes:
1. **Terminal Mode** - Raw shell commands via PTY
2. **AI Interaction Mode** - Direct communication with AI assistant

This is implemented via the `isTerminal` flag in `ProcessManager`.

### Event-Driven Output Streaming

ProcessManager extends EventEmitter:
```typescript
processManager.on('data', (sessionId, data) => { ... })
processManager.on('exit', (sessionId, code) => { ... })
```

Events are forwarded to renderer via IPC:
```typescript
mainWindow?.webContents.send('process:data', sessionId, data)
```

### Secure Command Execution

**ALWAYS use `execFileNoThrow` utility** from `src/main/utils/execFile.ts` for running external commands. This prevents shell injection vulnerabilities by using `execFile` instead of `exec`:

```typescript
// Correct - safe from injection
import { execFileNoThrow } from './utils/execFile';
const result = await execFileNoThrow('git', ['status', '--porcelain'], cwd);

// The utility returns: { stdout: string, stderr: string, exitCode: number }
// It never throws - non-zero exit codes return exitCode !== 0
```

## UI Architecture & Components

### Main Application Structure (App.tsx)

The main application is structured in three columns:
1. **Left Sidebar** - Session list, groups, new instance button
2. **Main Panel** - Terminal/AI output, input area, toolbar
3. **Right Panel** - Files, History, Scratchpad tabs

### Key Components

#### SettingsModal (`src/renderer/components/SettingsModal.tsx`)
- Tabbed interface: General, LLM, Shortcuts, Themes, Network
- All settings changes should use wrapper functions for persistence
- Includes LLM test functionality to verify API connectivity

#### Scratchpad (`src/renderer/components/Scratchpad.tsx`)
- Edit/Preview mode toggle (Command-E to switch)
- Markdown rendering with GFM support
- Smart list continuation (unordered, ordered, task lists)
- Container must be focusable (tabIndex) for keyboard shortcuts

#### FilePreview (`src/renderer/components/FilePreview.tsx`)
- Full-screen overlay for file viewing
- Syntax highlighting via react-syntax-highlighter
- Markdown rendering for .md files
- Arrow keys for scrolling, Escape to close
- Auto-focuses when opened for immediate keyboard control

### Keyboard Navigation Patterns

The app is keyboard-first with these patterns:

**Focus Management:**
- Escape in input → Focus output window
- Escape in output → Focus back to input
- Escape in file preview → Return to file tree
- Components need `tabIndex={-1}` and `outline-none` for programmatic focus

**Output Window:**
- `/` → Open search/filter
- Arrow Up/Down → Scroll output
- Cmd/Ctrl + Arrow Up/Down → Jump to top/bottom
- Escape → Close search (if open) or return to input

**File Tree:**
- Arrow keys → Navigate files/folders
- Enter → Open file preview
- Space → Toggle folder expansion
- Cmd+E → Expand all, Cmd+Shift+E → Collapse all

**Scratchpad:**
- Cmd+E → Toggle Edit/Preview mode

### Theme System

Themes defined in `THEMES` object in App.tsx with structure:
```typescript
{
  id: string;
  name: string;
  mode: 'light' | 'dark';
  colors: {
    bgMain: string;      // Main content background
    bgSidebar: string;   // Sidebar background
    bgActivity: string;  // Accent background
    border: string;      // Border colors
    textMain: string;    // Primary text
    textDim: string;     // Secondary text
    accent: string;      // Accent color
    accentDim: string;   // Dimmed accent
    success: string;     // Success state
    warning: string;     // Warning state
    error: string;       // Error state
  }
}
```

Use `style={{ color: theme.colors.textMain }}` instead of fixed colors.

### Styling Conventions

- **Tailwind CSS** for layout and spacing
- **Inline styles** for theme colors (dynamic based on selected theme)
- **Standard spacing**: `gap-2`, `p-4`, `mb-3` for consistency
- **Focus states**: Always add `outline-none` when using `tabIndex`
- **Sticky elements**: Use `sticky top-0 z-10` with solid background
- **Overlays**: Use `fixed inset-0` with backdrop blur and high z-index

### State Management Per Session

Each session stores:
- `cwd` - Current working directory
- `fileTree` - File tree structure
- `fileExplorerExpanded` - Expanded folder paths
- `fileExplorerScrollPos` - Scroll position in file tree
- `aiLogs` / `shellLogs` - Output history
- `inputMode` - 'ai' or 'terminal'
- `state` - 'idle' | 'busy' | 'waiting_input'

Sessions persist scroll positions, expanded states, and UI state per-session.

## Code Conventions

### TypeScript

- All code is TypeScript with strict mode enabled
- Interface definitions for all data structures
- Type exports via `preload.ts` for renderer types

### Commit Message Format

Use conventional commits:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test additions/changes
- `chore:` - Build process or tooling changes

### Security Requirements

1. **Use `execFileNoThrow` for all external commands** - Located in `src/main/utils/execFile.ts`
2. **Context isolation** - Keep enabled in BrowserWindow
3. **Input sanitization** - Validate all user inputs
4. **Minimal preload exposure** - Only expose necessary APIs via contextBridge
5. **Process spawning** - Use `spawn()` with `shell: false` flag

## Technology Stack

### Backend (Main Process)
- Electron 28+
- TypeScript
- node-pty - Terminal emulation
- Fastify - Web server
- electron-store - Settings persistence
- ws - WebSocket support

### Frontend (Renderer)
- React 18
- TypeScript
- Tailwind CSS
- Vite
- Lucide React - Icons
- react-syntax-highlighter - Code display
- marked - Markdown rendering
- dompurify - XSS prevention

## Settings Storage

Settings persisted via `electron-store`:
- **macOS**: `~/Library/Application Support/maestro/`
- **Windows**: `%APPDATA%/maestro/`
- **Linux**: `~/.config/maestro/`

Files:
- `maestro-settings.json` - User preferences
- `maestro-sessions.json` - Session persistence (planned)
- `maestro-groups.json` - Session groups (planned)

### Adding New Persistent Settings

To add a new setting that persists across sessions:

1. **Define state variable** in App.tsx:
```typescript
const [mySetting, setMySettingState] = useState<MyType>(defaultValue);
```

2. **Create wrapper function** that persists:
```typescript
const setMySetting = (value: MyType) => {
  setMySettingState(value);
  window.maestro.settings.set('mySetting', value);
};
```

3. **Load in useEffect**:
```typescript
// Inside the loadSettings useEffect
const savedMySetting = await window.maestro.settings.get('mySetting');
if (savedMySetting !== undefined) setMySettingState(savedMySetting);
```

4. **Pass wrapper to child components**, not the direct setState

**Current Persistent Settings:**
- `llmProvider`, `modelSlug`, `apiKey` - LLM configuration
- `tunnelProvider`, `tunnelApiKey` - Tunnel configuration
- `defaultAgent` - Default AI agent selection
- `fontFamily`, `fontSize`, `customFonts` - UI font settings
- `enterToSend` - Input behavior (Enter vs Command-Enter to send)
- `activeThemeId` - Selected theme

## Development Phases

The project follows a phased development approach (see PRD.md):

**Completed Phases:**
- Phase 1: Core Primitives (ProcessManager, Session Model, Dual-Mode Input)
- Phase 2: UI Foundations (Obsidian-inspired design, keyboard navigation)

**In Progress:**
- Phase 3: Intelligence Layer (auto-generated descriptions, semantic worklogs)

**Planned:**
- Phase 4: Workspace Intelligence (dual Git/non-Git modes)
- Phase 5: Status & Control Layer
- Phase 6: Remote Access & Tunneling (ngrok integration)
- Phase 7: Performance & Polish
- Phase 8: Multi-Device Continuity

## Common Development Tasks

### Adding a New UI Feature

1. **Plan the state** - Determine if it's per-session or global
2. **Add state management** - In App.tsx or component
3. **Create persistence** - Use wrapper function pattern if global
4. **Implement UI** - Follow Tailwind + theme color pattern
5. **Add keyboard shortcuts** - Integrate with existing keyboard handler
6. **Test focus flow** - Ensure Escape key navigation works

### Adding a New Modal

1. Create component in `src/renderer/components/`
2. Add state in App.tsx: `const [myModalOpen, setMyModalOpen] = useState(false)`
3. Add Escape handler in keyboard shortcuts
4. Use `fixed inset-0` overlay with `z-[50]` or higher
5. Include close button and backdrop click handler
6. Use `ref={(el) => el?.focus()}` for immediate keyboard control

### Adding Keyboard Shortcuts

1. Find the main keyboard handler in App.tsx (around line 650)
2. Add your shortcut in the appropriate section:
   - Component-specific: Inside component's onKeyDown
   - Global: In main useEffect keyboard handler
   - Modify pressed: Check for `e.metaKey || e.ctrlKey`
3. Remember to `e.preventDefault()` to avoid browser defaults

### Working with File Tree

File tree structure is stored per-session as `fileTree` array of nodes:
```typescript
{
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileTreeNode[];
}
```

Expanded folders tracked in session's `fileExplorerExpanded: string[]` as full paths.

### Modifying Themes

1. Find `THEMES` constant in App.tsx
2. Add new theme or modify existing one
3. All color keys must be present (11 required colors)
4. Test in both light and dark mode contexts
5. Theme ID is stored in settings and persists across sessions

### Adding to Settings Modal

1. Add tab if needed in SettingsModal.tsx
2. Create state in App.tsx with wrapper function
3. Add to loadSettings useEffect
4. Pass wrapper function (not setState) to SettingsModal props
5. Add UI in appropriate tab section

## Important File Locations

### Main Process Entry Points
- `src/main/index.ts:81-109` - IPC handler setup
- `src/main/index.ts:272-282` - Process event listeners
- `src/main/process-manager.ts:30-116` - Process spawning logic

### Security-Critical Code
- `src/main/preload.ts:5` - Context bridge API exposure
- `src/main/process-manager.ts:75` - Shell disabled for spawn
- `src/main/utils/execFile.ts` - Safe command execution wrapper

### Configuration
- `package.json:26-86` - electron-builder config
- `tsconfig.json` - Renderer TypeScript config
- `tsconfig.main.json` - Main process TypeScript config
- `vite.config.mts` - Vite bundler config

## Debugging & Common Issues

### Focus Not Working

If keyboard shortcuts aren't working:
1. Check element has `tabIndex={0}` or `tabIndex={-1}`
2. Add `outline-none` class to hide focus ring
3. Use `ref={(el) => el?.focus()}` or `useEffect` to auto-focus
4. Check for `e.stopPropagation()` blocking events

### Settings Not Persisting

If settings don't save across sessions:
1. Ensure you created a wrapper function with `window.maestro.settings.set()`
2. Check the wrapper is passed to child components, not the direct setState
3. Verify loading code exists in the `loadSettings` useEffect
4. Use direct state setter (e.g., `setMySettingState`) in the loading code

### Modal Escape Key Not Working

If Escape doesn't close a modal:
1. Modal overlay needs `tabIndex={0}`
2. Use `ref={(el) => el?.focus()}` to focus on mount
3. Add `e.stopPropagation()` in onKeyDown handler
4. Check z-index is higher than other modals

### Theme Colors Not Applying

If colors appear hardcoded:
1. Replace fixed colors with `style={{ color: theme.colors.textMain }}`
2. Never use hardcoded hex colors for text/borders
3. Use inline styles for theme colors, Tailwind for layout
4. Check theme prop is being passed down correctly

### Scroll Position Not Saving

Per-session scroll position:
1. Container needs a ref: `useRef<HTMLDivElement>(null)`
2. Add `onScroll` handler that updates session state
3. Add useEffect to restore scroll on session change
4. Use `ref.current.scrollTop` to get/set position

## Running Tests

Currently no test suite implemented. When adding tests, use the `test` script in package.json.

## Recent Features Added

- **Output Search/Filter** - Press `/` in output window to filter logs
- **Scratchpad Command-E** - Toggle between Edit and Preview modes
- **File Preview Focus** - Arrow keys scroll, Escape returns to file tree
- **Sticky File Tree Header** - Working directory stays visible when scrolling
- **LLM Connection Test** - Test API connectivity in Settings before saving
- **Settings Persistence** - All settings now save across sessions
- **Emoji Picker Improvements** - Proper positioning and Escape key support

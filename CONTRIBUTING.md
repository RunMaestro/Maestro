# Contributing to Maestro

NOTE: The project is currently changing rapidly, there's a high likelihood that PRs will be out of sync with latest code versions and may be hard to rebase.

Thank you for your interest in contributing to Maestro! This document provides guidelines, setup instructions, and practical guidance for developers.

For architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md). For quick reference while coding, see [CLAUDE.md](CLAUDE.md).

## Core Goals

**Snappy interface and reduced battery consumption are fundamental goals for Maestro.** Every contribution should consider:

- **Responsiveness**: UI interactions should feel instant. Avoid blocking the main thread.
- **Battery efficiency**: Minimize unnecessary timers, polling, and re-renders.
- **Memory efficiency**: Clean up event listeners, timers, and subscriptions properly.

See [Performance Guidelines](#performance-guidelines) for specific practices.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Scripts](#development-scripts)
- [Testing](#testing)
- [Linting](#linting)
- [Common Development Tasks](#common-development-tasks)
- [Adding a New AI Agent](#adding-a-new-ai-agent)
- [Code Style](#code-style)
- [Performance Guidelines](#performance-guidelines)
- [Debugging Guide](#debugging-guide)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Building for Release](#building-for-release)

## Development Setup

### Prerequisites

- Node.js 20+
- npm or yarn
- Git

### Getting Started

```bash
# Fork and clone the repository
git clone <your-fork-url>
cd maestro

# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev
```

## Project Structure

```
maestro/
├── src/
│   ├── main/              # Electron main process (Node.js backend)
│   │   ├── index.ts       # Entry point, IPC handlers
│   │   ├── process-manager.ts
│   │   ├── preload.ts     # Secure IPC bridge
│   │   └── utils/         # Shared utilities
│   ├── renderer/          # React frontend (Desktop UI)
│   │   ├── App.tsx        # Main coordinator
│   │   ├── components/    # React components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── services/      # IPC wrappers (git, process)
│   │   ├── contexts/      # React contexts
│   │   ├── constants/     # Themes, shortcuts, priorities
│   │   ├── types/         # TypeScript definitions
│   │   └── utils/         # Frontend utilities
│   ├── cli/               # CLI tool (maestro-cli)
│   │   ├── index.ts       # CLI entry point
│   │   ├── commands/      # Command implementations
│   │   ├── services/      # CLI services (storage, batch processor)
│   │   └── output/        # Output formatters (human, JSONL)
│   ├── shared/            # Shared code across processes
│   │   ├── theme-types.ts # Theme type definitions
│   │   └── templateVariables.ts # Template variable system
│   └── web/               # Web interface (Remote Control)
│       └── ...            # Mobile-optimized React app
├── build/                 # Application icons
├── .github/workflows/     # CI/CD automation
└── dist/                  # Build output (generated)
```

## Development Scripts

```bash
npm run dev            # Start dev server with hot reload
npm run dev:demo       # Start in demo mode (fresh settings, isolated data)
npm run dev:web        # Start web interface dev server
npm run build          # Full production build (main + renderer + web + CLI)
npm run build:main     # Build main process only
npm run build:renderer # Build renderer only
npm run build:web      # Build web interface only
npm run build:cli      # Build CLI tool only
npm start              # Start built application
npm run clean          # Clean build artifacts
npm run lint           # Run TypeScript type checking
npm run package        # Package for all platforms
npm run package:mac    # Package for macOS
npm run package:win    # Package for Windows
npm run package:linux  # Package for Linux
```

### Demo Mode

Use demo mode to run Maestro with a fresh, isolated data directory - useful for demos, testing, or screenshots without affecting your real settings:

```bash
npm run dev:demo
```

Demo mode stores all data in `/tmp/maestro-demo`. For a completely fresh start each time:

```bash
rm -rf /tmp/maestro-demo && npm run dev:demo
```

You can also specify a custom demo directory via environment variable:

```bash
MAESTRO_DEMO_DIR=~/Desktop/my-demo npm run dev
```

## Testing

Run the test suite with Jest:

```bash
npm test                              # Run all tests
npm test -- --watch                   # Watch mode (re-runs on file changes)
npm test -- --testPathPattern="name"  # Run tests matching a pattern
npm test -- --coverage                # Run with coverage report
```

### Watch Mode

Watch mode keeps Jest running and automatically re-runs tests when you save changes:

- Watches source and test files for changes
- Re-runs only tests affected by changed files
- Provides instant feedback during development

**Interactive options in watch mode:**
- `a` - Run all tests
- `f` - Run only failing tests
- `p` - Filter by filename pattern
- `t` - Filter by test name pattern
- `q` - Quit watch mode

### Test Organization

Tests are located in `src/__tests__/` and organized by area:

```
src/__tests__/
├── cli/           # CLI tool tests
├── main/          # Electron main process tests
├── renderer/      # React component and hook tests
├── shared/        # Shared utility tests
└── web/           # Web interface tests
```

## Linting

Run TypeScript type checking and ESLint to catch errors before building:

```bash
npm run lint           # TypeScript type checking (all configs: renderer, main, cli)
npm run lint:eslint    # ESLint code quality checks (React hooks, unused vars, etc.)
npm run lint:eslint -- --fix  # Auto-fix ESLint issues where possible
```

### TypeScript Linting

The TypeScript linter checks all three build configurations:
- `tsconfig.lint.json` - Renderer, web, and shared code
- `tsconfig.main.json` - Main process code
- `tsconfig.cli.json` - CLI tooling

### ESLint

ESLint is configured with TypeScript and React plugins (`eslint.config.mjs`):
- `react-hooks/rules-of-hooks` - Enforces React hooks rules
- `react-hooks/exhaustive-deps` - Enforces correct hook dependencies
- `@typescript-eslint/no-unused-vars` - Warns about unused variables
- `prefer-const` - Suggests const for never-reassigned variables

**When to run linting:**
- Before committing changes
- After making significant refactors
- When CI fails with type errors

**Common lint issues:**
- Unused imports or variables
- Type mismatches in function calls
- Missing required properties on interfaces
- React hooks called conditionally (must be called in same order every render)
- Missing dependencies in useEffect/useCallback/useMemo

## Common Development Tasks

### Adding a New UI Feature

1. **Plan the state** - Determine if it's per-session or global
2. **Add state management** - In `useSettings.ts` (global) or session state
3. **Create persistence** - Use wrapper function pattern for global settings
4. **Implement UI** - Follow Tailwind + theme color pattern
5. **Add keyboard shortcuts** - In `shortcuts.ts` and `App.tsx`
6. **Test focus flow** - Ensure Escape key navigation works

### Adding a New Modal

1. Create component in `src/renderer/components/`
2. Add priority in `src/renderer/constants/modalPriorities.ts`:
   ```typescript
   MY_MODAL: 600,
   ```
3. Register with layer stack (see [ARCHITECTURE.md](ARCHITECTURE.md#layer-stack-system))
4. Use proper ARIA attributes:
   ```typescript
   <div role="dialog" aria-modal="true" aria-label="My Modal">
   ```

### Adding Keyboard Shortcuts

1. Add definition in `src/renderer/constants/shortcuts.ts`:
   ```typescript
   myShortcut: { id: 'myShortcut', label: 'My Action', keys: ['Meta', 'k'] },
   ```

2. Add handler in `App.tsx` keyboard event listener:
   ```typescript
   else if (isShortcut(e, 'myShortcut')) {
     e.preventDefault();
     // Handler code
   }
   ```

**Supported modifiers:** `Meta` (Cmd/Win), `Ctrl`, `Alt`, `Shift`
**Arrow keys:** `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`

### Adding a New Setting

1. Add state in `useSettings.ts`:
   ```typescript
   const [mySetting, setMySettingState] = useState(defaultValue);
   ```

2. Create wrapper function:
   ```typescript
   const setMySetting = (value) => {
     setMySettingState(value);
     window.maestro.settings.set('mySetting', value);
   };
   ```

3. Load in useEffect:
   ```typescript
   const saved = await window.maestro.settings.get('mySetting');
   if (saved !== undefined) setMySettingState(saved);
   ```

4. Add to return object and export.

### Adding a Slash Command

Slash commands are now **Custom AI Commands** defined in Settings, not in code. They are prompt macros that get substituted and sent to the AI agent.

To add a built-in slash command that users see by default, add it to the Custom AI Commands default list in `useSettings.ts`. Each command needs:

```typescript
{
  command: '/mycommand',
  description: 'Does something useful',
  prompt: 'The prompt text with {{TEMPLATE_VARIABLES}}',
}
```

For commands that need programmatic behavior (not just prompts), handle them in `App.tsx` where slash commands are processed before being sent to the agent.

### Adding a New Theme

Maestro has 16 themes across 3 modes: dark, light, and vibe.

Add to `src/renderer/constants/themes.ts`:

```typescript
'my-theme': {
  id: 'my-theme',
  name: 'My Theme',
  mode: 'dark',  // 'dark', 'light', or 'vibe'
  colors: {
    bgMain: '#...',           // Main background
    bgSidebar: '#...',        // Sidebar background
    bgActivity: '#...',       // Activity/hover background
    border: '#...',           // Border color
    textMain: '#...',         // Primary text
    textDim: '#...',          // Secondary/dimmed text
    accent: '#...',           // Accent color
    accentDim: 'rgba(...)',   // Dimmed accent (with alpha)
    accentText: '#...',       // Text in accent contexts
    accentForeground: '#...', // Text ON accent backgrounds (contrast)
    success: '#...',          // Success state (green)
    warning: '#...',          // Warning state (yellow/orange)
    error: '#...',            // Error state (red)
  }
}
```

Then add the ID to `ThemeId` type in `src/shared/theme-types.ts` and to the `isValidThemeId` function.

### Adding an IPC Handler

1. Add handler in `src/main/index.ts`:
   ```typescript
   ipcMain.handle('myNamespace:myAction', async (_, arg1, arg2) => {
     // Implementation
     return result;
   });
   ```

2. Expose in `src/main/preload.ts`:
   ```typescript
   myNamespace: {
     myAction: (arg1, arg2) => ipcRenderer.invoke('myNamespace:myAction', arg1, arg2),
   },
   ```

3. Add types to `MaestroAPI` interface in preload.ts.

## Adding a New AI Agent

Maestro supports multiple AI coding agents. Each agent has different capabilities that determine which UI features are available. For detailed architecture, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

### Agent Capability Checklist

Before implementing, investigate the agent's CLI to determine which capabilities it supports:

| Capability | Question to Answer | Example |
|------------|-------------------|---------|
| **Session Resume** | Can you continue a previous conversation? | `--resume <id>`, `--session <id>` |
| **Read-Only Mode** | Is there a plan/analysis-only mode? | `--permission-mode plan`, `--agent plan` |
| **JSON Output** | Does it emit structured JSON? | `--output-format json`, `--format json` |
| **Session ID** | Does output include a session identifier? | `session_id`, `sessionID` in JSON |
| **Image Input** | Can you send images to the agent? | `--input-format stream-json`, `-f image.png` |
| **Slash Commands** | Are there discoverable commands? | Emitted in init message |
| **Session Storage** | Does it persist sessions to disk? | `~/.agent/sessions/` |
| **Cost Tracking** | Is it API-based with costs? | Cloud API vs local model |
| **Usage Stats** | Does it report token counts? | `tokens`, `usage` in output |
| **Batch Mode** | Does it run per-message or persistently? | `--print` vs interactive |

### Implementation Steps

#### 1. Add Agent Definition

In `src/main/agent-detector.ts`, add to `AGENT_DEFINITIONS`:

```typescript
{
  id: 'my-agent',
  name: 'My Agent',
  binaryName: 'myagent',
  command: 'myagent',
  args: ['--json'],  // Base args for batch mode
},
```

#### 2. Define Capabilities

In `src/main/agent-capabilities.ts` (create if needed):

```typescript
'my-agent': {
  supportsResume: true,              // Set based on investigation
  supportsReadOnlyMode: false,       // Set based on investigation
  supportsJsonOutput: true,
  supportsSessionId: true,
  supportsImageInput: false,
  supportsSlashCommands: false,
  supportsSessionStorage: false,
  supportsCostTracking: false,       // true for API-based agents
  supportsUsageStats: true,
  supportsBatchMode: true,
  supportsStreaming: true,
},
```

#### 3. Implement Output Parser

In `src/main/agent-output-parser.ts`, add a parser for the agent's JSON format:

```typescript
class MyAgentOutputParser implements AgentOutputParser {
  parseJsonLine(line: string): ParsedEvent {
    const msg = JSON.parse(line);
    return {
      type: msg.type,
      sessionId: msg.session_id,  // Agent-specific field name
      text: msg.content,          // Agent-specific field name
      tokens: msg.usage,          // Agent-specific field name
    };
  }
}
```

#### 4. Configure CLI Arguments

Add argument builders for capability-driven flags:

```typescript
// In agent definition
resumeArgs: (sessionId) => ['--resume', sessionId],
readOnlyArgs: ['--read-only'],  // If supported
jsonOutputArgs: ['--format', 'json'],
batchModePrefix: ['run'],  // If needed (e.g., 'myagent run "prompt"')
```

#### 5. Implement Session Storage (Optional)

If the agent persists sessions to disk:

```typescript
class MyAgentSessionStorage implements AgentSessionStorage {
  async listSessions(projectPath: string): Promise<AgentSession[]> {
    // Read from agent's session directory
  }

  async readSession(projectPath: string, sessionId: string): Promise<Message[]> {
    // Parse session file format
  }
}
```

#### 6. Test the Integration

```bash
# 1. Verify agent detection
npm run dev
# Check Settings → AI Agents shows your agent

# 2. Test new session
# Create session with your agent, send a message

# 3. Test JSON parsing
# Verify response appears correctly in UI

# 4. Test resume (if supported)
# Close and reopen tab, send follow-up message

# 5. Test read-only mode (if supported)
# Toggle read-only, verify agent refuses writes
```

### UI Feature Availability

Based on capabilities, these UI features are automatically enabled/disabled:

| Feature | Required Capability | Component |
|---------|-------------------|-----------|
| Read-only toggle | `supportsReadOnlyMode` | InputArea |
| Image attachment | `supportsImageInput` | InputArea |
| Session browser | `supportsSessionStorage` | RightPanel |
| Resume button | `supportsResume` | AgentSessionsBrowser |
| Cost widget | `supportsCostTracking` | MainPanel |
| Token display | `supportsUsageStats` | MainPanel, TabBar |
| Session ID pill | `supportsSessionId` | MainPanel |
| Slash autocomplete | `supportsSlashCommands` | InputArea |

### Supported Agents Reference

| Agent | Resume | Read-Only | JSON | Images | Sessions | Cost | Status |
|-------|--------|-----------|------|--------|----------|------|--------|
| Claude Code | ✅ `--resume` | ✅ `--permission-mode plan` | ✅ | ✅ | ✅ `~/.claude/` | ✅ | ✅ Complete |
| OpenCode | ✅ `--session` | ✅ `--agent plan` | ✅ | ✅ | Stub | ❌ (local) | 🔄 Stub Ready |
| Gemini CLI | TBD | TBD | TBD | TBD | TBD | ✅ | 📋 Planned |
| Codex | TBD | TBD | TBD | TBD | TBD | ✅ | 📋 Planned |

For detailed implementation guide, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

## Code Style

### TypeScript

- Strict mode enabled
- Interface definitions for all data structures
- Export types via `preload.ts` for renderer

### React Components

- Functional components with hooks
- Keep components focused and small
- Use Tailwind for layout, inline styles for theme colors
- Maintain keyboard accessibility
- Use `tabIndex={-1}` + `outline-none` for programmatic focus

### Security

- **Always use `execFileNoThrow`** for external commands (never shell-based execution)
- Keep context isolation enabled
- Use preload script for all IPC
- Sanitize all user inputs
- Use `spawn()` with `shell: false`

## Performance Guidelines

Maestro prioritizes a snappy interface and minimal battery consumption. Follow these guidelines:

### React Rendering

- **Memoize expensive computations** with `useMemo` - especially sorting, filtering, and transformations
- **Use Maps for lookups** instead of `Array.find()` in loops (O(1) vs O(n))
- **Batch state updates** - use the `useBatchedSessionUpdates` hook for high-frequency IPC updates
- **Avoid creating objects/arrays in render** - move static objects outside components or memoize them

```typescript
// Bad: O(n) lookup in every iteration
sessions.filter(s => {
  const group = groups.find(g => g.id === s.groupId); // O(n) per session
  return group && !group.collapsed;
});

// Good: O(1) lookup with memoized Map
const groupsById = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups]);
sessions.filter(s => {
  const group = groupsById.get(s.groupId); // O(1)
  return group && !group.collapsed;
});
```

### Timers & Intervals

- **Prefer longer intervals** - 3 seconds instead of 1 second for non-critical updates
- **Use `setTimeout` sparingly** - consider if the delay is truly necessary
- **Clean up all timers** in `useEffect` cleanup functions
- **Avoid polling** - use event-driven updates via IPC when possible

```typescript
// RightPanel.tsx uses 3-second intervals for elapsed time updates
intervalRef.current = setInterval(updateElapsed, 3000); // Not 1000ms
```

### Memory & Cleanup

- **Remove event listeners** in cleanup functions
- **Clear Maps and Sets** when no longer needed
- **Use WeakMap/WeakSet** for caches that should allow garbage collection
- **Limit log buffer sizes** - truncate old entries when buffers grow large

### IPC & Data Transfer

- **Batch IPC calls** - combine multiple small calls into fewer larger ones
- **Debounce persistence** - use `useDebouncedPersistence` for settings that change frequently
- **Stream large data** - don't load entire files into memory when streaming is possible

### Profiling

When investigating performance issues:

1. Use Chrome DevTools Performance tab (Cmd+Option+I → Performance)
2. Record during the slow operation
3. Look for long tasks (>50ms) blocking the main thread
4. Check for excessive re-renders in React DevTools Profiler

## Debugging Guide

### Focus Not Working

1. Add `tabIndex={0}` or `tabIndex={-1}` to element
2. Add `outline-none` class to hide focus ring
3. Use `ref={(el) => el?.focus()}` for auto-focus
4. Check for `e.stopPropagation()` blocking events

### Settings Not Persisting

1. Ensure wrapper function calls `window.maestro.settings.set()`
2. Check loading code in `useSettings.ts` useEffect
3. Verify the key name matches in both save and load

### Modal Escape Not Working

1. Register modal with layer stack (don't handle Escape locally)
2. Check priority in `modalPriorities.ts`
3. Use ref pattern to avoid re-registration:
   ```typescript
   const onCloseRef = useRef(onClose);
   onCloseRef.current = onClose;
   ```

### Theme Colors Not Applying

1. Use `style={{ color: theme.colors.textMain }}` instead of Tailwind color classes
2. Check theme prop is passed to component
3. Never use hardcoded hex colors for themed elements

### Process Output Not Showing

1. Check session ID matches (with `-ai` or `-terminal` suffix)
2. Verify `onData` listener is registered
3. Check process spawned successfully (check pid > 0)
4. Look for errors in DevTools console

### DevTools

Open via Quick Actions (`Cmd+K` → "Toggle DevTools") or set `DEBUG=true` env var.

## Commit Messages

Use conventional commits:

```
feat: new feature
fix: bug fix
docs: documentation changes
refactor: code refactoring
test: test additions/changes
chore: build process or tooling changes
```

Example: `feat: add context usage visualization`

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes following the code style
3. Test thoroughly (keyboard navigation, themes, focus)
4. Update documentation if needed
5. Submit PR with clear description
6. Wait for review

## Building for Release

### 0. Refresh Spec Kit Prompts (Optional)

Before releasing, check if GitHub's spec-kit has updates:

```bash
npm run refresh-speckit
```

This fetches the latest prompts from [github/spec-kit](https://github.com/github/spec-kit) and updates the bundled files in `src/prompts/speckit/`. The custom `/speckit.implement` prompt is never overwritten.

Review any changes with `git diff` before committing.

### 1. Prepare Icons

Place icons in `build/` directory:
- `icon.icns` - macOS (512x512 or 1024x1024)
- `icon.ico` - Windows (256x256)
- `icon.png` - Linux (512x512)

### 2. Update Version

Update in `package.json`:
```json
{
  "version": "0.1.0"
}
```

### 3. Build Distributables

```bash
npm run package           # All platforms
npm run package:mac       # macOS (.dmg, .zip)
npm run package:win       # Windows (.exe)
npm run package:linux     # Linux (.AppImage, .deb, .rpm)
```

Output in `release/` directory.

### GitHub Actions

Create a release tag to trigger automated builds:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will build for all platforms and create a release.

## Questions?

Open a GitHub Discussion or create an Issue.

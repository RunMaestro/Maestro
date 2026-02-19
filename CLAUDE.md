# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation Index

This guide has been split into focused sub-documents for progressive disclosure:

| Document | Description |
|----------|-------------|
| [[CLAUDE-PATTERNS.md]] | Core implementation patterns (process management, settings, modals, themes, Auto Run, SSH, Encore Features) |
| [[CLAUDE-IPC.md]] | IPC API surface (`window.maestro.*` namespaces) |
| [[CLAUDE-PERFORMANCE.md]] | Performance best practices (React optimization, debouncing, batching) |
| [[CLAUDE-WIZARD.md]] | Onboarding Wizard, Inline Wizard, and Tour System |
| [[CLAUDE-FEATURES.md]] | Usage Dashboard and Document Graph features |
| [[CLAUDE-AGENTS.md]] | Supported agents and capabilities |
| [[CLAUDE-SESSION.md]] | Session interface (agent data model) and code conventions |
| [[CLAUDE-PLATFORM.md]] | Cross-platform concerns (Windows, Linux, macOS, SSH remote) |
| [AGENT_SUPPORT.md](AGENT_SUPPORT.md) | Detailed agent integration guide |

---

## Agent Behavioral Guidelines

Core behaviors for effective collaboration. Failures here cause the most rework.

### Surface Assumptions Early
Before implementing non-trivial work, explicitly state assumptions. Never silently fill in ambiguous requirements—the most common failure mode is guessing wrong and running with it. Format: "Assumptions: 1) X, 2) Y. Correct me now or I proceed."

### Manage Confusion Actively
When encountering inconsistencies, conflicting requirements, or unclear specs: **STOP**. Name the specific confusion, present the tradeoff, and wait for resolution. Bad: silently picking one interpretation. Good: "I see X in file A but Y in file B—which takes precedence?"

### Push Back When Warranted
Not a yes-machine. When an approach has clear problems: point out the issue directly, explain the concrete downside, propose an alternative, then accept the decision if overridden. Sycophancy ("Of course!") followed by implementing a bad idea helps no one.

### Enforce Simplicity
Natural tendency is to overcomplicate—actively resist. Before finishing: Can this be fewer lines? Are abstractions earning their complexity? Would a senior dev say "why didn't you just..."? Prefer the boring, obvious solution.

### Maintain Scope Discipline
Touch only what's asked. Do NOT: remove comments you don't understand, "clean up" orthogonal code, refactor adjacent systems as side effects, or delete seemingly-unused code without approval. Surgical precision, not unsolicited renovation.

### Dead Code Hygiene
After refactoring: identify now-unreachable code, list it explicitly, ask "Should I remove these now-unused elements: [list]?" Don't leave corpses. Don't delete without asking.

---

## Standardized Vernacular

Use these terms consistently in code, comments, and documentation:

### Terminology: Agent vs Session

In Maestro, the terms "agent" and "session" have distinct meanings:

- **Agent** - An entity in the Left Bar backed by a provider (Claude Code, Codex, etc.). This is what users see, create, and interact with. Each agent has its own workspace, tabs, and configuration.
- **Session** (or **provider session**) - An individual conversation context within a provider (e.g., Claude's `session_id`). Each AI tab within an agent can have its own provider session. In code, the `Session` interface represents an agent (historical naming).

Use "agent" in user-facing language. Reserve "session" for provider-level conversation contexts or when documenting the code interface.

### UI Components
- **Left Bar** - Left sidebar with agent list and groups (`SessionList.tsx`)
- **Right Bar** - Right sidebar with Files, History, Auto Run tabs (`RightPanel.tsx`)
- **Main Window** - Center workspace (`MainPanel.tsx`)
  - **AI Terminal** - Main window in AI mode (interacting with AI agents)
  - **Command Terminal** - Main window in terminal/shell mode
  - **System Log Viewer** - Special view for system logs (`LogViewer.tsx`)

### Agent States (color-coded)
- **Green** - Ready/idle
- **Yellow** - Agent thinking/busy
- **Red** - No connection/error
- **Pulsing Orange** - Connecting

---

## Code Style

This codebase uses **tabs for indentation**, not spaces. Always match existing file indentation when editing.

---

## Project Overview

Maestro is an Electron desktop app for managing multiple AI coding assistants simultaneously with a keyboard-first interface.

### Supported Agents

| ID | Name | Status |
|----|------|--------|
| `claude-code` | Claude Code | **Active** |
| `codex` | OpenAI Codex | **Active** |
| `opencode` | OpenCode | **Active** |
| `factory-droid` | Factory Droid | **Active** |
| `terminal` | Terminal | Internal |

See [[CLAUDE-AGENTS.md]] for capabilities and integration details.

---

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

---

## Architecture at a Glance

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts            # Entry point, IPC handlers
│   ├── preload.ts          # Secure IPC bridge
│   ├── process-manager.ts  # Process spawning (PTY + child_process)
│   ├── agent-*.ts          # Agent detection, capabilities, session storage
│   ├── parsers/            # Per-agent output parsers + error patterns
│   ├── storage/            # Per-agent session storage implementations
│   ├── ipc/handlers/       # IPC handler modules (stats, git, playbooks, etc.)
│   └── utils/              # Utilities (execFile, ssh-spawn-wrapper, etc.)
│
├── renderer/               # React frontend (desktop)
│   ├── App.tsx            # Main coordinator
│   ├── components/        # UI components
│   ├── hooks/             # Custom React hooks
│   ├── services/          # IPC wrappers (git.ts, process.ts)
│   ├── constants/         # Themes, shortcuts, priorities
│   └── contexts/          # Context providers (LayerStack, etc.)
│
├── web/                    # Web/mobile interface
│   ├── mobile/            # Mobile-optimized React app
│   └── components/        # Shared web components
│
├── cli/                    # CLI tooling for batch automation
│   ├── commands/          # CLI command implementations
│   └── services/          # Playbook and batch processing
│
├── prompts/                # System prompts (editable .md files)
│
├── shared/                 # Shared types and utilities
│
└── docs/                   # Mintlify documentation (docs.runmaestro.ai)
```

---

## Key Files for Common Tasks

| Task | Primary Files |
|------|---------------|
| Add IPC handler | `src/main/index.ts`, `src/main/preload.ts` |
| Add UI component | `src/renderer/components/` |
| Add web/mobile component | `src/web/components/`, `src/web/mobile/` |
| Add keyboard shortcut | `src/renderer/constants/shortcuts.ts`, `App.tsx` |
| Add theme | `src/renderer/constants/themes.ts` |
| Add modal | Component + `src/renderer/constants/modalPriorities.ts` |
| Add tab overlay menu | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]] |
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
| Add marketplace playbook | `src/main/ipc/handlers/marketplace.ts` (import from GitHub) |
| Playbook import/export | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets) |
| Modify wizard flow | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]]) |
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
| Spawn agent with SSH support | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution) |
| Modify file preview tabs | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System) |
| Add Director's Notes feature | `src/renderer/components/DirectorNotes/`, `src/main/ipc/handlers/director-notes.ts` |
| Add Encore Feature | `src/renderer/types/index.ts` (flag), `useSettings.ts` (state), `SettingsModal.tsx` (toggle UI), gate in `App.tsx` + keyboard handler |
| Modify history components | `src/renderer/components/History/` |

---

## Critical Implementation Guidelines

### Error Handling & Sentry

Maestro uses Sentry for error tracking. Field data from production crashes is invaluable for improving code quality.

**DO let exceptions bubble up:**
```typescript
// WRONG - silently swallowing errors hides bugs from Sentry
try {
  await riskyOperation();
} catch (e) {
  console.error(e);  // Lost to the void
}

// CORRECT - let unhandled exceptions reach Sentry
await riskyOperation();  // Crashes are reported automatically
```

**DO handle expected/recoverable errors explicitly:**
```typescript
// CORRECT - known failure modes should be handled gracefully
try {
  await fetchUserData();
} catch (e) {
  if (e.code === 'NETWORK_ERROR') {
    showOfflineMessage();  // Expected, recoverable
  } else {
    throw e;  // Unexpected - let Sentry capture it
  }
}
```

**DO use Sentry utilities for explicit reporting:**
```typescript
import { captureException, captureMessage } from '../utils/sentry';

// Report exceptions with context
await captureException(error, { userId, operation: 'sync' });

// Report notable events that aren't crashes
await captureMessage('Unusual state detected', 'warning', { state });
```

**Key files:** `src/main/utils/sentry.ts`, `src/renderer/components/ErrorBoundary.tsx`

---

### SSH Remote Execution Awareness

**IMPORTANT:** When implementing any feature that spawns agent processes (e.g., context grooming, group chat, batch operations), you MUST support SSH remote execution.

Agents can be configured to run on remote hosts via SSH. Without proper SSH wrapping, agents will always execute locally, breaking the user's expected behavior.

**Required pattern:**
1. Check if the session has `sshRemoteConfig` with `enabled: true`
2. Use `wrapSpawnWithSsh()` from `src/main/utils/ssh-spawn-wrapper.ts` to wrap the spawn config
3. Pass the SSH store (available via `createSshRemoteStoreAdapter(settingsStore)`)

```typescript
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

// Before spawning, wrap the config with SSH if needed
if (sshStore && session.sshRemoteConfig?.enabled) {
  const sshWrapped = await wrapSpawnWithSsh(spawnConfig, session.sshRemoteConfig, sshStore);
  // Use sshWrapped.command, sshWrapped.args, sshWrapped.cwd, etc.
}
```

**Also ensure:**
- The correct agent type is used (don't hardcode `claude-code`)
- Custom agent configuration (customPath, customArgs, customEnvVars) is passed through
- Agent's `binaryName` is used for remote execution (not local paths)

See [[CLAUDE-PATTERNS.md]] for detailed SSH patterns.

---

## Debugging

### Root Cause Verification (Before Implementing Fixes)

Initial hypotheses are often wrong. Before implementing any fix:

1. **IPC issues:** Verify handler is registered in `src/main/index.ts` before modifying caller code
2. **UI rendering bugs:** Check CSS properties (overflow, z-index, position) on element AND parent containers before changing component logic
3. **State not updating:** Trace the data flow from source to consumer; check if the setter is being called vs if re-render is suppressed
4. **Feature not working:** Verify the code path is actually being executed (add temporary `console.log`, check output, then remove)

**Historical patterns that wasted time:**
- Tab naming bug: Modal coordination was "fixed" when the actual issue was an unregistered IPC handler
- Tooltip clipping: Attempted `overflow: visible` on element when parent container had `overflow: hidden`
- Session validation: Fixed renderer calls when handler wasn't wired in main process

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

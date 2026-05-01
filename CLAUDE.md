# CLAUDE.md

Essential guidance for working with this codebase. For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For development setup and processes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation Index

This guide has been split into focused sub-documents for progressive disclosure:

| Document                             | Description                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [[CLAUDE-PATTERNS.md]]               | Core implementation patterns (process management, settings, modals, themes, Auto Run, SSH, Encore Features)      |
| [[CLAUDE-IPC.md]]                    | IPC API surface (`window.maestro.*` namespaces)                                                                  |
| [[CLAUDE-PERFORMANCE.md]]            | Performance best practices (React optimization, debouncing, batching)                                            |
| [[CLAUDE-WIZARD.md]]                 | Onboarding Wizard, Inline Wizard, and Tour System                                                                |
| [[CLAUDE-FEATURES.md]]               | Usage Dashboard and Document Graph features                                                                      |
| [[CLAUDE-AGENTS.md]]                 | Supported agents and capabilities                                                                                |
| [[CLAUDE-SESSION.md]]                | Session interface (agent data model) and code conventions                                                        |
| [[CLAUDE-PLATFORM.md]]               | Cross-platform concerns (Windows, Linux, macOS, SSH remote)                                                      |
| [[CLAUDE-CUE.md]]                    | Cue automation engine: architecture, dispatch flow, lifecycle, gotchas (read before editing `src/main/cue/`)     |
| [[CLAUDE-AGENT-DISPATCH.md]]         | Agent Dispatch: lifecycle (claim/heartbeat/release), IPC namespace, fork-only GitHub assumption, troubleshooting |
| [[CLAUDE-DELIVERY-PLANNER.md]]       | Delivery Planner: PRD → Epic → Tasks → GitHub sync, external mirror, path resolver, validation commands          |
| [[CLAUDE-PLANNING-PIPELINE.md]]      | Planning Pipeline epic: stage machine, triggers, supervisor, SLA, file index, how to add a new stage             |
| [[CLAUDE-CONVERSATIONAL-PRD.md]]     | Conversational PRD Planner: architecture, IPC channels, file index, output contract, persistence, validation     |
| [AGENT_SUPPORT.md](AGENT_SUPPORT.md) | Detailed agent integration guide                                                                                 |

---

## Before Writing New Code - Check Existing Utilities

**MANDATORY:** Before creating any new utility function, helper, hook, component, type, or constant, check the guide docs in `docs/agent-guides/` to see if it already exists. Duplicated code is the #1 source of maintenance burden in this codebase - there are already grep-verified instances of 20+ duplicate format helpers, 60+ ad-hoc mock factories, and 500+ manual modal-layer registrations. Don't add to the pile.

| Before creating...                                 | Check this guide first                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| Utility function (formatting, IDs, paths, strings) | [SHARED-UTILS.md](docs/agent-guides/SHARED-UTILS.md)           |
| IPC handler or preload bridge                      | [IPC-PATTERNS.md](docs/agent-guides/IPC-PATTERNS.md)           |
| Store action, selector, or hook                    | [STATE-PATTERNS.md](docs/agent-guides/STATE-PATTERNS.md)       |
| Agent parser, storage, or error pattern            | [AGENT-INFRA.md](docs/agent-guides/AGENT-INFRA.md)             |
| UI component, modal, or theme usage                | [UI-PATTERNS.md](docs/agent-guides/UI-PATTERNS.md)             |
| Test mock, factory, or setup pattern               | [TEST-PATTERNS.md](docs/agent-guides/TEST-PATTERNS.md)         |
| Renderer service or constant                       | [RENDERER-SERVICES.md](docs/agent-guides/RENDERER-SERVICES.md) |
| Process spawning or listener                       | [PROCESS-SYSTEM.md](docs/agent-guides/PROCESS-SYSTEM.md)       |
| Web/mobile hook or component                       | [WEB-MOBILE.md](docs/agent-guides/WEB-MOBILE.md)               |
| CLI command or playbook feature                    | [CLI-PLAYBOOKS.md](docs/agent-guides/CLI-PLAYBOOKS.md)         |
| Group chat or Symphony feature                     | [GROUP-CHAT.md](docs/agent-guides/GROUP-CHAT.md)               |
| Stats, analytics, or dashboard                     | [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)     |
| Prompt template or SpecKit/OpenSpec                | [PROMPTS-SPECS.md](docs/agent-guides/PROMPTS-SPECS.md)         |
| Cue pipeline feature                               | [CUE-PIPELINE.md](docs/agent-guides/CUE-PIPELINE.md)           |
| App lifecycle, updater, or power mgmt              | [MAIN-LIFECYCLE.md](docs/agent-guides/MAIN-LIFECYCLE.md)       |

### Commonly-reimplemented functions (do NOT add new copies)

Grep-verified 2026-04-10. Import from these canonical locations:

- **ID generation:** `generateId()` in `src/renderer/utils/ids.ts`, `generateUUID()` in `src/shared/uuid.ts`
- **Format file size:** `formatSize()` in `src/shared/formatters.ts`
- **Format numbers:** `formatNumber()` in `src/shared/formatters.ts`
- **Format tokens:** `formatTokens()`, `formatTokensCompact()`, `estimateTokenCount()` in `src/shared/formatters.ts`
- **Format elapsed time:** `formatElapsedTime()`, `formatElapsedTimeColon()` in `src/shared/formatters.ts`
- **Format duration (ms):** `formatDuration()` in `src/shared/performance-metrics.ts` (NOT formatters.ts - common mistake)
- **Format relative time:** `formatRelativeTime()` in `src/shared/formatters.ts`
- **Format cost:** `formatCost()` in `src/shared/formatters.ts`
- **Path utilities:** `truncatePath()`, `getParentDir()`, `truncateCommand()` in `src/shared/formatters.ts`
- **Strip ANSI:** `stripAnsiCodes()` in `src/shared/stringUtils.ts`
- **Shell escape:** `shellEscape()`, `shellEscapeArgs()`, `shellEscapeForDoubleQuotes()` in `src/main/utils/shell-escape.ts`
- **Platform detection:** `isWindows()`, `isMacOS()`, `isLinux()` in `src/shared/platformDetection.ts`
- **Agent display name:** `getAgentDisplayName()` in `src/shared/agentMetadata.ts`
- **SSH remote lookup:** `getSshRemoteById()` in `src/main/stores/getters.ts`
- **Toast notifications:** `notifyToast({ color, title, message, dismissible? })` in `src/renderer/stores/notificationStore.ts`. Use for async results, errors, and persistent/dismissable messages. Same five-color design language as Center Flash: `green | yellow | orange | red | theme` (default `theme`). Set `dismissible: true` (or pass `--dismissible` from `maestro-cli notify toast`) when the user MUST acknowledge — disables auto-dismiss, requires click to close, and emphasizes the X button. Cannot combine `dismissible` with `duration`/`--timeout`. External CLI cap: 60 seconds (use `--dismissible` for sticky). **Click actions** (data-driven, survive the IPC bridge): pass `clickAction: { kind: 'jump-session', sessionId, tabId? } | { kind: 'open-file', sessionId, path } | { kind: 'open-url', url }` for what should happen when the toast body is clicked, or use the legacy `sessionId`/`tabId` fields for plain agent jump. From the CLI: `--agent` (+ optional `--tab`), `--open-file <path>` (requires `--agent`), `--open-url <url>` (mutually exclusive with `--open-file`). `--action-url` / `--action-label` render an inline link button beneath the message and are independent of the body click. Do NOT pass renderer-only callbacks across the bridge — use `clickAction` instead.
- **Center flash (rapid acks):** `notifyCenterFlash({ message, color, detail?, duration? })` in `src/renderer/stores/centerFlashStore.ts`; clipboard helper `flashCopiedToClipboard()` in `src/renderer/utils/flashCopiedToClipboard.ts`. Use for momentary "I did the thing" confirmations of user-initiated actions. Five-color design language: `green | yellow | orange | red | theme` — default `theme` matches the active Maestro theme. External integrations can fire flashes via `maestro-cli notify flash <message> --color <color>`. Do NOT roll your own center-screen overlay, useState+setTimeout flash, add a sixth color, or use a Toast for clipboard acks. Single visible flash at a time, themed frosted-glass card mounted once in `App.tsx`. Full decision rules, color palette, and design language: [UI-PATTERNS.md → Center Flash System](docs/agent-guides/UI-PATTERNS.md#center-flash-system-rapid-temporary-notifications).
- **Session lookup:** `selectActiveSession()`, `selectSessionById()` in `src/renderer/stores/sessionStore.ts`; `useActiveSession()` hook in `src/renderer/hooks/session/useActiveSession.ts`
- **Session mutation:** `updateSessionWith(sessionId, updater)` in `src/renderer/stores/sessionStore.ts` (do NOT hand-roll `setSessions(prev => prev.map(...))`)
- **Modal layer:** `useModalLayer()` in `src/renderer/hooks/ui/useModalLayer.ts` (do NOT use manual `registerLayer()` boilerplate)
- **Focus after render:** `useFocusAfterRender()` in `src/renderer/hooks/utils/useFocusAfterRender.ts` (do NOT use `useEffect + setTimeout(() => ref.focus())`)
- **Event listeners:** `useEventListener()` in `src/renderer/hooks/utils/useEventListener.ts` (do NOT pair raw `addEventListener`/`removeEventListener` inside useEffect)
- **Debounce/throttle:** `useDebouncedValue()`, `useDebouncedCallback()`, `useThrottledCallback()` in `src/renderer/hooks/utils/useThrottle.ts` (filename is misleading - all three live here)

If your use case does NOT match an existing utility, prefer extending the canonical file over creating a new one. If you genuinely need something new, add it to the relevant guide in `docs/agent-guides/` so the next person can find it.

The tracker at [DEDUP-TRACKER.md](docs/agent-guides/DEDUP-TRACKER.md) lists all known duplication findings.

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

### Validate Before Push

Before pushing any branch, re-run the relevant formatting, lint, type-check, and test commands for the changes you made. Fix any issues those commands surface, include the fixes in the branch, and only then push or update the PR.

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

### Automation

- **Cue** — Event-driven automation system (Maestro Cue), gated as an Encore Feature. Watches for file changes, time intervals, agent completions, GitHub PRs/issues, and pending markdown tasks to trigger automated prompts. Configured via `.maestro/cue.yaml` per project.
- **Cue Modal** — Dashboard for managing Cue subscriptions and viewing activity (`CueModal.tsx`)

### Agent States (color-coded)

- **Green** - Ready/idle
- **Yellow** - Agent thinking/busy
- **Red** - No connection/error
- **Pulsing Orange** - Connecting

---

## Code Style

This codebase uses **tabs for indentation**, not spaces. Always match existing file indentation when editing.

---

## Do Not Edit: `docs/releases.md`

`docs/releases.md` is generated/updated automatically during release pressing. **Never modify it manually** — even when shipping user-facing changes that would seem to warrant a release note entry. The release tooling handles it.

---

## Project Overview

Maestro is an Electron desktop app for managing multiple AI coding assistants simultaneously with a keyboard-first interface.

### Supported Agents

| ID              | Name          | Status     |
| --------------- | ------------- | ---------- |
| `claude-code`   | Claude Code   | **Active** |
| `codex`         | OpenAI Codex  | **Active** |
| `opencode`      | OpenCode      | **Active** |
| `factory-droid` | Factory Droid | **Active** |
| `copilot-cli`   | Copilot-CLI   | **Beta**   |
| `terminal`      | Terminal      | Internal   |

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
│   ├── cue/               # Maestro Cue event-driven automation engine
│   ├── parsers/            # Per-agent output parsers + error patterns
│   ├── storage/            # Per-agent session storage implementations
│   ├── ipc/handlers/       # IPC handler modules (stats, git, playbooks, cue, etc.)
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

| Task                          | Primary Files                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add IPC handler               | `src/main/index.ts`, `src/main/preload.ts`                                                                                                                                                                                                                       |
| Add UI component              | `src/renderer/components/`                                                                                                                                                                                                                                       |
| Add web/mobile component      | `src/web/components/`, `src/web/mobile/`                                                                                                                                                                                                                         |
| Add keyboard shortcut         | `src/renderer/constants/shortcuts.ts`, `App.tsx`                                                                                                                                                                                                                 |
| Add theme                     | `src/renderer/constants/themes.ts`                                                                                                                                                                                                                               |
| Add modal                     | Component + `src/renderer/constants/modalPriorities.ts`                                                                                                                                                                                                          |
| Add tab overlay menu          | See Tab Hover Overlay Menu pattern in [[CLAUDE-PATTERNS.md]]                                                                                                                                                                                                     |
| Add setting                   | `src/shared/settingsMetadata.ts` (metadata), `src/renderer/stores/settingsStore.ts`, `src/main/stores/defaults.ts`, AND `src/renderer/components/Settings/searchableSettings.ts` + `data-setting-id` wrapper on rendered control (see [[CLAUDE-PATTERNS.md]] §3) |
| Add template variable         | `src/shared/templateVariables.ts`, `src/renderer/utils/templateVariables.ts`                                                                                                                                                                                     |
| Modify system prompts         | `src/prompts/*.md` (wizard, Auto Run, etc.) or edit via **Maestro Prompts** tab in Settings                                                                                                                                                                      |
| Customize prompts             | Use **Maestro Prompts** tab in Settings, or edit `userData/core-prompts-customizations.json`                                                                                                                                                                     |
| Add new prompt                | `src/prompts/*.md`, `src/shared/promptDefinitions.ts` (add to `CORE_PROMPTS` array and `PROMPT_IDS`)                                                                                                                                                             |
| Add Spec-Kit command          | `src/prompts/speckit/`, `src/main/speckit-manager.ts`                                                                                                                                                                                                            |
| Add OpenSpec command          | `src/prompts/openspec/`, `src/main/openspec-manager.ts`                                                                                                                                                                                                          |
| Add CLI command               | `src/cli/commands/`, `src/cli/index.ts`                                                                                                                                                                                                                          |
| Add new agent                 | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts`, `src/shared/agentMetadata.ts` — see [AGENT_SUPPORT.md](AGENT_SUPPORT.md)                                                                                          |
| Add agent output parser       | `src/main/parsers/`, `src/main/parsers/index.ts`                                                                                                                                                                                                                 |
| Add agent session storage     | `src/main/storage/` (extend `BaseSessionStorage`), `src/main/storage/index.ts`                                                                                                                                                                                   |
| Add agent error patterns      | `src/main/parsers/error-patterns.ts`                                                                                                                                                                                                                             |
| Add agent context window      | `src/shared/agentConstants.ts` (`DEFAULT_CONTEXT_WINDOWS`, `FALLBACK_CONTEXT_WINDOW`)                                                                                                                                                                            |
| Add playbook feature          | `src/cli/services/playbooks.ts`                                                                                                                                                                                                                                  |
| Add marketplace playbook      | `src/main/ipc/handlers/marketplace.ts` (import from GitHub)                                                                                                                                                                                                      |
| Playbook import/export        | `src/main/ipc/handlers/playbooks.ts` (ZIP handling with assets)                                                                                                                                                                                                  |
| Modify wizard flow            | `src/renderer/components/Wizard/` (see [[CLAUDE-WIZARD.md]])                                                                                                                                                                                                     |
| Add tour step                 | `src/renderer/components/Wizard/tour/tourSteps.ts`                                                                                                                                                                                                               |
| Modify file linking           | `src/renderer/utils/remarkFileLinks.ts` (remark plugin for `[[wiki]]` and path links)                                                                                                                                                                            |
| Add documentation page        | `docs/*.md`, `docs/docs.json` (navigation)                                                                                                                                                                                                                       |
| Add documentation screenshot  | `docs/screenshots/` (PNG, kebab-case naming)                                                                                                                                                                                                                     |
| MCP server integration        | See [MCP Server docs](https://docs.runmaestro.ai/mcp-server)                                                                                                                                                                                                     |
| Add stats/analytics feature   | `src/main/stats-db.ts`, `src/main/ipc/handlers/stats.ts`                                                                                                                                                                                                         |
| Add Usage Dashboard chart     | `src/renderer/components/UsageDashboard/`                                                                                                                                                                                                                        |
| Add Document Graph feature    | `src/renderer/components/DocumentGraph/`, `src/main/ipc/handlers/documentGraph.ts`                                                                                                                                                                               |
| Add colorblind palette        | `src/renderer/constants/colorblindPalettes.ts`                                                                                                                                                                                                                   |
| Add performance metrics       | `src/shared/performance-metrics.ts`                                                                                                                                                                                                                              |
| Add power management          | `src/main/power-manager.ts`, `src/main/ipc/handlers/system.ts`                                                                                                                                                                                                   |
| Spawn agent with SSH support  | `src/main/utils/ssh-spawn-wrapper.ts` (required for SSH remote execution)                                                                                                                                                                                        |
| Modify file preview tabs      | `TabBar.tsx`, `FilePreview.tsx`, `MainPanel.tsx` (see ARCHITECTURE.md → File Preview Tab System)                                                                                                                                                                 |
| Add Director's Notes feature  | `src/renderer/components/DirectorNotes/`, `src/main/ipc/handlers/director-notes.ts`                                                                                                                                                                              |
| Add Encore Feature            | `src/renderer/types/index.ts` (flag), `useSettings.ts` (state), `SettingsModal.tsx` (toggle UI), gate in `App.tsx` + keyboard handler                                                                                                                            |
| Modify history components     | `src/renderer/components/History/`                                                                                                                                                                                                                               |
| Modify history activity graph | `src/renderer/components/History/ActivityGraph.tsx`, `src/main/utils/history-bucket-cache.ts` (disk-cached aggregates), `src/main/utils/history-bucket-builder.ts`                                                                                               |
| Add Cue event type            | `src/main/cue/cue-types.ts`, `src/main/cue/cue-engine.ts`                                                                                                                                                                                                        |
| Add Cue template variable     | `src/shared/templateVariables.ts`, `src/main/cue/cue-executor.ts`                                                                                                                                                                                                |
| Modify Cue modal              | `src/renderer/components/CueModal.tsx`                                                                                                                                                                                                                           |
| Configure Cue engine          | `src/main/cue/cue-engine.ts`, `src/main/ipc/handlers/cue.ts`                                                                                                                                                                                                     |
| Add terminal feature          | `src/renderer/components/XTerminal.tsx`, `src/renderer/components/TerminalView.tsx`                                                                                                                                                                              |
| Modify terminal tabs          | `src/renderer/utils/terminalTabHelpers.ts`, `src/renderer/stores/tabStore.ts`                                                                                                                                                                                    |

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
	console.error(e); // Lost to the void
}

// CORRECT - let unhandled exceptions reach Sentry
await riskyOperation(); // Crashes are reported automatically
```

**DO handle expected/recoverable errors explicitly:**

```typescript
// CORRECT - known failure modes should be handled gracefully
try {
	await fetchUserData();
} catch (e) {
	if (e.code === 'NETWORK_ERROR') {
		showOfflineMessage(); // Expected, recoverable
	} else {
		throw e; // Unexpected - let Sentry capture it
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
- When the user enabled SSH but the configured remote can't be resolved, **fail
  loudly** instead of silently running locally — the user explicitly opted into
  SSH and their prompt shouldn't leak to the local machine (see
  `sshUnresolvedFailure()` in `src/cli/services/agent-spawner.ts` for the CLI's
  version of this).

**CLI parity:** The CLI (`src/cli/services/agent-spawner.ts`) spawns agent
processes for batch/playbook automation and honors the same SSH wrapping and
agent-config overrides as the desktop app. When adding new CLI spawn sites,
thread `sessionSshRemoteConfig`, `customArgs`, `customEnvVars`, `customModel`,
`customEffort` through to `spawnAgent(...)`. The CLI loads `ssh-spawn-wrapper`
via dynamic `import()` so the SSH chain stays out of the local hot path.

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

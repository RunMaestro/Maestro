---
type: architecture
title: Global Environment Variables Architecture
created: 2026-02-17
tags:
  - architecture
  - environment-variables
  - agents
  - settings
related:
  - '[[ENV_VAR_ARCHITECTURE.md]]'
  - '[[CLAUDE-PATTERNS.md]]'
---

# Global Environment Variables Architecture

## Overview

Maestro's global environment variables feature allows users to define environment variables once in Settings and have them automatically applied to all terminal sessions and AI agent processes. This eliminates the need to duplicate configuration across multiple agents and enables centralized management of secrets, API keys, and tool paths.

### Problem This Solves

Previously, environment variables had to be:

- Manually configured for each agent individually
- Duplicated across multiple agent configurations
- Re-entered each time an agent was added or reconfigured
- Managed in separate locations, increasing maintenance burden

This feature solves all of these issues by providing a single, unified source of configuration that applies globally.

### Why It Matters

1. **Security**: API keys and secrets defined once, reducing exposure and typos
2. **Efficiency**: No repetition across 4+ agent types
3. **Consistency**: All agents use identical environment configuration
4. **Simplicity**: Single place to manage shared configuration

---

## System Design

### Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    User Settings UI                          │
│        (Settings → Environment)            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
         ┌─────────────────────────┐
         │  Renderer Store         │
         │  (Zustand)              │
         │  shellEnvVars: {...}    │
         └────────────┬────────────┘
                      │
                      ▼
          ┌──────────────────────────┐
          │  IPC: settings:set       │
          │  Persist to electron-    │
          │  store                   │
          └────────────┬─────────────┘
                       │
                       ▼
          ┌──────────────────────────┐
          │  Main Process Settings   │
          │  electron-store:         │
          │  shellEnvVars            │
          └────────────┬─────────────┘
                       │
        ┌──────────────┴──────────────┐
        │                             │
        ▼                             ▼
 ┌─────────────────┐        ┌─────────────────┐
 │ Terminal (PTY)  │        │ Agent Process   │
 │ Spawning        │        │ Spawning        │
 └────────┬────────┘        └────────┬────────┘
          │                          │
          ▼                          ▼
 ┌─────────────────┐        ┌─────────────────┐
 │buildPtyTerminal │        │buildChildProcess│
 │Env()            │        │Env()            │
 │+ global vars    │        │+ global vars    │
 │+ shell path     │        │+ agent config   │
 │+ shell args     │        │+ session vars   │
 └────────┬────────┘        └────────┬────────┘
          │                          │
          ▼                          ▼
 ┌─────────────────┐        ┌─────────────────┐
 │ PTY Environment │        │ Child Process   │
 │ Variables       │        │ Environment     │
 └─────────────────┘        └─────────────────┘
```

### Data Flow: Settings → Spawned Process

#### For Terminal Sessions

```text
1. User opens Settings → Environment
2. Enters environment variables: KEY=VALUE (one per line)
3. Clicks Save or Auto-Save triggers
4. Renderer calls: window.maestro.settings.set('shellEnvVars', {...})
5. IPC handler persists to electron-store
6. User spawns terminal via Maestro UI
7. ProcessManager.spawn() called with config
8. PtySpawner extracts shellEnvVars from config
9. buildPtyTerminalEnv(shellEnvVars) called
10. PTY process spawned with merged environment
11. Terminal inherits all global env vars
```

#### For Agent Processes

```text
1. Global env vars stored in electron-store as before
2. User requests to spawn agent (Claude Code, Codex, etc.)
3. IPC handler loads: settingsStore.get('shellEnvVars', {})
4. ProcessConfig created with: { shellEnvVars: {...} }
5. ProcessManager.spawn() called with config
6. ChildProcessSpawner extracts: config.shellEnvVars
7. buildChildProcessEnv(sessionVars, isResuming, globalVars) called
8. Precedence applied (session overrides global overrides defaults)
9. Child process spawned with merged environment
10. Agent inherits all global env vars
```

---

## Precedence Rules

The environment variable precedence (highest to lowest) is:

```text
Priority 1: Session-Level Custom Environment Variables
            (set in spawn request for this specific session)
                    ▲
                    │ overrides
                    │
Priority 2: Global Shell Environment Variables
            (Settings → Environment)
                    ▲
                    │ overrides
                    │
Priority 3: Process Environment
            (with problematic vars stripped for agents)
```

### Precedence Examples

**Example 1: Global Variable (No Override)**

```env
Global: DEBUG=maestro:*
Session: (not set)

Result: DEBUG=maestro:*
```

**Example 2: Session Overrides Global**

```env
Global:  API_KEY=global-key
Session: API_KEY=session-key

Result: API_KEY=session-key
```

**Example 3: Multiple Variables (Mixed Levels)**

```env
Global:  API_KEY=key123
Global:  DEBUG=on
Session: DEBUG=off

Result: API_KEY=key123, DEBUG=off
```

**Example 4: Path Expansion**

```env
Global: WORKSPACE_PATH=~/my-workspace

Result: WORKSPACE_PATH=/Users/john/my-workspace (expanded)
         (Same behavior on Windows with home directory)
```

---

## Implementation Details

### 1. envBuilder.ts: Environment Construction

**File**: `src/main/process-manager/utils/envBuilder.ts`

#### Function: `buildPtyTerminalEnv()`

Builds the environment for PTY (terminal) sessions:

```typescript
export function buildPtyTerminalEnv(shellEnvVars?: Record<string, string>): NodeJS.ProcessEnv;
```

**Behavior**:

- Windows: Inherits full parent process environment + TERM setting
- Unix: Creates minimal clean environment with HOME, USER, SHELL, TERM, LANG
- Unix: Builds expanded PATH including Node version managers (nvm, fnm, etc.)
- Applies custom `shellEnvVars` on top with `~/` path expansion

**Variable Stripping**: None for terminals (full environment inherited)

#### Function: `buildChildProcessEnv()`

Builds the environment for child processes (agents):

```typescript
export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	globalShellEnvVars?: Record<string, string>
): NodeJS.ProcessEnv;
```

**Behavior** (in order):

1. Starts with full parent process environment
2. Strips problematic variables (see Variable Stripping section below)
3. Sets PATH to expanded path (includes Node managers)
4. Applies global shell env vars from Settings
5. Applies session-level custom env vars (highest priority)

**Variable Stripping**: Removes Electron/IDE-specific variables that interfere with agent authentication

### 2. Variable Stripping: Why It's Necessary

**Stripped Variables** (in `STRIPPED_ENV_VARS`):

```typescript
('ELECTRON_RUN_AS_NODE',
	'ELECTRON_NO_ASAR',
	'ELECTRON_EXTRA_LAUNCH_ARGS',
	'CLAUDECODE', // VSCode Claude Code marker
	'CLAUDE_CODE_ENTRYPOINT', // Claude Code extension
	'CLAUDE_AGENT_SDK_VERSION', // SDK version flag
	'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', // Checkpoint flag
	'NODE_ENV'); // Maestro's NODE_ENV shouldn't leak
```

**Why**: These variables can cause agents to misidentify their execution context:

- Electron markers may make CLI tools think they're running inside Electron
- IDE extensions markers may make agents use IDE-specific credentials
- This breaks agent authentication and causes API failures

### 3. IPC Handler: Loading Global Variables

**File**: `src/main/ipc/handlers/process.ts`

**Handler Pattern**:

```typescript
// Load global shell env vars for all process types
const globalShellEnvVars = settingsStore.get('shellEnvVars', {});

const config = {
	toolType,
	sessionId,
	shellEnvVars: globalShellEnvVars, // Now applies to agents too
	// ... other config
};

await processManager.spawn(config);
```

**Key Change**: Previously, `shellEnvVars` was only passed to terminal processes. Now it's passed to ALL process types (agents, terminals, commands).

### 4. ChildProcessSpawner: Extracting Variables

**File**: `src/main/process-manager/spawners/ChildProcessSpawner.ts`

**Pattern**:

```typescript
const env = buildChildProcessEnv(
	config.sessionCustomEnvVars, // Session overrides (highest)
	config.isResuming,
	config.shellEnvVars // Global vars (from Settings)
);

spawn(command, args, { env });
```

---

## Configuration Storage

### Electron Store Path

**Location**: `~/.config/Maestro/` (Linux/Mac) or `%APPDATA%\Maestro\` (Windows)

**Store Key**: `shellEnvVars`

**Type**: `Record<string, string>`

**Persistence Path**:

```json
electron-store
  → shellEnvVars: {
      "API_KEY": "sk-proj-xxxxx",
      "PROXY_URL": "http://proxy.local:8080",
      "DEBUG": "maestro:*"
    }
```

### Related Settings

```typescript
// All stored in electron-store together
{
  "shellEnvVars": {...},           // Global env vars (NEW feature)
  "defaultShell": "zsh",           // Default shell name
  "customShellPath": "",           // Custom shell path override
  "shellArgs": "--login"           // Args for all shell sessions
}
```

---

## Breaking Changes

**None**. This is fully backward compatible:

- Existing code without global env vars continues to work
- New `globalShellEnvVars` parameter is optional in `buildChildProcessEnv()`
- Default value is `undefined`, which skips the merging step
- Session-level overrides still work as before
- Terminal behavior unchanged (already had global support)

---

## Future Considerations

### Potential Improvements

1. **Environment Variable Validation**
   - Validate format before storage (KEY=VALUE syntax)
   - Warn about potentially dangerous variable names
   - Suggest common patterns (API_KEY, PROXY_URL, etc.)

2. **UI for Debugging**
   - Add "View Applied Environment" button in agent settings
   - Show final merged environment for preview
   - Highlight precedence chain (which vars override which)

3. **Environment Variable Templates**
   - Pre-populated templates for common services (OpenAI, Anthropic, etc.)
   - One-click setup for API key variables
   - Documentation links for each template

4. **Secret Management**
   - Integration with system keychain (macOS/Windows/Linux)
   - Encrypted storage option for sensitive variables
   - "Mask" UI showing ••••• instead of actual values

5. **Environment Profiles**
   - Multiple environment configurations (Development, Staging, Production)
   - Quick switching between profiles
   - Per-profile environment variables

6. **Inheritance & Organization**
   - Environment groups (Database, API Keys, Debug, etc.)
   - Comments and documentation fields
   - Search/filter in settings

---

## File Locations Reference

### Core Implementation

| File                                                       | Purpose                            |
| ---------------------------------------------------------- | ---------------------------------- |
| `src/main/process-manager/utils/envBuilder.ts`             | Environment construction functions |
| `src/main/process-manager/spawners/ChildProcessSpawner.ts` | Agent spawning with env merging    |
| `src/main/process-manager/spawners/PtySpawner.ts`          | Terminal spawning with env         |
| `src/main/ipc/handlers/process.ts`                         | IPC handler loading global vars    |

### Settings & Storage

| File                                        | Purpose                   |
| ------------------------------------------- | ------------------------- |
| `src/main/stores/types.ts`                  | MaestroSettings interface |
| `src/main/stores/defaults.ts`               | Default settings values   |
| `src/main/stores/instances.ts`              | Store initialization      |
| `src/main/preload/settings.ts`              | IPC bridge for settings   |
| `src/renderer/stores/settingsStore.ts`      | Zustand renderer store    |
| `src/renderer/components/SettingsModal.tsx` | Settings UI component     |

### Testing

| File                                                          | Purpose           |
| ------------------------------------------------------------- | ----------------- |
| `src/main/process-manager/utils/__tests__/envBuilder.test.ts` | Unit tests        |
| `src/__tests__/integration/process-global-env-vars.test.ts`   | Integration tests |

---

## Testing Strategy

### Unit Tests

- Verify precedence order (session > global > defaults)
- Test path expansion (`~/` → home directory)
- Verify variable stripping (Electron vars removed)
- Test empty/undefined parameter handling

### Integration Tests

- Verify global vars reach spawned terminal
- Verify global vars reach spawned agent
- Verify session vars override global vars
- Verify vars persist across settings reload

### Manual Testing

1. Set global env var: `TEST_VAR=hello`
2. Spawn terminal: `echo $TEST_VAR` → shows `hello`
3. Spawn agent: Agent receives `TEST_VAR` in environment
4. Override with session var: Takes precedence
5. Restart Maestro: Settings persist

---

## Summary

The global environment variables system provides:

✓ **Centralized configuration** - Set once, apply everywhere  
✓ **Clean precedence** - Session > Global > Defaults  
✓ **Backward compatible** - No breaking changes  
✓ **Secure** - Strips problematic Electron/IDE variables  
✓ **Flexible** - Supports all process types  
✓ **Expandable** - Future improvements planned

Users can now confidently manage API keys, proxy settings, and tool paths from a single, persistent location.

<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# CLI & Playbooks

Command-line interface, playbook system, batch processing, and agent spawning for headless Maestro automation.

---

## Overview

The Maestro CLI (`maestro-cli`) provides command-line access to agents, playbooks, and session data without requiring the desktop Electron app to be running. It reads Electron Store JSON files directly from disk and spawns agent CLIs (Claude Code, Codex, OpenCode, Factory Droid) as child processes.

### Architecture

```text
src/cli/
├── index.ts                # Entry point (Commander.js program)
├── commands/               # Command implementations
│   ├── auto-run.ts
│   ├── clean-playbooks.ts
│   ├── create-agent.ts       # Create agent via WebSocket (requires running app)
│   ├── create-ssh-remote.ts  # Create SSH remote via disk I/O
│   ├── list-agents.ts
│   ├── list-groups.ts
│   ├── list-playbooks.ts
│   ├── list-sessions.ts
│   ├── list-ssh-remotes.ts   # List SSH remotes via disk I/O
│   ├── open-file.ts
│   ├── refresh-auto-run.ts
│   ├── refresh-files.ts
│   ├── remove-agent.ts       # Remove agent via WebSocket (requires running app)
│   ├── remove-ssh-remote.ts  # Remove SSH remote via disk I/O
│   ├── run-playbook.ts
│   ├── send.ts
│   ├── settings-agent.ts
│   ├── settings-get.ts
│   ├── settings-list.ts
│   ├── settings-reset.ts
│   ├── settings-set.ts
│   ├── show-agent.ts
│   ├── show-playbook.ts
│   └── status.ts
├── services/               # Business logic
│   ├── agent-sessions.ts    # Read Claude Code session files
│   ├── agent-spawner.ts     # Spawn agent CLIs
│   ├── batch-processor.ts   # Playbook execution engine
│   ├── maestro-client.ts    # IPC client to running Maestro desktop app
│   ├── playbooks.ts         # Playbook file management
│   └── storage.ts           # Electron Store file reader + SSH remote helpers
└── output/                 # Output formatting
    ├── formatter.ts         # Human-readable terminal output (incl. SSH remote tables)
    └── jsonl.ts             # Machine-parseable JSON Lines
```

Note: `run-playbook.ts` is the file name, but the command is registered under the `playbook` verb (see entry point). Additional commands (`auto-run`, `open-file`, `refresh-*`, `settings-*`, `status`) are lightweight wrappers over `maestro-client.ts` for talking to a running desktop app.

### Shared Code with Desktop

The CLI imports directly from `src/shared/` and some `src/main/` modules:

- **Shared types**: `src/shared/types.ts` (SessionInfo, Group, Playbook, UsageStats)
- **Agent definitions**: `src/main/agents/definitions.ts` (binary names, capabilities)
- **Output parsers**: `src/main/parsers/` (Claude, Codex, OpenCode, Factory Droid)
- **Template variables**: `src/shared/templateVariables.ts`
- **Prompt templates**: `src/prompts/` (auto-run prompts)

The CLI avoids Electron-specific imports (no `electron`, no `electron-store`, no IPC).

---

## Entry Point

File: `src/cli/index.ts`

Built with [Commander.js](https://github.com/tj/commander.js). The CLI reads its version from `package.json` at runtime.

```bash
maestro-cli [command] [options]
```

---

## Commands

### `list groups`

List all session groups.

```bash
maestro-cli list groups [--json]
```

### `list agents`

List all agents (sessions in Maestro terminology).

```bash
maestro-cli list agents [-g, --group <id>] [--json]
```

Options:

- `--group <id>` - Filter by group ID (supports partial IDs)
- `--json` - Output as JSON Lines

### `list playbooks`

List playbooks, optionally filtered by agent.

```bash
maestro-cli list playbooks [-a, --agent <id>] [--json]
```

### `list sessions <agent-id>`

List agent provider sessions (Claude Code sessions, etc.) with pagination and search.

```bash
maestro-cli list sessions <agent-id> [-l, --limit <count>] [-k, --skip <count>] [-s, --search <keyword>] [--json]
```

Options:

- `--limit <count>` - Max sessions to show (default: 25)
- `--skip <count>` - Pagination offset (default: 0)
- `--search <keyword>` - Filter by name or first message content

### `show agent <id>`

Show detailed agent information including history and usage stats.

```bash
maestro-cli show agent <id> [--json]
```

### `show playbook <id>`

Show detailed playbook information.

```bash
maestro-cli show playbook <id> [--json]
```

### `playbook <playbook-id>`

Run a playbook (batch execution of Auto Run documents).

```bash
maestro-cli playbook <playbook-id> [--dry-run] [--no-history] [--json] [--debug] [--verbose] [--wait]
```

Options:

- `--dry-run` - Show what would be executed without running
- `--no-history` - Skip writing history entries
- `--json` - Output as JSON Lines (machine-parseable)
- `--debug` - Detailed debug output
- `--verbose` - Show full prompt sent to agent on each iteration
- `--wait` - Wait for agent to become available if busy

This command is lazy-loaded to avoid eager resolution of prompt templates.

### `send <agent-id> <message>`

Send a message to an agent and receive a JSON response. Supports multi-turn conversations via session resumption.

```bash
maestro-cli send <agent-id> <message> [-s, --session <id>]
```

Options:

- `--session <id>` - Resume an existing agent session for multi-turn conversations

Response format:

```json
{
	"agentId": "agent-abc-123",
	"agentName": "My Agent",
	"sessionId": "session-xyz-789",
	"response": "Agent's response text",
	"success": true,
	"usage": {
		"inputTokens": 1000,
		"outputTokens": 500,
		"cacheReadInputTokens": 200,
		"cacheCreationInputTokens": 100,
		"totalCostUsd": 0.05,
		"contextWindow": 200000,
		"contextUsagePercent": 1
	}
}
```

### `clean playbooks`

Remove orphaned playbooks for deleted sessions.

```bash
maestro-cli clean playbooks [--dry-run] [--json]
```

### `create-agent <name>`

Create a new agent in the running Maestro desktop app via WebSocket (`withMaestroClient`). Sends a `create_session` message with optional config fields that flow through the full IPC pipeline (messageHandlers → CallbackRegistry → web-server-factory → preload → useRemoteIntegration → useAppRemoteEventListeners).

```bash
maestro-cli create-agent <name> -d <cwd> [-t <type>] [-g <group-id>] [--nudge <msg>] [--new-session-message <msg>] [--custom-path <path>] [--custom-args <args>] [--env KEY=VALUE]... [--model <model>] [--effort <level>] [--context-window <size>] [--provider-path <path>] [--ssh-remote <id>] [--ssh-cwd <path>] [--json]
```

Options:

- `--cwd <path>` - Working directory (required)
- `--type <type>` - Agent type, validated against `AGENT_IDS` (default: `claude-code`)
- `--env KEY=VALUE` - Repeatable environment variable; parsed into a `Record<string, string>`
- `--context-window <size>` - Validated as positive integer
- `--ssh-remote <id>` + `--ssh-cwd <path>` - Builds `sessionSshRemoteConfig` for remote execution

### `remove-agent <agent-id>`

Remove an agent via WebSocket (`withMaestroClient`). Sends a `delete_session` message. Supports partial ID matching via `resolveAgentId()`.

```bash
maestro-cli remove-agent <agent-id> [--json]
```

### `list ssh-remotes`

List all configured SSH remotes. Reads directly from `maestro-settings.json` via `readSshRemotes()` — no running app required.

```bash
maestro-cli list ssh-remotes [--json]
```

### `create-ssh-remote <name>`

Create a new SSH remote configuration. Direct disk I/O via `readSshRemotes()`/`writeSshRemotes()`.

```bash
maestro-cli create-ssh-remote <name> -H <host> [-p <port>] [-u <user>] [-k <key-path>] [--env KEY=VALUE]... [--ssh-config] [--disabled] [--set-default] [--json]
```

Options:

- `--host <host>` - Hostname or IP (required)
- `--port <port>` - Validated range 1-65535 (default: 22)
- `--ssh-config` - Use `~/.ssh/config` mode; host becomes the Host pattern
- `--set-default` - Writes `defaultSshRemoteId` to settings
- `--env KEY=VALUE` - Repeatable remote environment variable

Generates a UUID via `crypto.randomUUID()` for the remote ID.

### `remove-ssh-remote <remote-id>`

Remove an SSH remote configuration. Supports partial ID matching via `resolveSshRemoteId()`. Clears `defaultSshRemoteId` if the removed remote was the default.

```bash
maestro-cli remove-ssh-remote <remote-id> [--json]
```

---

## ID Resolution

All commands that take agent, group, playbook, or SSH remote IDs support **partial ID matching**:

1. Try exact match first
2. Try prefix match - if exactly one ID starts with the input, use it
3. If multiple prefix matches, show the ambiguous list and exit
4. If no match, show "not found" error

```bash
# Full ID
maestro-cli show agent abc12345-def6-7890-abcd-ef1234567890

# Partial ID (if unambiguous)
maestro-cli show agent abc1
```

---

## Storage Service

File: `src/cli/services/storage.ts`

Reads Electron Store JSON files directly from disk. No Electron dependency.

### Config Directory Paths

```text
macOS:   ~/Library/Application Support/Maestro/
Windows: %APPDATA%/Maestro/
Linux:   $XDG_CONFIG_HOME/Maestro/ (or ~/.config/Maestro/)
```

### Store Files

| File                         | Content                          |
| ---------------------------- | -------------------------------- |
| `maestro-sessions.json`      | Agent sessions                   |
| `maestro-groups.json`        | Session groups                   |
| `maestro-settings.json`      | User settings                    |
| `maestro-agent-configs.json` | Per-agent custom paths/args      |
| `maestro-history.json`       | History entries (legacy format)  |
| `history/*.json`             | Per-session history (new format) |
| `playbooks/*.json`           | Per-session playbook definitions |

### Key Functions

```typescript
readSessions(): SessionInfo[]
readGroups(): Group[]
readSettings(): SettingsStore
readAgentConfigs(): Record<string, Record<string, unknown>>
readHistory(projectPath?, sessionId?): HistoryEntry[]
readHistoryPaginated(options?): PaginatedResult<HistoryEntry>
addHistoryEntry(entry: HistoryEntry): void

resolveAgentId(partialId: string): string   // throws on ambiguous/not found
resolveGroupId(partialId: string): string
resolveSshRemoteId(partialId: string): string  // throws on ambiguous/not found
getSessionById(sessionId: string): SessionInfo | undefined
getSessionsByGroup(groupId: string): SessionInfo[]
getAgentCustomPath(agentId: string): string | undefined
getConfigDirectory(): string
readSshRemotes(): SshRemoteConfig[]
writeSshRemotes(remotes: SshRemoteConfig[]): void
```

### History Migration

The CLI supports both legacy (single `maestro-history.json`) and new (per-session `history/*.json`) formats. It checks for a `history-migrated.json` marker file to determine which format to use.

---

## Agent Spawner

File: `src/cli/services/agent-spawner.ts`

Spawns agent CLIs as child processes and parses their output.

### Supported Agents

| Agent         | Binary     | Output Format                              |
| ------------- | ---------- | ------------------------------------------ |
| Claude Code   | `claude`   | `stream-json` (newline-delimited JSON)     |
| Codex         | `codex`    | Custom parser (`CodexOutputParser`)        |
| OpenCode      | `opencode` | Custom parser (`OpenCodeOutputParser`)     |
| Factory Droid | `droid`    | Custom parser (`FactoryDroidOutputParser`) |

### Agent Detection

`detectAgent(toolType)` resolves the agent binary path:

1. Check cached path (resolved once per session)
2. Check custom path from user settings (`maestro-agent-configs.json`)
3. Fall back to `which`/`where` PATH detection (with expanded PATH including common install locations)

```typescript
const result = await detectAgent('claude-code');
// { available: true, path: '/usr/local/bin/claude', source: 'path' }
```

### Spawning

```typescript
const result = await spawnAgent(
	'claude-code',
	'/path/to/project',  // cwd
	'Write a function that...',  // prompt
	'session-uuid'       // optional: resume existing session
);

// AgentResult:
{
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
}
```

### Claude Code Spawn Details

Claude Code uses `--print --verbose --output-format stream-json --dangerously-skip-permissions`:

- Fresh sessions get `--session-id <new-uuid>` to prevent context bleeding
- Session resumption uses `--resume <session-id>`
- Output is newline-delimited JSON with `type: 'result'` for final response
- Usage stats are aggregated from `modelUsage` / `usage` / `total_cost_usd` events

### Non-Claude Agents

Codex, OpenCode, and Factory Droid use the shared `AgentOutputParser` interface from `src/main/parsers/`. The spawner detects the agent type, selects the correct parser, and parses stdout/stderr into an `AgentResult`.

### CLI vs Desktop Spawning

The CLI spawner is simpler than the desktop process manager:

- No SSH wrapping (remote execution not supported)
- No custom model, args, or env var overrides
- No PTY (uses plain child_process spawn)
- No real-time output streaming to UI
- Designed for headless batch execution

---

## Playbook System

### What is a Playbook?

A playbook is a saved Auto Run configuration: an ordered list of Markdown documents with a prompt template. Running a playbook iterates through each document's tasks, sending each to the agent.

### Playbook Storage

File: `src/cli/services/playbooks.ts`

Playbooks are stored in `<config-dir>/playbooks/<session-id>.json`:

```json
{
	"playbooks": [
		{
			"id": "uuid-string",
			"name": "Backend Migration",
			"documents": [
				{ "path": "phase-01-setup.md", "enabled": true },
				{ "path": "phase-02-migrate.md", "enabled": true }
			],
			"prompt": "Complete the tasks in this document...",
			"loopEnabled": false,
			"maxLoops": null,
			"createdAt": 1700000000000,
			"updatedAt": 1700000000000
		}
	]
}
```

### Playbook Resolution

```typescript
import { readPlaybooks, getPlaybook, resolvePlaybookId } from './playbooks';

// Read all playbooks for a session
const playbooks = readPlaybooks(sessionId);

// Get a specific playbook (exact or prefix match)
const playbook = getPlaybook(sessionId, 'abc123');

// Resolve across all sessions (for `maestro-cli playbook <id>`)
const { playbook, sessionId } = findPlaybookAcrossAgents(playbookId);
```

---

## Batch Processor

File: `src/cli/services/batch-processor.ts`

The core execution engine for running playbooks. It yields JSONL events as an async generator.

### Execution Flow

```text
1. Register CLI activity (notifies desktop app)
2. For each document in playbook:
   a. Read document content
   b. Parse tasks (markdown checkboxes)
   c. For each unchecked task:
      i.   Build prompt (template variables + task content)
      ii.  Spawn agent with prompt
      iii. Parse response
      iv.  Mark task as complete in document
      v.   Yield task_complete event
   d. Yield document_complete event
3. Optional: loop back to first document
4. Generate synopsis (summary of all work done)
5. Write history entry
6. Yield complete event
7. Unregister CLI activity
```

### Template Variables

Prompts support template variables substituted at runtime via `src/shared/templateVariables.ts`:

- `{{document}}` - Current document content
- `{{task}}` - Current task text
- `{{gitBranch}}` - Current git branch
- `{{groupName}}` - Agent's group name
- `{{projectPath}}` - Working directory

### JSONL Event Types

The batch processor outputs machine-parseable JSON Lines events (defined in `src/cli/output/jsonl.ts`):

| Event               | Fields                                                                   | Description                 |
| ------------------- | ------------------------------------------------------------------------ | --------------------------- |
| `start`             | `playbook`, `session`                                                    | Batch run started           |
| `document_start`    | `document`, `index`, `taskCount`                                         | Starting a document         |
| `task_start`        | `document`, `taskIndex`                                                  | Starting a task             |
| `task_complete`     | `document`, `taskIndex`, `success`, `summary`, `elapsedMs`, `usageStats` | Task finished               |
| `document_complete` | `document`, `tasksCompleted`                                             | All tasks in document done  |
| `loop_complete`     | `iteration`                                                              | One loop iteration finished |
| `synopsis`          | `text`, `sessionId`                                                      | AI-generated summary        |
| `history`           | `entry`                                                                  | History entry written       |
| `complete`          | `documentsProcessed`, `tasksCompleted`, `totalElapsedMs`, `totalCost`    | Batch run finished          |
| `error`             | `message`, `document?`, `taskIndex?`                                     | Error occurred              |
| `skipped`           | `reason`                                                                 | Task or document skipped    |
| `waiting`           | `reason`                                                                 | Waiting for agent           |

### Synopsis Generation

After all tasks complete, the batch processor spawns the agent one more time to generate a synopsis (summary of work done). This uses a special prompt from `src/prompts/` and the same agent session for context continuity. The synopsis is parsed for structured data (title, description, files changed).

### CLI Activity Registration

The batch processor registers its activity via `src/shared/cli-activity.ts` so the desktop app knows the session is busy:

```typescript
registerCliActivity({
	sessionId: session.id,
	playbookId: playbook.id,
	playbookName: playbook.name,
	startedAt: Date.now(),
	pid: process.pid,
});

// ... after completion:
unregisterCliActivity({ sessionId: session.id });
```

---

## Agent Sessions Service

File: `src/cli/services/agent-sessions.ts`

Reads Claude Code session files directly from disk (JSONL format) without Electron dependencies. Used by `list sessions` command.

### Session Info Extracted

```typescript
interface AgentSessionInfo {
	sessionId: string;
	sessionName?: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	sizeBytes: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
	origin?: string;
	starred?: boolean;
}
```

The service reads the Origins Store (`claude-origins.json`) to retrieve session names, starred status, and origin metadata set by the desktop app.

---

## Output Formatting

### Human-Readable (`formatter.ts`)

File: `src/cli/output/formatter.ts`

ANSI-colored terminal output with:

- Color support detection (`process.stdout.isTTY`)
- Bold, dim, and colored text helpers
- Truncation for long strings
- Formatted tables for groups, agents, playbooks

### JSON Lines (`jsonl.ts`)

File: `src/cli/output/jsonl.ts`

Machine-parseable output format. Each line is a complete JSON object. Used when `--json` flag is passed. Enables piping to `jq`, scripting, and integration with other tools.

---

## Key Files Reference

| Concern             | Primary Files                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- |
| CLI entry point     | `src/cli/index.ts`                                                                     |
| Storage reader      | `src/cli/services/storage.ts`                                                          |
| Agent spawner       | `src/cli/services/agent-spawner.ts`                                                    |
| Batch processor     | `src/cli/services/batch-processor.ts`                                                  |
| Playbook management | `src/cli/services/playbooks.ts`                                                        |
| Agent sessions      | `src/cli/services/agent-sessions.ts`                                                   |
| Desktop IPC client  | `src/cli/services/maestro-client.ts`                                                   |
| Human output        | `src/cli/output/formatter.ts`                                                          |
| JSONL output        | `src/cli/output/jsonl.ts`                                                              |
| Send command        | `src/cli/commands/send.ts`                                                             |
| Run playbook        | `src/cli/commands/run-playbook.ts`                                                     |
| Create agent        | `src/cli/commands/create-agent.ts`                                                     |
| Remove agent        | `src/cli/commands/remove-agent.ts`                                                     |
| SSH remote CRUD     | `src/cli/commands/create-ssh-remote.ts`, `list-ssh-remotes.ts`, `remove-ssh-remote.ts` |
| Shared types        | `src/shared/types.ts`                                                                  |
| Template variables  | `src/shared/templateVariables.ts`                                                      |
| Agent definitions   | `src/main/agents/definitions.ts`                                                       |
| Agent IDs           | `src/shared/agentIds.ts`                                                               |
| CLI activity        | `src/shared/cli-activity.ts`                                                           |
| Prompt templates    | `src/prompts/`                                                                         |

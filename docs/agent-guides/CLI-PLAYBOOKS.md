<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# CLI & Playbooks

Command-line interface, playbook system, batch processing, and agent spawning for headless Maestro automation.

Before adding a command that mirrors something a user does by clicking, read
[CLI-UI-PARITY.md](CLI-UI-PARITY.md): it records which UI actions are already
scriptable, which are not, and the one write path (`update_session_config`) that
new per-agent and per-tab state should go through.

---

## Overview

The Maestro CLI (`maestro-cli`) provides command-line access to agents, playbooks, and session data without requiring the desktop Electron app to be running. It reads Electron Store JSON files directly from disk and spawns agent CLIs (Claude Code, Codex, OpenCode, Factory Droid) as child processes.

### Architecture

```text
src/cli/
├── index.ts                # Entry point (Commander.js program; exports `program`, parses unless under a test runner)
├── command-examples.ts     # The example registry: one entry per verb, shown by --help and `reference`
├── exit-codes.ts           # ExitCode, exitWith(), exitCodeForError()
├── commands/               # Command implementations
│   ├── auto-run.ts
│   ├── clean-playbooks.ts
│   ├── create-agent.ts       # Create agent via WebSocket (requires running app)
│   ├── create-worktree.ts    # Create worktree agent off a parent via WebSocket (requires running app)
│   ├── create-ssh-remote.ts  # Create SSH remote via disk I/O
│   ├── goal-run.ts            # Goal-Driven Auto Run (free-text objective)
│   ├── list-agents.ts
│   ├── list-groups.ts
│   ├── list-playbooks.ts
│   ├── list-sessions.ts
│   ├── list-ssh-remotes.ts   # List SSH remotes via disk I/O
│   ├── open-file.ts
│   ├── refresh-auto-run.ts
│   ├── refresh-files.ts
│   ├── remove-agent.ts       # Remove agent via WebSocket (requires running app)
│   ├── update-agent.ts       # Move agent to group / change cwd via WebSocket (requires running app)
│   ├── update-ssh-remote.ts  # Edit an SSH remote via disk I/O
│   ├── remove-ssh-remote.ts  # Remove SSH remote via disk I/O
│   ├── run-playbook.ts
│   ├── run-doc.ts            # Run raw Auto Run docs headlessly (no saved playbook)
│   ├── send.ts
│   ├── settings-agent.ts
│   ├── settings-get.ts
│   ├── settings-list.ts
│   ├── settings-reset.ts
│   ├── settings-set.ts
│   ├── show-agent.ts
│   ├── show-playbook.ts
│   ├── status.ts
│   ├── agent-test-run-on.ts   # Run on Test button (agent test-run-on)
│   ├── delegation-graph.ts    # Read the Delegation Graph (no app needed)
│   ├── group-settings.ts      # Read a group's defaults; update-group-settings.ts writes them
│   ├── models-*.ts            # manage, assign, run, status, index, proxy, server, tiers, config, runtimes, endpoints
│   ├── search.ts              # Search past work: text, or --semantic
│   ├── stats.ts               # stats, and stats models (the Models tab as data)
│   ├── system-one*.ts         # s1: engine, key, ledger, route, usage, and the verbs agents ask with
│   └── voice*.ts              # voice: session, HUD, providers, credentials, devices, wake word
├── services/               # Business logic
│   ├── agent-busy.ts        # Shared busy-state check (desktop + CLI activity)
│   ├── agent-sessions.ts    # Read Claude Code session files
│   ├── agent-busy.ts        # Busy-state checks + --wait loop (shared by playbook/run-doc)
│   ├── agent-spawner.ts     # Spawn agent CLIs
│   ├── batch-processor.ts   # Playbook (Spec-Driven) execution engine
│   ├── goal-runner.ts       # Goal-Driven Auto Run engine (shared goalDriven core)
│   ├── maestro-client.ts    # IPC client to running Maestro desktop app
│   ├── maestro-bridge-errors.ts # MaestroNotRunningError / UnsupportedCommandError / CommandTimeoutError (no imports)
│   ├── session-command.ts   # Shared helpers for desktop-driving commands (see below)
│   ├── agent-setting-flags.ts # The per-agent setting flags shared by create-agent, update-agent, update-group-settings
│   ├── peer-flags.ts        # --peer / --peer-note / --remove-peer / --group-peers / --worktree-peers
│   ├── playbooks.ts         # Playbook file management
│   └── storage.ts           # Electron Store file reader + SSH remote helpers
├── utils/                  # Argument parsing shared by commands
│   ├── confirm.ts           # confirmOnTerminal() / canPrompt(): a yes/no only when both ends are a terminal
│   └── parse.ts             # parseCliBool / isInheritValue (one vocabulary for every verb)
└── output/                 # Output formatting
    ├── formatter.ts         # Human-readable terminal output (incl. SSH remote tables)
    └── jsonl.ts             # Machine-parseable JSON Lines
```

Note: `run-playbook.ts` is the file name, but the command is registered under the `playbook` verb (see entry point). Additional commands (`auto-run`, `open-file`, `refresh-*`, `settings-*`, `status`) are lightweight wrappers over `maestro-client.ts` for talking to a running desktop app.

**Adding a desktop-driving command? Reuse `services/session-command.ts` first.** Most commands that mutate a running app follow one shape: resolve an agent, send a single `{ type, sessionId, ... }` WS message, expect a `{ success, error? }` reply, then report it (JSON or human-readable) and exit non-zero on failure. `session-command.ts` centralizes that:

- `runAgentCommand(agentId, options, build)` - the one-liner path: resolves the agent (partial IDs), sends the message `build()` describes, reports the result. Used by `rename-agent`, `auto-run-control` (stop/resume/skip/abort/reset), `remove-playbook`, `agent-control` (focus/switch-mode).
- `sendSimpleCommand(payload, responseType)` + `reportResult(result, opts)` + `failCommand(msg, json, code?)` - the building blocks, for commands that don't key off an agent ID (e.g. `rename-group` uses `resolveGroupId`; `set-theme`/`encore` send `set_setting`).
- `sendBridgeCommand<T>(payload, responseType, json, timeoutMs?)` - one round trip for a verb that needs the reply's fields. A transport failure exits with its own code (see Exit codes and failures below), and a reply the app marked `success: false` exits with its error, so the caller only ever reads a reply that succeeded. `s1`, `voice`, `models` and `group-settings` are built on it.
- `failFromError(error, json)` - the one spelling of `catch (error) { ... }`: prints the error and exits with `exitCodeForError(error)`.
- `resolveAgentOrFail(agentId, json)` - resolve-or-exit helper.
- `resolveTabEntry(tabId, agentHint?)` - resolve one desktop tab via `list_desktop_sessions` and return its whole `DesktopTabEntry` (`src/shared/desktopTabs.ts`). Accepts an exact ID, a unique prefix, or the literal `active` - the tab that `agentHint`'s agent has selected, or the desktop's focused agent (`readActiveAgentId()`) when no hint is given. Use it rather than matching IDs yourself: a verb that has to read before it writes (`tab show`, `tab thinking cycle`) gets the current settings from the same call that resolved the tab, instead of a second round trip or a value the caller guessed.
- `resolveTabOwner(tabId, agentHint?)` - thin wrapper over `resolveTabEntry` for the verbs that only need `{ agentId, tabId }`.

Do NOT re-implement the withMaestroClient + sendCommand + JSON/text + exit boilerplate in a new command file, and do not write a private `fail()`, `send()` or `emitError()`: 28 such copies were collapsed into `failCommand()` and `sendBridgeCommand()`. Extend `session-command.ts` if your case needs a new shape.

**Exit codes and failures.** Every exit goes through `exitWith(ExitCode.*)` (`src/cli/exit-codes.ts`), never a bare `process.exit(n)`:

| Code  | `ExitCode`     | Meaning                                                                                                 |
| ----- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `0`   | `Success`      | Done                                                                                                    |
| `1`   | `GeneralError` | Uncategorized failure. Also the "no" of `s1 yes` and an answer under `--min-confidence`, never an error |
| `2`   | `InvalidUsage` | Unknown flag, bad argument, nothing to do, or a confirmation with no terminal and no `--yes`            |
| `3`   | `NotRunning`   | The desktop app is not running or not reachable                                                         |
| `4`   | `Unsupported`  | The running app is an older build without the command                                                   |
| `5`   | `Timeout`      | The app was reachable and did not answer in time                                                        |
| `6`   | `Refused`      | A switch or a budget declined the request (System One off, a task switched off). Do not retry           |
| `7`   | `NoAnswer`     | It ran and has no answer (engine failed, a task unavailable, a long job incomplete)                     |
| `130` | `Interrupted`  | The operator pressed Ctrl+C                                                                             |

`exitCodeForError(error)` maps a bridge failure to 3, 4 or 5 through the three error classes in `services/maestro-bridge-errors.ts` (a module with no imports, so loading it does not pull in the WebSocket client). The failure shape is one for every verb: a person reads `Error: <reason>` on stderr, and under `--json` a script reads `{"success":false,"error":"<reason>"}` on stdout. The only two raw exits left are in `maestro-client.ts`, which `exit-codes.ts` imports, so `exitWith` there would be a cycle.

**`--json` on every verb that returns data.** A verb that always prints JSON (`send`, `dispatch`, `queue`, `gist create`, `settings media-status`) still declares `--json`, as a documented no-op, so one flag works everywhere. Read verbs print `{ "success": true, ... }` where they are new; older verbs keep their record, array or JSONL shape.

**Parsing an argument? Use `utils/parse.ts`.** `parseCliBool(value, flag)` is the one boolean vocabulary (`true/false`, `1/0`, `yes/no`, `on/off`, case-insensitive) - three near-identical copies had already drifted on whether they accepted `on`/`off`. `isInheritValue(value)` recognizes the words that clear an override (`inherit`, `default`, `none`, `clear`, `unset`, empty) so a per-tab or per-agent value falls back to what it inherits. Clearing is not the same as `false`: `tab enter-to-send <id> false` pins the tab to Cmd+Enter, while `inherit` returns it to the global `enterToSendAI` setting.

### Shared Code with Desktop

The CLI imports directly from `src/shared/` and some `src/main/` modules:

- **Shared types**: `src/shared/types.ts` (SessionInfo, Group, Playbook, UsageStats)
- **Agent definitions**: `src/main/agents/definitions.ts` (binary names, capabilities)
- **Output parsers**: `src/main/parsers/` (Claude, Codex, OpenCode, Factory Droid)
- **Template variables**: `src/shared/templateVariables.ts`
- **Prompt templates**: `src/prompts/` (auto-run prompts)
- **Goal-Driven core**: `src/shared/goalDriven/` (marker parsing + exit evaluation shared by the CLI `goal-runner` and the desktop `useGoalRunner` hook)

The CLI avoids Electron-specific imports (no `electron`, no `electron-store`, no IPC).

---

## Entry Point

File: `src/cli/index.ts`

Built with [Commander.js](https://github.com/tj/commander.js). The CLI reads its version from `package.json` at runtime.

```bash
maestro-cli [command] [options]
```

`src/cli/index.ts` exports `program` and does not call `program.parse()` under a test runner (`process.env.VITEST`), so a test can walk the live command tree.

### Help, examples, and `reference`

Every verb ends its `--help` with an `Examples:` block, and `maestro-cli reference` prints the same lines under each command (`--format json` carries them as `examples`). They come from one registry, `COMMAND_EXAMPLES` in `src/cli/command-examples.ts`, keyed by the command path without the program name (`models server start`). `applyCommandExamples(program)` attaches each entry with `addHelpText('after', ...)` before parse.

**Adding a verb means adding its entry.** `src/__tests__/cli/command-tree.test.ts` walks the registered tree and fails when a command has no description, when a runnable command (a leaf, or a group with an action) has no example, when a registry key names a command that does not exist, when an example does not start at `maestro-cli` or resolves to a different command than the one it is filed under, or when it uses a flag the command does not declare. It is structural: whether the example's values make sense on a given machine is not checked.

`docs/cli-reference.md` is generated from `maestro-cli reference` (`npm run gen:cli-reference`, which also rebuilds the CLI bundle). Regenerating destroys hand edits, so check the diff before committing: the generator keeps the usage notes it carries in `scripts/gen-cli-reference.mjs`, and anything hand-written that is not there is lost.

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

### `image list` / `image save`

Reach the images a user pasted into a chat. An agent sees a pasted screenshot as pixels in its context and has no path to it, so writing one into the repo used to be a right-click only the human could perform (`ImageContextMenu` -> Save to Project).

```bash
maestro-cli image list [-a, --agent <id>] [-t, --tab <tab-id>] [--limit <n>] [--json]
maestro-cli image save [target] [-a <id>] [-t <tab-id>] [-o, --output <path>] [--all] [--force] [--json]
```

`target` is a 1-based index from `image list`, a content handle (leading hex of the sha256), or `latest` (the default).

Implementation notes:

- After writing, it calls `nudgeFileTreeForPaths()` so the Files panel picks the new file up instead of waiting for its next timed refresh. Best-effort by contract: the bytes are already on disk, so a closed desktop must not turn a good save into a failure. `--json` reports which agents were nudged as `refreshedAgents`.
- Reads the sessions file directly (`readSessions()`), not the running app, so it works with the desktop closed. Pasted images are relocated into the content-addressed store on persistence, so the transcript holds `maestro-image://store/<sha>.<ext>` refs that `resolveToBytesSync()` turns back into bytes. The cost is the renderer's 2s persistence debounce: an image pasted this instant may not be on disk yet.
- The written extension is derived from the resolved media type, never from the requested filename - the same rule `saveImageToProject()` follows in the renderer.
- `--all` always treats `--output` as a folder, so the same command cannot produce a directory on one conversation and a file on another.

### Shared CLI helpers worth reusing

Two things several verbs need, written once rather than per-command:

- **`resolveOwningAgent(absolutePath)`** in `src/cli/utils/owning-agent.ts` - which agent's workspace a path lives in. Every agent whose `cwd` contains the path is a candidate, the deepest `cwd` wins (nested worktrees), and a genuine tie goes to the most recently active by history-file mtime. It returns the losers as `others` so the caller can name what it picked and how to override. `open-file`, `open-graph`, and the `image save` refresh nudge all ride it; it had already been written out twice, byte for byte, before it was extracted.
- **`nudgeFileTreeForPaths(paths)` / `refreshFileTreeFor(sessionId)`** in `src/cli/services/file-tree-refresh.ts` - tell the desktop's Files panel to re-read a workspace. The quiet form never throws and never prints (the caller's write already succeeded); the loud form is what `refresh-files` reports on. Any new verb that writes a file into an agent's workspace should call the quiet one.

### `show agent <id>`

Show detailed agent information including history and usage stats, the environment the agent is spawned with, and its peers.

```bash
maestro-cli show agent <id> [--show-secrets] [--json]
```

- `effectiveEnv` is `resolveAgentEnvironment()` (`src/shared/agentEnvironment.ts`) over the global, agent (or tab session) and gateway layers: every variable the agent is spawned with, the layer that won (`source`), and the layers it overrode (`shadowedBy`). `parkedEnvVars` are the variables switched off with `update-agent --env-park`.
- Values whose key `isSecretEnvKey()` flags (and the same keys in `customEnvVars`) are masked with `maskEnvValue()` unless `--show-secrets` is passed, as `settings list` does.
- Reads the stored agent. It also prints the resolved peer roster (`peers`), the Run on target (`runOn`, `runOnSpec`) and each tier with where it came from.

### `show playbook <id>`

Show detailed playbook information.

```bash
maestro-cli show playbook <id> [--json]
```

### `playbook <playbook-id>`

Run a playbook (batch execution of Auto Run documents).

```bash
maestro-cli playbook <playbook-id> [--dry-run] [--no-history] [--json] [--debug] [--verbose] [--wait] [--model <model>] [--effort <effort>] [--ignore-model-hints]
```

Options:

- `--dry-run` - Show what would be executed without running
- `--no-history` - Skip writing history entries
- `--json` - Output as JSON Lines (machine-parseable)
- `--debug` - Detailed debug output
- `--verbose` - Show full prompt sent to agent on each iteration
- `--wait` - Wait for agent to become available if busy
- `--model <model>` / `--effort <effort>` - Run-scoped model/effort override (see [Per-run model override](#per-run-model-override))
- `--ignore-model-hints` - Skip the documents' `MAESTRO:MODEL` markers so every task runs at the run override or the agent default

This command is lazy-loaded to avoid eager resolution of prompt templates.

### `goal-run <agent-id> <goal>`

Launch a Goal-Driven Auto Run: instead of working through a checklist of documents (the `playbook` command), pursue a single free-text objective. Each iteration spawns a FRESH agent that makes one increment of progress, self-reports how far along it is via Maestro markers, and exits, repeating until the goal is reached, a deadlock is declared, the iteration limit is hit, or progress stalls.

```bash
maestro-cli goal-run <agent-id> "<goal>" [--exit-criteria <text>] [--max-iterations <n>] [--no-history] [--json] [--verbose] [--model <model>] [--effort <effort>]
```

Options:

- `--exit-criteria <text>` - What "done" looks like and when to declare a deadlock (guides the agent; not matched automatically)
- `--max-iterations <n>` - Cap iterations (default: infinite, bounded by `GOAL_RUN_HARD_ITERATION_CAP`)
- `--no-history` - Skip writing history entries
- `--json` - Output as JSON Lines (events: `goal_start`, `goal_iteration_start`, `goal_iteration_complete`, `goal_complete`)
- `--verbose` - Show full prompt sent to agent on each iteration
- `--model <model>` / `--effort <effort>` - Run-scoped model/effort override (see [Per-run model override](#per-run-model-override))

Implemented by `services/goal-runner.ts` (`runGoal`), the CLI counterpart to the desktop `useGoalRunner` hook. Both drive the SAME pure engine in `src/shared/goalDriven/*` (marker parsing + exit evaluation) so CLI and desktop behave identically. Like `playbook`, it is lazy-loaded, refuses to start when the agent is busy (`services/agent-busy.ts`), and threads per-agent SSH remote + model/effort/args/env overrides into every spawn.

### `run-doc <docs...>`

Run one or more raw Auto Run `.md` documents without a saved playbook. Mirrors `playbook` but builds an ephemeral `Playbook` on the fly (`src/cli/commands/run-doc.ts`), then drives it through the same `batch-processor` generator. Headless and self-contained - it does **not** route through the desktop renderer (unlike `auto-run --launch`), so it runs whether or not the Maestro window is open. This is the path group-chat participants use to execute a document they just wrote.

```bash
maestro-cli run-doc <docs...> --agent <id-or-name> [--prompt <text>] [--loop] [--max-loops <n>] [--reset-on-completion] [--dry-run] [--no-history] [--json] [--debug] [--verbose] [--no-synopsis] [--wait] [--model <model>] [--effort <effort>] [--ignore-model-hints]
```

- `-a, --agent <id>` (required) - target agent by ID (full/partial) or display name
- Document paths may be relative to the agent's Auto Run folder, relative to cwd, or absolute; all must share one folder, which becomes the run's `folderPath`.
- An empty `--prompt` falls back to the default Auto Run prompt (`PROMPT_IDS.AUTORUN_DEFAULT`), handled inside `batch-processor`.
- Busy-state detection and `--wait` are shared with `playbook` via `src/cli/services/agent-busy.ts` (`checkAgentBusy`, `waitForAgentAvailable`).

Note: `resolveAgentId()` in `src/cli/services/storage.ts` resolves `--agent` by ID first, then falls back to an exact case-insensitive display-name match, so name targeting works across `run-doc`, `playbook` lookups, `list playbooks`, and `auto-run`.

### Per-run model override

`--model <model>` and `--effort <effort>` are registered on all four Auto Run entry points (`playbook`, `run-doc`, `goal-run`, `auto-run` in `src/cli/index.ts`). The value is **run-scoped**: it wins over `session.customModel` / `session.customEffort` for every spawn the run makes, and nothing is ever written back to the session, so the agent's interactive tabs are unaffected and the override dies with the run. Resolution order for an Auto Run spawn is `run override -> session.customModel -> agent default`.

Threading, by entry point:

- **Headless (`playbook`, `run-doc`, `goal-run`)** - the flag rides the command's options object into `services/goal-runner.ts` (`RunGoalOptions`) or `services/batch-processor.ts` (`runPlaybook` options), and both pass `runModel ?? session.customModel` / `runEffort ?? session.customEffort` at every `spawnAgent` call site. `agent-spawner.ts` already accepted `customModel` / `customEffort`, so it needed no change. Note the synopsis and goal-handoff spawns take the override too, so the summary runs on the same model as the work it summarizes.
- **Desktop-routed (`auto-run`)** - the flags travel in the `configure_auto_run` WebSocket message (`commands/auto-run.ts`), are validated as optional non-empty strings in `handleConfigureAutoRun` (`src/main/web-server/handlers/messageHandlers/autoRun.ts`), pass through `ConfigureAutoRunCallback` (`src/main/web-server/types.ts`) and `CallbackRegistry.configureAutoRun`, and land on the `BatchRunConfig` built in `useAppRemoteEventListeners.ts`. From there the desktop runners apply them via `spawnAgentForSession`'s `modelOverride` / `effortOverride` options.

Conventions to preserve when touching this:

- **Spread-when-set everywhere.** Producers use `...(model && { model })` so an unset override is absent, never an empty string. The CLI trims first (`options.model?.trim() || undefined`), so `--model "   "` reads as unset.
- **No CLI-side validation.** Valid model names are provider-specific and only the desktop/provider layer knows them, so the CLI passes the value through. The WebSocket boundary rejects non-strings and blank strings, nothing more.
- **The override is config, not session state.** In particular `buildWorktreeSession` (`src/renderer/utils/worktreeSession.ts`) still copies the PARENT session's `customModel` into a worktree child - do not "fix" that to use the run override. Worktree dispatch gets the override for free because it hands the same `BatchRunConfig` to the same runners.

### `send <agent-id> <message>`

Send a message to an agent and receive a JSON response. Supports multi-turn conversations via session resumption.

```bash
maestro-cli send <agent-id> <message> [-s, --session <id>] [--require-plugin-tools] [--require-tool-receipt <tool-id>]
```

Options:

- `--session <id>` - Resume an existing agent session for multi-turn conversations
- `--require-plugin-tools` - Require the authenticated desktop plugin runner with active tools. If unavailable, fail instead of falling back to a standalone CLI run. Use with a supported local provider; the caller must still verify the specific tool result and any external delivery receipt.
- `--require-tool-receipt <tool-id>` - Also require a host-observed successful call to this exact namespaced plugin tool ID (for Relay, `sh.maestro.relay/send`) with nonempty numeric `messageIds`. Implies the fail-closed desktop path. The JSON response adds `toolReceipts: [{ runId, agentId, toolId, messageIds }]`; exit status is nonzero if the provider fails, the tool is unavailable, or no matching receipt is observed. A failed run may still include receipts from a tool call that completed before the failure, so consumers must inspect them before retrying.
- `--no-history` - Skip writing the History entry
- `--no-synopsis` - Skip the synopsis turn; the History entry carries the response

Every send writes one History entry on the target agent (`recordSendHistory` in `src/cli/commands/send.ts`). `resolveSendOrigin` picks the kind from the environment the command inherited: `CUE` when `MAESTRO_QUERY_SOURCE` is `cue`, `AGENT` (with `sourceAgentName`) when a caller identity is present, `USER` otherwise.

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
- `--run-on`, `--run-on-context`, `--gateway-url` - Where the model runs and the gateway, checked like the `update-agent` flags
- `--peer`, `--peer-note`, `--group-peers`, `--worktree-peers` - Peers, read by `readPeerFlags()` (`services/peer-flags.ts`) and written after the create by the same `update_session_config` message `update-agent --peer` sends, so one applier owns the rules. `create-agent` has no `--remove-peer` (a new agent has no row to remove), `--tier`, `--background-requests`, `--system-one` or `--proxy-mode`: set those with `update-agent` afterwards. `src/__tests__/prompts/maestroCliPrompt.test.ts` pins this, so adding one fails the test on purpose and the agent-facing map gets updated with it.
- `--type` lists `PICKABLE_AGENT_IDS` in its help; `--model auto` is the model router.

### `create-worktree`

Create a new agent in a git worktree branched off an existing parent agent, without an Auto Run playbook. Sends a `create_worktree_session` message; the desktop creates the worktree on disk, builds a child session linked to the parent (reusing `spawnWorktreeAgentAndDispatch`), and returns the new agent's session ID. The optional `--message` is then delivered as a plain prompt over the same connection via `send_command`, addressed by the returned ID - it deliberately does NOT route through `dispatch`, which re-resolves the agent against the CLI's persisted sessions file and would race the desktop's debounced persistence.

```bash
maestro-cli create-worktree -a <parent-agent-id> -b <branch-name> [--base-branch <ref>] [-m <message>] [--json]
```

- `-a, --agent <id>` - Parent agent ID, supports partial IDs via `resolveTargetSessionId()` (required)
- `-b, --branch <name>` - Branch name for the worktree, created if it does not exist (required)
- `--base-branch <name>` - Ref the new branch is based on when it does not yet exist; defaults to the parent repo HEAD
- `-m, --message <text>` - Optional initial prompt dispatched to the new agent after creation

### `remove-agent <agent-id>`

Remove an agent via WebSocket (`withMaestroClient`). Sends a `delete_session` message. Supports partial ID matching via `resolveAgentId()`.

```bash
maestro-cli remove-agent <agent-id> [--json]
```

### `update-agent <agent-id>`

Mutate an existing agent in place via WebSocket (`withMaestroClient`). At least one field flag is required; the command fans out one round-trip per kind of change (group, cwd, SSH, settings).

```bash
maestro-cli update-agent <agent-id> [-g <group-id|none>] [-d <new-cwd>] [--json]
maestro-cli update-agent <agent-id> [setting flags: --nudge --model --effort --env --tier --peer ...]
```

The setting flags are read by `buildConfigPatch()` (`services/agent-setting-flags.ts`), shared with `update-group-settings`, and ride one `update_session_config` message. The renderer applies the patch with the validators the Edit Agent dialog saves with, so a flag and a click cannot store different things:

- `--proxy-mode <off|passthrough|compress|compress-early>`, `--gateway-url`, `--run-on`, `--run-on-context`, `--tier <tier=target>` (repeatable), `--background-requests <target|none>`, `--system-one <on|off>`, and `--model auto` are the Models tab.
- `--retry-on-availability`, `--retry-on-token-exhaustion`, `--codex-auto-reset` (`true|false|default`), `--additional-dir <path[:rw]>`, `--clear-additional-dirs`, `--env-park KEY`, `--env-unpark KEY` and `--share-history-to-project-dir` are applied by `applyAgentConfigExtras()` in `src/shared/agentConfigExtras.ts`, over `setKeysParked()` (`src/shared/parkedRecords.ts`) and `normalizeAdditionalDirectories()`. `default` writes `null`, which the patch reads as "drop the choice" (the retries are on by default, which is why it is not `false`).
- `--peer`, `--peer-note`, `--remove-peer`, `--group-peers`, `--worktree-peers` are the Peers tab (`peerAgentEdits` in the same patch). `--peer x:none` excludes a peer from a grant; `--remove-peer x` deletes the row.
- `--json` reports the patch it sent, not the stored result. Read the result with `show agent <id> --json`.

- `--group <id>` sends a `move_session_to_group` message (reuses the same write path as drag-and-drop in the Left Bar). Pass `none`, `null`, or `""` to ungroup. Supports partial group IDs via `resolveGroupId()`.
- `--cwd <path>` sends the new `update_session_cwd` message. Resolves to absolute via `path.resolve()`. The renderer relocates the agent through `withWorkingDirectory()` (`src/renderer/utils/agentWorkingDirectory.ts`), which moves `cwd`/`fullPath`/`shellCwd`/`projectRoot` together, rebases `autoRunFolderPath` when it lives under the old root, and clears the file tree and git state so they reload from the new directory. Moving `cwd` alone left the Files panel and the Edit dialog on the old folder (#1565). Provider conversations stored under the old path are not carried over.
- The renderer refuses cwd updates while the agent is busy or `aiPid > 0` (`workingDirectoryChangeBlocker()`; the PTY's cwd is fixed at spawn time) and returns `{ success: false, error: '...' }`; the CLI surfaces that error and exits non-zero.
- `--gateway-url <url|none>` rides the `update_session_config` message as `gatewayUrl` (a normalized URL, or `null` to clear). Both ends validate with `parseGatewayUrlEdit()` (`src/shared/local-models/gateway.ts`): the CLI before it contacts the app, when it can read the agent's provider, and the renderer before it writes, so a provider that cannot use a gateway or a value that is not a URL is refused instead of being stored for the launch to trip over. The handler's `setMany` flush matters here: the desktop spawn reads the gateway from the main-process sessions store. Read it back with `show agent <id> --json` (`gatewayUrl`).

### `models list|install|pause|cancel|remove|verify|add-hf|remove-hf`

The local model Library and what is on disk. Implemented in `src/cli/commands/models-manage.ts`.

```bash
maestro-cli models list [-k <text-gen|embedding|classifier|stt|tts|wake-word>] [--fit] [--json]
maestro-cli models add-hf <repo> <file> [--dry-run] [--json]
maestro-cli models remove-hf <model-id> [--force] [--json]
maestro-cli models install <model-id> [--json]
maestro-cli models pause <model-id> [--json]
maestro-cli models cancel <model-id> [--json]
maestro-cli models remove <model-id> [--force] [--json]
maestro-cli models runtimes list [--json]
maestro-cli models runtimes install <onnx|llama> [--json]
maestro-cli models verify <model-id> [--json]
```

- All six run in the desktop over the WS bridge (`local_models_list`, `local_models_download`, `local_models_pause`, `local_models_cancel`, `local_models_remove`, `local_models_verify`, handlers in `src/main/web-server/handlers/messageHandlers/localModels.ts`) through the same `src/main/local-models/service.ts` functions as the `localModels:*` IPC channels the Settings -> Local Models rows call. A download started from the CLI is the same job the app shows progress for; a second `install` of a running download joins it.
- `list` groups with `groupLocalModelsForLibrary()` (`src/shared/local-models/library.ts`), the same grouping the Library draws, and prints each model's `goodAt` line and role badges. `--fit` sends `fit: true`; the desktop adds its hardware profile (`resolveHardwareProfile()`) to the reply and the CLI runs the shared `modelFit()` on it, so a row and the CLI cannot disagree. The CLI hides nothing: the "too large" toggle is a view filter.
- `add-hf` (`local_models_hf_add`) and `remove-hf` (`local_models_hf_remove`) call `addHuggingFaceModel()` / `removeUserLocalModel()` in `src/main/local-models/user-models.ts`, the functions behind the Library's Add from Hugging Face card and a row's Remove from Library. `add-hf` makes one request to Hugging Face's API and downloads nothing; `--dry-run` calls `previewHuggingFaceModel()` and saves nothing. A refusal (no such repo, a gated repo, a file with no reported SHA-256) comes back as `success: false` with its sentence. `remove-hf` applies the same in-use guard as `remove`.
- The `models` group has a `preAction` hook, `loadUserLocalModels()` (`src/cli/services/storage.ts`), which reads `local-models-user.json` from the data folder into the CLI's catalog, so `install`, `remove`, `verify` and `assign` accept a user model's id.
- Ids are checked against the shared catalog before the bridge opens. `install` refuses a `pending` model (one this build cannot run), matching the Settings row, which offers no Download button for it. It waits up to two hours for the job to settle; if the wait ends, the download keeps running in the app.
- `pause` and `cancel` are the row's Pause and Cancel buttons (`pauseLocalModel()` / `cancelLocalModel()`). `pause` keeps the partial file; there is no `resume` verb because `install` is the same call the Resume button makes. `cancel` deletes everything the job wrote, the partial file of a paused download included, and leaves an installed model alone (that is `remove`). Both answer `paused: false` / `cancelled: false` with exit code 0 when nothing was downloading: that is an answer, not a failure.
- `remove` refuses a model whose EFFECTIVE assignment (`tasksUsingLocalModel()`) is a task, naming the tasks, until `--force`; Settings shows the same warning inline. Voice usage is reported but does not block, as in Settings.
- `verify` never deletes or re-downloads; a mismatch exits non-zero and prints the file and both hashes.

### `models assign <task-id> <assignment>` and `models tasks`

Which source each Local Models task runs on. Implemented in `src/cli/commands/models-assign.ts`.

```bash
maestro-cli models assign <task-id> <off|utility-agent|local:<model-id>|endpoint:<endpoint>:<model>> [--json]
maestro-cli models tasks [--json]
```

- `assign` edits the `localModelAssignments` setting on disk (`readLocalModelAssignments()` / `writeLocalModelAssignments()`), so it works with the app closed. It parses with `parseLocalModelAssignmentSpec()`, validates with `localModelAssignmentProblem()`, and stores with `withLocalModelAssignment()` (shared, `src/shared/local-models/tasks.ts`): the same three the Assignments picker uses, so a wrong-kind model or an endpoint for a classifier is refused, and choosing a task's default removes its entry. The endpoint may be named by id, id prefix, or name (`findLocalModelEndpoint()`); the full id is stored. Everything after the endpoint is the model, so `endpoint:ollama:qwen3:latest` keeps the tag.
- `tasks` lists every task with its stored-or-default assignment, and the readiness verdict from the desktop (`local_models_task_readiness`, the resolver behind `models status`). With the app closed it still lists the assignments and reports `readinessError`. Use `models status` when a script needs an exit code.

### `models proxy status` and `models proxy block <hash>`

Implemented in `src/cli/commands/models-proxy.ts`. Both are one WS round trip to the desktop and change nothing.

- `status` (`local_models_proxy_status`) prints `getTokenProxyReport()`, the same report `localModels:proxy:report` returns and Settings -> Models -> Gateway draws: whether the proxy is listening and on which port, the agents on it with their mode, requests, tokens saved and average added latency for the last 30 days (in all and per agent), and the blocks it last shortened, each with the hash `block` takes. `--json` prints the whole report. Exit code is non-zero only when the proxy could not start (its port is held by another program); not set up and stopped are not failures.
- `block <hash>` (`local_models_proxy_block`) prints `readTokenProxyBlock(hash)`: a unified diff of what the agent sent against what was sent in its place, both read from the content-addressed cache under `userData/proxy-cache/`. `--original` and `--compressed` print one side alone, for piping. The app checks the hash with `isContentHash()` before it is used as a path. Exit code is non-zero for a hash the cache holds no compressed block for.
- An agent's mode is not set here. `update-agent --proxy-mode <off|passthrough|compress|compress-early>` rides `update_session_config` as `tokenProxyMode`, and the renderer applies it with `setAgentTokenProxyMode()` (`src/renderer/services/agentGateway.ts`), the function the Gateway table's select calls: `passthrough` and `compress` point the agent's gateway at the proxy and store the mode, `off` clears that gateway. It cannot be combined with `--gateway-url`, because the mode chooses the URL. Read it back with `show agent <id> --json` (`tokenProxyMode`; `null` is the default, passthrough).

### `models index`

Prints the semantic index's background indexer: its state (`off`, `idle`, `indexing`, `paused`, `unavailable`), `indexed / total` sources per type, and the reason when it cannot run. It is one WS round trip (`local_models_semantic_index_status`) answered from memory by `semanticIndexProgress()`, the same record `localModels:semanticIndex:status` returns. There is no start verb: the indexer runs whenever `semantic-search` is assigned a source, and `settings set semanticIndexCue true` opts Cue runs in. Exit code is non-zero only for `unavailable`.

### `search <query>`

Finds past work across History entries, archived Director's Notes synopses, and persisted AI tab transcripts. Implemented in `src/cli/commands/search.ts`.

```bash
maestro-cli search "<query>" [--semantic] [--source history|notes|transcripts] [--agent <id>] [--limit n] [--json]
```

- One WS round trip (`local_models_search`) to `searchPastWorkRequest()` in `src/main/local-models/work-search.ts`, the same function the `localModels:search` IPC channel calls for the History panel's and cross-tab search's Semantic toggle, so the three rank and cut snippets identically.
- With no flag it matches the query as written (case-insensitive), newest first, with no model. `--semantic` embeds the query on the `semantic-search` assignment and ranks by cosine similarity against the semantic index. It NEVER falls back to text: `off` and `unavailable` print the reason and exit 1.
- `--source` is repeatable or comma-separated. `--agent` goes through `resolveAgentId()` (id, prefix, or exact name) and leaves Director's Notes out, since a synopsis belongs to no agent. `--limit` is 1 to 100, default 20.
- Each hit prints its rank (a percentage, or a match count in text mode), source, agent, age, title, snippet, and the ids to act on (`agent <id>  entry <id>` or `agent <id>  tab <id>`). `--json` prints the whole `WorkSearchResult`, including `index` (how far the index had got) for a semantic search.

### `tab suggest-cleanup`

The CLI path to the Tab Cleanup Suggestions modal's list. Implemented in `src/cli/commands/tab-suggest-cleanup.ts`. `tabs` is accepted as an alias of the `tab` group, so `maestro-cli tabs suggest-cleanup` works too.

```bash
maestro-cli tab suggest-cleanup [--json]
```

- One WS round trip (`local_models_tab_cleanup`) to `suggestTabCleanup()` in `src/main/local-models/tab-cleanup.ts`, the same function the `localModels:suggestTabCleanup` IPC channel calls for the modal, so both read the same tabs (every agent's visible AI tabs plus its snoozed tabs), the same `tab-cleanup` assignment, and the same guard. The request carries nothing: a caller cannot steer which tabs are read.
- **Read-only, and there is no `--apply`.** It changes no tab. Each suggestion is printed with the ordinary verb that applies it (`tab close <tab-id>`, `snooze tab <tab-id> <when> --agent <id>`, `snooze wake <snooze-id>`), which is the path the modal's Apply button takes. `--json` prints the whole `TabCleanupResult` with that command as `apply` on each suggestion.
- A tab that is busy, starred, or holding an unsent draft is never suggested (`guardTabCleanupSuggestions()` in `src/shared/tabCleanup.ts`); `protectedCount` says how many were left out. Hidden consult tabs are never read.
- Exits 0 with a list, including an empty one. Exits non-zero with the reason when the task is off (the default), the assigned model or endpoint is unavailable, the model timed out, or its reply was not usable. It never falls back to an agent.

### `models run <task-id>`

Runs a text task through its assignment, or the two file and repository forms below. Implemented in `src/cli/commands/models-run.ts`.

```bash
maestro-cli models run <task-id> --input <text> [--system <text>] [--max-tokens <n>] [--json]
```

- Exit codes follow the split `s1 route` uses: `6` when the task is switched off or assigned to the Utility Agent (nothing local will answer; do not retry), `7` when the task ran and could not answer (unavailable, cancelled, no changes), `2` for a bad invocation, `3`/`4`/`5` for the app.

### `models server status|start|stop|set|key`

The Maestro model server (`llama-server`), the card in Settings -> Models -> Sources. Implemented in `src/cli/commands/models-server.ts`. Every verb runs in the desktop over the WS bridge through `getModelServerReport()`, `startModelServer()`, `stopModelServer()` and `installModelServerEngine()`, so a server started here is the one the card shows.

```bash
maestro-cli models server status [--json]
maestro-cli models server start [--json]
maestro-cli models server stop [--json]
maestro-cli models server set [--bind local|network] [--max-models <n>] [--rotate-key] [--build default|cpu|cuda|rocm] [--json]
maestro-cli models server key [--json]
```

- `start` and `stop` wait until the server answers or exits. A running server restarts to apply any `set`. `--bind network` needs the key; `--rotate-key` invalidates whatever used the old one.
- `status` exits non-zero only when the server is `failed` (could not start, or crashed repeatedly); a stopped server is not a failure. `key` prints the key a harness sends, made on first use.

### `models tiers list|options|suggest|set|reset`

The harness tier defaults: which model a `low`, `medium` or `high` task launches on, per harness (Settings -> Models -> System Two). Implemented in `src/cli/commands/models-tiers.ts`.

```bash
maestro-cli models tiers list [--harness <id>] [--json]
maestro-cli models tiers options <harness> [--refresh] [--json]
maestro-cli models tiers suggest <harness> [--apply] [--json]
maestro-cli models tiers set <harness> <low|medium|high> <default|provider|provider:<model>|<source id>:<model>> [--json]
maestro-cli models tiers reset <harness> [--tier <tier>] [--json]
```

- `list`, `set`, `reset` and `suggest --apply` read and write the `harnessTierDefaults` setting in the settings file, so they work with Maestro closed and the watcher reloads every window. `options` and `suggest` ask the desktop, which owns the agent detector and the Run on sources.
- They check and store through the helpers the Tier defaults table uses (`parseTierTargetSpec()`, `parseTierTargetEdit()`, `withHarnessTierDefault()`, `suggestHarnessTierDefaults()` in `src/shared/modelTiers.ts`), so the CLI cannot save a target the table would refuse. `default` clears a tier. Each tier prints the layer it came from (Harness default or Built-in).

### `models config show|set`

Where model files are downloaded from (`localModelsDownloadBase`). Implemented in `src/cli/commands/models-config.ts`.

```bash
maestro-cli models config show [--json]
maestro-cli models config set download-base <url|default> [--json]
```

Both read and write the settings file, so they work with Maestro closed. The value is checked by `downloadBaseProblem()`, the function the Settings field uses; exit `2` for an unknown key or an unusable URL. It changes the host only: every download is still checked against the catalog hash.

### `agent test-run-on <agent-id>`

The Run on picker's Test button. Implemented in `src/cli/commands/agent-test-run-on.ts`. One WS round trip to `testAgentRunOn()` (`src/main/local-models/run-on-test.ts`), which sends one short read-only turn through the agent's own harness on its STORED Run on target. Only the agent id is sent, so there is no way to test an unsaved draft from the CLI: write the target with `update-agent --run-on`, then test it. A Provider target has nothing to test and is refused. Its outer timeout is long enough for the model server to start and a cold model to load; the app applies its own budget to each step and answers with the reason when one runs out.

### `s1` (System One)

The engine, its key, and the verbs agents ask with. Implemented in `src/cli/commands/system-one.ts` (status, set, key, test, ledger), `system-one-ask.ts` (yes, pick, rate, ask, rank, batch), `system-one-route.ts` (route), `system-one-spend.ts` (usage, cost) and `system-one-guide.ts` (guide, examples).

```bash
maestro-cli s1 status|test [--json]
maestro-cli s1 set engine off|jev-cloud|openjev|local-judge [--url <url>] [--model <source>]
maestro-cli s1 set timeout <ms> | fail-policy <task> open|closed|default | keep-inputs on|off | agents on|off | budget [<usd>] [--per-agent <usd|none>]
pbpaste | maestro-cli s1 key set [--engine jev-cloud|openjev]
maestro-cli s1 key clear [--engine jev-cloud|openjev]
maestro-cli s1 ledger [--task <task>] [--outcome <outcome>] [--since <time>] [--limit <n>] [--json]
maestro-cli s1 usage [--agent <id>] [--since <time>] [--json]
maestro-cli s1 route "<prompt>" [--agent <id>] [--correct <low|medium|high>] [--json]
maestro-cli s1 yes "<question>" -s <text> | pick "<question>" "a=desc,b=desc" | rate "<question>" "low,...,high" | ask | rank | batch
```

- The admin verbs run in the desktop over the WS bridge through the same service functions the System One card calls. The asking verbs send ONE request to `runAgentSystemOneRequest()` (`src/main/local-models/system-one/agent-service.ts`); the engine's key never leaves the desktop, and the caller's agent and tab are read from its environment so the request is counted against that agent's budget and filed under it in the ledger.
- The flag grammar is the `jev` CLI's (`readState()`, `buildQuestions()`, `collectQuestionFlags()` in `src/cli/services/system-one-input.ts`), so an agent that knows one knows the other.
- A key is read from standard input only (`readStdinText()`), never an argument, and no verb prints one.
- Exit codes so a verb can sit in a shell `if`: `0` yes, or an answer at or above `--min-confidence`, or a job that judged everything; `1` is a "no" or an answer under the confidence asked for (never an error); `2` a bad request; `3`/`4`/`5` the app; `6` refused (System One off, or the day's budget spent: go on without it); `7` no answer (the engine failed, or a `rank` or `batch` is incomplete). `status` exits non-zero when the engine in force cannot answer as set up; `off` is not a failure.

### `voice`

A Cappella: the HUD and the Voice settings, verb for verb. Implemented in `src/cli/commands/voice.ts` (session, HUD, readouts), `voice-providers.ts` (providers, voices, credentials, wake-phrase), `voice-devices.ts` (paired devices) and `voice-wake.ts` (wake word training).

```bash
maestro-cli voice status|latency|self-test|setup [--download] [--json]
maestro-cli voice start [--conductor | --agent <id> [--tab <id|active>] | --agent <id> --document <path>] [--paused] [--json]
maestro-cli voice stop|send|stop-reply|mute|unmute [--json]
maestro-cli voice listen on|off [--send] | scope conductor|agent|tab | wait [<ms>|default] | volume <0.1-1>
maestro-cli voice input list | set <device-id|default>
maestro-cli voice providers list | set <stt|tts|brain|realtime> <provider-id> | set pipeline <cascade|realtime>
maestro-cli voice voices list | set <voice-id> | preview [<voice-id>] [--text <text>]
pbpaste | maestro-cli voice credentials set <openai|elevenlabs|anthropic>   # also: list, test, clear
maestro-cli voice devices list|rename|revoke|forget|revoke-all|disconnect|discovery|test-connection
maestro-cli voice wake-phrase list | set <agent> <phrase> | clear <agent>
maestro-cli voice wake record|stop|add|undo|clear-background|train|status|list|remove|test
```

- **One entry point.** Every `voice` verb except `voice wake` crosses the bridge as one `voice_control` message (`sendVoiceControl()` in `src/cli/services/voice-control.ts`, wire contract in `src/shared/acappella/voice-control.ts`) and ends in `runVoiceControlRequest()` (`src/main/acappella/voice-control-service.ts`). The handlers are built in `src/main/ipc/handlers/acappella.ts` from the same named functions the `acappella:*` IPC channels call, so a session started here and one started from the header pill are the same session on the same microphone. The bridge hop answers `maestro-cli` only.
- **Refusals are replies, not crashes.** A refusal the app gave on purpose (voice is off, a turn is in flight, no device has that id, a model is missing) comes back with a reason; the verb prints it and exits non-zero. A missing capability is refused by name and never swapped for a cloud provider.
- **Window.** A session a verb starts belongs to the window the user is looking at, like a global hotkey, because a command line has no window of its own. A new surface must gate on `useOwnsVoiceSession()`.
- **Settings.** `voice providers|voices|wake-phrase` write the `acappella` settings object in the settings file (so they work with Maestro closed) after `voiceSettingProblem()` (`src/shared/acappella/voice-settings-schema.ts`) checks the value against the bounds the panels use, and then ask the running app to apply it. A swap refused because a turn is in flight is reported as saved, not applied. `settings get|set|reset acappella.<path>` is checked by the same table through `nestedSettingProblem()`, and after a write main re-syncs the wake word and the voice hotkeys (`syncACappellaAfterExternalSettingsChange()`).
- **Secrets.** A cloud key is read from standard input and filed in the OS keychain by the app. The TURN credential reads back masked from `settings get` and `settings list`; it is still plain text at rest (an open gap in CLI-UI-PARITY.md).
- **No verb for pairing Approve or Deny.** It is a decision for a person at the computer.
- **Wake training** has its own message and enrollment service (`src/main/acappella/wake/wake-enrollment-service.ts`): `record` opens the microphone and returns at once, `stop` closes it, and `train` waits. `--other-speech` marks ordinary speech; `--background` is the old spelling and is hidden from `reference`.

### `stats` and `stats models`

Implemented in `src/cli/commands/stats.ts`. Both are one WS round trip to the desktop, which owns the open stats database. `stats [--range <r>]` is the aggregated dashboard; `stats models [--range <r>]` is the Models tab as data, from `readModelUsage()` (`src/main/local-models/model-usage.ts`) over `getModelUsage()`: what every model other than a provider's own did, by source and task, the Run on agents, System One, and what the token proxy saved. `--range` is `day|week|month|quarter|year|all` (default `week`). `stats-query "<sql>"` runs a read-only query; it is enforced read-only in the main process.

### `delegation graph`

The read half of the Delegation Graph. Implemented in `src/cli/commands/delegation-graph.ts`. It builds the model the canvas draws with `buildDelegationGraph()` (`src/shared/delegationGraph.ts`) from the stored agents, so the listing cannot disagree with the graph, and it needs no running app.

```bash
maestro-cli delegation graph [--group <group-id>] [--json]
```

`--json` prints `scope`, `group`, `stats`, `nodes` and `edges`. There is no write verb: an edge is written with `update-agent --peer` or `--remove-peer`, the same `peerAgentEdits` path the graph's drawing mode uses (`writeDelegationEdge()`). `maestro-cli open delegation-graph [--group <id>]` shows the canvas.

### `group-settings` and `update-group-settings`

A group's profile (what a new agent in it starts with) and its pill label. Implemented in `src/cli/commands/group-settings.ts` and `update-group-settings.ts`, over `services/group-settings.ts`.

```bash
maestro-cli group-settings <group-id> [--json]
maestro-cli update-group-settings <group-id> [setting flags] [--short-label <text>] [--clear] [--publish [--yes]] [--json]
maestro-cli open group-settings --group <group-id>
```

- The read needs no app. The write is one `update_group_settings` message: the renderer owns the group list and the validator the dialog saves with, so the flags are the `update-agent` ones (`buildConfigPatch()`, `readPeerFlags()`) and the app builds the profile. The CLI then reads the group back, because an older app would drop a field it does not know.
- Profile only is the default. `--publish` also writes THIS call's diff into the group's existing agents by the dialog's "Update N agents" rules (`summarizeGroupDefaultsDiff()`), and has no undo on the CLI, so it asks on a terminal or needs `--yes`.
- `create-agent --group` seeds a new agent from the profile (`seedRemoteCreate()`); `--no-group-defaults` skips it.
- `open group-settings --group` has `groupRequired` on its `UI_SURFACES` entry and no hotkey: a global chord has no group to act on.
- `open agent-settings --agent <id> [--tab <tab>]` opens Edit Agent the same way. Its entry has `agentClick`, which makes `--agent` valid and required, and its tabs come from `AGENT_SETTINGS_TAB_IDS` (`src/shared/agentSettingsTabs.ts`), the list the form's own strip is built from. The bridge handler refuses an agent that is gone (`getSessions`), because the renderer would open nothing and say nothing.

### `models run git-drafts --cwd <path>`

The CLI path to the Create Pull Request form's "Draft with local model" button. Implemented in `src/cli/commands/models-run.ts` (`runPullRequestDraft`).

```bash
maestro-cli models run git-drafts --cwd <path> [--base <branch>] [--json]
```

- Runs in the desktop (`local_models_git_draft`) through `draftPullRequestRequest()` in `src/main/local-models/git-drafts.ts`, the same function the `localModels:draftPullRequest` IPC channel calls, so the form and the CLI read the same assignment and summarize the same branch. `--cwd` is resolved with `resolveCliPath()` and must be a local checkout.
- `--base` defaults to `main`, then `master` (the form's own default order); a named branch is tried locally, then as `origin/<branch>`.
- Prints the title, a blank line, then the body. `--json` prints the whole result (`title`, `body`, `baseBranch`, `commitCount`, `truncated`, `producedBy`). It never pushes or opens a pull request.
- Exits non-zero with the reason when the task is off, the source is unavailable, the branch has no commits the base lacks, or git fails. `--cwd` and `--base` are refused for every other task, and do not combine with `--input`, `--system`, or `--max-tokens`.

### `models run dictation --audio <file>`

The CLI path to dictation (the microphone in a text box, and the `dictate` shortcut). Implemented in `src/cli/commands/models-run.ts` (`runTranscription`).

```bash
maestro-cli models run dictation --audio <file.wav> [--json]
```

- Runs in the desktop (`local_models_transcribe`) through `transcribeAudioFileRequest()` in `src/main/local-models/dictation.ts`, which decodes the file and calls `transcribeClip()`: the same function a clip recorded in a text box ends in, so both run on the same Dictation assignment and record the same `local_model_runs` row. `--audio` is resolved with `resolveCliPath()`.
- **It takes a file, not the microphone.** The UI records from the computer's microphone; an agent has none, so it brings the speech as audio. The verb transcribes and stops: where the text goes is the caller's business, the same way the UI only types it into a box and never sends it.
- Only 16-bit PCM WAV is read (mono, or the first channel of a stereo file; any sample rate, resampled to 16 kHz). Convert anything else first, for example `ffmpeg -i in.m4a -ac 1 -c:a pcm_s16le out.wav`.
- Prints the transcript alone on stdout, which is empty when the clip held no speech. `--json` prints the whole result (`text`, `audioMs`, `source`, `durationMs`).
- Exits non-zero with the reason when the task is off (the default), the source is unavailable, or the file is missing or not a readable WAV. It never falls back to another recogniser. `--audio` is refused for every other task and does not combine with `--input`, `--system`, `--max-tokens`, `--cwd`, or `--base`.

### `notify speak <text>`

The CLI path to spoken notices (the Test button under **Speak When an Agent Finishes** in Settings > Notifications). Implemented in `src/cli/commands/notify-speak.ts`.

```bash
maestro-cli notify speak "<text>" [--json]
```

- Runs in the desktop (`notify_speak`) through `speakNoticeRequest()` in `src/main/local-models/spoken-notices.ts`, which calls `speakNotice()`: the same queue, the same local voice, and the same rules as the notice Maestro speaks when an agent finishes a turn.
- **It waits.** The command returns once the line was heard, or was refused, so a caller can tell the two apart. Prints `Spoken: <text>`; `--json` prints `{ success, spoken, text }`.
- **It ignores the `spokenNotices` setting and window focus**, because it is an explicit request. Everything else holds: one line at a time with a quiet window between them, and nothing while a voice session is live.
- A line that was not spoken exits non-zero with `Not spoken (<code>): <reason>` (`--json`: `{ success: false, spoken: false, code, error }`). Codes: `voice-session-active`, `no-speaker`, `empty`, `stale`, `superseded`, `cancelled`, `speech-failed`.
- Text is limited to 600 characters (refused as a usage error before the app is called) and is flattened to one speakable line: markup and URLs are removed.
- The mode itself is a setting, not a verb: `maestro-cli settings set spokenNotices <off|unfocused|always>`.

### `models endpoints list|add|update|remove|models|test|detect`

Model servers the user runs for Local Models (Ollama, LM Studio, any OpenAI-compatible base URL). Implemented in `src/cli/commands/models-endpoints.ts`.

```bash
maestro-cli models endpoints list [--json]
maestro-cli models endpoints add --kind <ollama|lmstudio|openai-compatible> [--url <url>] [--name <name>] [--api-key-env <VAR>] [--disabled] [--json]
maestro-cli models endpoints update <id|id-prefix|name> [--name <name>] [--url <url>] [--kind <kind>] [--api-key-env <VAR> | --clear-api-key-env] [--enable | --disable] [--json]
maestro-cli models endpoints remove <id|id-prefix|name> [--json]
maestro-cli models endpoints models <id|id-prefix|name> [--json]
maestro-cli models endpoints test <id|id-prefix|name> [-m <model>] [--json]
maestro-cli models endpoints detect [--json]
```

- `list` / `add` / `update` / `remove` edit the `localModelEndpoints` setting on disk (`readLocalModelEndpoints()` / `writeLocalModelEndpoints()`), like the SSH remote verbs, so they work with the app closed; the settings watcher reloads every window. The list changes go through the shared `addLocalModelEndpoint()` / `updateLocalModelEndpoint()` / `removeLocalModelEndpoint()` / `findLocalModelEndpoint()` in `src/shared/local-models/endpoints.ts`, so the CLI cannot save a record the app would drop (bad URL, credentials in the URL, taken id, or a server already configured under another loopback spelling).
- `--url` defaults to the standard local port for `ollama` and `lmstudio`; `openai-compatible` requires it. `--api-key-env` stores the NAME of a Settings -> Environment variable, never the key. `list` and `add` flag a name that is not set there yet.
- `update` is the row's Edit form and its enabled switch in one verb. Only the fields a flag names change; the id and the list position are kept, so an assignment that names the endpoint still resolves. A call with no field flag, with both `--enable` and `--disable`, or with both `--api-key-env` and `--clear-api-key-env` is a usage error. `--disable` is not checked against assignments (neither is the switch in Settings): a task assigned to a disabled endpoint reports `endpoint-disabled` in `models status`.
- `models` prints the ids the server lists now, one per line, with the on-disk size when the server reports one (Ollama does). It is the row's "List the models this server serves now" button and the source of the `<model>` half of `models assign <task> endpoint:<endpoint>:<model>`. A server that cannot be listed exits non-zero with the same failure kinds as `test`.
- `models`, `test` and `detect` need the network and Settings -> Environment, so they run in the desktop over the WS bridge (`local_models_endpoint_models`, `local_models_endpoint_test`, `local_models_endpoints_detect`, handlers in `src/main/web-server/handlers/messageHandlers/localModels.ts`) through the same `endpoint-service.ts` functions as the `localModels:endpoints:*` IPC channels. A failed test exits non-zero and reports the failure `kind` (`missing-key`, `auth`, `network`, `timeout`, ...) in `--json`. `detect` saves nothing; it prints the `add` command for each server it finds.

### `list ssh-remotes`

List all configured SSH remotes. Reads directly from `maestro-settings.json` via `readSshRemotes()` - no running app required.

```bash
maestro-cli list ssh-remotes [--json]
```

### `create-ssh-remote <name>`

Create a new SSH remote configuration. Direct disk I/O via `readSshRemotes()`/`writeSshRemotes()`.

```bash
maestro-cli create-ssh-remote <name> -H <host> [-p <port>] [-u <user>] [-k <key-path>] [--env KEY=VALUE]... [--ssh-option KEY=VALUE]... [--ssh-config] [--disabled] [--set-default] [--json]
```

Options:

- `--host <host>` - Hostname or IP (required)
- `--port <port>` - Validated range 1-65535 (default: 22)
- `--ssh-config` - Use `~/.ssh/config` mode; host becomes the Host pattern
- `--set-default` - Writes `defaultSshRemoteId` to settings
- `--env KEY=VALUE` - Repeatable remote environment variable
- `--ssh-option KEY=VALUE` - Repeatable extra `ssh -o` option, validated by
  `validateSshOption()` in `src/shared/sshOptions.ts`

Generates a UUID via `crypto.randomUUID()` for the remote ID.

### `update-ssh-remote <remote-id>`

Edit an existing SSH remote in place. Same direct disk I/O and partial ID
matching as the other two.

```bash
maestro-cli update-ssh-remote <remote-id> [-n <name>] [-H <host>] [-p <port>] [-u <user>] [-k <key-path>] [--env KEY=VALUE]... [--clear-env] [--ssh-option KEY=VALUE]... [--clear-ssh-options] [--ssh-config <bool>] [--enabled <bool>] [--set-default] [--json]
```

`--env` and `--ssh-option` MERGE into the existing maps rather than replacing
them, so setting one option cannot silently drop the others; `--clear-env` and
`--clear-ssh-options` empty the respective map first. An empty string to `-u` or
`-k` clears that field.

`--json` (and `list ssh-remotes --json`) reports `resolvedSshOptions` alongside
the stored `sshOptions`: the full merged set `ssh` receives once
`resolveSshOptions()` has folded the overrides over Maestro's defaults. That is
the field that answers "did my override take effect?" - the stored map alone
cannot, since a reserved key is dropped and a default may already hold the slot.

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

The CLI spawner is simpler than the desktop process manager but honors the same
per-agent/per-session overrides that users configure in the desktop app:

- **Honored**: custom binary path, custom CLI args, custom env vars, custom model,
  custom effort/reasoning - all resolved via `applyAgentConfigOverrides()` just
  like the desktop (`session` wins over `agent config` wins over defaults).
  Env vars REPLACE rather than layer: an agent with any vars of its own gets
  none of the provider-level set, so usage attribution can read the same
  single set back (`effectiveAgentCustomEnvVars()` in `shared/providerProfiles.ts`).
- **Honored**: SSH remote execution - when `sessionSshRemoteConfig.enabled` is
  true, the spawn is wrapped via `wrapSpawnWithSsh()` (dynamic import so the
  SSH chain stays out of the local hot path). If the configured remote can't
  be resolved, the CLI returns a clear error instead of silently falling back
  to local - users who opt into SSH don't want their prompt leaking locally.
- **Not applicable**: PTY (CLI uses plain `child_process.spawn`), real-time
  output streaming to UI.

See `src/cli/services/agent-spawner.ts` - the `resolveAgentOverrides()` helper
and `maybeWrapSpawnWithSsh()` are the CLI-side equivalents of the desktop
`process:spawn` IPC handler's override + SSH wrapping logic.

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

| Event               | Fields                                                                     | Description                                          |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `start`             | `playbook`, `session`                                                      | Batch run started                                    |
| `document_start`    | `document`, `index`, `taskCount`                                           | Starting a document                                  |
| `task_start`        | `document`, `taskIndex`                                                    | Starting a task                                      |
| `task_complete`     | `document`, `taskIndex`, `success`, `summary`, `elapsedMs`, `usageStats`   | Task finished                                        |
| `document_complete` | `document`, `tasksCompleted`                                               | All tasks in document done                           |
| `loop_complete`     | `iteration`                                                                | One loop iteration finished                          |
| `synopsis`          | `text`, `sessionId`                                                        | AI-generated summary                                 |
| `history`           | `entry`                                                                    | History entry written                                |
| `complete`          | `documentsProcessed`, `tasksCompleted`, `totalElapsedMs`, `totalCost`      | Batch run finished                                   |
| `error`             | `message`, `document?`, `taskIndex?`                                       | Error occurred                                       |
| `skipped`           | `reason`                                                                   | Task or document skipped                             |
| `waiting`           | `reason`                                                                   | Waiting for agent                                    |
| `model_resolution`  | `document`, `taskIndex`, `model`, `effort`, `notes`, `warnings`, `message` | A `MAESTRO:MODEL` hint was applied (or could not be) |

`model_resolution` is deliberately NOT gated on `--verbose`. A hint the provider could not honor (non-empty `warnings`) is exactly the case the feature exists to make visible, and an operator who never sees it concludes tier hints are broken rather than unmapped. `model`/`effort` are `null` when the agent's own default was used.

### Synopsis Generation

After all tasks complete, the batch processor spawns the agent one more time to generate a synopsis (summary of work done). This uses a special prompt from `src/prompts/` and the same agent session for context continuity. The synopsis is parsed for structured data (title, description, files changed).

The turn is `requestCliSynopsis()` in `src/cli/services/synopsis.ts`, the one synopsis spawn on the CLI: Auto Run and `maestro-cli send` both record their turns through it. It is pinned to the bottom of both ladders via `cheapResumeTurnSettings()` (`src/shared/modelTiers.ts`) regardless of what the tasks ran at - it summarizes work that already happened, so paying premium rates for it is one wasted turn per task. The one exception is a task that ran on a larger context window than the cheap model has (`opus[1m]`): the synopsis resumes that transcript, so it keeps the task's model and only drops effort. Safe only because the synopsis is a leaf: its returned `agentSessionId` is discarded, so the downgrade cannot follow the conversation into a later real turn.

The helper returns `null` when there is nothing usable - the turn failed, printed only a provider error, or answered NOTHING_TO_REPORT - and the task keeps its default `[<document>] Task completed` label rather than recording an error line as the summary of the work.

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

| Concern             | Primary Files                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| CLI entry point     | `src/cli/index.ts`                                                                                             |
| Storage reader      | `src/cli/services/storage.ts`                                                                                  |
| Agent spawner       | `src/cli/services/agent-spawner.ts`                                                                            |
| Batch processor     | `src/cli/services/batch-processor.ts`                                                                          |
| Playbook management | `src/cli/services/playbooks.ts`                                                                                |
| Agent sessions      | `src/cli/services/agent-sessions.ts`                                                                           |
| Desktop IPC client  | `src/cli/services/maestro-client.ts` over `src/shared/maestro-lib/client/bridge-connection.ts`                 |
| Human output        | `src/cli/output/formatter.ts`                                                                                  |
| JSONL output        | `src/cli/output/jsonl.ts`                                                                                      |
| Send command        | `src/cli/commands/send.ts`                                                                                     |
| Run playbook        | `src/cli/commands/run-playbook.ts`                                                                             |
| Create agent        | `src/cli/commands/create-agent.ts`                                                                             |
| Remove agent        | `src/cli/commands/remove-agent.ts`                                                                             |
| Update agent        | `src/cli/commands/update-agent.ts`                                                                             |
| Exit codes          | `src/cli/exit-codes.ts`, `src/cli/services/maestro-bridge-errors.ts`                                           |
| Bridge round trip   | `src/cli/services/session-command.ts` (`failCommand`, `failFromError`, `sendBridgeCommand`)                    |
| Help examples       | `src/cli/command-examples.ts`, `src/__tests__/cli/command-tree.test.ts`                                        |
| Agent setting flags | `src/cli/services/agent-setting-flags.ts`, `src/cli/services/peer-flags.ts`, `src/shared/agentConfigExtras.ts` |
| Local Models verbs  | `src/cli/commands/models-*.ts`, `agent-test-run-on.ts`                                                         |
| System One verbs    | `src/cli/commands/system-one*.ts`, `src/cli/services/system-one-input.ts`                                      |
| Voice verbs         | `src/cli/commands/voice*.ts`, `src/cli/services/voice-control.ts`, `src/shared/acappella/voice-control.ts`     |
| SSH remote CRUD     | `src/cli/commands/create-ssh-remote.ts`, `list-ssh-remotes.ts`, `update-ssh-remote.ts`, `remove-ssh-remote.ts` |
| SSH `-o` resolution | `src/shared/sshOptions.ts`                                                                                     |
| Shared types        | `src/shared/types.ts`                                                                                          |
| Template variables  | `src/shared/templateVariables.ts`                                                                              |
| Agent definitions   | `src/main/agents/definitions.ts`                                                                               |
| Agent IDs           | `src/shared/agentIds.ts`                                                                                       |
| CLI activity        | `src/shared/cli-activity.ts`                                                                                   |
| Prompt templates    | `src/prompts/`                                                                                                 |

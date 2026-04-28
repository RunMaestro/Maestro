---
title: Command Line Interface
description: Send messages to agents, list sessions, run playbooks, and manage Maestro settings from the command line.
icon: square-terminal
---

Maestro includes a CLI tool (`maestro-cli`) for sending messages to agents, browsing sessions, running playbooks, managing settings, and controlling resources from the command line, cron jobs, or CI/CD pipelines. The CLI requires Node.js (which you already have if you're using Claude Code).

## Installation

The CLI is bundled with Maestro as a JavaScript file. Create a shell wrapper to run it:

```bash
# macOS (after installing Maestro.app)
printf '#!/bin/bash\nnode "/Applications/Maestro.app/Contents/Resources/maestro-cli.js" "$@"\n' | sudo tee /usr/local/bin/maestro-cli && sudo chmod +x /usr/local/bin/maestro-cli

# Linux (deb/rpm installs to /opt)
printf '#!/bin/bash\nnode "/opt/Maestro/resources/maestro-cli.js" "$@"\n' | sudo tee /usr/local/bin/maestro-cli && sudo chmod +x /usr/local/bin/maestro-cli

# Windows (PowerShell as Administrator) - create a batch file
@"
@echo off
node "%ProgramFiles%\Maestro\resources\maestro-cli.js" %*
"@ | Out-File -FilePath "$env:ProgramFiles\Maestro\maestro-cli.cmd" -Encoding ASCII
```

Alternatively, run directly with Node.js:

```bash
node "/Applications/Maestro.app/Contents/Resources/maestro-cli.js" list groups
```

## Usage

### Sending Messages to Agents

Send a message to an agent and receive a structured JSON response. Supports creating new sessions or resuming existing ones for multi-turn conversations.

```bash
# Send a message to an agent (creates a new session)
maestro-cli send <agent-id> "describe the authentication flow"

# Resume an existing session for follow-up
maestro-cli send <agent-id> "now add rate limiting" -s <session-id>

# Send in read-only mode (agent can read but not modify files)
maestro-cli send <agent-id> "analyze the code structure" -r
```

The response is always JSON:

```json
{
	"agentId": "a1b2c3d4-...",
	"agentName": "My Agent",
	"sessionId": "abc123def456",
	"response": "The authentication flow works by...",
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

On failure, `success` is `false` and an `error` field is included:

```json
{
	"success": false,
	"error": "Agent not found: bad-id",
	"code": "AGENT_NOT_FOUND"
}
```

| Flag                 | Description                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-s, --session <id>` | Resume an existing session instead of creating a new one                                                                                                                                            |
| `-r, --read-only`    | Run in read-only/plan mode (agent cannot modify files)                                                                                                                                              |
| `-t, --tab`          | Open/focus the agent's session tab in the Maestro desktop app                                                                                                                                       |
| `-l, --live`         | **Deprecated — use `dispatch` instead.** Route the message through the Maestro desktop so it appears in the agent's tab                                                                             |
| `--new-tab`          | With `--live`, create a new AI tab and send the prompt into it                                                                                                                                      |
| `-f, --force`        | With `--live`, bypass the busy-state guard so you can dispatch concurrent writes to a single agent's active tab. Requires `allowConcurrentSend=true`; otherwise exits with code `FORCE_NOT_ALLOWED` |

Error codes: `AGENT_NOT_FOUND`, `AGENT_UNSUPPORTED`, `CLAUDE_NOT_FOUND`, `CODEX_NOT_FOUND`, `INVALID_OPTIONS`, `FORCE_NOT_ALLOWED`, `MAESTRO_NOT_RUNNING`, `SESSION_NOT_FOUND`, `COMMAND_FAILED`.

Supported agent types: `claude-code`, `codex`.

#### Messages that start with a dash

Messages whose first character is a dash (em-dash `—`, en-dash `–`, double-dash `--`, minus `-`) collide with option parsing and will be rejected as unknown flags. Use the standard `--` end-of-options separator so the message is passed verbatim:

```bash
maestro-cli send <agent-id> -- "———revise the spec"
maestro-cli send <agent-id> -s <session-id> -- "--re-run"
maestro-cli dispatch <agent-id> -- "--force the rewrite"
```

Everything after `--` is treated as positional, so any flags you need (`-s`, `-r`, `-t`, `--new-tab`, `-f`) must come before the separator.

### Dispatching to a Desktop Tab

`dispatch` hands a prompt to an agent in the running Maestro desktop app and returns the tab/session id, so callers can address the same tab on follow-up calls without holding a persistent channel. It replaces `send --live` for orchestration use cases (Cue pipelines, external bots, multi-step automations).

```bash
# Dispatch to the active tab of an agent
maestro-cli dispatch <agent-id> "review the PR description"

# Open a fresh tab and dispatch the prompt into it
maestro-cli dispatch <agent-id> "start a new review pass" --new-tab

# Continue a previous dispatch by targeting its tab
maestro-cli dispatch <agent-id> "and now run the tests" -s <tab-id>

# Force a write to a busy tab (requires allowConcurrentSend=true)
maestro-cli dispatch <agent-id> "interrupt with this" -f
```

Output is always JSON. `sessionId` and `tabId` are the same value, duplicated so polling consumers can use either name:

```json
{
	"success": true,
	"agentId": "a1b2c3d4-...",
	"sessionId": "tab-xyz",
	"tabId": "tab-xyz"
}
```

| Flag                 | Description                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--new-tab`          | Create a fresh AI tab in the target agent. Mutually exclusive with `-s` and `-f` (a new tab is never busy, so `--force` has nothing to bypass) |
| `-s, --session <id>` | Target an existing tab by id (from a previous `dispatch`). Mutually exclusive with `--new-tab`                                                 |
| `-f, --force`        | Bypass the busy-state guard. Gated by `allowConcurrentSend`; errors with code `FORCE_NOT_ALLOWED`. Cannot be combined with `--new-tab`         |

Error codes: `INVALID_OPTIONS`, `AGENT_NOT_FOUND`, `FORCE_NOT_ALLOWED`, `MAESTRO_NOT_RUNNING`, `SESSION_NOT_FOUND`, `NEW_TAB_NO_ID`, `COMMAND_FAILED`. `NEW_TAB_NO_ID` fires when the desktop app acknowledges `--new-tab` without returning a tab id, leaving callers nothing to chain follow-up dispatches against. Requires the Maestro desktop app to be running.

### Listing Sessions

Browse an agent's session history, sorted most recent to oldest. Supports pagination with limit/skip and keyword search.

```bash
# List the 25 most recent sessions
maestro-cli list sessions <agent-id>

# Limit to 10 results
maestro-cli list sessions <agent-id> -l 10

# Paginate: skip the first 25, show next 25
maestro-cli list sessions <agent-id> -k 25

# Page 3 of 10-item pages
maestro-cli list sessions <agent-id> -l 10 -k 20

# Search for sessions by keyword (matches session name and first message)
maestro-cli list sessions <agent-id> -s "authentication"

# Combine limit, skip, and search with JSON output
maestro-cli list sessions <agent-id> -l 50 -k 0 -s "refactor" --json
```

| Flag                     | Description                                        | Default |
| ------------------------ | -------------------------------------------------- | ------- |
| `-l, --limit <count>`    | Maximum number of sessions to return               | 25      |
| `-k, --skip <count>`     | Number of sessions to skip (for pagination)        | 0       |
| `-s, --search <keyword>` | Filter by keyword in session name or first message | —       |
| `--json`                 | Output as JSON                                     | —       |

JSON output includes full session metadata:

```json
{
	"success": true,
	"agentId": "a1b2c3d4-...",
	"agentName": "My Agent",
	"totalCount": 42,
	"filteredCount": 3,
	"sessions": [
		{
			"sessionId": "abc123",
			"sessionName": "Auth refactor",
			"modifiedAt": "2026-02-08T10:00:00.000Z",
			"firstMessage": "Help me refactor the auth module...",
			"messageCount": 12,
			"costUsd": 0.05,
			"inputTokens": 5000,
			"outputTokens": 2000,
			"durationSeconds": 300,
			"starred": true
		}
	]
}
```

Currently supported for `claude-code` agents.

### Creating and Removing Agents

Create agents directly from the command line. Requires the Maestro desktop app to be running.

```bash
# Create a Claude Code agent with a working directory
maestro-cli create-agent "My Agent" -d /path/to/project

# Create a Codex agent with custom model and environment variables
maestro-cli create-agent "Codex Worker" -d . -t codex --model gpt-5.3-codex --env API_KEY=abc123

# Create an agent with SSH remote execution
maestro-cli create-agent "Remote Agent" -d /home/user/project -t claude-code --ssh-remote <remote-id>

# Create an agent with all options
maestro-cli create-agent "Full Config" -d /workspace \
	-t claude-code \
	-g <group-id> \
	--nudge "Always write tests" \
	--new-session-message "You are a senior engineer working on project X" \
	--custom-path /usr/local/bin/claude \
	--custom-args "--verbose" \
	--env DEBUG=true --env LOG_LEVEL=info \
	--model opus \
	--effort high \
	--context-window 200000 \
	--provider-path /custom/provider \
	--ssh-remote <remote-id> \
	--ssh-cwd /remote/workdir \
	--auto-run-folder ~/playbooks/full-config

# Remove an agent
maestro-cli remove-agent <agent-id>
```

| Flag                              | Description                                              | Default                    |
| --------------------------------- | -------------------------------------------------------- | -------------------------- |
| `-d, --cwd <path>`                | Working directory for the agent (required)               | —                          |
| `-t, --type <type>`               | Agent type (claude-code, codex, opencode, factory-droid) | `claude-code`              |
| `-g, --group <id>`                | Group ID to assign the agent to                          | —                          |
| `--nudge <message>`               | Nudge message appended to every user message             | —                          |
| `--new-session-message <message>` | Message prefixed to first message in new sessions        | —                          |
| `--custom-path <path>`            | Custom binary path for the agent CLI                     | —                          |
| `--custom-args <args>`            | Custom CLI arguments                                     | —                          |
| `--env <KEY=VALUE>`               | Environment variable (repeatable)                        | —                          |
| `--model <model>`                 | Model override (e.g., sonnet, opus)                      | —                          |
| `--effort <level>`                | Effort/reasoning level override                          | —                          |
| `--context-window <size>`         | Context window size in tokens                            | —                          |
| `--provider-path <path>`          | Custom provider path                                     | —                          |
| `--ssh-remote <id>`               | SSH remote ID for remote execution                       | —                          |
| `--ssh-cwd <path>`                | Working directory override on the SSH remote             | —                          |
| `--auto-run-folder <path>`        | Auto Run / playbooks folder for this agent               | `<cwd>/.maestro/playbooks` |
| `--json`                          | Machine-readable JSON output                             | —                          |

### Listing Resources

```bash
# List all groups
maestro-cli list groups

# List all agents
maestro-cli list agents
maestro-cli list agents -g <group-id>
maestro-cli list agents --group <group-id>

# Show agent details (history, usage stats, cost)
maestro-cli show agent <agent-id>

# List all playbooks (or filter by agent)
maestro-cli list playbooks
maestro-cli list playbooks -a <agent-id>
maestro-cli list playbooks --agent <agent-id>

# Show playbook details
maestro-cli show playbook <playbook-id>
```

### Running Playbooks

```bash
# Run a playbook
maestro-cli playbook <playbook-id>

# Dry run (shows what would be executed)
maestro-cli playbook <playbook-id> --dry-run

# Run without writing to history
maestro-cli playbook <playbook-id> --no-history

# Wait for agent if busy, with verbose output
maestro-cli playbook <playbook-id> --wait --verbose

# Debug mode for troubleshooting
maestro-cli playbook <playbook-id> --debug

# Clean orphaned playbooks (for deleted sessions)
maestro-cli clean playbooks
maestro-cli clean playbooks --dry-run
```

### Prompt Customization

The CLI uses the same core system prompts as the desktop app. When you customize prompts via Settings → **Maestro Prompts**, those customizations are stored in `core-prompts-customizations.json` in the Maestro data directory and are automatically picked up by the CLI during playbook runs.

The prompts most relevant to CLI playbook execution are:

| Prompt ID               | Controls                                      |
| ----------------------- | --------------------------------------------- |
| `autorun-default`       | Default Auto Run task execution behavior      |
| `autorun-synopsis`      | Synopsis generation after task completion     |
| `commit-command`        | `/commit` command behavior                    |
| `maestro-system-prompt` | Maestro system context injected into sessions |
| `context-grooming`      | Context grooming during transfers             |

To customize these prompts, either use the desktop app's **Maestro Prompts** tab or edit the JSON file directly:

```text
# macOS
~/Library/Application Support/Maestro/core-prompts-customizations.json

# Linux
~/.config/Maestro/core-prompts-customizations.json

# Windows
%APPDATA%\Maestro\core-prompts-customizations.json
```

The file format is:

```json
{
	"prompts": {
		"autorun-default": {
			"content": "Your customized prompt content...",
			"isModified": true,
			"modifiedAt": "2026-04-11T..."
		}
	}
}
```

### Reading Prompts (`prompts list` / `prompts get`)

The CLI exposes Maestro's prompt registry directly so other agents can self-fetch reference material on demand. Parent prompts can use the `{{REF:name}}` directive (see [Prompt Customization → Include Directives](/prompt-customization#include-directives)) to expand into a one-line pointer; the agent then runs `prompts get` to retrieve the full content.

```bash
# List every available prompt id with description and category
maestro-cli prompts list

# JSON output for scripting
maestro-cli prompts list --json

# Print a specific prompt's content (honors user customizations)
maestro-cli prompts get _maestro-cli
maestro-cli prompts get autorun-default

# Include metadata in the response
maestro-cli prompts get _maestro-cue --json
```

`prompts get` returns the same content the desktop app would deliver, so customizations made via Settings → **Maestro Prompts** are reflected immediately. Bundled include fragments use a leading underscore in their id (e.g., `_maestro-cli`, `_history-format`); standalone prompts do not.

### Managing Settings

View and modify any Maestro configuration setting directly from the CLI. Changes take effect immediately in the running desktop app — no restart required.

```bash
# List all settings with current values
maestro-cli settings list

# List with descriptions (great for understanding what each setting does)
maestro-cli settings list -v

# Filter by category
maestro-cli settings list -c appearance
maestro-cli settings list -c shell -v

# Show only setting keys
maestro-cli settings list --keys-only

# Get a specific setting
maestro-cli settings get fontSize
maestro-cli settings get activeThemeId

# Get nested settings with dot-notation
maestro-cli settings get encoreFeatures.directorNotes

# Get with full details (type, default, description)
maestro-cli settings get fontSize -v

# Set a setting (type is auto-detected)
maestro-cli settings set fontSize 16
maestro-cli settings set audioFeedbackEnabled true
maestro-cli settings set activeThemeId monokai
maestro-cli settings set defaultShowThinking on

# Set complex values with explicit JSON
maestro-cli settings set localIgnorePatterns --raw '["node_modules",".git","dist"]'

# Reset a setting to its default value
maestro-cli settings reset fontSize
```

| Flag                    | Description                                             | Commands      |
| ----------------------- | ------------------------------------------------------- | ------------- |
| `-v, --verbose`         | Show descriptions for each setting                      | `list`, `get` |
| `--keys-only`           | Show only setting key names                             | `list`        |
| `--defaults`            | Show default values alongside current values            | `list`        |
| `-c, --category <name>` | Filter by category (appearance, shell, editor, etc.)    | `list`        |
| `--show-secrets`        | Show sensitive values like API keys (masked by default) | `list`        |
| `--raw <json>`          | Pass an explicit JSON value                             | `set`         |
| `--json`                | Machine-readable JSON output                            | all           |

**Categories:** appearance, editor, shell, notifications, updates, logging, web, ssh, file-indexing, context, document-graph, stats, accessibility, integrations, onboarding, advanced, internal.

<Tip>
Use `maestro-cli settings list -v` from inside an AI agent conversation to give the agent full context about every available setting and what it controls.
</Tip>

### Managing Agent Configuration

Each agent (Claude Code, Codex, OpenCode, Factory Droid) can have its own configuration for custom paths, CLI arguments, environment variables, and model overrides.

```bash
# List all agent configurations
maestro-cli settings agent list

# List config for a specific agent
maestro-cli settings agent list claude-code

# Get a specific agent config value
maestro-cli settings agent get codex model
maestro-cli settings agent get claude-code customPath

# Set agent config values
maestro-cli settings agent set codex contextWindow 128000
maestro-cli settings agent set claude-code customPath /usr/local/bin/claude
maestro-cli settings agent set codex customEnvVars --raw '{"DEBUG":"true"}'

# Remove an agent config key
maestro-cli settings agent reset codex model
```

| Flag            | Description                           | Commands      |
| --------------- | ------------------------------------- | ------------- |
| `-v, --verbose` | Show descriptions for each config key | `list`, `get` |
| `--raw <json>`  | Pass an explicit JSON value           | `set`         |
| `--json`        | Machine-readable JSON output          | all           |

**Common agent config keys:**

| Key               | Type   | Description                                      |
| ----------------- | ------ | ------------------------------------------------ |
| `customPath`      | string | Custom path to the agent CLI binary              |
| `customArgs`      | string | Additional CLI arguments                         |
| `customEnvVars`   | object | Extra environment variables                      |
| `model`           | string | Model override (e.g., `gpt-5.3-codex`, `o3`)     |
| `contextWindow`   | number | Context window size in tokens                    |
| `reasoningEffort` | string | Reasoning effort level (`low`, `medium`, `high`) |

<Info>
Settings and agent config changes made via the CLI are automatically detected by the running Maestro desktop app. The app watches for file changes and reloads immediately — it's as if you toggled the setting in the Settings modal yourself.
</Info>

### Managing SSH Remotes

Create, list, and remove SSH remote configurations. These commands read and write directly to the Maestro settings file — no running desktop app required.

```bash
# List all configured SSH remotes
maestro-cli list ssh-remotes

# Create a new SSH remote
maestro-cli create-ssh-remote "Dev Server" -H 192.168.1.100 -u deploy

# Create with SSH config mode (uses ~/.ssh/config)
maestro-cli create-ssh-remote "Prod" -H prod-host --ssh-config

# Create with all options
maestro-cli create-ssh-remote "Build Server" \
	-H build.example.com \
	-p 2222 \
	-u ci \
	-k ~/.ssh/build_key \
	--env PATH=/usr/local/bin --env NODE_ENV=production \
	--set-default

# Remove an SSH remote
maestro-cli remove-ssh-remote <remote-id>
```

| Flag                    | Description                                                     | Default |
| ----------------------- | --------------------------------------------------------------- | ------- |
| `-H, --host <host>`     | SSH hostname or IP (required; Host pattern with `--ssh-config`) | —       |
| `-p, --port <port>`     | SSH port                                                        | `22`    |
| `-u, --username <user>` | SSH username                                                    | —       |
| `-k, --key <path>`      | Path to private key file                                        | —       |
| `--env <KEY=VALUE>`     | Remote environment variable (repeatable)                        | —       |
| `--ssh-config`          | Use `~/.ssh/config` for connection settings                     | —       |
| `--disabled`            | Create in disabled state                                        | —       |
| `--set-default`         | Set as the global default SSH remote                            | —       |
| `--json`                | Machine-readable JSON output                                    | —       |

<Info>
SSH remote changes made via the CLI are detected by the running Maestro desktop app through file watching, just like settings changes.
</Info>

## Partial IDs

All commands that accept an agent ID, group ID, or SSH remote ID support partial matching. You only need to type enough characters to uniquely identify the resource:

```bash
# These are equivalent if "a1b2" uniquely matches one agent
maestro-cli send a1b2c3d4-e5f6-7890-abcd-ef1234567890 "hello"
maestro-cli send a1b2 "hello"
```

If the partial ID is ambiguous, the CLI will show all matches.

## JSON Output

By default, commands output human-readable formatted text. Use `--json` for machine-parseable output:

```bash
# Human-readable output (default)
maestro-cli list groups
GROUPS (2)

  🎨  Frontend
      group-abc123
  ⚙️  Backend
      group-def456

# JSON output for scripting
maestro-cli list groups --json
{"type":"group","id":"group-abc123","name":"Frontend","emoji":"🎨","collapsed":false,"timestamp":...}
{"type":"group","id":"group-def456","name":"Backend","emoji":"⚙️","collapsed":false,"timestamp":...}

# Note: list agents outputs a JSON array (not JSONL)
maestro-cli list agents --json
[{"id":"agent-abc123","name":"My Agent","toolType":"claude-code","cwd":"/path/to/project",...}]

# Running a playbook with JSON streams events
maestro-cli playbook <playbook-id> --json
{"type":"start","timestamp":...,"playbook":{...}}
{"type":"document_start","timestamp":...,"document":"tasks.md","taskCount":5}
{"type":"task_start","timestamp":...,"taskIndex":0}
{"type":"task_complete","timestamp":...,"success":true,"summary":"...","elapsedMs":8000,"usageStats":{...}}
{"type":"document_complete","timestamp":...,"document":"tasks.md","tasksCompleted":5}
{"type":"loop_complete","timestamp":...,"iteration":1,"tasksCompleted":5,"elapsedMs":60000}
{"type":"complete","timestamp":...,"success":true,"totalTasksCompleted":5,"totalElapsedMs":60000,"totalCost":0.05}
```

The `send` command always outputs JSON (no `--json` flag needed).

### Desktop Integration

Commands for interacting with the running Maestro desktop app. These are especially useful for AI agents to trigger UI updates after creating or modifying files.

#### Open a File

Open a file as a preview tab in the Maestro desktop app:

```bash
maestro-cli open-file <file-path> [--session <id>]
```

#### Open a Browser Tab

Open a URL as a browser tab in the Maestro desktop app. Only `http(s)` URLs are accepted; scheme-less inputs like `localhost:3000` or `example.com:8080` are auto-prefixed with `https://`.

```bash
# Open in the active agent
maestro-cli open-browser https://docs.runmaestro.ai

# Scheme-less — gets https:// prepended
maestro-cli open-browser localhost:3000

# Target a specific agent
maestro-cli open-browser https://github.com/RunMaestro/Maestro -a <agent-id>
```

| Flag               | Description                                       |
| ------------------ | ------------------------------------------------- |
| `-a, --agent <id>` | Target agent by ID (defaults to the active agent) |

#### Open a Terminal Tab

Open a fresh terminal tab in the Maestro desktop app. The working directory must resolve inside the target agent's `cwd`; paths outside it are rejected.

```bash
# Open a terminal in the active agent's cwd with the default shell
maestro-cli open-terminal

# Custom cwd, shell, and tab label
maestro-cli open-terminal --cwd ./packages/api --shell bash --name "API tests"

# Target a specific agent
maestro-cli open-terminal -a <agent-id> --name "Build watch"
```

| Flag               | Description                                                         | Default     |
| ------------------ | ------------------------------------------------------------------- | ----------- |
| `-a, --agent <id>` | Target agent by ID (defaults to the active agent)                   | —           |
| `--cwd <path>`     | Working directory for the terminal (must be inside the agent's cwd) | agent's cwd |
| `--shell <bin>`    | Shell binary to use                                                 | `zsh`       |
| `--name <label>`   | Display name for the tab                                            | —           |

#### Refresh the File Tree

Refresh the file tree sidebar after creating multiple files or making significant filesystem changes:

```bash
maestro-cli refresh-files [--session <id>]
```

#### Refresh Auto Run Documents

Refresh the Auto Run document list after creating or modifying auto-run documents:

```bash
maestro-cli refresh-auto-run [--session <id>]
```

#### Notifications

Surface notifications in the running desktop app from any script, hook, or agent. Two delivery modes are available, both built on the same five-color design language so they feel unified:

- **Toast** — persistent notification that lands in the toast queue (top-right). Auto-dismisses by default. Use this when you want the user to see a result they may want to act on later, when an OS notification should also fire, or when the message benefits from being clickable to jump to a specific agent. Toasts can be made **sticky** with `--dismissible` so they require an explicit click to dismiss — use this for messages the user must acknowledge.
- **Center Flash** — momentary, single-slot center-screen confirmation that auto-dismisses (default 1.5s, max 5s). Use this for "I did the thing" feedback for a user-initiated action — clipboard acks, quick status nudges, brief success notes. Only one flash is visible at a time; firing a new one replaces the active one.

##### Color palette (shared by both)

Both commands accept `--color`, one of five canonical values:

| Color    | Looks like                  | When to use                                                         |
| -------- | --------------------------- | ------------------------------------------------------------------- |
| `theme`  | Active Maestro theme accent | **Default.** Generic confirmation with no semantic                  |
| `green`  | Success green               | Succeeded ("Build passed", "Tests green", "Deploy complete")        |
| `yellow` | Warning yellow              | Soft heads-up ("Quota at 60%", "Slow query detected")               |
| `orange` | Warm orange (`#f97316`)     | More emphatic warning ("Approaching context limit", "Quota at 90%") |
| `red`    | Error red                   | Failure / blocked ("CI failed", "Auth expired", "Sync error")       |

Pick `theme` when you don't have an opinion — the flash/toast will visually match whatever theme the user is running.

##### Toasts

```bash
# Default — themed, queue-based, auto-dismisses on the app's default schedule.
maestro-cli notify toast "Build" "Compiled in 3.2s"

# Pick a color and a custom timeout (in seconds, max 60).
maestro-cli notify toast "Tests" "All green" --color green --timeout 10
maestro-cli notify toast "Quota" "Approaching limit" --color orange --timeout 30
maestro-cli notify toast "Tests failing" "12 failures in auth.test.ts" --color red

# Sticky — user must click to dismiss. Cannot combine with --timeout/--duration.
maestro-cli notify toast "Action required" "Approve the PR before EOD" \
    --color red --dismissible

# Toast linked to an agent (clicking jumps to it).
maestro-cli notify toast "Auto Run done" "All tasks completed" --agent <agent-id>
```

| Flag               | Description                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `-c, --color`      | `green \| yellow \| orange \| red \| theme` (default: `theme`)                                   |
| `-t, --type`       | **[deprecated]** `success \| info \| warning \| error` — prefer `--color`                        |
| `--timeout <sec>`  | Auto-dismiss after N seconds (range: `(0, 60]`; wins over `--duration`)                          |
| `-d, --duration`   | Same as `--timeout` (legacy alias; range: `(0, 60]`)                                             |
| `--dismissible`    | Sticky toast — no auto-dismiss, click to close. Mutually exclusive with `--timeout`/`--duration` |
| `-a, --agent <id>` | Associate with an agent so clicking the toast jumps to it                                        |
| `--json`           | JSON output for scripting                                                                        |

##### Center Flash

```bash
# Default — themed, auto-dismisses after 1.5s.
maestro-cli notify flash "Deployed"

# Pick a color. Use --timeout in seconds (max 5).
maestro-cli notify flash "Tests passed" --color green
maestro-cli notify flash "Production deploy starting" --color orange --detail "v1.42.0"
maestro-cli notify flash "CI failed on main" --color red --timeout 5

# Add a second line of detail.
maestro-cli notify flash "Cache cleared" --detail "1.2 GB freed" --timeout 3
```

| Flag             | Description                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `-c, --color`    | `green \| yellow \| orange \| red \| theme` (default: `theme`)            |
| `-v, --variant`  | **[deprecated]** `success \| info \| warning \| error` — prefer `--color` |
| `-D, --detail`   | Optional mono-font second line shown beneath the message                  |
| `-t, --timeout`  | Auto-dismiss after N seconds (range: `(0, 5]`; wins over `--duration`)    |
| `-d, --duration` | Auto-dismiss after N **milliseconds** (range: `(0, 5000]`; legacy)        |
| `--json`         | JSON output for scripting                                                 |

##### Caps and dismissibility

External (CLI/web) callers are capped to **5 seconds** for Center Flash and **60 seconds** for Toast. The cap exists so external scripts can't stick a permanent overlay on the user. The only way to leave a notification on screen indefinitely is `--dismissible` on a toast — there is no equivalent for Center Flash (it is, by design, momentary).

Both commands support `--json` for scripting. Toasts respect the user's notification settings (audio feedback, OS desktop notifications) configured in the app.

### Configuring Auto-Run

Set up and optionally launch an auto-run session with one or more markdown documents. Documents must be `.md` files containing `- [ ]` checkbox tasks.

```bash
# Configure documents for auto-run
maestro-cli auto-run doc1.md doc2.md

# Configure and immediately launch
maestro-cli auto-run doc1.md doc2.md --agent <agent-id> --launch

# Add a custom prompt for the agent
maestro-cli auto-run doc1.md --prompt "Focus on test coverage"

# Save as a reusable playbook
maestro-cli auto-run doc1.md doc2.md --save-as "Auth Rewrite"

# Enable looping (re-run documents after completion)
maestro-cli auto-run doc1.md --loop --launch

# Loop with a maximum number of iterations
maestro-cli auto-run doc1.md --loop --max-loops 3 --launch

# Reset task checkboxes on completion (useful with looping)
maestro-cli auto-run doc1.md --reset-on-completion --loop --launch

# Run the auto-run inside a fresh git worktree on a dedicated branch
maestro-cli auto-run doc1.md --agent <agent-id> --launch \
  --worktree --branch feature/auto-x --worktree-path ../repo-auto-x

# Open a PR against the repo's default branch when the auto-run finishes
maestro-cli auto-run doc1.md --agent <agent-id> --launch \
  --worktree --branch feature/auto-x --worktree-path ../repo-auto-x \
  --create-pr

# Target a specific base branch for the PR
maestro-cli auto-run doc1.md --agent <agent-id> --launch \
  --worktree --branch feature/auto-x --worktree-path ../repo-auto-x \
  --create-pr --pr-target-branch develop
```

| Flag                          | Description                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `-a, --agent <id>`            | Target agent to run the documents (partial ID supported)                                        |
| `-s, --session <id>`          | Deprecated — use `--agent` instead                                                              |
| `-p, --prompt <text>`         | Custom prompt/instructions for the agent                                                        |
| `--loop`                      | Enable looping (re-run documents after completion)                                              |
| `--max-loops <n>`             | Maximum number of loop iterations (implies `--loop`)                                            |
| `--save-as <name>`            | Save the configuration as a named playbook                                                      |
| `--launch`                    | Immediately start the auto-run after configuring                                                |
| `--reset-on-completion`       | Reset task checkboxes when documents complete                                                   |
| `--worktree`                  | Run the auto-run inside a git worktree (requires `--launch`, `--branch`, and `--worktree-path`) |
| `--branch <name>`             | Branch name for the worktree (created if it does not exist)                                     |
| `--worktree-path <path>`      | Filesystem path for the worktree (must be a sibling of the repo, not nested inside it)          |
| `--create-pr`                 | Open a GitHub PR when the auto-run completes successfully                                       |
| `--pr-target-branch <branch>` | Target branch for the PR (defaults to the repo's default branch)                                |

Worktree mode reuses the desktop app's Auto Run pipeline: the app creates the
worktree (or reuses an existing one on the same repo), checks out the requested
branch, dispatches the agent inside the worktree, and — when `--create-pr` is
set — runs `gh pr create` once the batch completes. See
[Git Worktrees](git-worktrees.md) for more on worktree behavior.

### Checking Status

Check if the Maestro desktop app is running and reachable:

```bash
maestro-cli status
```

Returns the app version, uptime, and connection status.

## Cue Automation

Interact with Maestro Cue subscriptions directly from the command line.

### Listing Subscriptions

List all Cue subscriptions across all agents:

```bash
maestro-cli cue list

# JSON output (for scripting)
maestro-cli cue list --json
```

Shows each subscription's name, event type, agent, enabled status, and last trigger time.

### Triggering a Subscription

Manually trigger a Cue subscription by name, bypassing its normal event conditions:

```bash
# Trigger a subscription
maestro-cli cue trigger <subscription-name>

# Trigger with a custom prompt (overrides the configured prompt)
maestro-cli cue trigger <subscription-name> --prompt "Deploy to staging only"

# JSON output (for scripting)
maestro-cli cue trigger <subscription-name> --json
```

| Flag                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `-p, --prompt <text>`    | Override the subscription's configured prompt                        |
| `--source-agent-id <id>` | Identify the originating agent (populates `{{CUE_SOURCE_AGENT_ID}}`) |
| `--json`                 | Output as JSON (for scripting and CI/CD integration)                 |

The `--prompt` flag is especially useful for `cli.trigger` subscriptions, where the prompt text is available in the subscription's template as `{{CUE_CLI_PROMPT}}`.

**Examples:**

```bash
# Trigger a review pipeline after finishing work
maestro-cli cue trigger "code-review" --prompt "Review the changes in the auth module"

# Trigger a deploy from CI
maestro-cli cue trigger "deploy" --prompt "Deploy commit abc123 to production" --json

# Re-run a failed automation
maestro-cli cue trigger "lint-on-save"
```

## Director's Notes

Director's Notes is an Encore feature (`encoreFeatures.directorNotes`) that builds a unified history view across every agent in your fleet, plus an AI-generated synopsis of recent activity.

```bash
# Show recent unified history (last N days, default 7)
maestro-cli director-notes history -d 3

# Limit to user-initiated entries only
maestro-cli director-notes history --filter user -l 50

# Markdown output for piping into a doc
maestro-cli director-notes history -f markdown -d 1

# AI synopsis of the past day (requires the desktop app running)
maestro-cli director-notes synopsis -d 1
maestro-cli director-notes synopsis --json
```

| Subcommand | Flag                  | Description                                                              |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| both       | `-d, --days <n>`      | Lookback period in days (defaults to the app's Director's Notes setting) |
| both       | `-f, --format <type>` | Output format: `json`, `markdown`, `text` (default `text`)               |
| both       | `--json`              | Shorthand for `--format json`                                            |
| `history`  | `--filter <type>`     | Filter by entry type: `auto`, `user`, `cue`                              |
| `history`  | `-l, --limit <n>`     | Maximum entries to show (default 100)                                    |

`synopsis` requires the desktop app to be running; `history` reads from disk and works offline. If `encoreFeatures.directorNotes` is disabled, enable it first with `maestro-cli settings set encoreFeatures.directorNotes true`.

## Publishing Session Transcripts to Gists

Publish an agent's session transcript to a GitHub gist so you can share it with collaborators or attach it to a bug report. Routes through the running Maestro desktop app (which holds the live transcript) and uses the user's authenticated `gh` CLI under the hood.

```bash
# Create a private gist (default)
maestro-cli gist create <agent-id>

# Add a description
maestro-cli gist create <agent-id> -d "Auth refactor pairing session"

# Make it public
maestro-cli gist create <agent-id> --public -d "Repro for issue #1234"
```

| Flag                       | Description                            | Default |
| -------------------------- | -------------------------------------- | ------- |
| `-d, --description <text>` | Gist description                       | —       |
| `-p, --public`             | Create a public gist (default private) | private |

Output is JSON with the gist URL on success:

```json
{ "success": true, "agentId": "a1b2c3d4-...", "gistUrl": "https://gist.github.com/..." }
```

Requires the Maestro desktop app to be running and `gh` to be authenticated (`gh auth login`). Error codes: `AGENT_NOT_FOUND`, `MAESTRO_NOT_RUNNING`, `GIST_CREATE_FAILED`.

## Scheduling with Cron

```bash
# Run a playbook every hour (use --json for log parsing)
0 * * * * /usr/local/bin/maestro-cli playbook <playbook-id> --json >> /var/log/maestro.jsonl 2>&1
```

## Agent Integration

Maestro agents are automatically informed about `maestro-cli` through the system prompt. Each agent receives the platform-appropriate CLI invocation command via the `{{MAESTRO_CLI_PATH}}` template variable, which resolves to the full `node "/path/to/maestro-cli.js"` command for the current OS.

This means agents can:

- **Read settings** to understand the current Maestro configuration
- **Change settings** on behalf of the user (e.g., "switch to the nord theme", "increase font size")
- **Manage agent configs** (e.g., "set the Codex context window to 128000")
- **List resources** like agents, groups, and playbooks
- **Open files** in the Maestro file preview tab
- **Refresh the file tree** after creating or modifying files
- **Configure and launch auto-runs** with documents they create
- **Send messages** to other agents for inter-agent coordination
- **Discover Cue subscriptions** with `cue list` and **trigger automation pipelines** with `cue trigger`

When a user asks an agent to change a Maestro setting, the agent can use the CLI directly rather than instructing the user to navigate the settings modal. Changes take effect instantly.

The system prompt instructs agents to use `settings list -v` to discover available settings with descriptions, giving them full context to reason about configuration changes.

## Requirements

- At least one AI agent CLI must be installed and in PATH (Claude Code, Codex, or OpenCode)
- Maestro config files must exist (created automatically when you use the GUI)

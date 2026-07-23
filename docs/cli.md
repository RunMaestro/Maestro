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

### Global Flags and Exit Codes

Two flags work on every command:

| Flag          | Description                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `-q, --quiet` | Suppress incidental success output (errors still print). Never gates `--json`. |
| `--verbose`   | Print extra detail where available                                             |

Commands exit with a standardized code so scripts and CI can branch on the failure class:

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | Success                                                    |
| `1`  | Generic / uncategorized failure                            |
| `2`  | Invalid usage (unknown flag, bad argument, nothing to do)  |
| `3`  | The Maestro desktop app is not running or not reachable    |
| `4`  | The running app does not support the command (older build) |
| `5`  | The app was reachable but did not respond in time          |

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

| Flag                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `-s, --session <id>` | Resume an existing session instead of creating a new one      |
| `-r, --read-only`    | Run in read-only/plan mode (agent cannot modify files)        |
| `-t, --tab`          | Open/focus the agent's session tab in the Maestro desktop app |

For desktop-handoff workflows (route the message through a desktop tab, return an addressable tab id, etc.) use [`maestro-cli dispatch`](#dispatching-to-a-desktop-tab) instead.

Error codes: `AGENT_NOT_FOUND`, `AGENT_UNSUPPORTED`, `<AGENT>_NOT_FOUND` (e.g. `CLAUDE_CODE_NOT_FOUND`, `CODEX_NOT_FOUND`), `MAESTRO_NOT_RUNNING`, `COMMAND_FAILED`.

Supported agent types: any installed provider - `claude-code`, `codex`, `opencode`, `factory-droid`, `copilot-cli`, `hermes`, `pi`, `qwen3-coder`, `omp`.

#### Messages that start with a dash

Messages whose first character is a dash (em-dash `-`, en-dash `-`, double-dash `--`, minus `-`) collide with option parsing and will be rejected as unknown flags. Use the standard `--` end-of-options separator so the message is passed verbatim:

```bash
maestro-cli send <agent-id> -- " -  -  - revise the spec"
maestro-cli send <agent-id> -s <session-id> -- "--re-run"
maestro-cli dispatch <agent-id> -- "--force the rewrite"
```

Everything after `--` is treated as positional, so any flags you need must come before the separator. For `send` that's `-s`, `-r`, `-t` (`-t` is the boolean focus flag here); for `dispatch` it's `-t`/`--tab`, `--new-tab`, `-f`.

### Dispatching to a Desktop Tab

`dispatch` hands a prompt to an agent in the running Maestro desktop app and returns the tab/session id, so callers can address the same tab on follow-up calls without holding a persistent channel. Use this for orchestration use cases (Cue pipelines, external bots, multi-step automations).

```bash
# Dispatch to the active tab of an agent
maestro-cli dispatch <agent-id> "review the PR description"

# Open a fresh tab and dispatch the prompt into it
maestro-cli dispatch <agent-id> "start a new review pass" --new-tab

# Continue a previous dispatch by targeting its tab
maestro-cli dispatch <agent-id> "and now run the tests" -t <tab-id>

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

| Flag             | Description                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--new-tab`      | Create a fresh AI tab in the target agent. Mutually exclusive with `-t` and `-f` (a new tab is never busy, so `--force` has nothing to bypass) |
| `-t, --tab <id>` | Target an existing tab by id (from a previous `dispatch`). Mutually exclusive with `--new-tab`                                                 |
| `-f, --force`    | Bypass the busy-state guard. Gated by `allowConcurrentSend`; errors with code `FORCE_NOT_ALLOWED`. Cannot be combined with `--new-tab`         |

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
| `-s, --search <keyword>` | Filter by keyword in session name or first message | -       |
| `--json`                 | Output as JSON                                     | -       |

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

### Session Inspection

Inspect open AI tabs across the running Maestro desktop app and read their conversation history. Pair `dispatch --new-tab` (writes, returns a `tabId`) with `session show <tabId>` (reads, supports `--since` and `--tail`) to build a stateless poll loop without owning a persistent connection - used by Maestro-Discord and Cue follow-ups.

Both verbs talk to the running desktop over the same WebSocket as `dispatch`. There is no on-disk fallback: if the app is not running, the CLI exits with code `MAESTRO_NOT_RUNNING`.

#### List Open Tabs

Flatten every open AI tab across every Maestro agent into addressable entries:

```bash
# Default: compact text (one tab per line)
maestro-cli session list

# JSON for scripting
maestro-cli session list --json
```

Default text columns: `state` (`busy` / `idle`), star (`★` if starred), `tabId`, agent name + id, tab name, `createdAt` (relative). One tab per line so the output pipes cleanly into `grep`, `awk`, etc.

JSON envelope:

```json
{
	"success": true,
	"sessions": [
		{
			"tabId": "tab-1",
			"sessionId": "tab-1",
			"agentId": "a1b2c3d4-...",
			"agentName": "Backend",
			"toolType": "claude-code",
			"name": "Refactor parser",
			"agentSessionId": "claude-uuid-1",
			"state": "idle",
			"createdAt": 1714268000000,
			"starred": false
		}
	]
}
```

To extract just `tabId`s with `jq`: `maestro-cli session list --json | jq '.sessions[].tabId'`.

#### Show Conversation History

Print a tab's conversation log, with optional cursor (`--since`) and cap (`--tail`) filters applied desktop-side so the wire payload stays small even on long conversations.

```bash
# Default: formatted transcript (header + per-message blocks)
maestro-cli session show <tab-id>

# JSON for scripting
maestro-cli session show <tab-id> --json

# Only messages newer than an ISO-8601 timestamp
maestro-cli session show <tab-id> --since "2026-04-28T10:00:00Z"

# `--since` also accepts a bare epoch number (auto-detects ms vs sec by magnitude,
# so both `Date.now()` and `Date.now() / 1000` cursors work without a unit flag)
maestro-cli session show <tab-id> --since 1714268000

# Cap at the last N messages (applied after `--since`)
maestro-cli session show <tab-id> --tail 20

# Combine cursor + cap for poll loops
maestro-cli session show <tab-id> --since "$LAST_TS" --tail 50
```

| Flag                  | Description                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `--since <timestamp>` | Only return messages strictly after this timestamp (ISO-8601, or epoch ms/sec auto-scaled) |
| `--tail <n>`          | Cap output to the last N messages (non-negative integer; applied after `--since`)          |
| `--json`              | Output as JSON (default is a formatted transcript)                                         |

JSON shape:

```json
{
	"success": true,
	"tabId": "tab-1",
	"sessionId": "tab-1",
	"agentId": "a1b2c3d4-...",
	"agentSessionId": "claude-uuid-1",
	"messages": [
		{
			"id": "log-1",
			"role": "user",
			"source": "user",
			"content": "Hello",
			"timestamp": "2026-04-28T10:00:00.000Z"
		},
		{
			"id": "log-2",
			"role": "assistant",
			"source": "ai",
			"content": "Hi there",
			"timestamp": "2026-04-28T10:00:01.000Z"
		}
	]
}
```

`role` is a coarse classification (`user` | `assistant` | `system` | `tool` | `thinking` | `error` | `unknown`) so conversational consumers can branch on intent; the raw `source` is preserved alongside for callers that need to discriminate further. ISO timestamps are emitted verbatim so a `messages[-1].timestamp` from one call can be fed directly back into `--since` on the next.

Error codes: `MISSING_TAB_ID`, `TAB_NOT_FOUND`, `INVALID_OPTION`, `MAESTRO_NOT_RUNNING`, `COMMAND_FAILED`. All errors are emitted as `{ "success": false, "error": "...", "code": "..." }` with exit code `1`.

### Creating, Updating, and Removing Agents

Create, mutate, or delete agents directly from the command line. Requires the Maestro desktop app to be running.

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

# Rename an agent
maestro-cli rename-agent <agent-id> "New Name"

# Move an agent into a group (use "none" to ungroup)
maestro-cli update-agent <agent-id> --group <group-id>
maestro-cli update-agent <agent-id> --group none

# Change an agent's working directory (refused while the agent process is running)
maestro-cli update-agent <agent-id> --cwd /new/path/to/project

# Combine both in a single call
maestro-cli update-agent <agent-id> --group <group-id> --cwd /new/path

# Edit the agent's settings - the same fields as the Edit Agent modal
maestro-cli update-agent <agent-id> --nudge "Always write tests"
maestro-cli update-agent <agent-id> --new-session-message "You are a senior engineer"
maestro-cli update-agent <agent-id> --model opus --effort high --context-window 200000
maestro-cli update-agent <agent-id> --env DEBUG=true --env LOG_LEVEL=info
maestro-cli update-agent <agent-id> --custom-path /usr/local/bin/claude --custom-args "--verbose"

# Clear a field by passing an empty string; --clear-env empties the env map
maestro-cli update-agent <agent-id> --nudge ""
maestro-cli update-agent <agent-id> --clear-env

# Set the Claude token source (Claude Code agents only): api | tui | dynamic
maestro-cli update-agent <agent-id> --token-source tui

# Update SSH execution config (use "none" to revert to local)
maestro-cli update-agent <agent-id> --ssh-remote <remote-id> --ssh-cwd /remote/workdir
maestro-cli update-agent <agent-id> --ssh-remote none
maestro-cli update-agent <agent-id> --sync-history-to-remote true
```

`update-agent` mutates an existing agent in place, writing the same live desktop Session the Edit Agent modal edits (not the per-agent config store that `settings agent set` writes). Read the current values back with `maestro-cli show agent <id> --json`.

The group update reuses the same write path as drag-and-drop in the Left Bar. The cwd update only moves the UI-facing working directory (`cwd`/`fullPath`) - `projectRoot` is preserved so historical provider sessions stay addressable, which keeps prior conversation history attached when you relocate an archived project folder. Stop the agent before changing its cwd or SSH config; the underlying PTY's working directory and spawn target are fixed at launch time, so the renderer refuses those updates while the process is alive and surfaces the reason on stderr. The remaining settings (nudge, messages, model, effort, env, token source, etc.) are spawn-time values and apply on the next launch, so they are accepted even while the agent is running.

For text fields, passing an empty string (for example `--nudge ""`) clears the field. `--env` replaces the environment map with the provided pairs; `--clear-env` empties it. `--context-window 0` (or `none`) clears the context-window override. `--token-source` only carries meaning for Claude Code agents: `api` uses `claude --print` (per-token API credit), `tui` drives the maestro-p TUI (Max-plan quota), and `dynamic` starts on the TUI and falls back to API when a usage window hits its limit. The `tui` and `dynamic` modes need the [maestro-p helper](https://runmaestro.ai/maestro-p/) on PATH; it is bundled locally, but for SSH remotes it must be installed on the remote host. See [Provider Notes](/provider-notes#token-source-max-plan-vs-api).

| Flag                              | Description                                                                                                                                        | Default |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-g, --group <id>`                | Move the agent to this group; supports partial IDs. Use `none` (or `null`) to ungroup                                                              | -       |
| `-d, --cwd <path>`                | New working directory (resolved to absolute). Agent must be stopped                                                                                | -       |
| `--ssh-remote <id>`               | SSH remote for remote execution. Use `none` to revert to local. Agent must be stopped                                                              | -       |
| `--ssh-cwd <path>`                | Working directory override on the SSH remote                                                                                                       | -       |
| `--sync-history-to-remote <bool>` | Sync history entries to `.maestro/history/` on the remote host                                                                                     | -       |
| `--nudge <message>`               | Nudge message appended to every message. Empty string clears                                                                                       | -       |
| `--new-session-message <message>` | Message prefixed to the first message of new sessions. Empty string clears                                                                         | -       |
| `--custom-path <path>`            | Override the agent binary path. Empty string clears                                                                                                | -       |
| `--custom-args <args>`            | Custom CLI arguments. Empty string clears                                                                                                          | -       |
| `--env <KEY=VALUE>`               | Set an environment variable (repeatable; replaces the env map)                                                                                     | -       |
| `--clear-env`                     | Clear all per-agent environment variables                                                                                                          | -       |
| `--model <model>`                 | Model override (e.g. sonnet, opus). Empty string clears                                                                                            | -       |
| `--effort <level>`                | Effort/reasoning level override. Empty string clears                                                                                               | -       |
| `--context-window <size>`         | Context window size in tokens. `0` or `none` clears                                                                                                | -       |
| `--token-source <mode>`           | Claude Code token source: `api`, `tui`, or `dynamic` (Claude Code agents only)                                                                     | -       |
| `--maestro-p-path <path>`         | Override the maestro-p binary path. Empty string clears                                                                                            | -       |
| `--provider <type>`               | Switch the agent's provider. Destructive: resets tabs and clears provider config. Requires `--force`. Cannot be combined with other settings edits | -       |
| `--force`                         | Confirm a destructive change (required for `--provider`)                                                                                           | -       |
| `--json`                          | Machine-readable JSON output                                                                                                                       | -       |

The flag table below covers `create-agent`:

| Flag                              | Description                                              | Default                    |
| --------------------------------- | -------------------------------------------------------- | -------------------------- |
| `-d, --cwd <path>`                | Working directory for the agent (required)               | -                          |
| `-t, --type <type>`               | Agent type (claude-code, codex, opencode, factory-droid) | `claude-code`              |
| `-g, --group <id>`                | Group ID to assign the agent to                          | -                          |
| `--nudge <message>`               | Nudge message appended to every user message             | -                          |
| `--new-session-message <message>` | Message prefixed to first message in new sessions        | -                          |
| `--custom-path <path>`            | Custom binary path for the agent CLI                     | -                          |
| `--custom-args <args>`            | Custom CLI arguments                                     | -                          |
| `--env <KEY=VALUE>`               | Environment variable (repeatable)                        | -                          |
| `--model <model>`                 | Model override (e.g., sonnet, opus)                      | -                          |
| `--effort <level>`                | Effort/reasoning level override                          | -                          |
| `--context-window <size>`         | Context window size in tokens                            | -                          |
| `--provider-path <path>`          | Custom provider path                                     | -                          |
| `--ssh-remote <id>`               | SSH remote ID for remote execution                       | -                          |
| `--ssh-cwd <path>`                | Working directory override on the SSH remote             | -                          |
| `--auto-run-folder <path>`        | Auto Run / playbooks folder for this agent               | `<cwd>/.maestro/playbooks` |
| `--json`                          | Machine-readable JSON output                             | -                          |

### Creating and Removing Groups

Manage Left Bar groups from the command line. Requires the Maestro desktop app to be running. Use a group ID with `create-agent -g` or `update-agent --group` to place agents into it, and `update-agent --group none` to move an agent back out.

```bash
# Create a group
maestro-cli create-group "Backend"

# Create a group with an emoji icon
maestro-cli create-group "Backend" -e 🔧

# Machine-readable output (returns the new group ID)
maestro-cli create-group "Backend" --json

# Remove an (empty) group
maestro-cli remove-group <group-id>

# Remove a group that still has agents (ungroups them first)
maestro-cli remove-group <group-id> --force

# Rename a group
maestro-cli rename-group <group-id> "Frontend"
```

Removing a group never deletes the agents inside it: the desktop ungroups any members (moves them to no group) and then removes the group. `remove-group` refuses a non-empty group unless you pass `--force`, so you don't accidentally scatter a populated group. Group IDs support partial-ID resolution.

`create-group` flags:

| Flag                  | Description                  | Default |
| --------------------- | ---------------------------- | ------- |
| `-e, --emoji <emoji>` | Emoji icon for the group     | -       |
| `--json`              | Machine-readable JSON output | -       |

`remove-group` flags:

| Flag          | Description                                               | Default |
| ------------- | --------------------------------------------------------- | ------- |
| `-f, --force` | Delete even if the group still has agents (ungroups them) | -       |
| `--json`      | Machine-readable JSON output                              | -       |

### Creating Worktree Agents

Branch a new agent off an existing parent agent into its own git worktree, without an Auto Run playbook. This mirrors the desktop "create worktree" flow: the parent agent must already exist in the running app, the desktop creates the worktree on disk and a child session linked to the parent, then hands back the new agent's ID.

```bash
# Create a worktree agent off a parent, on a new branch
maestro-cli create-worktree -a <parent-agent-id> -b feature/new-thing

# Base the new branch on a specific ref when it does not yet exist
maestro-cli create-worktree -a <parent-agent-id> -b feature/new-thing --base-branch rc

# Create the worktree and immediately dispatch an initial prompt to it
maestro-cli create-worktree -a <parent-agent-id> -b feature/new-thing -m "Start on the API layer"
```

The optional `--message` is delivered to the new agent as a plain prompt (not an Auto Run loop) on the same connection, addressed by the ID the desktop just returned. Both `--agent` and `--branch` support the usual partial-ID resolution.

| Flag                   | Description                                                                   | Default          |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------- |
| `-a, --agent <id>`     | Parent agent ID the worktree branches from (required)                         | -                |
| `-b, --branch <name>`  | Branch name for the worktree, created if it does not exist (required)         | -                |
| `--base-branch <name>` | Ref the new branch is based on when it does not yet exist (e.g. `rc`, `main`) | parent repo HEAD |
| `-m, --message <text>` | Optional initial prompt dispatched to the new agent after creation            | -                |
| `--json`               | Machine-readable JSON output                                                  | -                |

### Driving the Workspace (Focus, Mode, Tabs)

Steer the desktop UI itself: focus an agent, flip an agent between AI and terminal mode, and manage an agent's AI tabs. These mirror clicking around the app and require the desktop app to be running.

```bash
# Focus (select) an agent in the Left Bar; optionally focus a specific tab
maestro-cli focus-agent <agent-id>
maestro-cli focus-agent <agent-id> --tab <tab-id>

# Switch an agent between AI chat and terminal mode
maestro-cli switch-mode <agent-id> ai
maestro-cli switch-mode <agent-id> terminal

# Open a new tab for an agent (optionally seed an AI tab with a prompt)
maestro-cli tab new -a <agent-id>
maestro-cli tab new -a <agent-id> --prompt "Start reviewing the API layer"

# Close, rename, star, or unstar a tab. The owning agent is resolved from the
# tab ID automatically, so you only need the tab ID (exact or a unique prefix).
maestro-cli tab close <tab-id>
maestro-cli tab rename <tab-id> "Docs"
maestro-cli tab star <tab-id>
maestro-cli tab unstar <tab-id>
```

Find tab IDs with `maestro-cli session list`. `tab new` returns the new tab's ID (printed, or in the JSON payload with `--json`).

An agent running inside Maestro gets its **own** tab ID in its system prompt (the `Tab ID` line under Session Information, from the `{{TAB_ID}}` variable), so you can just tell it "close this tab" or "rename this tab to Docs" and it will act on the right one. Every other entry in `session list` is a different live conversation, so agents are instructed never to guess a tab ID from that list.

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

### Goal-Driven Auto Run

Spec-Driven runs (the `playbook` command above) work through a checklist of documents. Goal-Driven runs instead pursue a single free-text objective: each iteration spawns a fresh agent that makes one increment of progress, reports how far along it is, and exits, repeating until the goal is reached, a deadlock is declared, the iteration limit is hit, or progress stalls.

```bash
# Run until the goal is reached or a deadlock is detected (infinite iterations)
maestro-cli goal-run <agent-id> "Migrate the settings store from Redux to Zustand and keep all tests green"

# Spell out what "done" looks like (guides the agent; not matched automatically)
maestro-cli goal-run <agent-id> "Improve test coverage" \
  --exit-criteria "Done when coverage is above 90% and all tests pass"

# Cap the number of iterations
maestro-cli goal-run <agent-id> "Refactor the auth module" --max-iterations 10

# Machine-parseable JSON lines for scripting / CI
maestro-cli goal-run <agent-id> "Fix all lint errors" --json

# Show the full prompt sent to the agent each iteration
maestro-cli goal-run <agent-id> "Tidy the codebase" --verbose

# Run without writing history entries
maestro-cli goal-run <agent-id> "Quick experiment" --no-history
```

| Option                   | Description                                              | Default    |
| ------------------------ | -------------------------------------------------------- | ---------- |
| `--exit-criteria <text>` | What "done" looks like and when to declare a deadlock    | _(none)_   |
| `--max-iterations <n>`   | Cap the number of iterations                             | Infinite   |
| `--no-history`           | Do not write history entries                             | Writes     |
| `--json`                 | Output as JSON lines (for scripting)                     | Human text |
| `--verbose`              | Show the full prompt sent to the agent on each iteration | Off        |

The run writes an immediate "started" history entry (recording the goal and exit criteria), one entry per iteration, and a final summary with the stop reason and final progress. Goal-Driven runs honor the same per-agent SSH remote and model/effort/args overrides as `playbook`, and refuse to start if the agent is already busy in the desktop app or another CLI instance.

**JSON event stream:** `goal_start`, `goal_iteration_start`, `goal_iteration_complete` (carries `progress`, `rationale`, `complete`, `deadlock`), and `goal_complete` (carries `success`, `exitReason`, `finalProgress`, `iterations`).

### Running Documents Without a Playbook (`run-doc`)

`run-doc` runs one or more Auto Run `.md` documents directly, without saving a playbook first. Like `playbook`, it runs **headlessly** - it spawns the target agent itself and streams events, so it works whether or not the Maestro desktop window is open. This is the reliable way to execute a document an agent just wrote.

```bash
# Run a single document on an agent (by ID or name)
maestro-cli run-doc plans/frontend-plan.md --agent "Frontend"

# The path may be relative to the agent's Auto Run folder, relative to the
# current directory, or absolute. Multiple documents run in sequence.
maestro-cli run-doc plan-a.md plan-b.md --agent <agent-id>

# Wait for the agent if it is busy, loop until all tasks are done
maestro-cli run-doc plans/migrate.md --agent <agent-id> --wait --loop

# JSON output for scripting; skip history writes
maestro-cli run-doc plans/spec.md --agent <agent-id> --json --no-history
```

`run-doc` accepts the same execution flags as `playbook` (`--dry-run`, `--no-history`, `--json`, `--debug`, `--verbose`, `--no-synopsis`, `--wait`) plus `--prompt`, `--loop`, `--max-loops`, and `--reset-on-completion`. When no `--prompt` is given it uses the default Auto Run prompt.

> **`playbook` vs `run-doc` vs `auto-run --launch`:** use `playbook <id>` for a saved playbook and `run-doc <docs>` for raw documents - both run headlessly with no desktop dependency. `auto-run --launch` instead hands the run to the running desktop app (needed only when you want the run to appear and be controlled in the desktop UI).

> **`--agent` accepts a name:** the `-a, --agent` flag on these commands resolves an agent by ID (full or partial) **or** by display name. This lets a group-chat participant target itself with `--agent "<its name>"`.

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

View and modify any Maestro configuration setting directly from the CLI. Changes take effect immediately in the running desktop app - no restart required.

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

### Theme and Encore Features

Ergonomic, validated wrappers over the underlying settings, for the customizations users most often ask for by voice. Unlike `settings set` (which writes the settings file), these route through the running desktop app, so the change applies live. The app must be running.

```bash
# Switch the active theme by ID or display name (case-insensitive)
maestro-cli set-theme tokyo-night
maestro-cli set-theme "Catppuccin Mocha"

# See every available theme
maestro-cli set-theme --list

# List Encore (experimental) features and whether each is enabled
maestro-cli encore list

# Enable or disable an Encore feature
maestro-cli encore enable symphony
maestro-cli encore disable maestroCue
```

Encore feature IDs: `directorNotes`, `usageStats`, `symphony`, `maestroCue`. Friendly aliases are accepted (for example `group-chat` for `symphony`, `cue` for `maestroCue`).

### Custom Theme Palette

`set-theme` only switches between built-in themes. The `theme` command group manages the user-configurable **Custom** theme palette (the same two settings the in-app Custom Theme Builder edits: `customThemeColors` and `customThemeBaseId`). Activate the result with `set-theme custom`.

```bash
# Print the current custom palette and its base theme (reads from disk; works offline)
maestro-cli theme show
maestro-cli theme show --json

# Export the custom theme as portable JSON (stdout, or to a file)
maestro-cli theme export
maestro-cli theme export --file my-theme.json

# Import a theme JSON file, apply it live, and activate it
maestro-cli theme import my-theme.json
maestro-cli theme import my-theme.json --no-activate   # save the palette without switching to it

# Set individual colors (key=value); optionally re-base from a built-in theme first
maestro-cli theme set accent=#ff0000 bgMain=#1a1a1a
maestro-cli theme set --base dracula accent=#ff79c6 --activate
```

Export files are byte-compatible with the in-app Custom Theme Builder, so a palette round-trips between the UI and CLI. `theme show` and `theme export` read the on-disk settings store directly (no running app required); `theme import` and `theme set` apply live through the running desktop app. Imports are validated the same way as the in-app importer: every required color key must be present and every value must be a valid CSS color.

| Command        | Flag                | Description                                                |
| -------------- | ------------------- | ---------------------------------------------------------- |
| `theme show`   | `--json`            | Machine-readable output                                    |
| `theme export` | `-f, --file <path>` | Write the theme JSON to this file instead of stdout        |
| `theme import` | `--no-activate`     | Save the palette without switching to the Custom theme     |
| `theme set`    | `-b, --base <id>`   | Initialize from a built-in theme before applying overrides |
| `theme set`    | `-a, --activate`    | Switch to the Custom theme after applying                  |

### Managing Agent Configuration

Each agent (Claude Code, Codex, OpenCode, Factory Droid) can have its own configuration for custom paths, CLI arguments, environment variables, and model overrides.

<Info>
`settings agent set` writes the per-agent-type configuration store (defaults applied to newly created agents and headless CLI spawns). To change the settings of a specific existing agent shown in the Left Bar - its nudge message, model, env vars, Claude token source, and so on - use [`update-agent`](#creating-updating-and-removing-agents) instead, which writes that agent's live desktop Session.
</Info>

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
Settings and agent config changes made via the CLI are automatically detected by the running Maestro desktop app. The app watches for file changes and reloads immediately - it's as if you toggled the setting in the Settings modal yourself.
</Info>

### Managing SSH Remotes

Create, list, and remove SSH remote configurations. These commands read and write directly to the Maestro settings file - no running desktop app required.

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
| `-H, --host <host>`     | SSH hostname or IP (required; Host pattern with `--ssh-config`) | -       |
| `-p, --port <port>`     | SSH port                                                        | `22`    |
| `-u, --username <user>` | SSH username                                                    | -       |
| `-k, --key <path>`      | Path to private key file                                        | -       |
| `--env <KEY=VALUE>`     | Remote environment variable (repeatable)                        | -       |
| `--ssh-config`          | Use `~/.ssh/config` for connection settings                     | -       |
| `--disabled`            | Create in disabled state                                        | -       |
| `--set-default`         | Set as the global default SSH remote                            | -       |
| `--json`                | Machine-readable JSON output                                    | -       |

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

Open a file as a preview tab in the Maestro desktop app. Without `--agent`, the owning agent is auto-detected by which agent's working directory the file lives in (longest-prefix match, most-recently-active wins on ties). Pass `--agent <id>` to target an explicit agent - the file must live inside that agent's `cwd`. Pass `--no-switch` to skip switching the Maestro UI to the resulting agent/tab.

```bash
maestro-cli open-file <file-path> [-a <id>] [--no-switch]
```

| Flag               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `-a, --agent <id>` | Target agent (defaults to auto-detect by file path's owning agent) |
| `--no-switch`      | Don't switch the Maestro UI to the target agent/tab                |

#### Open a Browser Tab

Open a URL as a browser tab in the Maestro desktop app. Only `http(s)` URLs are accepted; scheme-less inputs like `localhost:3000` or `example.com:8080` are auto-prefixed with `https://`.

```bash
# Open in the active agent
maestro-cli open-browser https://docs.runmaestro.ai

# Scheme-less - gets https:// prepended
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
| `-a, --agent <id>` | Target agent by ID (defaults to the active agent)                   | -           |
| `--cwd <path>`     | Working directory for the terminal (must be inside the agent's cwd) | agent's cwd |
| `--shell <bin>`    | Shell binary to use                                                 | `zsh`       |
| `--name <label>`   | Display name for the tab                                            | -           |

#### Refresh the File Tree

Refresh the file tree sidebar after creating multiple files or making significant filesystem changes:

```bash
maestro-cli refresh-files [--agent <id>]
```

#### Refresh Auto Run Documents

Refresh the Auto Run document list after creating or modifying auto-run documents:

```bash
maestro-cli refresh-auto-run [--agent <id>]
```

#### Notifications

Surface notifications in the running desktop app from any script, hook, or agent. Two delivery modes are available, both built on the same five-color design language so they feel unified:

- **Toast** - persistent notification that lands in the toast queue (top-right). Auto-dismisses by default. Use this when you want the user to see a result they may want to act on later, when an OS notification should also fire, or when the message benefits from being clickable to jump to a specific agent. Toasts can be made **sticky** with `--dismissible` so they require an explicit click to dismiss - use this for messages the user must acknowledge.
- **Center Flash** - momentary, single-slot center-screen confirmation that auto-dismisses (default 1.5s, max 5s). Use this for "I did the thing" feedback for a user-initiated action - clipboard acks, quick status nudges, brief success notes. Only one flash is visible at a time; firing a new one replaces the active one.

##### Color palette (shared by both)

Both commands accept `--color`, one of five canonical values:

| Color    | Looks like                  | When to use                                                         |
| -------- | --------------------------- | ------------------------------------------------------------------- |
| `theme`  | Active Maestro theme accent | **Default.** Generic confirmation with no semantic                  |
| `green`  | Success green               | Succeeded ("Build passed", "Tests green", "Deploy complete")        |
| `yellow` | Warning yellow              | Soft heads-up ("Quota at 60%", "Slow query detected")               |
| `orange` | Warm orange (`#f97316`)     | More emphatic warning ("Approaching context limit", "Quota at 90%") |
| `red`    | Error red                   | Failure / blocked ("CI failed", "Auth expired", "Sync error")       |

Pick `theme` when you don't have an opinion - the flash/toast will visually match whatever theme the user is running.

##### Toasts

```bash
# Default - themed, queue-based, auto-dismisses on the app's default schedule.
maestro-cli notify toast "Build" "Compiled in 3.2s"

# Pick a color and a custom timeout (in seconds, max 60).
maestro-cli notify toast "Tests" "All green" --color green --timeout 10
maestro-cli notify toast "Quota" "Approaching limit" --color orange --timeout 30
maestro-cli notify toast "Tests failing" "12 failures in auth.test.ts" --color red

# Sticky - user must click to dismiss. Cannot combine with --timeout.
maestro-cli notify toast "Action required" "Approve the PR before EOD" \
    --color red --dismissible

# Toast linked to an agent (clicking jumps to it).
maestro-cli notify toast "Auto Run done" "All tasks completed" --agent <agent-id>

# Jump to a specific AI tab inside the agent.
maestro-cli notify toast "Diff ready" "Switch to review tab" \
    --agent <agent-id> --tab <tab-id>

# Open a file in the agent's File Preview pane on click.
maestro-cli notify toast "Patch ready" "Open the diff" \
    --agent <agent-id> --open-file src/foo.ts

# Open an external URL in the system browser on click.
maestro-cli notify toast "Run finished" "View logs" \
    --open-url https://example.com/logs

# Render an inline action link beneath the message body (separate from
# the body click). Useful for "view PR" style affordances.
maestro-cli notify toast "PR opened" "Auto Run completed" \
    --agent <agent-id> \
    --action-url https://github.com/org/repo/pull/42 --action-label "View PR"
```

| Flag                    | Description                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `-c, --color`           | `green \| yellow \| orange \| red \| theme` (default: `theme`)                                  |
| `-t, --timeout <sec>`   | Auto-dismiss after N seconds (range: `(0, 60]`; omitted = app default)                          |
| `--dismissible`         | Sticky toast - no auto-dismiss, click to close. Mutually exclusive with `--timeout`             |
| `-a, --agent <id>`      | Associate with an agent so clicking the toast jumps to it                                       |
| `--tab <id>`            | AI tab ID within the agent - clicking jumps to that tab. Requires `--agent`                     |
| `--open-file <path>`    | On click, switch to the agent and open the file in File Preview. Requires `--agent`             |
| `--open-url <url>`      | On click, open the URL in the system browser. Mutually exclusive with `--open-file`             |
| `--action-url <url>`    | Inline link rendered beneath the message body (separate from the body click - opens in browser) |
| `--action-label <text>` | Label for `--action-url` (defaults to the URL itself); requires `--action-url`                  |
| `--json`                | JSON output for scripting                                                                       |

The body-click hierarchy is: `--open-file` / `--open-url` (mutually exclusive) > `--agent` (+ optional `--tab`). `--action-url` is independent - it renders a separate inline link button and does not affect the body click.

##### Center Flash

```bash
# Default - themed, auto-dismisses after 1.5s.
maestro-cli notify flash "Deployed"

# Pick a color. Use --timeout in seconds (max 5).
maestro-cli notify flash "Tests passed" --color green
maestro-cli notify flash "Production deploy starting" --color orange --detail "v1.42.0"
maestro-cli notify flash "CI failed on main" --color red --timeout 5

# Add a second line of detail.
maestro-cli notify flash "Cache cleared" --detail "1.2 GB freed" --timeout 3
```

| Flag            | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `-c, --color`   | `green \| yellow \| orange \| red \| theme` (default: `theme`) |
| `-D, --detail`  | Optional mono-font second line shown beneath the message       |
| `-t, --timeout` | Auto-dismiss after N seconds (range: `(0, 5]`; default 1.5)    |
| `--json`        | JSON output for scripting                                      |

##### Caps and dismissibility

External (CLI/web) callers are capped to **5 seconds** for Center Flash and **60 seconds** for Toast. The cap exists so external scripts can't stick a permanent overlay on the user. The only way to leave a notification on screen indefinitely is `--dismissible` on a toast - there is no equivalent for Center Flash (it is, by design, momentary).

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
branch, dispatches the agent inside the worktree, and - when `--create-pr` is
set - runs `gh pr create` once the batch completes. See
[Git Worktrees](git-worktrees.md) for more on worktree behavior.

### Controlling a Running Auto Run

Once an Auto Run is going, these commands stop it or recover it from an error pause - the counterpart to launching with `auto-run --launch`. They require the desktop app to be running.

```bash
# Stop the active Auto Run for an agent
maestro-cli stop-auto-run -a <agent-id>

# When an Auto Run pauses on an error, choose how to proceed:
maestro-cli resume-auto-run -a <agent-id>   # clear the error and continue
maestro-cli skip-auto-run -a <agent-id>     # skip the failing document, continue with the next
maestro-cli abort-auto-run -a <agent-id>    # stop the run entirely

# Revert all completed [x] tasks back to [ ] in one document so it can re-run
maestro-cli reset-auto-run-tasks loop/step-1.md -a <agent-id>

# Delete a saved playbook (find IDs with "list playbooks -a <agent-id>")
maestro-cli remove-playbook <agent-id> <playbook-id>
```

The filename for `reset-auto-run-tasks` is relative to the agent's Auto Run folder; absolute paths and `..` traversal are rejected.

### Checking Status

Check if the Maestro desktop app is running and reachable:

```bash
maestro-cli status
```

Returns the app version, uptime, and connection status.

### Diagnosing Problems (`doctor`)

When a command isn't working, `doctor` runs a checklist covering the most common causes in one shot: the desktop app reachable, the running build's version vs. this CLI's, whether the running app understands newer commands, and whether configured SSH remotes are well-formed.

```bash
maestro-cli doctor
maestro-cli doctor --json
```

```
  ✓ Discovery file present - port 54748
  ✓ App process alive - pid 10510
  ⚠ Version match - App is 0.17.1 but CLI is 0.17.2. Rebuild/restart whichever is behind.
  ✓ WebSocket reachable
  ✓ App handles commands
  ✓ SSH remotes - 2 configured, all well-formed
```

The version and "App handles commands" checks catch the most common gotcha: a freshly-built CLI talking to an older desktop app that's still running. When the app is behind, new commands fail because their handlers don't exist in the running build - rebuild and restart the desktop app. The CLI surfaces this directly: a command the running app doesn't recognize fails fast with "The running Maestro app does not support the '...' command" instead of a generic timeout.

### Shell Completions

Generate a completion script for your shell and source it:

```bash
# zsh - add to a directory on your fpath, or source from ~/.zshrc
maestro-cli completions zsh > ~/.maestro-cli-completion.zsh
echo 'source ~/.maestro-cli-completion.zsh' >> ~/.zshrc

# bash
maestro-cli completions bash >> ~/.bashrc

# fish
maestro-cli completions fish > ~/.config/fish/completions/maestro-cli.fish
```

The script is generated by introspecting the live command tree, so regenerating it after a CLI upgrade picks up new commands and flags automatically. The full command list is also available as `maestro-cli reference` (Markdown or `--format json`); [docs/cli-reference.md](cli-reference.md) is generated from it via `npm run gen:cli-reference`.

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
| `-d, --description <text>` | Gist description                       | -       |
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

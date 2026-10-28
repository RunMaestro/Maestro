---
title: CLI Reference
description: Every maestro-cli command, argument, and option, generated from the live command tree.
icon: book
---

# maestro-cli Command Reference

> Generated from the CLI command tree by `maestro-cli reference`. Do not edit by hand - run `npm run gen:cli-reference` to refresh.

## `maestro-cli lite`

Control a running isolated Maestro Lite client through its native connection actions (JSON output)

| Option               | Description                                                                       | Default |
| -------------------- | --------------------------------------------------------------------------------- | ------- |
| `--user-data <path>` | Final isolated Lite user-data directory (same as Maestro --lite --lite-user-data) | -       |
| `--json`             | Output JSON (Lite controls always return JSON)                                    | -       |

## `maestro-cli lite profile`

Read and manage local Lite connection profiles through the running client

## `maestro-cli lite profile list`

Read saved Lite profiles and current connection state

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite profile list --json
```

## `maestro-cli lite profile read <id>`

Read one saved profile, including validated host identity

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite profile read <profile-id> --json
```

## `maestro-cli lite profile save`

Save a complete profile JSON using native URL, SSH, and identity validation; returns the saved profile

| Option          | Description                                                                                | Default |
| --------------- | ------------------------------------------------------------------------------------------ | ------- |
| `--file <path>` | Profile JSON file (same fields as profile read; id, name, transport, url, and ssh for SSH) | -       |
| `--json`        | Output JSON                                                                                | -       |

```bash
maestro-cli lite profile save --file profile.json
```

## `maestro-cli lite profile remove <id>`

Remove local connection preferences only; never stops host work

| Option   | Description                                                 | Default |
| -------- | ----------------------------------------------------------- | ------- |
| `--yes`  | Explicitly confirm profile deletion without a native dialog | -       |
| `--json` | Output JSON                                                 | -       |

```bash
maestro-cli lite profile remove <profile-id> --yes
```

## `maestro-cli lite profile reset-identity <id>`

Disconnect and forget the validated host identity; verify the host out of band before connecting again

| Option   | Description                                               | Default |
| -------- | --------------------------------------------------------- | ------- |
| `--yes`  | Explicitly confirm identity reset without a native dialog | -       |
| `--json` | Output JSON                                               | -       |

```bash
maestro-cli lite profile reset-identity <profile-id> --yes
```

## `maestro-cli lite connect <id>`

Connect to a saved profile using the native TLS, SSH, authentication, and identity checks

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite connect <profile-id>
```

## `maestro-cli lite discovery`

Local-network and consented Tailscale peer or advertised Service discovery

## `maestro-cli lite discovery show`

Show the native discovery view in the Lite client

```bash
maestro-cli lite discovery show
```

## `maestro-cli lite discovery status`

Read the discovered hosts, each with its key and generation, and any pairing state

```bash
maestro-cli lite discovery status
```

## `maestro-cli lite discovery stop`

Stop browsing for hosts; saved profiles and connections are not changed

```bash
maestro-cli lite discovery stop
```

## `maestro-cli lite discovery start`

Start browsing for hosts on the local network and through Tailscale

| Option               | Description                                                                                                        | Default |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| `--interface <ipv4>` | Advanced override: use one approved LAN interface instead of automatic selection                                   | -       |
| `--no-lan`           | Do not browse local-network advertisements                                                                         | -       |
| `--no-tailscale`     | Do not read existing Tailscale client service metadata                                                             | -       |
| `--tailscale-peers`  | Allow direct HTTP Maestro checks on Tailscale TCP 56036 for up to 32 existing peers per refresh; no login or trust | -       |

```bash
maestro-cli lite discovery start
maestro-cli lite discovery start --no-tailscale
```

## `maestro-cli lite discovery import`

Read an expiring host invitation from stdin; never connect or save trust

```bash
maestro-cli lite discovery import < invitation.txt
```

## `maestro-cli lite pair`

Attended metadata-only PIN proof; never creates a full Maestro login

## `maestro-cli lite pair request <key>`

Ask a discovered host to pair with this client; the host shows a six-digit PIN to the person there

| Option             | Description                      | Default |
| ------------------ | -------------------------------- | ------- |
| `--generation <n>` | Generation from discovery status | -       |
| `--name <label>`   | Self-asserted client label       | -       |

```bash
maestro-cli lite pair request <host-key> --generation 3 --name "Work laptop"
```

## `maestro-cli lite pair submit`

Answer the active pairing request with the PIN the host showed

| Option        | Description                                          | Default |
| ------------- | ---------------------------------------------------- | ------- |
| `--pin-stdin` | Read six-digit PIN from stdin, not process arguments | -       |

```bash
maestro-cli lite pair submit --pin-stdin < pin.txt
```

## `maestro-cli lite pair read`

Read the connection details the host released to the completed pairing

```bash
maestro-cli lite pair read
```

## `maestro-cli lite pair cancel`

Cancel the active pairing request; nothing is saved

```bash
maestro-cli lite pair cancel
```

## `maestro-cli lite status`

Read connection status, errors, selected profile, and local presentation state

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite status --json
```

## `maestro-cli lite reconnect`

Reconnect the selected profile without replaying host commands

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite reconnect
```

## `maestro-cli lite disconnect`

Disconnect this client and stop only its owned SSH tunnel; host work continues

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite disconnect
```

## `maestro-cli lite connections`

Show the native connection picker

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite connections
```

## `maestro-cli lite commands`

Show the native connection command palette

| Option   | Description | Default |
| -------- | ----------- | ------- |
| `--json` | Output JSON | -       |

```bash
maestro-cli lite commands
```

## `maestro-cli lite dismiss`

Return to the remote view or stay on setup; never close Lite

| Option   | Description                                           | Default |
| -------- | ----------------------------------------------------- | ------- |
| `--json` | Output JSON                                           | -       |
| `--yes`  | Accepted for compatibility; dismiss never closes Lite | -       |

```bash
maestro-cli lite dismiss
```

## `maestro-cli lite close`

Close Maestro Lite only; host work continues

| Option   | Description                                                    | Default |
| -------- | -------------------------------------------------------------- | ------- |
| `--json` | Output JSON                                                    | -       |
| `--yes`  | Explicitly confirm closing this client without a native dialog | -       |

```bash
maestro-cli lite close --yes
```

## `maestro-cli agent-run`

Record and inspect agent runs

## `maestro-cli agent-run record`

Record or update an agent run from a JSON file

| Option          | Description                    | Default |
| --------------- | ------------------------------ | ------- |
| `--file <json>` | Agent run JSON file            | -       |
| `--json`        | Output as JSON (for scripting) | -       |

```bash
maestro-cli agent-run record --file run.json
```

## `maestro-cli agent-run append-event <run-id>`

Append an event to an agent run

| Option              | Description                           | Default |
| ------------------- | ------------------------------------- | ------- |
| `--type <type>`     | Event type                            | -       |
| `--status <status>` | Update the run status with this event | -       |
| `--message <text>`  | Human-readable event message          | -       |
| `--json`            | Output as JSON (for scripting)        | -       |

```bash
maestro-cli agent-run append-event <run-id> --type progress --message "Tests passed"
```

## `maestro-cli agent-run list`

List recent agent runs

| Option              | Description                    | Default |
| ------------------- | ------------------------------ | ------- |
| `--status <status>` | Filter by run status           | -       |
| `--campaign <id>`   | Filter by campaign id          | -       |
| `--limit <n>`       | Maximum number of runs to show | -       |
| `--json`            | Output as JSON (for scripting) | -       |

```bash
maestro-cli agent-run list --status running --limit 10 --json
```

## `maestro-cli agent-run show <run-id>`

Show an agent run and its events

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli agent-run show <run-id> --json
```

## `maestro-cli campaign`

Record and inspect agent campaigns

## `maestro-cli campaign record`

Record or update a campaign from a JSON file

| Option          | Description                    | Default |
| --------------- | ------------------------------ | ------- |
| `--file <json>` | Campaign JSON file             | -       |
| `--json`        | Output as JSON (for scripting) | -       |

```bash
maestro-cli campaign record --file campaign.json
```

## `maestro-cli campaign list`

List campaigns

| Option              | Description                         | Default |
| ------------------- | ----------------------------------- | ------- |
| `--status <status>` | Filter by campaign status           | -       |
| `--limit <n>`       | Maximum number of campaigns to show | -       |
| `--json`            | Output as JSON (for scripting)      | -       |

```bash
maestro-cli campaign list --limit 10 --json
```

## `maestro-cli campaign show <id>`

Show a campaign

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli campaign show <campaign-id> --json
```

## `maestro-cli list`

List resources

## `maestro-cli list groups`

List all session groups

| Option   | Description                          | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Output as JSON lines (for scripting) | -       |

```bash
maestro-cli list groups --json
```

## `maestro-cli list agents`

List all agents

| Option             | Description                          | Default |
| ------------------ | ------------------------------------ | ------- |
| `-g, --group <id>` | Filter by group ID                   | -       |
| `--json`           | Output as JSON lines (for scripting) | -       |

```bash
maestro-cli list agents --group <group-id> --json
```

## `maestro-cli list playbooks`

List playbooks (optionally filter by agent)

| Option             | Description                           | Default |
| ------------------ | ------------------------------------- | ------- |
| `-a, --agent <id>` | Agent ID (shows all if not specified) | -       |
| `--json`           | Output as JSON lines (for scripting)  | -       |

```bash
maestro-cli list playbooks --agent <agent-id>
```

## `maestro-cli list sessions <agent-id>`

List agent sessions (most recent first)

| Option                   | Description                                            | Default |
| ------------------------ | ------------------------------------------------------ | ------- |
| `-l, --limit <count>`    | Maximum number of sessions to show (default: 25)       | -       |
| `-k, --skip <count>`     | Number of sessions to skip for pagination (default: 0) | -       |
| `-s, --search <keyword>` | Filter sessions by keyword in name or first message    | -       |
| `--json`                 | Output as JSON (for scripting)                         | -       |

```bash
maestro-cli list sessions <agent-id> --limit 10 --search "auth"
```

## `maestro-cli list ssh-remotes`

List all configured SSH remotes

| Option   | Description                          | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Output as JSON lines (for scripting) | -       |

```bash
maestro-cli list ssh-remotes --json
```

## `maestro-cli list terminals`

List open terminal tabs in the desktop app (all agents unless --agent is given)

| Option             | Description                                 | Default |
| ------------------ | ------------------------------------------- | ------- |
| `-a, --agent <id>` | Only list terminals belonging to this agent | -       |
| `--json`           | Output as JSON (for scripting)              | -       |

```bash
maestro-cli list terminals --agent <agent-id>
```

## `maestro-cli show`

Show details of a resource

## `maestro-cli show agent <id>`

Show agent details: settings, the environment it is spawned with, peers, history and usage stats

| Option           | Description                                               | Default |
| ---------------- | --------------------------------------------------------- | ------- |
| `--json`         | Output as JSON (for scripting)                            | -       |
| `--show-secrets` | Print secret environment values in full instead of masked | -       |

```bash
maestro-cli show agent <agent-id> --json
maestro-cli show agent <agent-id> --show-secrets
```

## `maestro-cli show playbook <id>`

Show detailed information about a playbook

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli show playbook <playbook-id>
```

## `maestro-cli playbook <playbook-id>`

Run a playbook

| Option                 | Description                                                                                                 | Default |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| `--dry-run`            | Show what would be executed without running                                                                 | -       |
| `--no-history`         | Do not write history entries                                                                                | -       |
| `--json`               | Output as JSON lines (for scripting)                                                                        | -       |
| `--debug`              | Show detailed debug output for troubleshooting                                                              | -       |
| `--verbose`            | Show full prompt sent to agent on each iteration                                                            | -       |
| `--no-synopsis`        | Skip synopsis generation after each task (reduces overhead)                                                 | -       |
| `--wait`               | Wait for agent to become available if busy                                                                  | -       |
| `--model <model>`      | Model to use for this run only, overriding the agent's configured default                                   | -       |
| `--effort <effort>`    | Reasoning effort for this run only, overriding the agent's configured default                               | -       |
| `--ignore-model-hints` | Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default) | -       |

```bash
maestro-cli playbook <playbook-id> --dry-run
maestro-cli playbook <playbook-id> --wait --json
```

## `maestro-cli goal-run <agent-id> <goal>`

Launch a Goal-Driven Auto Run: pursue a free-text goal until done

| Option                   | Description                                                                   | Default |
| ------------------------ | ----------------------------------------------------------------------------- | ------- |
| `--exit-criteria <text>` | What "done" looks like and when to declare a deadlock                         | -       |
| `--max-iterations <n>`   | Cap iterations (default: infinite)                                            | -       |
| `--no-history`           | Do not write history entries                                                  | -       |
| `--json`                 | Output as JSON lines (for scripting)                                          | -       |
| `--verbose`              | Show full prompt sent to agent on each iteration                              | -       |
| `--visible`              | Run inside the Maestro desktop app (visible Auto Run) instead of headlessly   | -       |
| `--wait`                 | With --visible, wait for the agent to become available if busy                | -       |
| `--model <model>`        | Model to use for this run only, overriding the agent's configured default     | -       |
| `--effort <effort>`      | Reasoning effort for this run only, overriding the agent's configured default | -       |

```bash
maestro-cli goal-run <agent-id> "Make the build pass" --exit-criteria "npm test exits 0" --max-iterations 5
```

## `maestro-cli run-doc <docs>`

Run one or more Auto Run documents headlessly (no saved playbook required)

| Option                  | Description                                                                                                 | Default |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`      | Target agent by ID or name (use "maestro-cli list agents" to find agents)                                   | -       |
| `-p, --prompt <text>`   | Custom prompt for the run (defaults to the Auto Run prompt)                                                 | -       |
| `--loop`                | Enable looping                                                                                              | -       |
| `--max-loops <n>`       | Maximum loop count (implies --loop)                                                                         | -       |
| `--reset-on-completion` | Enable reset-on-completion for all documents                                                                | -       |
| `--dry-run`             | Show what would be executed without running                                                                 | -       |
| `--no-history`          | Do not write history entries                                                                                | -       |
| `--json`                | Output as JSON lines (for scripting)                                                                        | -       |
| `--debug`               | Show detailed debug output for troubleshooting                                                              | -       |
| `--verbose`             | Show full prompt sent to agent on each iteration                                                            | -       |
| `--no-synopsis`         | Skip synopsis generation after each task (reduces overhead)                                                 | -       |
| `--wait`                | Wait for agent to become available if busy                                                                  | -       |
| `--model <model>`       | Model to use for this run only, overriding the agent's configured default                                   | -       |
| `--effort <effort>`     | Reasoning effort for this run only, overriding the agent's configured default                               | -       |
| `--ignore-model-hints`  | Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default) | -       |

```bash
maestro-cli run-doc ./tasks.md --agent <agent-id> --wait
```

## `maestro-cli clean`

Clean up orphaned resources

## `maestro-cli clean playbooks`

Remove playbooks for deleted sessions

| Option      | Description                                          | Default |
| ----------- | ---------------------------------------------------- | ------- |
| `--dry-run` | Show what would be removed without actually removing | -       |
| `--json`    | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli clean playbooks --dry-run
```

## `maestro-cli send <agent-id> <message>`

Send a message to an agent and get a JSON response

| Option                             | Description                                                                                                                                             | Default |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-s, --session <id>`               | Resume an existing agent session (for multi-turn conversations)                                                                                         | -       |
| `-r, --read-only`                  | Run in read-only/plan mode (agent cannot modify files)                                                                                                  | -       |
| `-t, --tab`                        | Open/focus the session tab in Maestro desktop                                                                                                           | -       |
| `--model <model>`                  | Run this one turn on a model other than the agent's own. "auto" asks the model router for the tier and effort this message needs (see: s1 route)        | -       |
| `--require-plugin-tools`           | Fail if a desktop-backed run with plugin tools is unavailable                                                                                           | -       |
| `--require-tool-receipt <tool-id>` | Require a host-observed delivery receipt from this plugin tool ID                                                                                       | -       |
| `--no-system-prompt`               | Skip the Maestro system prompt (agent identity, git branch, history path, conductor profile). Default is to include it for parity with the desktop app. | -       |
| `--no-history`                     | Do not write a History entry for this turn (written by default, desktop app running or not)                                                             | -       |
| `--no-synopsis`                    | Skip the synopsis turn; the History entry carries the response instead                                                                                  | -       |
| `--json`                           | Output as JSON (this verb always does; accepted so every verb takes --json)                                                                             | -       |

```bash
maestro-cli send <agent-id> "Summarize the open TODOs" --json
maestro-cli send <agent-id> "Now fix the first one" --session <session-id>
maestro-cli send <agent-id> "Review the diff" --read-only
```

## `maestro-cli dispatch <agent-id> <message>`

Dispatch a prompt to an agent in the Maestro desktop app and return its tab/session ID

| Option                            | Description                                                                                                                                                                                                                                                                                                                                                                                    | Default |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--new-tab`                       | Create a fresh AI tab and deliver the prompt into it. The tab is hidden by default: it is named from the prompt but draws no chip until the user opens it from the completion toast or the delegation pill. A working agent cannot start a second turn, so the prompt is queued for the new tab and runs when the current turn ends (the response reports queued: true).                       | -       |
| `--visible`                       | With --new-tab: give the new tab a chip in the tab strip instead of creating it hidden (it still opens in the background unless --focus)                                                                                                                                                                                                                                                       | -       |
| `--background`                    | Leave the view where it is (default with --new-tab; suppresses the agent switch otherwise)                                                                                                                                                                                                                                                                                                     | -       |
| `-t, --tab <id>`                  | Target an existing tab by its tab id (mutually exclusive with --new-tab)                                                                                                                                                                                                                                                                                                                       | -       |
| `-f, --force`                     | Bypass the busy-state guard when writing to a busy tab; requires allowConcurrentSend (cannot be combined with --new-tab, which queues instead)                                                                                                                                                                                                                                                 | -       |
| `--focus`                         | Switch to and focus the target agent/tab when dispatching (by default dispatch runs in the background without stealing focus)                                                                                                                                                                                                                                                                  | -       |
| `--queue`                         | If the target tab is busy, queue the prompt into the execution queue (FIFO) instead of rejecting it; an idle target dispatches immediately. Cannot be combined with --new-tab (which already queues when the agent is busy) or --force. Returns the queue position.                                                                                                                            | -       |
| `--wait`                          | Alias for --queue                                                                                                                                                                                                                                                                                                                                                                              | -       |
| `--routing <mode>`                | How the message's @mentions run, like the composer's routing strip: parallel (both answer, this agent waits for the reply), consult-first (the mentioned agent answers first), handoff (this agent's answer is sent on), or only (just the mentioned agents answer). Overrides what the wording implies. Requires an @mention of another agent in the message; read it back with `queue list`. | -       |
| `--held`                          | Queue the prompt PAUSED, even when the agent is idle, like the Send menu's Queue Held. It keeps its place until `queue resume <item-id>`. Implies --queue; returns the item id.                                                                                                                                                                                                                | -       |
| `--notify-on-complete <agent-id>` | Wake this agent with a real turn in its live tab when THIS dispatch finishes. Correlated to the dispatched tab, fires exactly once, and waits for a multi-task Auto Run to finish rather than firing per task. Requires --new-tab or --tab.                                                                                                                                                    | -       |
| `--callback-tab <id>`             | Specific tab of the --notify-on-complete agent to wake (default: the calling tab when an agent notifies itself, else its active AI tab)                                                                                                                                                                                                                                                        | -       |
| `--callback-prompt <text>`        | Override the callback prompt body. \{\{DISPATCH_STATUS\}\}, \{\{DISPATCH_TAB_ID\}\}, \{\{DISPATCH_TARGET_ID\}\}, \{\{DISPATCH_OUTPUT\}\}, \{\{DISPATCH_DURATION\}\}, \{\{DISPATCH_TASKS_COMPLETED\}\}, \{\{DISPATCH_TASKS_TOTAL\}\}, \{\{DISPATCH_PROMPT\}\} and \{\{DISPATCH_CALLBACK_ID\}\} are substituted.                                                                                 | -       |
| `--callback-timeout <seconds>`    | Give up and fire a timeout callback after this long (default 3600, max 86400)                                                                                                                                                                                                                                                                                                                  | -       |
| `--json`                          | Output as JSON (this verb always does; accepted so every verb takes --json)                                                                                                                                                                                                                                                                                                                    | -       |

```bash
maestro-cli dispatch <agent-id> "Run the tests"
maestro-cli dispatch <agent-id> "Start a review pass" --new-tab
```

## `maestro-cli ask <agent-id> <question>`

Ask another agent a question and print its answer (background consult - never touches the target's open conversation)

| Option                | Description                                                                                                                                                                                                                                  | Default |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--from <agent-id>`   | Your own agent id. Names the consult on the target, keeps continuity across repeat asks, forwards your working directory so it can read your project, and lets Stop cancel the consult. Defaults to the agent this runs under inside Maestro | -       |
| `--with-context`      | Forward your current transcript as context. Off by default: ask sends a self-contained question in a fresh context                                                                                                                           | -       |
| `--timeout <seconds>` | How long to wait for the answer (default 600, min 10, max 3600)                                                                                                                                                                              | -       |
| `--json`              | Output the answer as JSON                                                                                                                                                                                                                    | -       |

```bash
maestro-cli ask <agent-id> "Which module owns retries?" --from <your-agent-id>
```

`ask` is a background consult: it prints an answer without touching the target agent's open conversation. `dispatch` hands over work and returns a tab ID; with `--new-tab`, background tabs are hidden unless `--visible` is passed. Ask a self-contained question, or pass `--with-context` to include your transcript. The consult is recorded in the target's history.

```bash
maestro-cli ask "Substrate PedTome" "How does your authentication gate work?" --from "$MY_AGENT_ID"
```

## `maestro-cli queue`

Inspect and manage the desktop execution queue (from dispatch --queue)

## `maestro-cli queue list`

List queued execution items as JSON (all agents, or one with --agent)

| Option             | Description                                                                 | Default |
| ------------------ | --------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Only list items for this agent (default: every agent with queued items)     | -       |
| `--json`           | Output as JSON (this verb always does; accepted so every verb takes --json) | -       |

```bash
maestro-cli queue list --agent <agent-id>
```

## `maestro-cli queue remove <item-id>`

Remove a queued item by its id (from dispatch --queue output or queue list)

| Option             | Description                                                                 | Default |
| ------------------ | --------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required)                            | -       |
| `--json`           | Output as JSON (this verb always does; accepted so every verb takes --json) | -       |

```bash
maestro-cli queue remove <item-id> --agent <agent-id>
```

## `maestro-cli queue hold <item-id>`

Hold a queued item, like the Hold button on its queued card: it keeps its place but does not run until resumed

| Option             | Description                                      | Default |
| ------------------ | ------------------------------------------------ | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required) | -       |

```bash
maestro-cli queue hold <item-id> --agent <agent-id>
```

## `maestro-cli queue resume <item-id>`

Resume a held queued item, like the Resume button on its queued card: it runs when its turn comes

| Option             | Description                                      | Default |
| ------------------ | ------------------------------------------------ | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required) | -       |

```bash
maestro-cli queue resume <item-id> --agent <agent-id>
```

## `maestro-cli queue merge <item-id>`

Merge a queued message into the message above it on the same tab, like the Merge button on its queued card: the two are sent as one message, in the upper one's place

| Option             | Description                                      | Default |
| ------------------ | ------------------------------------------------ | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required) | -       |

```bash
maestro-cli queue merge <item-id> --agent <agent-id>
```

## `maestro-cli queue steer <item-id>`

Steer a queued message into the turn already running on its tab, like the Steer button on the queued card (Claude agents on the interactive token source, or Codex agents on the app-server transport). The item leaves the queue once the agent has it and returns if the agent never takes it.

| Option             | Description                                                                 | Default |
| ------------------ | --------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required)                            | -       |
| `--json`           | Output as JSON (this verb always does; accepted so every verb takes --json) | -       |

```bash
maestro-cli queue steer <item-id> --agent <agent-id>
```

## `maestro-cli window`

List Maestro windows, and move agents or whole groups between them

## `maestro-cli window list`

List open windows and the agents each one holds

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli window list
```

## `maestro-cli window move-agent <agent-id>`

Move an agent (with its worktrees) to another window

| Option          | Description                                                   | Default |
| --------------- | ------------------------------------------------------------- | ------- |
| `--to <window>` | "new", "main", a window number, a window id, or a window name | -       |
| `--json`        | Output as JSON                                                | -       |

```bash
maestro-cli window move-agent <agent-id> --to new
```

## `maestro-cli window move-group <group-id>`

Move every agent in a group (with subgroups when nesting is on) to another window

| Option          | Description                                                   | Default |
| --------------- | ------------------------------------------------------------- | ------- |
| `--to <window>` | "new", "main", a window number, a window id, or a window name | -       |
| `--json`        | Output as JSON                                                | -       |

```bash
maestro-cli window move-group <group-id> --to main
```

## `maestro-cli snooze`

Park a tab until later, and manage what is parked

## `maestro-cli snooze tab <tab-id> <when>`

Snooze a tab or tiled group until &lt;when> (e.g. 2h, tomorrow, "next fri 3pm")

| Option                     | Description                                                                                                     | Default |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`         | Agent that owns the tab. Required for a file, terminal, browser, or group tab, which are not in the AI tab list | -       |
| `-n, --note <text>`        | Note-to-self surfaced in the wake notification                                                                  | -       |
| `-p, --wake-prompt <text>` | Prompt sent to the agent the moment the tab comes back (AI tabs and groups only)                                | -       |
| `--background`             | Park it without flashing the "Snoozed until ..." confirmation                                                   | -       |
| `--focus`                  | Show the confirmation flash (the default)                                                                       | -       |
| `--json`                   | Output the stored snooze as JSON                                                                                | -       |

```bash
maestro-cli snooze tab <tab-id> 2h --note "Check the deploy"
maestro-cli snooze tab <tab-id> "tomorrow 9am" --wake-prompt "Continue where you left off"
```

## `maestro-cli snooze list`

List snoozed tabs across every agent, soonest wake first

| Option             | Description                          | Default |
| ------------------ | ------------------------------------ | ------- |
| `-a, --agent <id>` | Only list snoozes held by this agent | -       |
| `--json`           | Output as JSON                       | -       |

```bash
maestro-cli snooze list --agent <agent-id>
```

## `maestro-cli snooze wake <snooze-id>`

Bring a snoozed tab back right now (accepts a unique id prefix)

| Option         | Description                                                       | Default |
| -------------- | ----------------------------------------------------------------- | ------- |
| `--background` | Accepted and ignored: a wake restores the tab without focusing it | -       |
| `--focus`      | Accepted and ignored: a wake restores the tab without focusing it | -       |
| `--json`       | Output as JSON                                                    | -       |

```bash
maestro-cli snooze wake <snooze-id>
```

## `maestro-cli snooze dismiss <snooze-id>`

Drop a snooze and its tab - it won't come back

| Option         | Description                                             | Default |
| -------------- | ------------------------------------------------------- | ------- |
| `--background` | Dismiss it without raising the "Snooze dismissed" toast | -       |
| `--focus`      | Raise the toast (the default)                           | -       |
| `--json`       | Output as JSON                                          | -       |

```bash
maestro-cli snooze dismiss <snooze-id>
```

## `maestro-cli snooze reschedule <snooze-id> <when>`

Move a snooze to a new time, optionally rewriting its note or wake prompt

| Option                     | Description                                         | Default |
| -------------------------- | --------------------------------------------------- | ------- |
| `-n, --note <text>`        | Replace the note (pass an empty string to clear it) | -       |
| `-p, --wake-prompt <text>` | Replace the wake prompt (empty string clears it)    | -       |
| `--json`                   | Output as JSON                                      | -       |

```bash
maestro-cli snooze reschedule <snooze-id> "next fri 3pm"
```

## `maestro-cli snooze history`

Snoozes that have already resolved - woken, unsnoozed, or dismissed

| Option        | Description                         | Default |
| ------------- | ----------------------------------- | ------- |
| `--limit <n>` | Only show the newest &lt;n> entries | -       |
| `--json`      | Output as JSON                      | -       |

```bash
maestro-cli snooze history --limit 20
```

## `maestro-cli unsnooze <snooze-id>`

Bring a snoozed tab back right now (alias for "snooze wake")

| Option         | Description                                                       | Default |
| -------------- | ----------------------------------------------------------------- | ------- |
| `--background` | Accepted and ignored: a wake restores the tab without focusing it | -       |
| `--focus`      | Accepted and ignored: a wake restores the tab without focusing it | -       |
| `--json`       | Output as JSON                                                    | -       |

```bash
maestro-cli unsnooze <snooze-id>
```

## `maestro-cli throughput-gauge`

Show, hide, configure, or read the Throughput Gauge (tokens per second)

## `maestro-cli throughput-gauge show`

Put the gauge on screen (does not move focus)

| Option   | Description                     | Default |
| -------- | ------------------------------- | ------- |
| `--json` | Output the gauge status as JSON | -       |

```bash
maestro-cli throughput-gauge show
```

## `maestro-cli throughput-gauge hide`

Take the gauge off screen

| Option   | Description                     | Default |
| -------- | ------------------------------- | ------- |
| `--json` | Output the gauge status as JSON | -       |

```bash
maestro-cli throughput-gauge hide
```

## `maestro-cli throughput-gauge toggle`

Flip the gauge on or off screen, like the hotkey (scripts should prefer show / hide)

| Option   | Description                     | Default |
| -------- | ------------------------------- | ------- |
| `--json` | Output the gauge status as JSON | -       |

```bash
maestro-cli throughput-gauge toggle
```

## `maestro-cli throughput-gauge set`

Change one or more gauge settings, like the gear on the gauge

| Option               | Description                                              | Default |
| -------------------- | -------------------------------------------------------- | ------- |
| `--scope <scope>`    | Whose output to count: all \| active                     | -       |
| `--metric <metric>`  | Which reading to show: combined \| in \| out             | -       |
| `--layout <layout>`  | One gauge or all three: single \| all                    | -       |
| `--style <style>`    | How the reading is drawn: dial \| vu \| lcd \| sparkline | -       |
| `--window <seconds>` | Rolling-average window in seconds: 5 \| 10 \| 30 \| 60   | -       |
| `--json`             | Output the gauge status as JSON                          | -       |

```bash
maestro-cli throughput-gauge set --metric out --style vu --window 10
```

## `maestro-cli throughput-gauge reset-peak`

Start the peak mark again from the current reading

| Option   | Description                     | Default |
| -------- | ------------------------------- | ------- |
| `--json` | Output the gauge status as JSON | -       |

```bash
maestro-cli throughput-gauge reset-peak
```

## `maestro-cli throughput-gauge status`

Read visibility, settings, live rates, and peaks

| Option   | Description                                                        | Default |
| -------- | ------------------------------------------------------------------ | ------- |
| `--json` | Output as JSON (enabled, visible, settings, rates, peak, windowMs) | -       |

```bash
maestro-cli throughput-gauge status --json
```

## `maestro-cli session`

Inspect open desktop tabs and their conversation history

## `maestro-cli session list`

List open desktop AI tabs and their tab/session IDs

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli session list --json
```

## `maestro-cli session show <tab-id>`

Print conversation history for a desktop tab

| Option                | Description                                                          | Default |
| --------------------- | -------------------------------------------------------------------- | ------- |
| `--since <timestamp>` | Only return messages after this timestamp (ISO-8601 or epoch ms/sec) | -       |
| `--tail <n>`          | Only return the last N messages (applied after --since)              | -       |
| `--json`              | Output as JSON (for scripting); default is a formatted transcript    | -       |

```bash
maestro-cli session show <tab-id> --tail 20
```

## `maestro-cli timeline`

Show what happened, oldest first: agent turns, user actions in Maestro, commits

| Option             | Description                                              | Default |
| ------------------ | -------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent ID or name (default: every agent)                  | -       |
| `--since <time>`   | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 1d)  | -       |
| `--until <time>`   | End (default now)                                        | -       |
| `--sources <list>` | Comma list of sources (default history,journey,git)      | -       |
| `--tail <n>`       | Only the newest N events (default 30)                    | -       |
| `--per-source <n>` | Only the newest N events of each source (default 15)     | -       |
| `--grep <text>`    | Only events whose line matches (regex, case-insensitive) | -       |
| `--json`           | Output as JSON (for scripting)                           | -       |

## `maestro-cli timeline show <entry>`

Show one agent turn in full (its reply, tab, and timing) by an [entry &lt;id>] handle

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent ID or name (default: search every agent) | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

## `maestro-cli journey`

Show what the user did in Maestro: files opened/saved/renamed, pages browsed

| Option                | Description                                                           | Default |
| --------------------- | --------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`    | Agent ID or name (default: every agent)                               | -       |
| `--since <timestamp>` | Only entries at or after this time (ISO-8601 or epoch ms/sec)         | -       |
| `--tail <n>`          | Only the newest N entries per agent (applied after the other filters) | -       |
| `--kind <kinds>`      | Comma list of kinds, e.g. file.save,browser.navigate                  | -       |
| `--json`              | Output as JSON (for scripting)                                        | -       |

## `maestro-cli group-chat`

Start, message, and inspect group chats in the desktop app

## `maestro-cli group-chat start <name>`

Create a group chat and send its moderator the opening message

| Option                      | Description                                                                       | Default |
| --------------------------- | --------------------------------------------------------------------------------- | ------- |
| `-p, --participant <agent>` | Participant agent ID or name (repeatable; at least one)                           | `[]`    |
| `--moderator <agent-type>`  | Moderator agent type (e.g. claude-code); defaults to the first participant's type | -       |
| `-m, --message <text>`      | Opening message for the moderator (defaults to the name)                          | -       |
| `--message-file <path>`     | Read the opening message from a file                                              | -       |
| `--json`                    | Output as JSON (for scripting)                                                    | -       |

```bash
maestro-cli group-chat start "API review" --participant <agent-id> --participant <agent-id> --message "Review the new endpoint"
```

## `maestro-cli group-chat send <chat> [message]`

Send a message to a group chat (ID, ID prefix, or name); refused while busy

| Option                  | Description                    | Default |
| ----------------------- | ------------------------------ | ------- |
| `--message-file <path>` | Read the message from a file   | -       |
| `--json`                | Output as JSON (for scripting) | -       |

```bash
maestro-cli group-chat send <chat> "Summarize where you landed"
```

## `maestro-cli group-chat steer <chat> [message]`

Type a message into the round running in a group chat instead of waiting for it to end

| Option                  | Description                                                   | Default |
| ----------------------- | ------------------------------------------------------------- | ------- |
| `--message-file <path>` | Read the message from a file                                  | -       |
| `--item <queued-id>`    | Steer a message already in the chat queue (ids are in status) | -       |
| `--read-only`           | Only steer new text when the running round is read-only       | -       |
| `--json`                | Output as JSON (for scripting)                                | -       |

```bash
maestro-cli group-chat steer <chat> "Focus on the failing test"
```

## `maestro-cli group-chat status <chat>`

Show a group chat's state, participants, and latest messages

| Option       | Description                                               | Default |
| ------------ | --------------------------------------------------------- | ------- |
| `--tail <n>` | How many recent messages to print (default 5; 0 for none) | -       |
| `--json`     | Output as JSON (for scripting)                            | -       |

```bash
maestro-cli group-chat status <chat> --tail 10
```

## `maestro-cli group-chat list`

List group chats and whether each is busy

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--all`  | Include archived chats         | -       |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli group-chat list --json
```

## `maestro-cli group-chat stop <chat>`

Stop a group chat's moderator and participants

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli group-chat stop <chat>
```

## `maestro-cli group-chat archive <chat>`

Archive a group chat (stops its moderator and participants); --restore brings it back

| Option      | Description                    | Default |
| ----------- | ------------------------------ | ------- |
| `--restore` | Unarchive the chat instead     | -       |
| `--json`    | Output as JSON (for scripting) | -       |

```bash
maestro-cli group-chat archive <chat>
maestro-cli group-chat archive <chat> --restore
```

## `maestro-cli open-file <file-path>`

Open a file as a preview tab in the Maestro desktop app (audio and video play in the floating media player instead; an http(s) URL to an MP4 or audio file streams in the player; a folder is revealed in the Files panel)

| Option             | Description                                                                                   | Default |
| ------------------ | --------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent (defaults to auto-detect by file path's owning agent)                            | -       |
| `--background`     | Open the preview tab without changing anything currently rendered, on any agent               | -       |
| `--focus`          | Switch to the file after opening it (default)                                                 | -       |
| `--no-switch`      | Don't switch to the target agent, but still activate the tab there                            | -       |
| `--queue`          | Audio/video only: add to the media player queue and show the player without starting playback | -       |
| `--json`           | Output as JSON (for scripting)                                                                | -       |

```bash
maestro-cli open-file ./README.md --agent <agent-id> --background
```

## `maestro-cli open-graph [paths]`

Open the Document Graph over specific markdown files or a directory

| Option             | Description                                                      | Default |
| ------------------ | ---------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent (defaults to auto-detect by path's owning agent)    | -       |
| `--focus <path>`   | Center the graph on this document (default: the most-linked one) | -       |
| `--json`           | Output as JSON (for scripting)                                   | -       |

```bash
maestro-cli open-graph ./docs --agent <agent-id>
```

## `maestro-cli open-browser <url>`

Open a URL as a browser tab in the Maestro desktop app

| Option             | Description                                                                                                   | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active)                                                                       | -       |
| `--background`     | Create the tab without focusing it or switching agents (use for agent research, then close-browser when done) | -       |
| `--focus`          | Switch to the browser tab after opening it (default)                                                          | -       |
| `--json`           | Output as JSON (for scripting)                                                                                | -       |

```bash
maestro-cli open-browser https://example.com --agent <agent-id> --background
```

## `maestro-cli open [surface]`

Open a Maestro modal or dashboard (use --list to see every surface)

| Option                | Description                                                            | Default |
| --------------------- | ---------------------------------------------------------------------- | ------- |
| `-t, --tab <tab>`     | Deep-link to a tab within the surface                                  | -       |
| `--sub-tab <sub-tab>` | Deep-link to a tab inside that tab (needs --tab)                       | -       |
| `-g, --group <id>`    | Open the surface on one agent group (Delegation Graph, Group Settings) | -       |
| `-a, --agent <id>`    | Open one agent's surface for this agent (Edit Agent)                   | -       |
| `--list`              | List every openable surface, its tabs, and its shortcut                | -       |
| `--json`              | Output as JSON (for scripting)                                         | -       |

```bash
maestro-cli open --list
maestro-cli open settings --tab models --sub-tab library
maestro-cli open delegation-graph --group <group-id>
maestro-cli open agent-settings --agent <agent-id> --tab peers
```

## `maestro-cli image`

List and save images pasted into a Maestro chat

## `maestro-cli image list`

List images pasted into an agent's conversation, newest first

| Option               | Description                               | Default |
| -------------------- | ----------------------------------------- | ------- |
| `-a, --agent <id>`   | Only this agent (defaults to every agent) | -       |
| `-t, --tab <tab-id>` | Only this AI tab                          | -       |
| `--limit <n>`        | Maximum images to show (default: 20)      | -       |
| `--json`             | Output as JSON (for scripting)            | -       |

```bash
maestro-cli image list --agent <agent-id> --limit 10
```

## `maestro-cli image save [target]`

Save a pasted image to disk (target: index, handle, or "latest")

| Option                | Description                                                       | Default |
| --------------------- | ----------------------------------------------------------------- | ------- |
| `-a, --agent <id>`    | Only this agent (defaults to every agent)                         | -       |
| `-t, --tab <tab-id>`  | Only this AI tab                                                  | -       |
| `-o, --output <path>` | File or directory to write (default: a generated name in the cwd) | -       |
| `--all`               | Save every image in scope instead of just the newest              | -       |
| `--force`             | Overwrite an existing file named by --output                      | -       |
| `--json`              | Output as JSON (for scripting)                                    | -       |

```bash
maestro-cli image save latest --output ./screenshot.png
```

## `maestro-cli close-browser <tab-id>`

Close a browser tab in the Maestro desktop app (owning agent resolved by tab ID)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli close-browser <tab-id>
```

## `maestro-cli open-terminal`

Open a new terminal tab in the Maestro desktop app

| Option                | Description                                                                                     | Default |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`    | Target agent by ID (defaults to active)                                                         | -       |
| `--cwd <path>`        | Working directory for the terminal (must be within the agent's cwd)                             | -       |
| `--shell <shell>`     | Shell binary to use (default: zsh)                                                              | -       |
| `--name <name>`       | Display name for the tab                                                                        | -       |
| `--command <command>` | Command to run in the terminal (kept as the startup command, so it re-runs if the tab restarts) | -       |
| `--background`        | Create the tab without moving the view (agent and tab stay put)                                 | -       |
| `--input-required`    | Notify the user that this terminal needs human input                                            | -       |
| `--focus`             | Switch to the terminal tab after opening it (default)                                           | -       |
| `--json`              | Output as JSON (for scripting)                                                                  | -       |

```bash
maestro-cli open-terminal --agent <agent-id> --name "Dev server" --command "npm run dev" --background
```

## `maestro-cli send-terminal [command]`

Run a command in an existing Maestro terminal tab

| Option               | Description                                                               | Default |
| -------------------- | ------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`   | Target agent by ID (defaults to active)                                   | -       |
| `--tab <id-or-name>` | Terminal tab ID or display name (defaults to the agent's active terminal) | -       |
| `--control <letter>` | Send a control character instead of a command (e.g. C for Ctrl-C)         | -       |
| `--no-enter`         | Type the command without pressing Enter                                   | -       |
| `--json`             | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli send-terminal --tab "Dev server" "npm run build"
maestro-cli send-terminal --tab "Dev server" --control C
```

## `maestro-cli read-terminal`

Read a Maestro terminal tab's output

| Option               | Description                                                               | Default |
| -------------------- | ------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`   | Target agent by ID (defaults to active)                                   | -       |
| `--tab <id-or-name>` | Terminal tab ID or display name (defaults to the agent's active terminal) | -       |
| `--tail <n>`         | Return only the last N lines (default: 200)                               | -       |
| `--json`             | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli read-terminal --tab "Dev server" --tail 50
```

## `maestro-cli refresh-files`

Refresh the file tree in the Maestro desktop app (never moves the view)

| Option             | Description                                                               | Default |
| ------------------ | ------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active)                                   | -       |
| `--background`     | Accepted and ignored: this refresh never moves the view or shows a notice | -       |
| `--json`           | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli refresh-files --agent <agent-id>
```

## `maestro-cli refresh-auto-run`

Refresh Auto Run documents in the Maestro desktop app

| Option             | Description                                             | Default |
| ------------------ | ------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active)                 | -       |
| `--background`     | Refresh without switching to the target agent (default) | -       |
| `--focus`          | Switch to the target agent while refreshing             | -       |
| `--json`           | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli refresh-auto-run --agent <agent-id>
```

## `maestro-cli auto-run <docs>`

Configure and optionally launch an auto-run with documents

| Option                        | Description                                                                                                             | Default |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`            | Target agent by ID (use "maestro-cli list agents" to find IDs)                                                          | -       |
| `-p, --prompt <text>`         | Custom prompt for the auto-run                                                                                          | -       |
| `--loop`                      | Enable looping                                                                                                          | -       |
| `--max-loops <n>`             | Maximum loop count (implies --loop)                                                                                     | -       |
| `--save-as <name>`            | Save as a playbook with this name (don't launch)                                                                        | -       |
| `--launch`                    | Start the auto-run immediately (default: just configure)                                                                | -       |
| `--reset-on-completion`       | Enable reset-on-completion for all documents                                                                            | -       |
| `--worktree`                  | Run the auto-run inside a git worktree (requires --launch, --branch, --worktree-path)                                   | -       |
| `--branch <name>`             | Branch name for the worktree (created if it does not exist)                                                             | -       |
| `--base-branch <name>`        | Ref the new branch should be based on when it does not yet exist (e.g. "rc" or "main"). Defaults to the main repo HEAD. | -       |
| `--worktree-path <path>`      | Filesystem path for the worktree (must be a sibling of the repo)                                                        | -       |
| `--create-pr`                 | Open a GitHub PR when the auto-run completes successfully                                                               | -       |
| `--pr-target-branch <branch>` | Target branch for the PR (defaults to the repo default branch)                                                          | -       |
| `--model <model>`             | Model to use for this run only, overriding the agent's configured default                                               | -       |
| `--effort <effort>`           | Reasoning effort for this run only, overriding the agent's configured default                                           | -       |
| `--ignore-model-hints`        | Ignore MAESTRO:MODEL markers in the documents and run every task at --model/--effort (or the agent default)             | -       |
| `--json`                      | Output as JSON (for scripting)                                                                                          | -       |

```bash
maestro-cli auto-run ./phase-01.md ./phase-02.md --agent <agent-id> --launch
maestro-cli auto-run ./phase-01.md --agent <agent-id> --save-as "Release prep"
```

## `maestro-cli stop-auto-run`

Stop the active Auto Run for an agent

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli stop-auto-run --agent <agent-id>
```

## `maestro-cli resume-auto-run`

Resume an Auto Run that paused on an error

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli resume-auto-run --agent <agent-id>
```

## `maestro-cli skip-auto-run`

Skip the current document of an error-paused Auto Run and continue

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli skip-auto-run --agent <agent-id>
```

## `maestro-cli abort-auto-run`

Abort an error-paused Auto Run

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli abort-auto-run --agent <agent-id>
```

## `maestro-cli reset-auto-run-tasks <filename>`

Reset all completed [x] tasks back to [ ] in an Auto Run document

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli reset-auto-run-tasks phase-01.md --agent <agent-id>
```

## `maestro-cli auto-run-status`

Show whether an Auto Run is active and its document/task progress

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli auto-run-status --agent <agent-id> --json
```

## `maestro-cli auto-run-folder <path>`

Point an agent at a different Auto Run folder (relative paths resolve against this shell's cwd)

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

```bash
maestro-cli auto-run-folder ~/playbooks --agent <agent-id>
```

## `maestro-cli steer-auto-run`

Course-correct a running Auto Run without stopping it

## `maestro-cli steer-auto-run send <note>`

Send a steering note; it is delivered at the start of the next task

| Option             | Description                                                       | Default |
| ------------------ | ----------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent whose Auto Run to steer                                     | -       |
| `--background`     | Queue it without flashing the "Steering note queued" confirmation | -       |
| `--focus`          | Show the confirmation flash (the default)                         | -       |
| `--json`           | Output the stored note as JSON                                    | -       |

```bash
maestro-cli steer-auto-run send "Keep the public API unchanged" --agent <agent-id>
```

## `maestro-cli steer-auto-run list`

Show the notes still waiting, and each delivered note with its task reply

| Option             | Description                                                       | Default |
| ------------------ | ----------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent whose steering notes to read                                | -       |
| `--background`     | Accepted and ignored: reading the notes changes nothing on screen | -       |
| `--focus`          | Accepted and ignored: reading the notes changes nothing on screen | -       |
| `--json`           | Output as JSON, including each full reply                         | -       |

```bash
maestro-cli steer-auto-run list --agent <agent-id>
```

## `maestro-cli steer-auto-run cancel <note-id>`

Take back a note no task has read yet (accepts a unique id prefix)

| Option             | Description                                              | Default |
| ------------------ | -------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Agent that holds the note                                | -       |
| `--background`     | Accepted and ignored: cancelling a note raises no notice | -       |
| `--focus`          | Accepted and ignored: cancelling a note raises no notice | -       |
| `--json`           | Output the cancelled note as JSON                        | -       |

```bash
maestro-cli steer-auto-run cancel <note-id> --agent <agent-id>
```

## `maestro-cli marketplace`

Browse and import Playbook Exchange playbooks (the modal: `open marketplace`)

## `maestro-cli marketplace list`

List playbooks in the official + local catalog

| Option                  | Description                           | Default |
| ----------------------- | ------------------------------------- | ------- |
| `-c, --category <name>` | Only this category                    | -       |
| `-s, --search <text>`   | Match id, title, description, or tags | -       |
| `--refresh`             | Bypass the catalog cache              | -       |
| `--json`                | Output as JSON (for scripting)        | -       |

```bash
maestro-cli marketplace list --category testing --search "e2e"
```

## `maestro-cli marketplace show <playbook-id>`

Show a playbook's details, documents, and README

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli marketplace show <playbook-id>
```

## `maestro-cli marketplace import <playbook-id>`

Install a playbook into an agent's Auto Run folder

| Option                | Description                                                     | Default |
| --------------------- | --------------------------------------------------------------- | ------- |
| `-a, --agent <id>`    | Target agent ID                                                 | -       |
| `-f, --folder <name>` | Folder name under the Auto Run folder (default: from the title) | -       |
| `--json`              | Output as JSON (for scripting)                                  | -       |

```bash
maestro-cli marketplace import <playbook-id> --agent <agent-id>
```

## `maestro-cli remove-playbook <agent-id> <playbook-id>`

Remove a saved playbook from an agent (find IDs via "list playbooks -a &lt;agent>")

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli remove-playbook <agent-id> <playbook-id>
```

## `maestro-cli cue`

Interact with Maestro Cue automation

## `maestro-cli cue trigger <subscription-name>`

Manually trigger a Cue subscription by name (pipeline siblings with identical trigger settings fire too)

| Option                   | Description                                                                     | Default |
| ------------------------ | ------------------------------------------------------------------------------- | ------- |
| `-p, --prompt <text>`    | Override the subscription prompt with custom text                               | -       |
| `--json`                 | Output as JSON (for scripting)                                                  | -       |
| `--source-agent-id <id>` | Agent ID to pass as source context for write-back                               | -       |
| `--data-dir <path>`      | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |

```bash
maestro-cli cue trigger "Nightly review" --prompt "Focus on the auth module"
```

## `maestro-cli cue list`

List all Cue subscriptions across agents

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli cue list --json
```

## `maestro-cli cue model <subscription-name>`

Show or set the model tier, exact model, and effort a Cue subscription runs at (no setting flag = show)

| Option                     | Description                                                                     | Default |
| -------------------------- | ------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Scope to one agent (required when the name exists on two)                       | -       |
| `--tier <level>`           | Model tier: low, medium, high (mapped per provider)                             | -       |
| `--model <id>`             | Exact model id (instead of --tier)                                              | -       |
| `--effort <level>`         | Effort: low, medium, high (mapped per provider)                                 | -       |
| `--clear-model`            | Remove the tier / model and use the agent's own model                           | -       |
| `--clear-effort`           | Remove the effort and use the agent's own effort                                | -       |
| `--json`                   | Output as JSON (for scripting)                                                  | -       |
| `--data-dir <path>`        | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |

```bash
maestro-cli cue model "Nightly review" --tier high --effort low
maestro-cli cue model "Nightly review" --clear-model
```

## `maestro-cli cue enable <subscription>`

Turn a Cue subscription on (name, or the full id from `cue list --json`)

| Option             | Description                              | Default |
| ------------------ | ---------------------------------------- | ------- |
| `-a, --agent <id>` | Disambiguate a name several agents share | -       |
| `--json`           | Output as JSON (for scripting)           | -       |

```bash
maestro-cli cue enable "Nightly review" --agent <agent-id>
```

## `maestro-cli cue disable <subscription>`

Turn a Cue subscription off without deleting it

| Option             | Description                              | Default |
| ------------------ | ---------------------------------------- | ------- |
| `-a, --agent <id>` | Disambiguate a name several agents share | -       |
| `--json`           | Output as JSON (for scripting)           | -       |

```bash
maestro-cli cue disable "Nightly review" --agent <agent-id>
```

## `maestro-cli cue gate <subscription>`

Show, set, or remove a subscription's gate (a condition a local model checks before a run starts)

| Option                      | Description                                                             | Default |
| --------------------------- | ----------------------------------------------------------------------- | ------- |
| `--set <condition>`         | Set the gate: a condition the event must meet, in plain language        | -       |
| `--on-unavailable <policy>` | When no model can answer: run (start the run and warn; default) or skip | -       |
| `--clear`                   | Remove the gate                                                         | -       |
| `-a, --agent <id>`          | Disambiguate a name several agents share                                | -       |
| `--json`                    | Output as JSON (for scripting)                                          | -       |

```bash
maestro-cli cue gate "PR opened" --set "The PR touches the auth module" --on-unavailable skip
maestro-cli cue gate "PR opened" --clear
```

## `maestro-cli cue screen <subscription>`

Show or set a subscription's prompt-injection screen (a local classifier scores untrusted text before a run starts)

| Option                | Description                                                                                 | Default |
| --------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `--mode <mode>`       | on (always screen), off (never), or auto (screen commands that use untrusted text; default) | -       |
| `--threshold <score>` | Block at or above this score, above 0 and at most 1 (default 0.8)                           | -       |
| `-a, --agent <id>`    | Disambiguate a name several agents share                                                    | -       |
| `--json`              | Output as JSON (for scripting)                                                              | -       |

```bash
maestro-cli cue screen "PR opened" --mode on --threshold 0.8
```

## `maestro-cli cue activity`

Show recent Cue runs, newest first

| Option              | Description                                                                                                         | Default |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`  | Only runs for this agent                                                                                            | -       |
| `-n, --limit <n>`   | How many runs to show (default 20)                                                                                  | -       |
| `--json`            | Output as JSON (for scripting)                                                                                      | -       |
| `--data-dir <path>` | Data directory to read cue.db from when the app is not running (default: MAESTRO_USER_DATA or the platform default) | -       |

```bash
maestro-cli cue activity --agent <agent-id> --limit 20
```

## `maestro-cli cue schedule`

Create a scheduled task (or --list / --cancel / --reschedule / --pause)

| Option                           | Description                                                                                                                         | Default |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--in <duration>`                | One-shot: fire after a relative delay (e.g. 30s, 20m, 2h, 1d)                                                                       | -       |
| `--at <timestamp>`               | One-shot: fire at ISO-8601 timestamp or "YYYY-MM-DD HH:MM" (local)                                                                  | -       |
| `--daily-at <times>`             | Repeating: comma-separated HH:MM times (e.g. 09:00,17:30)                                                                           | -       |
| `--days <days>`                  | Limit --daily-at to these days (e.g. mon,tue,wed,thu,fri)                                                                           | -       |
| `--every <duration>`             | Repeating: fire on an interval (e.g. 30m, 2h, 1d)                                                                                   | -       |
| `--list`                         | List scheduled tasks across agents                                                                                                  | -       |
| `--kind <kind>`                  | Filter --list by kind: once, daily, interval, all (default: all)                                                                    | -       |
| `--cancel <name>`                | Cancel a scheduled task by name                                                                                                     | -       |
| `--reschedule <name>`            | Change when an existing task fires (pass the timing flag too)                                                                       | -       |
| `--pause <name>`                 | Disable a task without deleting it                                                                                                  | -       |
| `--resume <name>`                | Re-enable a paused task                                                                                                             | -       |
| `-a, --agent <id-or-name>`       | Target agent (required when creating; scopes other modes)                                                                           | -       |
| `-p, --prompt <text>`            | Prompt to send when the task fires. With --auto-run: extra instructions for the run                                                 | -       |
| `--auto-run <documents...>`      | Launch an Auto Run of these .md documents (inside the agent's Auto Run folder) instead of sending a prompt. Kept on a failed launch | -       |
| `--reset-on-completion`          | With --auto-run: uncheck every task when the run finishes                                                                           | -       |
| `--loop`                         | With --auto-run: re-run the documents once every task is checked off                                                                | -       |
| `--max-loops <n>`                | With --auto-run: loop ceiling (implies --loop)                                                                                      | -       |
| `--per-document`                 | With --auto-run: one agent turn per document instead of one per task                                                                | -       |
| `--ignore-model-hints`           | With --auto-run: ignore the documents' MAESTRO:MODEL hints                                                                          | -       |
| `--no-auto-resume`               | With --auto-run: stay paused after an agent error                                                                                   | -       |
| `--auto-resume-after <minutes>`  | With --auto-run: minutes between auto-resume attempts                                                                               | -       |
| `--max-auto-resumes <n>`         | With --auto-run: auto-resume attempt ceiling                                                                                        | -       |
| `--worktree-branch <name>`       | With --auto-run: create a worktree on this branch when the run fires, and run there                                                 | -       |
| `--worktree-agent <id-or-name>`  | With --auto-run: run in this already-open worktree agent                                                                            | -       |
| `--worktree-path <path>`         | With --auto-run: run in the worktree already on disk at this path                                                                   | -       |
| `--base-branch <ref>`            | With a worktree flag: ref a new branch is cut from, and the pull request target                                                     | -       |
| `--create-pr`                    | With a worktree flag: open a pull request when the run finishes                                                                     | -       |
| `--notify`                       | Show a toast notification when the task fires                                                                                       | -       |
| `--sticky`                       | Make the notify toast sticky (requires --notify)                                                                                    | -       |
| `-m, --message <text>`           | Body for the notify toast (defaults to label/prompt)                                                                                | -       |
| `-n, --name <name>`              | Custom subscription name (auto-generated when omitted)                                                                              | -       |
| `-l, --label <text>`             | Human-readable label (defaults to truncated prompt)                                                                                 | -       |
| `--pipeline <name>`              | Pipeline name (default: Tasks)                                                                                                      | -       |
| `--grace-minutes <n>`            | Override the default 360-minute grace window                                                                                        | -       |
| `--tier <level>`                 | Model tier for the prompt run: low, medium, high (mapped per provider)                                                              | -       |
| `--model <id>`                   | Exact model id for the prompt run (instead of --tier). With --auto-run: model for this run only                                     | -       |
| `--effort <level>`               | Effort for the prompt run: low, medium, high (mapped per provider). With --auto-run: reasoning effort for this run only             | -       |
| `--keep-on-failure`              | Keep the subscription on a failed/timed-out run (default: self-destructs on both success and failure)                               | -       |
| `--gate <condition>`             | Only run when a local model says the fire meets this condition (edit later with `cue gate`)                                         | -       |
| `--gate-on-unavailable <policy>` | With --gate, when no model can answer: run (default) or skip                                                                        | -       |
| `--json`                         | Output as JSON (for scripting)                                                                                                      | -       |

```bash
maestro-cli cue schedule --in 20m --agent <agent-id> --prompt "Check the deploy status"
maestro-cli cue schedule --daily-at 09:00 --days mon,tue,wed,thu,fri --agent <agent-id> --prompt "Draft the standup"
maestro-cli cue schedule --list --kind daily
```

## `maestro-cli cue pipeline`

Manage Cue pipeline layout entries (cue-pipeline-layout.json)

## `maestro-cli cue pipeline list`

List all pipelines in the layout file

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli cue pipeline list --json
```

## `maestro-cli cue pipeline get <name>`

Print one pipeline entry as JSON to stdout

| Option   | Description                                    | Default |
| -------- | ---------------------------------------------- | ------- |
| `--json` | Output as JSON (default; flag kept for parity) | -       |

```bash
maestro-cli cue pipeline get "Nightly review" --json
```

## `maestro-cli cue pipeline export <name>`

Alias for `get`: print one pipeline entry as JSON to stdout

| Option   | Description                                    | Default |
| -------- | ---------------------------------------------- | ------- |
| `--json` | Output as JSON (default; flag kept for parity) | -       |

```bash
maestro-cli cue pipeline export "Nightly review" > pipeline.json
```

## `maestro-cli cue pipeline add <name>`

Add a new pipeline entry from a JSON file

| Option          | Description                                              | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `--from <file>` | JSON file with one pipeline entry (matches `get` output) | -       |
| `--force`       | Replace any existing pipeline with the same name/id      | -       |
| `--json`        | Output as JSON (for scripting)                           | -       |

```bash
maestro-cli cue pipeline add "Nightly review" --from pipeline.json
```

## `maestro-cli cue pipeline replace <name>`

Replace an existing pipeline entry from a JSON file

| Option          | Description                                              | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `--from <file>` | JSON file with one pipeline entry (matches `get` output) | -       |
| `--json`        | Output as JSON (for scripting)                           | -       |

```bash
maestro-cli cue pipeline replace "Nightly review" --from pipeline.json
```

## `maestro-cli cue pipeline remove <name>`

Remove a pipeline entry by name or id

| Option    | Description                                                  | Default |
| --------- | ------------------------------------------------------------ | ------- |
| `--force` | Suppress the no-op error when the pipeline is already absent | -       |
| `--json`  | Output as JSON (for scripting)                               | -       |

```bash
maestro-cli cue pipeline remove "Nightly review" --force
```

## `maestro-cli cue engine`

Run Maestro Cue unattended (no desktop app) and control that runner

## `maestro-cli cue engine start`

Start the Cue engine in this process and block until Ctrl+C / stopped. Agents inherit the whole environment unless MAESTRO_SERVER_MODE=1 (set by the server unit and image), which passes only the server allowlist plus MAESTRO_SERVER_ENV_ALLOW and declared secrets

| Option                      | Description                                                                                                    | Default  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| `--json`                    | Print machine-readable start/failure status                                                                    | -        |
| `--data-dir <path>`         | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist)                                | -        |
| `--log-format <format>`     | Log line format: text, or one JSON object per line on stderr                                                   | `"text"` |
| `--require-ready`           | Refuse to start (exit 1, nothing armed) when the readiness check finds any gap; see "cue engine check"         | -        |
| `--status-port <port>`      | Serve /healthz, /readyz and /status on 127.0.0.1 at this port (documented port: 7433). Off unless given        | -        |
| `--drain-timeout <seconds>` | On SIGTERM/SIGINT, let runs in flight finish for this long before stopping them; a second signal stops at once | `90`     |
| `--notify-webhook <url>`    | POST a JSON notice for every notify action and every expired agent login to this http(s) URL                   | -        |

```bash
maestro-cli cue engine start
```

## `maestro-cli cue engine check`

Check that every agent, secret, workspace, cue.yaml and tool the engine needs is present, and that there is something to run; list every gap (exit 1 when not ready)

| Option              | Description                                                                     | Default |
| ------------------- | ------------------------------------------------------------------------------- | ------- |
| `--json`            | Output as JSON (for scripting)                                                  | -       |
| `--data-dir <path>` | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |

```bash
maestro-cli cue engine check --json
```

## `maestro-cli cue engine stop`

Stop a running standalone engine (refuses to signal a desktop-owned one)

| Option              | Description                                                                     | Default |
| ------------------- | ------------------------------------------------------------------------------- | ------- |
| `--json`            | Output as JSON (for scripting)                                                  | -       |
| `--data-dir <path>` | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |
| `--wait-ms <ms>`    | How long to wait for the lock to clear after signaling                          | -       |

```bash
maestro-cli cue engine stop --wait-ms 5000
```

## `maestro-cli cue engine status`

Report whether an engine is running and its last known heartbeat

| Option              | Description                                                                     | Default |
| ------------------- | ------------------------------------------------------------------------------- | ------- |
| `--json`            | Output as JSON (for scripting)                                                  | -       |
| `--data-dir <path>` | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |

```bash
maestro-cli cue engine status --json
```

## `maestro-cli cue engine inspect`

List every agent with a readable .maestro/cue.yaml and its subscription counts

| Option              | Description                                                                     | Default |
| ------------------- | ------------------------------------------------------------------------------- | ------- |
| `--json`            | Output as JSON (for scripting)                                                  | -       |
| `--data-dir <path>` | Maestro data directory to use (overrides MAESTRO_USER_DATA; must already exist) | -       |

```bash
maestro-cli cue engine inspect --json
```

## `maestro-cli bundle`

Export, validate, inspect, and import portable Cue pipeline and agent bundles

## `maestro-cli bundle export`

Export one Cue pipeline or one agent to a deterministic bundle zip. Refuses, writing nothing, when an exported cue.yaml would fail bundle validate

| Option                     | Description                                                                                                                                                                               | Default |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Export this agent (exclusive with --pipeline)                                                                                                                                             | -       |
| `-p, --pipeline <name>`    | Export this Cue pipeline (exclusive with --agent)                                                                                                                                         | -       |
| `-o, --output <path>`      | Zip to write (default: ./&lt;name>.maestro-bundle.zip)                                                                                                                                    | -       |
| `--allow-inline-secrets`   | Export subscriptions that hold a literal webhook.secret                                                                                                                                   | -       |
| `--data-dir <path>`        | Read Maestro's data from this directory instead of the default                                                                                                                            | -       |
| `--created-at <iso>`       | Record this ISO-8601 time as the bundle creation time                                                                                                                                     | -       |
| `--no-claude-skills`       | Leave out Claude Code skills (.claude/skills)                                                                                                                                             | -       |
| `--no-claude-mcp`          | Leave out .mcp.json (exported with secrets as $\{VAR\} references)                                                                                                                        | -       |
| `--no-claude-memory`       | Leave out CLAUDE.md and Claude auto memory (exported with secret-looking tokens redacted)                                                                                                 | -       |
| `--no-cue`                 | Leave out the agent's Cue subscriptions (--agent only)                                                                                                                                    | -       |
| `--exact`                  | Exact copy: also carry secret values, binary paths, SSH and other providers settings, and local folders, so an import on this machine restores the agent as it was. Do not share the file | -       |
| `--json`                   | Output as JSON (for scripting)                                                                                                                                                            | -       |

```bash
maestro-cli bundle export --agent <agent-id> --output agent.maestro-bundle.zip
maestro-cli bundle export --agent <agent-id> --exact --output exact-agent.maestro-bundle.zip
```

## `maestro-cli bundle validate <bundle>`

Check a bundle zip: file hashes both ways, cue.yaml, references, secrets, and engine version

| Option        | Description                                                                                                                                                        | Default |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `--check-env` | Also check that this machine supplies each required secret (systemd credential, /run/secrets file, or environment variable); missing or unusable ones are warnings | -       |
| `--json`      | Output as JSON (for scripting)                                                                                                                                     | -       |

```bash
maestro-cli bundle validate agent.maestro-bundle.zip
```

## `maestro-cli bundle inspect <bundle>`

Describe a bundle from its manifest and README without unpacking the rest

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli bundle inspect agent.maestro-bundle.zip --json
```

## `maestro-cli bundle import <bundle>`

Import a bundle into the running app, or with it closed into a data directory, plus local workspace folders. Prints the plan, shell commands included, before the first write

| Option                       | Description                                                                             | Default |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `-w, --workspace <key=path>` | Map a bundle workspace to its own local folder (repeatable, one per workspace)          | `[]`    |
| `--agent-path <tool=path>`   | Set the binary a provider runs, e.g. claude-code=/usr/local/bin/claude (repeatable)     | `[]`    |
| `--data-dir <path>`          | Import into this Maestro data directory instead of the default                          | -       |
| `--dry-run`                  | Report everything the import would do, including conflicts; write nothing               | -       |
| `--force`                    | Overwrite conflicting agents, subscriptions, playbooks, files, and paths                | -       |
| `-g, --group <id>`           | Put the agents the import creates in this Left Bar group                                | -       |
| `--no-local`                 | Ignore an exact copy's machine data (secret values, binary paths, SSH, folders)         | -       |
| `--reject-shell-commands`    | Refuse the import, before anything is written, if any subscription runs a shell command | -       |
| `--json`                     | Output as JSON (for scripting): one document, after the import                          | -       |

```bash
maestro-cli bundle import agent.maestro-bundle.zip --dry-run
```

## `maestro-cli director-notes`

Director's Notes: unified history and AI synopsis

## `maestro-cli director-notes history`

Show unified history across all agents

| Option                | Description                                          | Default |
| --------------------- | ---------------------------------------------------- | ------- |
| `-d, --days <n>`      | Lookback period in days (default: from app settings) | -       |
| `-f, --format <type>` | Output format: json, markdown, text (default: text)  | -       |
| `--filter <type>`     | Filter by entry type: auto, user, cue, agent         | -       |
| `-l, --limit <n>`     | Maximum entries to show (default: 100)               | -       |
| `--json`              | Output as JSON (shorthand for --format json)         | -       |

```bash
maestro-cli director-notes history --days 7 --filter agent --limit 50
```

## `maestro-cli director-notes synopsis`

Generate AI synopsis of recent activity (requires running Maestro app)

| Option                | Description                                          | Default |
| --------------------- | ---------------------------------------------------- | ------- |
| `-d, --days <n>`      | Lookback period in days (default: from app settings) | -       |
| `-f, --format <type>` | Output format: json, markdown, text (default: text)  | -       |
| `--json`              | Output as JSON (shorthand for --format json)         | -       |

```bash
maestro-cli director-notes synopsis --days 7 --format markdown
```

## `maestro-cli status`

Check if the Maestro desktop app is running and reachable

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli status --json
```

## `maestro-cli version`

Show the running Maestro app's version and build commit hash

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli version --json
```

## `maestro-cli doctor`

Diagnose CLI connectivity, version skew, and configuration

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli doctor --json
```

## `maestro-cli host`

Run the Maestro runtime detached, with no desktop app, and control it

## `maestro-cli host start`

Start a detached host that serves this data directory over the bridge

| Option                   | Description                                                                                        | Default |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------- |
| `--data-dir <path>`      | Maestro data directory (default: resolved like the desktop app)                                    | -       |
| `--dev`                  | Use the development data directory                                                                 | -       |
| `--port <port>`          | Port to listen on (default: any free port)                                                         | -       |
| `--foreground`           | Serve in this process instead of detaching (what the detached child runs)                          | -       |
| `--stop-grace <seconds>` | On SIGTERM/SIGINT, wait this long for work in flight before stopping (default 30; 0 stops at once) | -       |
| `--json`                 | Output as JSON (for scripting)                                                                     | -       |

```bash
maestro-cli host start --dev
```

## `maestro-cli host status`

Report the host: pid, uptime, lock holder, Cue state, and work in flight

| Option              | Description                                                     | Default |
| ------------------- | --------------------------------------------------------------- | ------- |
| `--data-dir <path>` | Maestro data directory (default: resolved like the desktop app) | -       |
| `--dev`             | Use the development data directory                              | -       |
| `--json`            | Output as JSON (for scripting)                                  | -       |

```bash
maestro-cli host status --dev --json
```

## `maestro-cli host stop`

Stop the host (refuses while a turn, Auto Run or Cue run is in flight, unless --wait or --force)

| Option              | Description                                                               | Default |
| ------------------- | ------------------------------------------------------------------------- | ------- |
| `--data-dir <path>` | Maestro data directory (default: resolved like the desktop app)           | -       |
| `--dev`             | Use the development data directory                                        | -       |
| `--wait [seconds]`  | Wait for work in flight to finish (default 300s), then stop; never forces | -       |
| `--force`           | Stop even with work in flight; a run records how it ended first           | -       |
| `--json`            | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli host stop --dev --wait
```

## `maestro-cli completions <shell>`

Print a shell completion script (bash, zsh, or fish)

```bash
maestro-cli completions zsh > ~/.zfunc/_maestro-cli
```

## `maestro-cli reference`

Print the full command reference (Markdown, or --format json)

| Option              | Description                                                   | Default |
| ------------------- | ------------------------------------------------------------- | ------- |
| `--format <format>` | Output format: md (default) or json                           | -       |
| `--all`             | Include the commands of Encore Features that are switched off | -       |

```bash
maestro-cli reference --format json
```

## `maestro-cli create-agent <name>`

Create a new agent in the Maestro desktop app. With --group, the agent starts from that group's defaults (see group-settings); flags you pass take precedence

| Option                             | Description                                                                                                                                                                                                                                | Default         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `-d, --cwd <path>`                 | Working directory for the agent (required, unless --group names a group whose defaults set one)                                                                                                                                            | -               |
| `-t, --type <type>`                | Agent type (antigravity, claude-code, codex, copilot-cli, factory-droid, grok, hermes, omp, opencode, pi, qwen3-coder)                                                                                                                     | `"claude-code"` |
| `-g, --group <id>`                 | Group to assign the agent to. The agent starts from the group's defaults (provider, model, environment variables, peers, ...), and every flag below overrides one                                                                          | -               |
| `--no-group-defaults`              | Create a bare agent in --group, ignoring the group's defaults (no effect without --group)                                                                                                                                                  | -               |
| `--nudge <message>`                | Nudge message appended to every user message                                                                                                                                                                                               | -               |
| `--new-session-message <message>`  | Message prefixed to first message in new sessions                                                                                                                                                                                          | -               |
| `--custom-path <path>`             | Custom binary path for the agent                                                                                                                                                                                                           | -               |
| `--custom-args <args>`             | Custom CLI arguments for the agent                                                                                                                                                                                                         | -               |
| `--env <KEY=VALUE>`                | Environment variable (repeatable)                                                                                                                                                                                                          | `[]`            |
| `--model <model>`                  | Model override (e.g., sonnet, opus; "auto" lets the model router pick the tier and effort of each turn)                                                                                                                                    | -               |
| `--effort <level>`                 | Effort/reasoning level override                                                                                                                                                                                                            | -               |
| `--context-window <size>`          | Context window size in tokens                                                                                                                                                                                                              | -               |
| `--provider-path <path>`           | Custom provider path                                                                                                                                                                                                                       | -               |
| `--ssh-remote <id>`                | SSH remote ID for remote execution                                                                                                                                                                                                         | -               |
| `--ssh-cwd <path>`                 | Working directory override on SSH remote                                                                                                                                                                                                   | -               |
| `--sync-history-to-remote <bool>`  | Sync history entries to .maestro/history/ on the remote host (true/false; requires --ssh-remote)                                                                                                                                           | -               |
| `--auto-run-folder <path>`         | Path to the agent Auto Run / playbooks folder (overrides the default &lt;cwd>/.maestro/playbooks)                                                                                                                                          | -               |
| `--gateway-url <url\|none>`        | Local Models gateway: an HTTP proxy this agent's provider traffic goes through, set as its base-URL variable at launch. Set the Maestro token proxy mode afterwards with update-agent --proxy-mode                                         | -               |
| `--run-on <target>`                | Where this agent's model runs: provider (the default), or &lt;source id>:&lt;model> for a model on a Local Models source (maestro-server for the Maestro model server; ids from models endpoints list). The agent keeps its provider's CLI | -               |
| `--run-on-context <tokens>`        | Context size the harness is told a --run-on source has (at least 40960; default: the model's catalog context on the Maestro model server, 40960 elsewhere)                                                                                 | -               |
| `--peer <agent:access>`            | Set one explicit peer row (repeatable): &lt;agent>:r (consult), :w (delegate), :rw, or :none (exclude the peer from a group or worktree grant)                                                                                             | `[]`            |
| `--peer-note <agent:text>`         | Set the note on a peer row, the hint the agent reads for when to reach it (repeatable; needs a row)                                                                                                                                        | `[]`            |
| `--group-peers <r\|w\|rw\|off>`    | Grant access to every other agent in the same group, resolved live                                                                                                                                                                         | -               |
| `--worktree-peers <r\|w\|rw\|off>` | Grant access to the agent's worktree family, resolved live                                                                                                                                                                                 | -               |
| `--background`                     | Create the agent without selecting it (Left Bar selection stays put)                                                                                                                                                                       | -               |
| `--focus`                          | Select the new agent after creating it (default)                                                                                                                                                                                           | -               |
| `--json`                           | Output as JSON (for scripting)                                                                                                                                                                                                             | -               |

```bash
maestro-cli create-agent "API Worker" --cwd ~/code/api --type claude-code --group <group-id>
maestro-cli create-agent "Local Coder" --cwd . --run-on maestro-server:<model-id>
```

## `maestro-cli duplicate-agent <agent>`

Duplicate an agent with the same settings the Left Bar "Duplicate..." copies (read back with show-agent)

| Option              | Description                                                                                  | Default |
| ------------------- | -------------------------------------------------------------------------------------------- | ------- |
| `-n, --name <name>` | Name for the copy (default: "&lt;source name> (Copy)")                                       | -       |
| `-g, --group <id>`  | Group ID or prefix for the copy (default: the source agent's group)                          | -       |
| `-d, --cwd <path>`  | Working directory for the copy (default: the source agent's; a remote path for an SSH agent) | -       |
| `--background`      | Create the copy without selecting it (Left Bar selection stays put)                          | -       |
| `--focus`           | Select the copy after creating it (default)                                                  | -       |
| `--json`            | Output as JSON (for scripting)                                                               | -       |

```bash
maestro-cli duplicate-agent <agent-id> --background
```

## `maestro-cli create-group <name>`

Create a new group in the Maestro desktop app

| Option                | Description                                                                                            | Default |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `-e, --emoji <emoji>` | Emoji icon for the group                                                                               | -       |
| `--icon <icon-id>`    | Built-in icon ID (folder, briefcase, rocket, ...) or a plugin icon ID. Mutually exclusive with --emoji | -       |
| `--color <color>`     | Label color as #RRGGBB, or a plugin color ID                                                           | -       |
| `--parent <group-id>` | Create inside this root group                                                                          | -       |
| `--json`              | Output as JSON (for scripting)                                                                         | -       |

```bash
maestro-cli create-group "Backend" --emoji "🛠️" --color "#9146FF"
```

## `maestro-cli remove-group <group-id>`

Remove a group from the Maestro desktop app (agents inside are ungrouped, not deleted)

| Option        | Description                                               | Default |
| ------------- | --------------------------------------------------------- | ------- |
| `-f, --force` | Delete even if the group still has agents (ungroups them) | -       |
| `--json`      | Output as JSON (for scripting)                            | -       |

```bash
maestro-cli remove-group <group-id> --force
```

## `maestro-cli rename-group <group-id> <new-name>`

Rename a group in the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli rename-group <group-id> "Platform"
```

## `maestro-cli update-group <group-id>`

Update a group's name, icon, color, parent, Left Bar visibility, or collapsed state in the Maestro desktop app

| Option                | Description                                                                                            | Default |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `-n, --name <name>`   | New group name                                                                                         | -       |
| `-e, --emoji <emoji>` | Emoji icon for the group. Mutually exclusive with --icon                                               | -       |
| `--icon <icon-id>`    | Built-in icon ID (folder, briefcase, rocket, ...) or a plugin icon ID. Mutually exclusive with --emoji | -       |
| `--color <color>`     | Label color as #RRGGBB, or a plugin color ID                                                           | -       |
| `--parent <group-id>` | Move the group inside this root group                                                                  | -       |
| `--clear-emoji`       | Reset the emoji to the default folder                                                                  | -       |
| `--clear-icon`        | Remove the icon                                                                                        | -       |
| `--clear-color`       | Remove the label color                                                                                 | -       |
| `--clear-parent`      | Promote the group to the top level                                                                     | -       |
| `--hide`              | Park the group out of the Left Bar. Its agents stay reachable through search and the switcher          | -       |
| `--show`              | Bring a hidden group back into the Left Bar                                                            | -       |
| `--collapse`          | Fold the group in the Left Bar so its agents are tucked away                                           | -       |
| `--expand`            | Unfold a collapsed group in the Left Bar                                                               | -       |
| `--json`              | Output as JSON (for scripting)                                                                         | -       |

```bash
maestro-cli update-group <group-id> --name "Platform" --hide
```

## `maestro-cli delegation`

Read which agents may consult or delegate to which (the Delegation Graph)

## `maestro-cli delegation graph`

Print the Delegation Graph: every agent, whom it may consult or delegate to, and who reaches it

| Option             | Description                                                              | Default |
| ------------------ | ------------------------------------------------------------------------ | ------- |
| `-g, --group <id>` | Only one agent group, and the agents outside it that an edge joins to it | -       |
| `--json`           | Output the graph model (nodes and edges) as JSON                         | -       |

```bash
maestro-cli delegation graph
maestro-cli delegation graph --group <group-id> --json
```

## `maestro-cli group-settings <group-id>`

Show a group's defaults (what a new agent in it starts with) and its Left Bar pill label

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli group-settings <group-id> --json
```

## `maestro-cli update-group-settings <group-id>`

Set a group's defaults for new agents and its pill label (requires the desktop app). Existing agents change only with --publish

| Option                             | Description                                                                                                                                                                                                      | Default |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--provider <type>`                | Default provider for new agents (use "none" for no default; switching resets the profile's provider-bound values)                                                                                                | -       |
| `-d, --cwd <path>`                 | Default working directory (empty string clears)                                                                                                                                                                  | -       |
| `--nudge <message>`                | Nudge message appended to every message (empty string clears)                                                                                                                                                    | -       |
| `--new-session-message <message>`  | Message prefixed to the first message of new sessions (empty string clears)                                                                                                                                      | -       |
| `--custom-path <path>`             | Override the agent binary path (empty string clears)                                                                                                                                                             | -       |
| `--custom-args <args>`             | Custom CLI arguments for the agent (empty string clears)                                                                                                                                                         | -       |
| `--env <KEY=VALUE>`                | Set an environment variable (repeatable; replaces the env map)                                                                                                                                                   | `[]`    |
| `--clear-env`                      | Clear all environment variable defaults                                                                                                                                                                          | -       |
| `--gateway-url <url\|none>`        | Local Models gateway URL ("none" clears). Not combinable with --proxy-mode                                                                                                                                       | -       |
| `--run-on <target>`                | Where new agents run their model: provider, or &lt;source id>:&lt;model> on a Local Models source                                                                                                                | -       |
| `--run-on-context <tokens>`        | Context size the harness is told the Run on source has (at least 40960)                                                                                                                                          | -       |
| `--proxy-mode <mode>`              | Maestro token proxy for new agents: off \| passthrough \| compress \| compress-early                                                                                                                             | -       |
| `--tier <tier=target>`             | Where a low, medium or high task launches (repeatable): low=&lt;source id>:&lt;model>, high=provider:&lt;model>, medium=provider, or low=default                                                                 | `[]`    |
| `--background-requests <target>`   | Where the token proxy sends side requests: &lt;source id>:&lt;model>, or none                                                                                                                                    | -       |
| `--system-one <on\|off>`           | Whether new agents may ask System One: off switches it off for them                                                                                                                                              | -       |
| `--peer <agent:access>`            | Set one explicit peer row (repeatable): &lt;agent>:r, :w, :rw, or :none                                                                                                                                          | `[]`    |
| `--peer-note <agent:text>`         | Set the note on a peer row (repeatable; needs a row, empty text clears)                                                                                                                                          | `[]`    |
| `--remove-peer <agent>`            | Delete a peer row (repeatable). Not the same as :none                                                                                                                                                            | `[]`    |
| `--group-peers <r\|w\|rw\|off>`    | Grant access to every other agent in the same group                                                                                                                                                              | -       |
| `--worktree-peers <r\|w\|rw\|off>` | Grant access to the agent's worktree family                                                                                                                                                                      | -       |
| `--model <model>`                  | Default model ("auto" lets the model router pick; empty string clears)                                                                                                                                           | -       |
| `--effort <level>`                 | Default effort/reasoning level (empty string clears)                                                                                                                                                             | -       |
| `--context-window <size>`          | Default context window in tokens (0 or "none" clears)                                                                                                                                                            | -       |
| `--token-source <mode>`            | Claude token source: api \| tui \| dynamic (needs the Claude Code provider)                                                                                                                                      | -       |
| `--maestro-p-path <path>`          | Override the maestro-p binary path (empty string clears)                                                                                                                                                         | -       |
| `--codex-transport <transport>`    | Codex transport: exec \| app-server (needs the Codex provider)                                                                                                                                                   | -       |
| `--ssh-remote <id>`                | Default SSH remote for new agents, by id or name (use "none" for local execution)                                                                                                                                | -       |
| `--ssh-cwd <path>`                 | Working directory override on the SSH remote                                                                                                                                                                     | -       |
| `--sync-history-to-remote <bool>`  | Sync history entries to .maestro/history/ on the remote host (true/false)                                                                                                                                        | -       |
| `--short-label <text>`             | Text for the pill drawn beside the group's bookmarked agents, at most 12 characters (empty string returns to the automatic abbreviation). Display only: never copied or published                                | -       |
| `--clear`                          | Remove the defaults entirely. Does not touch --short-label, which is group display state and not an agent default. Cannot be combined with other defaults or --publish                                           | -       |
| `--publish`                        | Also write this call's changes into the agents already in the group (provider, working directory and SSH remote are never written; env vars merge by key, lists replace). Needs --yes unless you answer a prompt | -       |
| `--yes`                            | Confirm a --publish without asking                                                                                                                                                                               | -       |
| `--json`                           | Output as JSON (for scripting)                                                                                                                                                                                   | -       |

```bash
maestro-cli update-group-settings <group-id> --provider claude-code --model opus
maestro-cli update-group-settings <group-id> --short-label "API" --publish --yes
```

## `maestro-cli create-worktree`

Create a new agent in a git worktree branched off an existing parent agent

| Option                 | Description                                                                                                        | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| `-a, --agent <id>`     | Parent agent ID the worktree branches from (use "maestro-cli list agents" to find IDs)                             | -       |
| `-b, --branch <name>`  | Branch name for the worktree (created if it does not exist)                                                        | -       |
| `--base-branch <name>` | Ref the new branch is based on when it does not yet exist (e.g. "rc" or "main"). Defaults to the parent repo HEAD. | -       |
| `-m, --message <text>` | Optional initial prompt to dispatch to the new agent after creation                                                | -       |
| `--background`         | Create the agent without selecting it (Left Bar selection stays put)                                               | -       |
| `--focus`              | Select the new worktree agent after creating it (default)                                                          | -       |
| `--json`               | Output as JSON (for scripting)                                                                                     | -       |

```bash
maestro-cli create-worktree --agent <agent-id> --branch feat/search --base-branch main
```

## `maestro-cli remove-agent <agent-id>`

Remove an agent from the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli remove-agent <agent-id>
```

## `maestro-cli update-agent <agent-id>`

Update an existing agent's group, working directory, and per-agent settings

| Option                                  | Description                                                                                                                                                                                                                                                                                                                                                 | Default |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-g, --group <id>`                      | Move the agent to this group (use "none" to ungroup; supports partial IDs)                                                                                                                                                                                                                                                                                  | -       |
| `-d, --cwd <path>`                      | Change the agent's working directory (resolved to absolute; agent must be stopped)                                                                                                                                                                                                                                                                          | -       |
| `--ssh-remote <id>`                     | Set the SSH remote for remote execution (use "none" to revert to local; agent must be stopped)                                                                                                                                                                                                                                                              | -       |
| `--ssh-cwd <path>`                      | Working directory override on the SSH remote                                                                                                                                                                                                                                                                                                                | -       |
| `--sync-history-to-remote <bool>`       | Sync history entries to .maestro/history/ on the remote host (true/false)                                                                                                                                                                                                                                                                                   | -       |
| `--nudge <message>`                     | Nudge message appended to every message (empty string clears)                                                                                                                                                                                                                                                                                               | -       |
| `--new-session-message <message>`       | Message prefixed to the first message of new sessions (empty string clears)                                                                                                                                                                                                                                                                                 | -       |
| `--custom-path <path>`                  | Override the agent binary path (empty string clears)                                                                                                                                                                                                                                                                                                        | -       |
| `--custom-args <args>`                  | Custom CLI arguments for the agent (empty string clears)                                                                                                                                                                                                                                                                                                    | -       |
| `--env <KEY=VALUE>`                     | Set an environment variable (repeatable; replaces the env map)                                                                                                                                                                                                                                                                                              | `[]`    |
| `--clear-env`                           | Clear all per-agent environment variables                                                                                                                                                                                                                                                                                                                   | -       |
| `--gateway-url <url\|none>`             | Local Models gateway: an HTTP proxy this agent's provider traffic goes through, set as its base-URL variable at launch ("none" clears)                                                                                                                                                                                                                      | -       |
| `--run-on <target>`                     | Where this agent's model runs: provider (its provider's own model; clears a target), or &lt;source id>:&lt;model> for a model on a Local Models source (maestro-server for the Maestro model server; ids from models endpoints list). Check it with agent test-run-on                                                                                       | -       |
| `--run-on-context <tokens>`             | Context size the harness is told the Run on source has (at least 40960). Alone, it changes the context of the agent's current target                                                                                                                                                                                                                        | -       |
| `--proxy-mode <mode>`                   | Maestro token proxy for this agent: off \| passthrough \| compress \| compress-early. Any mode but off points the gateway at the proxy; off clears it. compress shortens a tool result after the model has read it once; compress-early shortens it before, which is cheaper and means the model works from the shortened output (requires the desktop app) | -       |
| `--tier <tier=target>`                  | Where a low, medium or high task of this agent launches (repeatable): low=&lt;source id>:&lt;model>, high=provider:&lt;model>, medium=provider (the provider, on the agent's own model), or low=default to follow the harness default again. Read them with show agent                                                                                      | `[]`    |
| `--background-requests <target>`        | Where the Maestro token proxy sends this agent's side requests (titles, summaries): &lt;source id>:&lt;model> for a model on a source that serves the Anthropic Messages route, or none. Claude Code agents on the token proxy only                                                                                                                         | -       |
| `--system-one <on\|off>`                | Whether this agent may ask System One with maestro-cli s1: off switches it off for this agent only, on follows "Let agents use System One" (default on)                                                                                                                                                                                                     | -       |
| `--peer <agent:access>`                 | Set one explicit peer row (repeatable): &lt;agent>:r (consult), :w (delegate), :rw, or :none (exclude the peer from a group or worktree grant)                                                                                                                                                                                                              | `[]`    |
| `--peer-note <agent:text>`              | Set the note on a peer row, the hint the agent reads for when to reach it (repeatable; needs a row, empty text clears)                                                                                                                                                                                                                                      | `[]`    |
| `--remove-peer <agent>`                 | Delete a peer row (repeatable). Not the same as :none: a deleted row lets the group and worktree grants apply again                                                                                                                                                                                                                                         | `[]`    |
| `--group-peers <r\|w\|rw\|off>`         | Grant access to every other agent in the same group, resolved live (off clears)                                                                                                                                                                                                                                                                             | -       |
| `--worktree-peers <r\|w\|rw\|off>`      | Grant access to the agent's worktree family: parent, sibling and child worktrees, resolved live (off clears)                                                                                                                                                                                                                                                | -       |
| `--model <model>`                       | Model override (e.g. sonnet, opus; "auto" lets the model router pick per turn; empty string clears)                                                                                                                                                                                                                                                         | -       |
| `--effort <level>`                      | Effort/reasoning level override (empty string clears)                                                                                                                                                                                                                                                                                                       | -       |
| `--context-window <size>`               | Context window size in tokens (0 or "none" clears)                                                                                                                                                                                                                                                                                                          | -       |
| `--token-source <mode>`                 | Claude token source: api \| tui \| dynamic (Claude Code agents only)                                                                                                                                                                                                                                                                                        | -       |
| `--maestro-p-path <path>`               | Override the maestro-p binary path (empty string clears)                                                                                                                                                                                                                                                                                                    | -       |
| `--codex-transport <transport>`         | Codex transport: exec \| app-server (experimental, enables steering; Codex only)                                                                                                                                                                                                                                                                            | -       |
| `--bookmark <bool>`                     | Bookmark the agent in the Left Bar (true/false)                                                                                                                                                                                                                                                                                                             | -       |
| `--retry-on-availability <bool>`        | Agent Resilience: resend a turn the provider refused as overloaded (true/false; "default" drops the choice, which is on)                                                                                                                                                                                                                                    | -       |
| `--retry-on-token-exhaustion <bool>`    | Agent Resilience: resend a turn refused for a spent quota once it resets (true/false; "default" drops the choice, which is on)                                                                                                                                                                                                                              | -       |
| `--codex-auto-reset <bool>`             | Spend a Codex rate-limit reset credit when the quota is exhausted (true/false; "default" drops the choice; Codex only)                                                                                                                                                                                                                                      | -       |
| `--additional-dir <path[:access]>`      | A directory outside the working directory the agent may use (repeatable; replaces the list): &lt;path> is read-only, &lt;path>:rw adds write                                                                                                                                                                                                                | `[]`    |
| `--clear-additional-dirs`               | Remove every additional directory                                                                                                                                                                                                                                                                                                                           | -       |
| `--env-park <KEY>`                      | Switch an environment variable off without deleting it (repeatable): kept and editable, never spawned with                                                                                                                                                                                                                                                  | `[]`    |
| `--env-unpark <KEY>`                    | Switch a parked environment variable back on (repeatable)                                                                                                                                                                                                                                                                                                   | `[]`    |
| `--share-history-to-project-dir <bool>` | Mirror History entries into the local project's .maestro/history/ (true/false; for an agent another Maestro controls; agent must be stopped)                                                                                                                                                                                                                | -       |
| `--provider <type>`                     | Switch to another provider; tabs keep their transcripts and start fresh conversations there                                                                                                                                                                                                                                                                 | -       |
| `--convert`                             | With --provider: also convert owned conversations and selected project knowledge (opt-in; implied by the translation options below)                                                                                                                                                                                                                         | -       |
| `--project-resources`                   | Install native project resources and add local git exclude entries                                                                                                                                                                                                                                                                                          | -       |
| `--force`                               | Alias for --accept-translation-limitations                                                                                                                                                                                                                                                                                                                  | -       |
| `--dry-run`                             | Plan provider migration without native writes (requires --provider)                                                                                                                                                                                                                                                                                         | -       |
| `--accept-translation-limitations`      | Accept the reported unverified or partial conversion limitations                                                                                                                                                                                                                                                                                            | -       |
| `--migration <action>`                  | Migration operation: plan \| apply \| status \| recover \| rollback                                                                                                                                                                                                                                                                                         | -       |
| `--migration-plan <id>`                 | Use the reviewed plan or inspect/recover a specific operation ID                                                                                                                                                                                                                                                                                            | -       |
| `--translation-resource <path>`         | Select one user-level resource (repeatable; no account-global import)                                                                                                                                                                                                                                                                                       | `[]`    |
| `--json`                                | Output as JSON (for scripting)                                                                                                                                                                                                                                                                                                                              | -       |

```bash
maestro-cli update-agent <agent-id> --model opus --effort high
maestro-cli update-agent <agent-id> --provider codex --convert --accept-translation-limitations
maestro-cli update-agent <agent-id> --run-on maestro-server:<model-id> --run-on-context 65536
maestro-cli update-agent <agent-id> --peer docs-agent:r --remove-peer legacy-agent
```

## `maestro-cli agent`

Act on one agent

## `maestro-cli agent test-run-on <agent-id>`

Send one short read-only turn through the agent's harness on its Run on target and report the reply (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli agent test-run-on <agent-id> --json
```

## `maestro-cli rename-agent <agent-id> <new-name>`

Rename an agent in the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli rename-agent <agent-id> "API Worker"
```

## `maestro-cli bookmark <agent-id>`

Bookmark an agent (pins it to the Left Bar's Bookmarks section)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli bookmark <agent-id>
```

## `maestro-cli unbookmark <agent-id>`

Remove an agent's bookmark

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli unbookmark <agent-id>
```

## `maestro-cli focus-agent <agent-id>`

Focus (select) an agent in the Maestro desktop UI

| Option           | Description                          | Default |
| ---------------- | ------------------------------------ | ------- |
| `--tab <tab-id>` | Also focus this tab within the agent | -       |
| `--json`         | Output as JSON (for scripting)       | -       |

```bash
maestro-cli focus-agent <agent-id> --tab <tab-id>
```

## `maestro-cli switch-mode <agent-id> <mode>`

Switch an agent between "ai" and "terminal" mode

| Option         | Description                                                                                           | Default |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `--background` | Refuse the switch if the agent is the one on screen, rather than changing what the user is looking at | -       |
| `--focus`      | Switch even when the agent is the one on screen (default)                                             | -       |
| `--json`       | Output as JSON (for scripting)                                                                        | -       |

```bash
maestro-cli switch-mode <agent-id> terminal --background
```

## `maestro-cli interrupt <agent-id>`

Stop an agent's running turn (every busy tab, like the Stop pill), or one tab's with --tab

| Option           | Description                                               | Default |
| ---------------- | --------------------------------------------------------- | ------- |
| `--tab <tab-id>` | Stop only this tab (exact id, unique prefix, or "active") | -       |
| `--json`         | Output as JSON (for scripting)                            | -       |

```bash
maestro-cli interrupt <agent-id> --tab active
```

## `maestro-cli live`

Read or switch Live mode (the web interface other devices on the network can open)

## `maestro-cli live status`

Show whether Live mode is on, its web interface URL, and Remote Control

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli live status --json
```

## `maestro-cli live on`

Turn Live mode on, as the LIVE pill does (no-op when already on; answers with the status)

| Option         | Description                                                          | Default |
| -------------- | -------------------------------------------------------------------- | ------- |
| `--tunnel`     | Also start Remote Control (the Cloudflare tunnel; needs cloudflared) | -       |
| `--background` | Accepted for uniformity; Live mode moves no view                     | -       |
| `--json`       | Output as JSON (for scripting)                                       | -       |

```bash
maestro-cli live on --background
```

## `maestro-cli live off`

Turn Live mode off and stop Remote Control, as the LIVE pill does (no-op when already off)

| Option         | Description                                      | Default |
| -------------- | ------------------------------------------------ | ------- |
| `--background` | Accepted for uniformity; Live mode moves no view | -       |
| `--json`       | Output as JSON (for scripting)                   | -       |

```bash
maestro-cli live off --background
```

## `maestro-cli live tunnel <state>`

Start (on) or stop (off) Remote Control, the Cloudflare tunnel to the web interface. "on" needs Live mode on.

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli live tunnel off
```

## `maestro-cli tab`

Manage an agent's tabs in the desktop app

## `maestro-cli tab new`

Open a new tab for an agent (optionally seeded with a prompt)

| Option                | Description                                                     | Default |
| --------------------- | --------------------------------------------------------------- | ------- |
| `-a, --agent <id>`    | Target agent ID                                                 | -       |
| `-p, --prompt <text>` | Seed the new AI tab with this prompt                            | -       |
| `--background`        | Create the tab without moving the view (agent and tab stay put) | -       |
| `--focus`             | Switch to the new tab after creating it (default)               | -       |
| `--json`              | Output as JSON (for scripting)                                  | -       |

```bash
maestro-cli tab new --agent <agent-id> --prompt "Review the API layer" --background
```

## `maestro-cli tab close <tab-id>`

Close a tab (owning agent is resolved automatically)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab close <tab-id>
```

## `maestro-cli tab rename <tab-id> <new-name>`

Rename a tab

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab rename <tab-id> "Docs"
```

## `maestro-cli tab star <tab-id>`

Star a tab

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab star <tab-id>
```

## `maestro-cli tab unstar <tab-id>`

Unstar a tab

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab unstar <tab-id>
```

## `maestro-cli tab unread <tab-id>`

Mark a tab unread (flags it for the human in the tab bar)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab unread <tab-id>
```

## `maestro-cli tab read <tab-id>`

Clear a tab's unread marker

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab read <tab-id>
```

## `maestro-cli tab save-to-history <tab-id> <bool>`

Enable/disable synopsizing this tab's completions into History (true/false)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab save-to-history <tab-id> false
```

## `maestro-cli tab show <tab-id>`

Show one tab's settings (model, effort, thinking, access, history)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab show active --agent <agent-id>
```

## `maestro-cli tab thinking <tab-id> <mode>`

Set the thinking display: off, on, sticky, or cycle

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab thinking <tab-id> sticky
```

## `maestro-cli tab read-only <tab-id> <bool>`

Put the tab in read-only/plan mode so the agent cannot modify files

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab read-only <tab-id> true
```

## `maestro-cli tab model <tab-id> <model>`

Override the model for this tab ("inherit" clears the override; "auto" lets the model router pick the tier and effort of each turn)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab model <tab-id> opus
maestro-cli tab model <tab-id> inherit
```

## `maestro-cli tab effort <tab-id> <level>`

Override the effort/reasoning level for this tab ("inherit" clears it)

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab effort <tab-id> high
```

## `maestro-cli tab enter-to-send <tab-id> <bool>`

Per-tab send key: true = Enter, false = Cmd+Enter, "inherit" = global setting

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab enter-to-send <tab-id> false
```

## `maestro-cli tab move <tab-id> <position>`

Move a tab to a position in its agent's tab bar (0-based, or "first"/"last")

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli tab move <tab-id> first
```

## `maestro-cli tab suggest-cleanup`

Suggest tabs to close, snooze, or wake across every agent (read-only; uses the Tab cleanup Local Models assignment)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli tab suggest-cleanup --json
```

## `maestro-cli tab closed`

List the closed tabs an agent can reopen, newest first (index 0 = Cmd+Shift+T)

| Option             | Description                                                    | Default |
| ------------------ | -------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose closed tabs (default: the agent selected in the desktop) | -       |
| `--json`           | Output as JSON (for scripting)                                 | -       |

```bash
maestro-cli tab closed --agent <agent-id> --json
```

## `maestro-cli tab reopen`

Reopen a closed tab (default: the newest, as Cmd+Shift+T) and print its tab id

| Option             | Description                                                      | Default |
| ------------------ | ---------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose closed tabs (default: the agent selected in the desktop)   | -       |
| `--index <n>`      | Position from "tab closed" (0 = newest)                          | -       |
| `--tab <tab-id>`   | The id the tab had when it was closed (exact or unique prefix)   | -       |
| `--background`     | Restore the tab without moving the view (agent and tab stay put) | -       |
| `--focus`          | Switch to the restored tab (default)                             | -       |
| `--json`           | Output as JSON (for scripting)                                   | -       |

```bash
maestro-cli tab reopen --agent <agent-id> --index 0 --background
```

## `maestro-cli tab compact [tab-id]`

Context: Compact - summarize a tab into a new tab beside it (default: the active tab) and print its id

| Option             | Description                                             | Default |
| ------------------ | ------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active"          | -       |
| `--json`           | Output as JSON (for scripting)                          | -       |
| `--background`     | Keep the source tab selected (no view change, no toast) | -       |
| `--focus`          | Switch to the compacted tab (default)                   | -       |

```bash
maestro-cli tab compact active --agent <agent-id> --background
```

## `maestro-cli tab merge [tab-id]`

Context: Merge Into - send a tab's transcript, verbatim, into another agent's tab (default: the active tab)

| Option                  | Description                                                                     | Default |
| ----------------------- | ------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`      | Whose active tab, when &lt;tab-id> is "active"                                  | -       |
| `--json`                | Output as JSON (for scripting)                                                  | -       |
| `--into <agent>`        | The agent whose tab receives the context                                        | -       |
| `--target-tab <tab-id>` | The tab that receives it (default: that agent's active tab)                     | -       |
| `--background`          | Stay put; the context waits on the target tab and sends when that tab is opened | -       |
| `--focus`               | Jump to the target tab, which sends the context (default)                       | -       |

```bash
maestro-cli tab merge <tab-id> --into <agent-id> --background
```

## `maestro-cli tab transfer [tab-id]`

Context: Send to Agent - open a new tab in another agent carrying this tab's transcript, verbatim

| Option             | Description                                    | Default |
| ------------------ | ---------------------------------------------- | ------- |
| `-a, --agent <id>` | Whose active tab, when &lt;tab-id> is "active" | -       |
| `--json`           | Output as JSON (for scripting)                 | -       |
| `--to <agent>`     | The agent that gets the new tab                | -       |
| `--background`     | Add the tab without selecting it or the agent  | -       |
| `--focus`          | Jump to the new tab (default)                  | -       |

```bash
maestro-cli tab transfer <tab-id> --to <agent-id> --background
```

## `maestro-cli create-ssh-remote <name>`

Create a new SSH remote configuration

| Option                     | Description                                                                  | Default |
| -------------------------- | ---------------------------------------------------------------------------- | ------- |
| `-H, --host <host>`        | SSH hostname or IP (or SSH config Host pattern with --ssh-config)            | -       |
| `-p, --port <port>`        | SSH port (default: 22)                                                       | -       |
| `-u, --username <user>`    | SSH username                                                                 | -       |
| `-k, --key <path>`         | Path to private key file                                                     | -       |
| `--env <KEY=VALUE>`        | Remote environment variable (repeatable)                                     | `[]`    |
| `--ssh-option <KEY=VALUE>` | Extra ssh -o option, e.g. ProxyCommand=... or ConnectTimeout=45 (repeatable) | `[]`    |
| `--ssh-config`             | Use ~/.ssh/config for connection settings (host becomes Host pattern)        | -       |
| `--disabled`               | Create in disabled state                                                     | -       |
| `--set-default`            | Set as the global default SSH remote                                         | -       |
| `--json`                   | Output as JSON (for scripting)                                               | -       |

```bash
maestro-cli create-ssh-remote "Build box" --host build.example.com --username deploy --key ~/.ssh/id_ed25519
```

`--ssh-option` passes an option to `ssh -o`, overriding Maestro defaults and `~/.ssh/config`. Use it for a tunnel `ProxyCommand`, a `ProxyJump` bastion, or a longer `ConnectTimeout`. `RequestTTY` is reserved because Maestro derives it per command; forcing a TTY can corrupt an agent's stream-json output.

```bash
maestro-cli create-ssh-remote "Tunnelled box" \
  --host tailcat-devbox \
  --ssh-option "ProxyCommand=/opt/homebrew/bin/tailcat tcXXXX 22" \
  --ssh-option ConnectTimeout=45
```

## `maestro-cli update-ssh-remote <remote-id>`

Update an existing SSH remote configuration

| Option                       | Description                                                     | Default |
| ---------------------------- | --------------------------------------------------------------- | ------- |
| `-n, --name <name>`          | Display name                                                    | -       |
| `-H, --host <host>`          | SSH hostname, IP, or SSH config Host pattern                    | -       |
| `-p, --port <port>`          | SSH port                                                        | -       |
| `-u, --username <user>`      | SSH username (empty string clears it)                           | -       |
| `-k, --key <path>`           | Path to private key file (empty string clears it)               | -       |
| `--env <KEY=VALUE>`          | Remote environment variable, merged with existing (repeatable)  | `[]`    |
| `--clear-env`                | Remove all remote environment variables before applying --env   | -       |
| `--disable-env <KEY>`        | Switch an env var off, keeping its value (repeatable)           | `[]`    |
| `--enable-env <KEY>`         | Switch a previously disabled env var back on (repeatable)       | `[]`    |
| `--ssh-option <KEY=VALUE>`   | Extra ssh -o option, merged with existing (repeatable)          | `[]`    |
| `--clear-ssh-options`        | Remove all extra ssh -o options before applying --ssh-option    | -       |
| `--disable-ssh-option <KEY>` | Switch an ssh -o option off, keeping its value (repeatable)     | `[]`    |
| `--enable-ssh-option <KEY>`  | Switch a previously disabled ssh -o option back on (repeatable) | `[]`    |
| `--ssh-config <bool>`        | Use ~/.ssh/config for connection settings (true/false)          | -       |
| `--enabled <bool>`           | Enable or disable this remote (true/false)                      | -       |
| `--set-default`              | Set as the global default SSH remote                            | -       |
| `--json`                     | Output as JSON (for scripting)                                  | -       |

```bash
maestro-cli update-ssh-remote <remote-id> --port 2222 --set-default
```

Only supplied fields change. `--env` and `--ssh-option` merge with existing values; use `--clear-env` or `--clear-ssh-options` to start from empty. `--disable-*` keeps a value but stops passing it to SSH; `--enable-*` restores it. Clearing also removes disabled entries. JSON output includes `sshOptions`, disabled entries, and `resolvedSshOptions` (the effective options including defaults).

## `maestro-cli remove-ssh-remote <remote-id>`

Remove an SSH remote configuration

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli remove-ssh-remote <remote-id>
```

## `maestro-cli test-ssh-remote <remote-id>`

Test an SSH remote connection and report what the remote answered

| Option                  | Description                                          | Default |
| ----------------------- | ---------------------------------------------------- | ------- |
| `-a, --agent <command>` | Also check whether this binary is on the remote PATH | -       |
| `--timeout <seconds>`   | Give up after this many seconds                      | `60`    |
| `--json`                | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli test-ssh-remote <remote-id> --timeout 30
```

`test-ssh-remote` uses the same connection options as agent spawning and prints the remote hostname, so tunnel and `ProxyCommand` errors can be caught during setup. It also works while the desktop is closed.

## `maestro-cli display`

View and manage typography (fonts, sizes, zoom)

## `maestro-cli display font [surface] [value]`

Get or set a surface font. Surfaces: interface, terminal, chat, filePreview, documentGraph, fileEditor. Pass "inherit" (or "inherit:terminal") to follow a root surface. Omit the surface to list all.

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli display font
maestro-cli display font terminal "JetBrains Mono"
```

## `maestro-cli display size <surface> [value]`

Get or set a surface font size in px. Pass "inherit" to follow the interface size.

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli display size chat 15
```

## `maestro-cli display zoom [level]`

Get or set the global zoom applied to every surface (e.g. 125% or 1.25)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli display zoom 125%
```

## `maestro-cli display preset [name]`

Get the active typography preset, or reset every font and size to one (default | hacker)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli display preset default
```

## `maestro-cli display fonts`

List the fonts bundled with Maestro (guaranteed available on any machine)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli display fonts --json
```

## `maestro-cli settings`

View and manage Maestro configuration

## `maestro-cli settings list`

List all settings with current values

| Option                  | Description                                                 | Default |
| ----------------------- | ----------------------------------------------------------- | ------- |
| `--json`                | Output as JSON lines (for scripting)                        | -       |
| `-v, --verbose`         | Show descriptions for each setting (useful for LLM context) | -       |
| `--keys-only`           | Show only setting key names                                 | -       |
| `--defaults`            | Show default values alongside current values                | -       |
| `-c, --category <name>` | Filter by category (e.g., appearance, shell, editor)        | -       |
| `--show-secrets`        | Show sensitive values like API keys (masked by default)     | -       |

```bash
maestro-cli settings list --category appearance --defaults
```

## `maestro-cli settings get <key>`

Get the value of a setting (supports dot-notation, e.g., encoreFeatures.directorNotes)

| Option          | Description                                                | Default |
| --------------- | ---------------------------------------------------------- | ------- |
| `--json`        | Output as JSON (for scripting)                             | -       |
| `-v, --verbose` | Show full details including description, type, and default | -       |

```bash
maestro-cli settings get encoreFeatures.directorNotes --verbose
```

## `maestro-cli settings set <key> <value>`

Set a setting value (auto-detects type: bool, number, JSON, string)

| Option         | Description                                               | Default |
| -------------- | --------------------------------------------------------- | ------- |
| `--json`       | Output as JSON (for scripting)                            | -       |
| `--raw <json>` | Pass an explicit JSON value (bypasses auto type coercion) | -       |

```bash
maestro-cli settings set fontSize 16
maestro-cli settings set localIgnorePatterns --raw '["node_modules",".git"]'
```

## `maestro-cli settings reset <key>`

Reset a setting to its default value

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli settings reset fontSize
```

## `maestro-cli settings media-status`

Report media tools available to this CLI process and allowed models as JSON

| Option   | Description                                                                 | Default |
| -------- | --------------------------------------------------------------------------- | ------- |
| `--json` | Output as JSON (this verb always does; accepted so every verb takes --json) | -       |

```bash
maestro-cli settings media-status --json
```

## `maestro-cli settings agent`

View and manage per-agent configuration

## `maestro-cli settings agent list [agent-id]`

List provider configurations (all, or one provider type), or the settings of one agent when given an agent ID

| Option          | Description                           | Default |
| --------------- | ------------------------------------- | ------- |
| `--json`        | Output as JSON lines (for scripting)  | -       |
| `-v, --verbose` | Show descriptions for each config key | -       |

```bash
maestro-cli settings agent list <agent-id> --verbose
```

## `maestro-cli settings agent get <agent-id> <key>`

Get a provider config value, or one setting of an agent when given an agent ID (e.g. codexTransport)

| Option          | Description                             | Default |
| --------------- | --------------------------------------- | ------- |
| `--json`        | Output as JSON (for scripting)          | -       |
| `-v, --verbose` | Show full details including description | -       |

```bash
maestro-cli settings agent get <agent-id> model
```

## `maestro-cli settings agent set <agent-id> <key> <value>`

Set an agent config value (auto-detects type)

| Option         | Description                                               | Default |
| -------------- | --------------------------------------------------------- | ------- |
| `--json`       | Output as JSON (for scripting)                            | -       |
| `--raw <json>` | Pass an explicit JSON value (bypasses auto type coercion) | -       |

```bash
maestro-cli settings agent set <agent-id> model opus
```

## `maestro-cli settings agent reset <agent-id> <key>`

Remove an agent config key

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli settings agent reset <agent-id> model
```

## `maestro-cli set-theme [name-or-id]`

Switch the active Maestro theme (applies live). Use --list to see options.

| Option       | Description                    | Default |
| ------------ | ------------------------------ | ------- |
| `-l, --list` | List available themes          | -       |
| `--json`     | Output as JSON (for scripting) | -       |

```bash
maestro-cli set-theme --list
maestro-cli set-theme monokai
```

## `maestro-cli gloss [level]`

Set the surface gloss level: off, sheen, strong or max (applies live). Omit the level to see the current one.

| Option       | Description                                  | Default |
| ------------ | -------------------------------------------- | ------- |
| `-l, --list` | List the gloss levels and what each one does | -       |
| `--json`     | Output as JSON (for scripting)               | -       |

```bash
maestro-cli gloss sheen
```

## `maestro-cli theme`

Manage the custom theme palette

## `maestro-cli theme show`

Print the current custom theme palette and base (reads from disk)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli theme show --json
```

## `maestro-cli theme export`

Export the custom theme as portable JSON (stdout, or --file &lt;path>)

| Option              | Description                                         | Default |
| ------------------- | --------------------------------------------------- | ------- |
| `-f, --file <path>` | Write the theme JSON to this file instead of stdout | -       |
| `--json`            | Output as JSON (for scripting)                      | -       |

```bash
maestro-cli theme export --file ./my-theme.json
```

## `maestro-cli theme import <file>`

Import a theme JSON file, apply it live, and activate it

| Option          | Description                                            | Default |
| --------------- | ------------------------------------------------------ | ------- |
| `--no-activate` | Save the palette without switching to the Custom theme | -       |
| `--json`        | Output as JSON (for scripting)                         | -       |

```bash
maestro-cli theme import ./my-theme.json
```

## `maestro-cli theme set [assignments]`

Set custom theme colors (key=value, e.g. accent=#ff0000) and/or re-base

| Option            | Description                                                | Default |
| ----------------- | ---------------------------------------------------------- | ------- |
| `-b, --base <id>` | Initialize from a built-in theme before applying overrides | -       |
| `-a, --activate`  | Switch to the Custom theme after applying                  | -       |
| `--json`          | Output as JSON (for scripting)                             | -       |

```bash
maestro-cli theme set accent=#ff0000 --base dracula --activate
```

## `maestro-cli encore`

List and toggle the optional features on Settings > Plugins

## `maestro-cli encore list`

List the optional features and whether each is on

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli encore list
```

## `maestro-cli encore enable <feature>`

Turn a feature on (any id from `encore list`, e.g. computerHistory or groups-plus)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli encore enable aCappella
```

## `maestro-cli encore disable <feature>`

Turn a feature off

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli encore disable pianola
```

## `maestro-cli computer-history`

Computer History: query what the user saw and typed across apps (local, untrusted content)

## `maestro-cli computer-history status`

Show whether recording is on, permission state, and store size

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history status
```

## `maestro-cli computer-history list`

List recorded 15-minute segments in a time range

| Option           | Description                                             | Default |
| ---------------- | ------------------------------------------------------- | ------- |
| `--since <time>` | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 2h) | -       |
| `--until <time>` | End (default now)                                       | -       |
| `--app <id>`     | Only segments that include this app id                  | -       |
| `--json`         | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli computer-history list --since 2h --app Slack
```

## `maestro-cli computer-history query`

Search recorded events (text, selections, snapshots, app and window changes)

| Option           | Description                                                           | Default |
| ---------------- | --------------------------------------------------------------------- | ------- |
| `--since <time>` | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 1h)               | -       |
| `--until <time>` | End (default now)                                                     | -       |
| `--app <id>`     | App id or name (comma list or repeat)                                 | `[]`    |
| `--kind <kind>`  | text \| selection \| snapshot \| app \| window (comma list or repeat) | `[]`    |
| `--grep <regex>` | Case-insensitive regex over text, titles, URLs, and labels            | -       |
| `--limit <n>`    | Most recent N matches (default 200)                                   | -       |
| `--drafts`       | Keep text commits a later commit in the same field supersedes         | -       |
| `--json`         | Output as JSON (for scripting)                                        | -       |

```bash
maestro-cli computer-history query --since 30m --kind text --grep "invoice"
```

## `maestro-cli computer-history apps`

Apps used in a time range, by foreground time and event count

| Option           | Description                    | Default |
| ---------------- | ------------------------------ | ------- |
| `--since <time>` | Start (default 1d)             | -       |
| `--until <time>` | End (default now)              | -       |
| `--json`         | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history apps --since 1d
```

## `maestro-cli computer-history digests`

List 15-minute digests and 6-hour roll-ups (model-written, untrusted content)

| Option           | Description                                             | Default |
| ---------------- | ------------------------------------------------------- | ------- |
| `--since <time>` | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default 1d) | -       |
| `--until <time>` | End (default now)                                       | -       |
| `--kind <kind>`  | 15m \| 6h (default both)                                | -       |
| `--json`         | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli computer-history digests --since 1d --kind 6h
```

## `maestro-cli computer-history pause`

Pause recording (until resumed, or for a duration)

| Option             | Description                                        | Default |
| ------------------ | -------------------------------------------------- | ------- |
| `--for <duration>` | Pause for 30m, 2h, 1d, 1w (default: until resumed) | -       |
| `--json`           | Output as JSON (for scripting)                     | -       |

```bash
maestro-cli computer-history pause --for 2h
```

## `maestro-cli computer-history resume`

Resume recording

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history resume
```

## `maestro-cli computer-history rules`

Which apps are recorded (exclude or include mode) and domains never recorded

## `maestro-cli computer-history rules list`

Show the app mode and user rules (built-in exclusions always apply)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history rules list
```

## `maestro-cli computer-history rules mode [mode]`

Show or set the app mode: exclude (record every app except ignored ones) or include (record only the record-only list)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history rules mode exclude
```

## `maestro-cli computer-history rules add`

Never record an app or a domain (and its subdomains); with --include, add an app to the record-only list

| Option              | Description                                                               | Default |
| ------------------- | ------------------------------------------------------------------------- | ------- |
| `--app <id>`        | App id or exact name: macOS bundle id, Windows exe name, Linux desktop id | -       |
| `--domain <domain>` | Domain, e.g. bank.example.com                                             | -       |
| `--include`         | Add the app to the record-only list used in include mode                  | -       |
| `--json`            | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli computer-history rules add --app com.apple.Passwords
maestro-cli computer-history rules add --domain bank.example.com
```

## `maestro-cli computer-history rules remove <id>`

Remove a rule by id (or by its app id / domain)

| Option      | Description                                                 | Default |
| ----------- | ----------------------------------------------------------- | ------- |
| `--include` | When removing by value, remove it from the record-only list | -       |
| `--json`    | Output as JSON (for scripting)                              | -       |

```bash
maestro-cli computer-history rules remove <rule-id>
```

## `maestro-cli computer-history clear`

Delete recorded history: everything since a time, or all of it

| Option           | Description                                               | Default |
| ---------------- | --------------------------------------------------------- | ------- |
| `--since <time>` | Delete what was recorded since: 30m, 2h, 1d, 1w, ISO-8601 | -       |
| `--all`          | Delete all recorded history (settings and rules stay)     | -       |
| `--json`         | Output as JSON (for scripting)                            | -       |

```bash
maestro-cli computer-history clear --since 1h
```

## `maestro-cli computer-history enable-accessibility`

macOS: show the Accessibility prompt. Linux: turn on the desktop accessibility bus. Windows: not needed

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli computer-history enable-accessibility
```

## `maestro-cli computer-history config`

Show settings, or change them with the flags below

| Option                             | Description                                                                                             | Default |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| `--retention-days <n>`             | Keep this many days (default 90)                                                                        | -       |
| `--max-gb <n>`                     | Keep at most this many GB (default 25)                                                                  | -       |
| `--snapshots <on\|off>`            | Record visible window text snapshots                                                                    | -       |
| `--skip-private-windows <on\|off>` | Never record private / incognito browser windows (default on)                                           | -       |
| `--digests <on\|off>`              | Write 15-minute digests (off by default)                                                                | -       |
| `--digest-source <local\|agent>`   | Who writes digests: the model assigned to the history-digests task (models assign), or the digest agent | -       |
| `--digest-agent <id>`              | Agent that writes digests; also sets the source to agent (empty string clears it)                       | -       |
| `--digest-rollup <on\|off>`        | Also write 6-hour roll-ups from the 15-minute digests (default on)                                      | -       |
| `--json`                           | Output as JSON (for scripting)                                                                          | -       |

```bash
maestro-cli computer-history config --retention-days 30 --digests on
maestro-cli computer-history config --digest-source local
```

## `maestro-cli pianola`

Pianola manager agent: watch tabs, auto-answer or escalate per your rules

## `maestro-cli pianola watch <tab-id>`

Watch a desktop tab and act on awaiting-input prompts per your rules

| Option                 | Description                                                                     | Default |
| ---------------------- | ------------------------------------------------------------------------------- | ------- |
| `--agent <agent-id>`   | Agent id to dispatch answers to (defaults to the tab owner)                     | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5)                                         | -       |
| `--idle-hours <hours>` | Stop watching after this many hours with no tab activity (default 6, 0 = never) | -       |
| `--dry-run`            | Classify and record decisions but never send a message                          | -       |
| `--once`               | Run a single iteration instead of looping                                       | -       |
| `--json`               | Reserved for scripting; affects the disabled-feature error only                 | -       |

```bash
maestro-cli pianola watch <tab-id> --agent <agent-id> --dry-run --once
```

## `maestro-cli pianola rules`

List the configured Pianola rules

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola rules --json
```

## `maestro-cli pianola add-rule`

Add a Pianola rule (how the manager agent turns a conversation into a durable rule)

| Option                    | Description                                           | Default |
| ------------------------- | ----------------------------------------------------- | ------- |
| `--scope <scope>`         | global \| project \| tab (default global)             | -       |
| `--scope-id <id>`         | Project path (scope project) or tab id (scope tab)    | -       |
| `--action <action>`       | auto_answer \| escalate \| ignore (required)          | -       |
| `--answer <text>`         | Reply text (required for auto_answer)                 | -       |
| `--max-risk <risk>`       | Only fire when risk is at most: low \| medium \| high | -       |
| `--kinds <list>`          | Comma list of signal kinds: question,blocked,none     | -       |
| `--topic-includes <list>` | Comma list of case-insensitive topic substrings       | -       |
| `--priority <n>`          | Lower runs first (default 100)                        | -       |
| `--description <text>`    | Human-readable description                            | -       |
| `--disabled`              | Create the rule disabled                              | -       |
| `--json`                  | Output as JSON (for scripting)                        | -       |

```bash
maestro-cli pianola add-rule --action auto_answer --answer "Yes, continue" --max-risk low --kinds question
```

## `maestro-cli pianola learn`

Crawl installed CLI transcripts into a labeled decision corpus (Claude Code + Codex)

| Option               | Description                                                             | Default |
| -------------------- | ----------------------------------------------------------------------- | ------- |
| `--agent <list>`     | Comma list of agents to crawl: claude-code,codex (default both)         | -       |
| `--limit <n>`        | Max sessions per agent, newest first (default 300)                      | -       |
| `--since <date>`     | Only crawl transcripts modified on/after this date (e.g. 2026-06-01)    | -       |
| `--project <substr>` | Only keep decisions from sessions whose path contains this substring    | -       |
| `--exclude <substr>` | Drop decisions from sessions whose path contains this substring         | -       |
| `--max-pairs <n>`    | Max decision pairs to print inline when --out is not used (default 200) | -       |
| `--out <file>`       | Write the full corpus JSON to a file instead of stdout                  | -       |
| `--json`             | Compact JSON output (for scripting)                                     | -       |

```bash
maestro-cli pianola learn --agent claude-code --since 2026-06-01 --out corpus.json
```

## `maestro-cli pianola profile`

Read a learned decision profile (per-project with --project, else global)

| Option             | Description                                                 | Default |
| ------------------ | ----------------------------------------------------------- | ------- |
| `--project <path>` | Project path to read the profile for (falls back to global) | -       |
| `--json`           | Output as JSON (for scripting)                              | -       |

```bash
maestro-cli pianola profile --project ~/code/api
```

## `maestro-cli pianola set-profile`

Save a learned decision profile from --file or stdin (per-project or global)

| Option             | Description                                                    | Default |
| ------------------ | -------------------------------------------------------------- | ------- |
| `--project <path>` | Project path this profile is for (omit for the global profile) | -       |
| `--file <path>`    | Read the profile markdown from this file (else reads stdin)    | -       |
| `--pair-count <n>` | How many decision pairs this profile was synthesized from      | -       |
| `--json`           | Output as JSON (for scripting)                                 | -       |

```bash
maestro-cli pianola set-profile --project ~/code/api --file profile.md --pair-count 120
```

## `maestro-cli pianola log`

Show recent Pianola decisions from the audit log

| Option        | Description                                    | Default |
| ------------- | ---------------------------------------------- | ------- |
| `--limit <n>` | Maximum number of records to show (default 20) | -       |
| `--json`      | Output as JSON (for scripting)                 | -       |

```bash
maestro-cli pianola log --limit 20
```

## `maestro-cli pianola plan`

Author and inspect Pianola task plans (DAGs)

## `maestro-cli pianola plan set`

Save a plan from --file or piped stdin (validated before write)

| Option          | Description                                          | Default |
| --------------- | ---------------------------------------------------- | ------- |
| `--file <path>` | Read the plan JSON from this file (else reads stdin) | -       |
| `--json`        | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli pianola plan set --file plan.json
```

## `maestro-cli pianola plan list`

List saved plans with a progress summary

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola plan list
```

## `maestro-cli pianola plan show <planId>`

Show one plan: its tasks, statuses, and dependencies

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola plan show <plan-id>
```

## `maestro-cli pianola orchestrate <planId>`

Run a saved plan to completion, dispatching tasks as their dependencies finish

| Option                 | Description                               | Default |
| ---------------------- | ----------------------------------------- | ------- |
| `--interval <seconds>` | Polling interval in seconds (default 5)   | -       |
| `--concurrency <n>`    | Max tasks running at once (default 3)     | -       |
| `--once`               | Run a single iteration instead of looping | -       |
| `--json`               | Output as JSON (for scripting)            | -       |

```bash
maestro-cli pianola orchestrate <plan-id> --concurrency 2 --once
```

## `maestro-cli pianola supervise`

Register desktop-supervised watchers and orchestrations (survive crashes/restarts)

## `maestro-cli pianola supervise watch <tabId>`

Register a supervised tab watcher the desktop keeps alive

| Option                 | Description                                                                          | Default |
| ---------------------- | ------------------------------------------------------------------------------------ | ------- |
| `--agent <agent-id>`   | Agent id to dispatch answers to (required)                                           | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5)                                              | -       |
| `--idle-hours <hours>` | Retire the watcher after this many hours with no tab activity (default 6, 0 = never) | -       |
| `--json`               | Output as JSON (for scripting)                                                       | -       |

```bash
maestro-cli pianola supervise watch <tab-id> --agent <agent-id>
```

## `maestro-cli pianola supervise orchestrate <planId>`

Register a supervised plan orchestration the desktop keeps alive

| Option                 | Description                             | Default |
| ---------------------- | --------------------------------------- | ------- |
| `--concurrency <n>`    | Max tasks running at once (default 3)   | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5) | -       |
| `--json`               | Output as JSON (for scripting)          | -       |

```bash
maestro-cli pianola supervise orchestrate <plan-id> --concurrency 2
```

## `maestro-cli pianola supervise list`

List registered supervised targets

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola supervise list
```

## `maestro-cli pianola supervise remove <id>`

Unregister a supervised target by id (the desktop stops its child)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola supervise remove <id>
```

## `maestro-cli pianola supervise enable <id>`

Enable a supervised target by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola supervise enable <id>
```

## `maestro-cli pianola supervise disable <id>`

Disable a supervised target by id (the desktop stops its child)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli pianola supervise disable <id>
```

## `maestro-cli prompts`

Read Maestro system prompts

## `maestro-cli prompts list`

List all known prompt ids with descriptions

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli prompts list --json
```

## `maestro-cli prompts get <id>`

Print a prompt by id (honors user customizations from Settings → Maestro Prompts)

| Option   | Description                                   | Default |
| -------- | --------------------------------------------- | ------- |
| `--json` | Output as JSON object with metadata + content | -       |

```bash
maestro-cli prompts get _maestro-cli
```

## `maestro-cli gist`

Publish session context to GitHub gists

## `maestro-cli gist create <agent-id>`

Publish an agent's session transcript as a GitHub gist (requires running Maestro app)

| Option                     | Description                                                                                              | Default |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `-d, --description <text>` | Gist description                                                                                         | -       |
| `-p, --public`             | Create a public gist (default: private)                                                                  | -       |
| `-s, --session <id>`       | Publish one provider session's transcript (from `send -s <id>`) instead of the agent's open desktop tabs | -       |
| `--allow-secrets`          | Publish even when the secret screen finds a possible credential (default: refuse and list them, masked)  | -       |
| `--json`                   | Output as JSON (this verb always does; accepted so every verb takes --json)                              | -       |

```bash
maestro-cli gist create <agent-id> --description "Auth bug investigation"
```

## `maestro-cli notify`

Show notifications in the Maestro desktop app

## `maestro-cli notify toast <title> <message>`

Show a toast notification (queued, click X or icon to dismiss)

| Option                    | Description                                                                                                                                                                                                                    | Default |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `-c, --color <color>`     | green \| yellow \| orange \| red \| theme (default: theme)                                                                                                                                                                     | -       |
| `-t, --timeout <seconds>` | Auto-dismiss after N seconds (range: (0, 60]; omitted = app default)                                                                                                                                                           | -       |
| `--dismissible`           | Sticky toast - no auto-dismiss; user must click to close. Cannot combine with --timeout                                                                                                                                        | -       |
| `-a, --agent <id>`        | Associate with an agent so clicking jumps to it                                                                                                                                                                                | -       |
| `--source-agent <label>`  | Label shown in the toast header identifying which agent/pipeline fired it. Store-independent, so it shows even for cron/watchdog toasts. Wins over the name resolved from --agent; pair with --agent to also get click-to-jump | -       |
| `--tab <id>`              | AI tab ID within the agent - clicking jumps to that tab (requires --agent)                                                                                                                                                     | -       |
| `--action-url <url>`      | Inline link rendered beneath the message body (opens in browser when clicked)                                                                                                                                                  | -       |
| `--action-label <text>`   | Label for --action-url (defaults to the URL itself)                                                                                                                                                                            | -       |
| `--open-file <path>`      | On click, switch to the agent and open this file in its File Preview pane (requires --agent; mutually exclusive with the other --open-\* flags)                                                                                | -       |
| `--open-terminal [tab]`   | On click, switch to the agent and focus a terminal tab. Optional value is a tab id or name; bare uses the active terminal tab (requires --agent)                                                                               | -       |
| `--open-browser <url>`    | On click, open this URL in a new in-app browser tab on the agent (requires --agent)                                                                                                                                            | -       |
| `--open-browser-tab <id>` | On click, focus this existing in-app browser tab (the id `open-browser` printed; requires --agent)                                                                                                                             | -       |
| `--open-url <url>`        | On click, open this URL in the system browser (opens outside Maestro; use --open-browser for an in-app tab)                                                                                                                    | -       |
| `--json`                  | Output as JSON (for scripting)                                                                                                                                                                                                 | -       |

```bash
maestro-cli notify toast "Build" "Compiled in 3.2s" --color green --timeout 10
maestro-cli notify toast "Review ready" "Open the diff" --agent <agent-id> --open-file ./diff.md
```

## `maestro-cli notify inbox`

Read and manage the desktop notification center history

## `maestro-cli notify inbox list`

List retained notifications with stable IDs

| Option     | Description              | Default |
| ---------- | ------------------------ | ------- |
| `--unread` | Only list unread entries | -       |
| `--json`   | Output as JSON           | -       |

```bash
maestro-cli notify inbox list
```

## `maestro-cli notify inbox open`

Open the notification center

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox open
```

## `maestro-cli notify inbox close`

Close the notification center

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox close
```

## `maestro-cli notify inbox read-all`

Mark every history entry read

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox read-all
```

## `maestro-cli notify inbox clear`

Clear retained history

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox clear
```

## `maestro-cli notify inbox collapse`

Collapse expanded notification details

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox collapse
```

## `maestro-cli notify inbox dismiss [id]`

Dismiss one notification or all visible toasts and mark their entries read

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox dismiss <id>
```

## `maestro-cli notify inbox read <id>`

Mark one notification read

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox read <id>
```

## `maestro-cli notify inbox activate <id>`

Run a notification body action

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox activate <id>
```

## `maestro-cli notify inbox link <id>`

Open a notification inline link

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox link <id>
```

## `maestro-cli notify inbox detail <id>`

Expand full notification details in the inbox (requires notificationCenterDetails)

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli notify inbox detail <id>
```

## `maestro-cli notify flash <message>`

Show a center-screen flash (momentary, exclusive - replaces any active flash)

| Option                    | Description                                                | Default |
| ------------------------- | ---------------------------------------------------------- | ------- |
| `-c, --color <color>`     | green \| yellow \| orange \| red \| theme (default: theme) | -       |
| `-D, --detail <text>`     | Optional second line shown beneath the message             | -       |
| `-t, --timeout <seconds>` | Auto-dismiss after N seconds (range: (0, 5]; default 1.5)  | -       |
| `--json`                  | Output as JSON (for scripting)                             | -       |

```bash
maestro-cli notify flash "Tests passed" --color green
```

## `maestro-cli notify speak <text>`

Say one line aloud on the computer running Maestro, with a local voice. Waits until it was spoken; queued behind other notices, and refused while a voice session is live

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli notify speak "The deploy finished and the smoke tests pass."
```

## `maestro-cli search <query>`

Search past work across History entries, Director's Notes, and tab transcripts: exact text by default, by meaning with --semantic (requires the desktop app)

| Option              | Description                                                                           | Default |
| ------------------- | ------------------------------------------------------------------------------------- | ------- |
| `--semantic`        | Match by meaning on the Semantic search assignment instead of by exact text           | -       |
| `--source <source>` | Restrict to a source: history, notes, or transcripts (repeatable, or comma-separated) | -       |
| `-a, --agent <id>`  | Restrict to one agent (id, id prefix, or exact name)                                  | -       |
| `-l, --limit <n>`   | Most results to return (default 20, max 100)                                          | -       |
| `--json`            | Output as JSON (for scripting)                                                        | -       |

```bash
maestro-cli search "retry backoff" --source history
maestro-cli search "how we handled rate limits" --semantic
```

## `maestro-cli voice`

A Cappella voice: sessions, the HUD controls, providers, voices, cloud keys, paired devices and the wake word

## `maestro-cli voice status`

Show whether voice is on, the live session, the send wait, and what blocks a session from starting (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice status --json
```

## `maestro-cli voice start`

Start a voice session on the Conductor (the default), an agent, one tab, a document, or Quick Chat. Its HUD opens in the window you are looking at

| Option              | Description                                                                               | Default |
| ------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`  | Talk to this agent (id, id prefix, or exact name)                                         | -       |
| `--tab <id>`        | Talk to this tab only ("active" for the selected tab)                                     | -       |
| `--conductor`       | Talk to the Conductor, which routes each request to an agent                              | -       |
| `--document <path>` | Talk about this document with the agent named by --agent                                  | -       |
| `--quick-chat`      | Talk to Quick Chat: opens its window and locks the session to its chat (no "voice scope") | -       |
| `--paused`          | Open with the microphone shut (push-to-talk): nothing is heard until "voice listen on"    | -       |
| `--json`            | Output as JSON (for scripting)                                                            | -       |

```bash
maestro-cli voice start --conductor
maestro-cli voice start --agent <agent-id> --paused
maestro-cli voice start --quick-chat
```

## `maestro-cli voice stop`

End the voice session and close the microphone. Works with voice switched off

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice stop
```

## `maestro-cli voice listen <state>`

Open (on) or shut (off) the microphone and keep the session: the HUD talk button, and both ends of push-to-talk

| Option   | Description                                                    | Default |
| -------- | -------------------------------------------------------------- | ------- |
| `--send` | With "off": send what was said, as releasing push-to-talk does | -       |
| `--json` | Output as JSON (for scripting)                                 | -       |

```bash
maestro-cli voice listen on
maestro-cli voice listen off --send
```

## `maestro-cli voice send`

Send what was said now, without waiting out the pause: the HUD "Send now" button

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice send
```

## `maestro-cli voice stop-reply`

Cut off the spoken reply and keep the session open

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice stop-reply
```

## `maestro-cli voice scope <mode>`

Re-aim the live session: conductor, agent, or tab (the HUD Tab / Agent / Conductor switch). Refused for a Quick Chat session, which is locked

| Option             | Description                                              | Default |
| ------------------ | -------------------------------------------------------- | ------- |
| `-a, --agent <id>` | The agent, for agent and tab (default: the active agent) | -       |
| `--tab <id>`       | The tab, for tab (default: the selected tab)             | -       |
| `--json`           | Output as JSON (for scripting)                           | -       |

```bash
maestro-cli voice scope agent --agent <agent-id>
```

## `maestro-cli voice wait [ms]`

Show, or set for this conversation, how long a pause sends a request. "default" returns to the saved wait

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wait 1500
maestro-cli voice wait default
```

## `maestro-cli voice volume <level>`

Set the volume of the spoken reply (0.1 to 1): saved, and applied to what is playing

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice volume 0.6
```

## `maestro-cli voice mute`

Silence the spoken reply for now. Not saved, like the HUD mute button

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice mute
```

## `maestro-cli voice unmute`

Return the spoken reply to the saved volume

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice unmute
```

## `maestro-cli voice latency`

Show where the time went in the last finished voice turn, hop by hop

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice latency --json
```

## `maestro-cli voice self-test`

Load each native runtime voice runs on and read the microphone permission. Works with voice switched off

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice self-test
```

## `maestro-cli voice setup`

Show the models local voice needs and which are on disk. Downloads nothing unless --download is passed

| Option       | Description                                                       | Default |
| ------------ | ----------------------------------------------------------------- | ------- |
| `--download` | Download what is missing, as the Voice Setup Download button does | -       |
| `--json`     | Output as JSON (for scripting)                                    | -       |

```bash
maestro-cli voice setup --download
```

## `maestro-cli voice input`

The microphone voice listens on

## `maestro-cli voice input list`

List the microphones the app has seen and the one selected

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice input list
```

## `maestro-cli voice input set <device-id>`

Choose the microphone, from the next capture on. "default" follows the system default

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice input set default
```

## `maestro-cli voice providers`

What transcribes speech, speaks replies, and routes a request

## `maestro-cli voice providers list`

Show what each slot (stt, tts, brain) runs and what it could run

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice providers list
```

## `maestro-cli voice providers set <slot> <provider-id>`

Pick what a slot runs (stt, tts, brain, realtime), or the pipeline (cascade, realtime), then tell the running app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice providers set stt <provider-id>
```

## `maestro-cli voice voices`

The voice replies are spoken in

## `maestro-cli voice voices list`

List the voices the Text-to-Speech provider offers and the one selected

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice voices list
```

## `maestro-cli voice voices set <voice-id>`

Pick the voice replies are spoken in

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice voices set <voice-id>
```

## `maestro-cli voice voices preview [voice-id]`

Speak one line in a voice (the selected one by default). Refused while a session is live

| Option          | Description                                            | Default |
| --------------- | ------------------------------------------------------ | ------- |
| `--text <text>` | The line to speak (default: the Settings Preview line) | -       |
| `--json`        | Output as JSON (for scripting)                         | -       |

```bash
maestro-cli voice voices preview <voice-id> --text "Build finished."
```

## `maestro-cli voice credentials`

The cloud keys hosted voice providers use (openai, elevenlabs, anthropic), kept in the OS keychain

## `maestro-cli voice credentials list`

Show which keys are stored. Never prints a key

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice credentials list
```

## `maestro-cli voice credentials set <service>`

Store a key read from standard input (never an argument, so it stays out of shell history)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
pbpaste | maestro-cli voice credentials set openai
```

## `maestro-cli voice credentials test <service>`

Ask the service whether the stored key works

| Option    | Description                                                    | Default |
| --------- | -------------------------------------------------------------- | ------- |
| `--stdin` | Test a key read from standard input instead, before storing it | -       |
| `--json`  | Output as JSON (for scripting)                                 | -       |

```bash
maestro-cli voice credentials test openai
```

## `maestro-cli voice credentials clear <service>`

Remove a stored key

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice credentials clear openai
```

## `maestro-cli voice devices`

Devices paired to hold a voice session from elsewhere. Pairing itself is approved in the app

## `maestro-cli voice devices list`

List every paired device, whether it is connected, and LAN discovery

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices list --json
```

## `maestro-cli voice devices rename <device> <name>`

Rename a paired device (id, id prefix, or exact name)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices rename <device> "Pedram iPhone"
```

## `maestro-cli voice devices revoke <device>`

End a pairing now: the device is disconnected and must pair again

| Option      | Description                    | Default |
| ----------- | ------------------------------ | ------- |
| `-y, --yes` | Do not ask for confirmation    | -       |
| `--json`    | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices revoke <device> --yes
```

## `maestro-cli voice devices forget <device>`

Delete a device's record altogether

| Option      | Description                    | Default |
| ----------- | ------------------------------ | ------- |
| `-y, --yes` | Do not ask for confirmation    | -       |
| `--json`    | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices forget <device> --yes
```

## `maestro-cli voice devices revoke-all`

End every pairing now

| Option      | Description                    | Default |
| ----------- | ------------------------------ | ------- |
| `-y, --yes` | Do not ask for confirmation    | -       |
| `--json`    | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices revoke-all --yes
```

## `maestro-cli voice devices disconnect`

Drop every live device connection and keep the pairings

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices disconnect
```

## `maestro-cli voice devices discovery <state>`

Advertise this machine on the local network (on), or stop (off)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices discovery on
```

## `maestro-cli voice devices test-connection`

Probe which paths a device could reach this machine on: local network, STUN, TURN relay

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice devices test-connection
```

## `maestro-cli voice wake-phrase`

A wake phrase of its own for one agent: saying it opens a session on that agent

## `maestro-cli voice wake-phrase list`

List every agent with a wake phrase of its own

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake-phrase list
```

## `maestro-cli voice wake-phrase set <agent> <phrase>`

Set one agent's wake phrase, leaving every other agent's as it is

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake-phrase set <agent-id> "hey scout"
```

## `maestro-cli voice wake-phrase clear <agent>`

Remove one agent's wake phrase

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake-phrase clear <agent-id>
```

## `maestro-cli voice wake`

Teach the wake word a phrase from your own recordings: record or add WAV files, then train (requires the desktop app)

## `maestro-cli voice wake test [phrase]`

Run the wake word alone for a few seconds and count how often it fired (default: the configured phrase)

| Option              | Description                                     | Default |
| ------------------- | ----------------------------------------------- | ------- |
| `--seconds <n>`     | How long to listen, 1 to 60 (default 10)        | -       |
| `--sensitivity <n>` | Try a sensitivity from 0 to 1 without saving it | -       |
| `--json`            | Output as JSON (for scripting)                  | -       |

```bash
maestro-cli voice wake test "hey scout" --seconds 10 --sensitivity 0.6
```

## `maestro-cli voice wake list`

List every phrase with recordings, and whether each is trained

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake list
```

## `maestro-cli voice wake status [phrase]`

Show what is recorded for a phrase and what its trained model measured (default: the configured wake phrase)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake status "hey scout"
```

## `maestro-cli voice wake record [phrase]`

Open the microphone and keep each burst of speech as one recording of the phrase (default: the configured wake phrase), until "voice wake stop"

| Option           | Description                                                              | Default |
| ---------------- | ------------------------------------------------------------------------ | ------- |
| `--other-speech` | Record ordinary speech that is NOT the phrase instead (about 30 seconds) | -       |
| `--background`   | -                                                                        | -       |
| `--json`         | Output as JSON (for scripting)                                           | -       |

```bash
maestro-cli voice wake record "hey scout"
maestro-cli voice wake record --other-speech
```

## `maestro-cli voice wake stop`

End the recording in progress and close the microphone

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake stop
```

## `maestro-cli voice wake add <phrase> <files>`

Add recordings from 16-bit PCM WAV files instead of the microphone, one recording of the phrase per file

| Option           | Description                                          | Default |
| ---------------- | ---------------------------------------------------- | ------- |
| `--other-speech` | The files are ordinary speech that is NOT the phrase | -       |
| `--background`   | -                                                    | -       |
| `--json`         | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli voice wake add "hey scout" take1.wav take2.wav
maestro-cli voice wake add "hey scout" talking.wav --other-speech
```

## `maestro-cli voice wake undo [phrase]`

Remove the newest recording of the phrase (default: the configured wake phrase)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake undo "hey scout"
```

## `maestro-cli voice wake clear-background [phrase]`

Remove the ordinary speech recorded for a phrase, so it can be recorded again (default: the configured wake phrase)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake clear-background "hey scout"
```

## `maestro-cli voice wake train [phrase]`

Build the wake word model for a phrase from its recordings (default: the configured wake phrase); waits until training finishes

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake train "hey scout"
```

## `maestro-cli voice wake remove <phrase>`

Delete the trained model and every recording of a phrase

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli voice wake remove "hey scout"
```

## `maestro-cli models`

Local Models: model sources Maestro can use

## `maestro-cli models list`

List the local model Library grouped by what each model is for, with install status, size, what it is good at, and what uses it (requires the desktop app)

| Option              | Description                                                                             | Default |
| ------------------- | --------------------------------------------------------------------------------------- | ------- |
| `-k, --kind <kind>` | Only one kind: text-gen \| embedding \| classifier \| stt \| tts \| wake-word           | -       |
| `--fit`             | Say whether each model runs on this computer: Fits, Tight or Too large, with the reason | -       |
| `--json`            | Output as JSON (for scripting)                                                          | -       |

```bash
maestro-cli models list --kind text-gen --fit
```

## `maestro-cli models add-hf <repo> <file>`

Add a GGUF text model from Hugging Face to the Library by repo id and file name, pinned and labeled "Not verified by Maestro"; prints its license and downloads nothing (requires the desktop app)

| Option      | Description                                          | Default |
| ----------- | ---------------------------------------------------- | ------- |
| `--dry-run` | Describe the model and its license without adding it | -       |
| `--json`    | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli models add-hf <repo> <file>.gguf --dry-run
maestro-cli models add-hf <repo> <file>.gguf
```

## `maestro-cli models remove-hf <model-id>`

Take a model added with add-hf out of the Library and delete its files. Refuses a model a task is assigned to unless --force (requires the desktop app)

| Option        | Description                                             | Default |
| ------------- | ------------------------------------------------------- | ------- |
| `-f, --force` | Remove it even though assigned tasks become unavailable | -       |
| `--json`      | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli models remove-hf <model-id> --force
```

## `maestro-cli models install <model-id>`

Download and verify a local model and the engine it runs on, resuming a paused download; waits until it finishes (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models install <model-id>
```

## `maestro-cli models runtimes`

The native engines local models run on (ONNX Runtime, llama.cpp)

## `maestro-cli models runtimes list`

List the engines with install state, size, and the models each runs (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models runtimes list --json
```

## `maestro-cli models runtimes install <runtime-id>`

Download, verify and install one engine (onnx | llama), or update a stale one; waits until it is usable (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models runtimes install onnx
```

## `maestro-cli models pause <model-id>`

Pause a running download and keep what arrived; models install resumes it (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models pause <model-id>
```

## `maestro-cli models cancel <model-id>`

Cancel a download and delete its partial files; an installed model is not touched (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models cancel <model-id>
```

## `maestro-cli models remove <model-id>`

Delete a downloaded model. Refuses a model a task is assigned to unless --force (requires the desktop app)

| Option        | Description                                             | Default |
| ------------- | ------------------------------------------------------- | ------- |
| `-f, --force` | Remove it even though assigned tasks become unavailable | -       |
| `--json`      | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli models remove <model-id> --force
```

## `maestro-cli models verify <model-id>`

Re-hash a downloaded model against the catalog; never deletes or re-downloads (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models verify <model-id>
```

## `maestro-cli models assign <task-id> <assignment>`

Choose what a task runs on: off | utility-agent | system-one | local:&lt;model-id> | endpoint:&lt;endpoint>:&lt;model>

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models assign tab-naming local:<model-id>
maestro-cli models assign model-routing endpoint:<endpoint>:<model>
maestro-cli models assign cue-gate off
```

## `maestro-cli models tasks`

List every task with its assignment, plus readiness when the desktop app is running

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models tasks --json
```

## `maestro-cli models run <task-id>`

Run a text-generation task (or dictation, with --audio) through its assignment; prints the text, or why it did not run (requires the desktop app)

| Option                | Description                                                                                        | Default |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| `-i, --input <text>`  | The prompt to send (required, except with --cwd or --audio)                                        | -       |
| `--cwd <path>`        | git-drafts only: draft a pull request title and body for the branch checked out in this repository | -       |
| `--base <branch>`     | git-drafts only: the target branch (default: main, then master)                                    | -       |
| `--audio <file>`      | dictation only: transcribe this 16-bit PCM WAV file and print the transcript                       | -       |
| `-s, --system <text>` | System prompt                                                                                      | -       |
| `--max-tokens <n>`    | Token budget for the reply (default 512)                                                           | -       |
| `--json`              | Output as JSON (for scripting)                                                                     | -       |

```bash
maestro-cli models run <task-id> --input "Name this tab: fix the login redirect"
maestro-cli models run git-drafts --cwd ~/code/api --base main
maestro-cli models run dictation --audio note.wav
```

## `maestro-cli models status [task-id]`

Whether each task (or one) would run on its assignment, and if not why and what to do (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models status model-routing
```

## `maestro-cli models index`

What the semantic index is doing: its state, and how many sources are indexed (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models index --json
```

## `maestro-cli models proxy`

The Maestro token proxy: what it carried, saved, and shortened

## `maestro-cli models proxy status`

Whether the proxy is listening, the agents on it and their mode, tokens saved and added latency for the last 30 days, and recent compressions (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models proxy status --json
```

## `maestro-cli models proxy block <hash>`

Show one compressed block from the cache: a diff of what the agent sent against what was sent in its place (requires the desktop app)

| Option         | Description                           | Default |
| -------------- | ------------------------------------- | ------- |
| `--original`   | Print only the text the agent sent    | -       |
| `--compressed` | Print only the text sent in its place | -       |
| `--json`       | Output as JSON (for scripting)        | -       |

```bash
maestro-cli models proxy block <hash> --original
```

## `maestro-cli models server`

The Maestro model server: llama.cpp's llama-server, serving downloaded models to agent harnesses over HTTP

## `maestro-cli models server status`

State, address, engine build and accelerator, models served and loaded, key storage and log path (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models server status --json
```

## `maestro-cli models server start`

Start the model server and wait until it answers (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models server start
```

## `maestro-cli models server stop`

Stop the model server and wait until it exits (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models server stop
```

## `maestro-cli models server set`

Change who can reach it, how many models stay loaded, the key, or the engine build; a running server restarts (requires the desktop app)

| Option             | Description                                                                                             | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------- |
| `--bind <mode>`    | local (127.0.0.1, this machine) \| network (0.0.0.0, needs the key)                                     | -       |
| `--max-models <n>` | Models loaded at the same time (1 to 16, default 1)                                                     | -       |
| `--rotate-key`     | Replace the API key; whatever used the old key needs the new one                                        | -       |
| `--build <choice>` | Install this engine build: default \| cpu \| cuda \| rocm (cuda and rocm on Windows and Linux x64 only) | -       |
| `--json`           | Output as JSON (for scripting)                                                                          | -       |

```bash
maestro-cli models server set --bind local --max-models 2
```

## `maestro-cli models server key`

Print the API key a harness sends to the model server, made on first use (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models server key
```

## `maestro-cli models tiers`

Harness tier defaults: which model a low, medium or high task launches on, per harness

## `maestro-cli models tiers list`

Each tier of each harness with its value and where it came from: Harness default (set by you) or Built-in

| Option           | Description                                           | Default |
| ---------------- | ----------------------------------------------------- | ------- |
| `--harness <id>` | Only this harness (e.g. claude-code, codex, opencode) | -       |
| `--json`         | Output as JSON (for scripting)                        | -       |

```bash
maestro-cli models tiers list --harness claude-code
```

## `maestro-cli models tiers options <harness>`

What a harness can launch a tier on: its own catalogue and the Run on targets, each in the spelling "tiers set" takes (requires the desktop app)

| Option      | Description                                                  | Default |
| ----------- | ------------------------------------------------------------ | ------- |
| `--refresh` | Ask the harness again instead of using the app's cached list | -       |
| `--json`    | Output as JSON (for scripting)                               | -       |

```bash
maestro-cli models tiers options claude-code --refresh
```

## `maestro-cli models tiers suggest <harness>`

A suggested model per tier with the reason, from what the harness lists; a tier nothing ranks is left blank (requires the desktop app)

| Option    | Description                                                         | Default |
| --------- | ------------------------------------------------------------------- | ------- |
| `--apply` | Save the suggested tiers; a tier with no suggestion keeps its value | -       |
| `--json`  | Output as JSON (for scripting)                                      | -       |

```bash
maestro-cli models tiers suggest claude-code --apply
```

## `maestro-cli models tiers set <harness> <tier> <target>`

Set one tier (low | medium | high) of one harness. Target: default (clear it) | provider (the agent's own model) | provider:&lt;model> | &lt;source id>:&lt;model>

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models tiers set claude-code high provider:opus
```

## `maestro-cli models tiers reset <harness>`

Put a harness back on the built-in tier table, or one tier with --tier

| Option          | Description                           | Default |
| --------------- | ------------------------------------- | ------- |
| `--tier <tier>` | Only this tier: low \| medium \| high | -       |
| `--json`        | Output as JSON (for scripting)        | -       |

```bash
maestro-cli models tiers reset claude-code --tier low
```

## `maestro-cli models config`

Local Models configuration: where model files are downloaded from

## `maestro-cli models config show`

Show the download base in force (works with Maestro closed)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models config show
```

## `maestro-cli models config set <key> <value>`

Set a Local Models option. Key: download-base, the host models and Hugging Face metadata are requested from (a mirror when your network blocks Hugging Face; "default" restores https://huggingface.co). Every download is still checked against its hash

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models config set download-base https://hf-mirror.example.com
```

## `maestro-cli models endpoints`

Model servers you run: Ollama, LM Studio, or any OpenAI-compatible base URL

## `maestro-cli models endpoints list`

List configured endpoints (flags an API key variable that is not set)

| Option   | Description                          | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Output as JSON lines (for scripting) | -       |

```bash
maestro-cli models endpoints list --json
```

## `maestro-cli models endpoints add`

Add an endpoint. Ollama and LM Studio default to their standard local port

| Option                 | Description                                                                                       | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `--kind <kind>`        | ollama \| lmstudio \| openai-compatible                                                           | -       |
| `--url <url>`          | Base URL (http/https, no credentials); required for openai-compatible                             | -       |
| `--name <name>`        | Display name (default: the kind, e.g. "Ollama")                                                   | -       |
| `--api-key-env <name>` | NAME of the Settings -> Environment variable holding the API key (the key itself is never stored) | -       |
| `--disabled`           | Add it switched off                                                                               | -       |
| `--json`               | Output as JSON (for scripting)                                                                    | -       |

```bash
maestro-cli models endpoints add --kind ollama
maestro-cli models endpoints add --kind openai-compatible --url https://llm.example.com/v1 --name "Team LLM" --api-key-env TEAM_LLM_KEY
```

## `maestro-cli models endpoints update <endpoint>`

Edit an endpoint, named by id, id prefix, or name; only the fields you pass change

| Option                 | Description                                                                                       | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `--name <name>`        | Display name                                                                                      | -       |
| `--url <url>`          | Base URL (http/https, no credentials)                                                             | -       |
| `--kind <kind>`        | ollama \| lmstudio \| openai-compatible                                                           | -       |
| `--api-key-env <name>` | NAME of the Settings -> Environment variable holding the API key (the key itself is never stored) | -       |
| `--clear-api-key-env`  | Stop sending an API key                                                                           | -       |
| `--enable`             | Switch the endpoint on                                                                            | -       |
| `--disable`            | Switch the endpoint off; tasks assigned to it become unavailable                                  | -       |
| `--json`               | Output as JSON (for scripting)                                                                    | -       |

```bash
maestro-cli models endpoints update <endpoint> --name "Studio Ollama" --disable
```

## `maestro-cli models endpoints remove <endpoint>`

Remove an endpoint, named by id, id prefix, or name

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models endpoints remove <endpoint>
```

## `maestro-cli models endpoints models <endpoint>`

List the models an endpoint serves now, for models assign endpoint:&lt;endpoint>:&lt;model> (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models endpoints models <endpoint>
```

## `maestro-cli models endpoints test <endpoint>`

Send a one-token chat and report latency (requires the desktop app)

| Option                | Description                                             | Default |
| --------------------- | ------------------------------------------------------- | ------- |
| `-m, --model <model>` | Model to test (default: the first one the server lists) | -       |
| `--json`              | Output as JSON (for scripting)                          | -       |

```bash
maestro-cli models endpoints test <endpoint> --model <model>
```

## `maestro-cli models endpoints detect`

Probe this machine for Ollama and LM Studio not yet configured; adds nothing (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli models endpoints detect
```

## `maestro-cli s1`

System One: ask typed questions about a text (yes, pick, rate, ask, rank, batch) and get calibrated judgments back; plus the engine that answers them (Jev, OpenJev, or a local judge), its key, a test, the decision ledger and the spend

## `maestro-cli s1 status`

The engine in force, its address, model and timeout, where each key comes from, the fail policies, and what agents may ask and spend (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 status --json
```

## `maestro-cli s1 set`

Change the System One engine, its timeout, a task fail policy, what the ledger keeps, or what agents may ask and spend

## `maestro-cli s1 set engine <engine>`

Choose the engine: off | jev-cloud (sends task text to TypeSafe) | openjev (your server) | local-judge (a local model, not calibrated) (requires the desktop app)

| Option            | Description                                                                                                                                                         | Default |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--url <url>`     | The OpenJev server (openjev only)                                                                                                                                   | -       |
| `--model <model>` | jev-cloud, openjev: pin this model, or "default" to remove the pin. local-judge: the source it answers on, local:&lt;model-id> or endpoint:&lt;endpoint>:&lt;model> | -       |
| `--json`          | Output as JSON (for scripting)                                                                                                                                      | -       |

```bash
maestro-cli s1 set engine local-judge --model local:<model-id>
maestro-cli s1 set engine openjev --url https://jev.example.com
```

## `maestro-cli s1 set timeout <ms>`

The request budget for Jev and OpenJev, in milliseconds (100 to 60000, default 1500) (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 set timeout 2000
```

## `maestro-cli s1 set fail-policy <task> <policy>`

What a task does when the engine gives no answer: open (the work goes ahead) | closed (it stops) | default (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 set fail-policy cue-gate open
```

## `maestro-cli s1 set keep-inputs <on|off>`

Whether a decision record keeps the state and questions it was asked, with secrets redacted (default off) (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 set keep-inputs on
```

## `maestro-cli s1 set agents <on|off>`

Let agents use System One: whether an agent's own s1 yes, pick, rate, ask, rank and batch are answered, and whether its system prompt says so (default on; one agent is switched off with update-agent --system-one off) (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 set agents off
```

## `maestro-cli s1 set budget [usd]`

What agents may spend on System One in a local day, in US dollars across all agents (0 to 1000, default 1; 0 refuses every agent request) (requires the desktop app)

| Option                    | Description                                                                           | Default |
| ------------------------- | ------------------------------------------------------------------------------------- | ------- |
| `--per-agent <usd\|none>` | The most one agent may spend in a day, or "none" for no cap of its own (default none) | -       |
| `--json`                  | Output as JSON (for scripting)                                                        | -       |

```bash
maestro-cli s1 set budget 2 --per-agent 0.5
```

## `maestro-cli s1 key`

The API key Maestro stores, sealed, for Jev or OpenJev. No verb prints a key

## `maestro-cli s1 key set`

Store a key read from standard input, never from an argument: pbpaste | maestro-cli s1 key set (requires the desktop app)

| Option              | Description                                         | Default |
| ------------------- | --------------------------------------------------- | ------- |
| `--engine <engine>` | jev-cloud \| openjev (default: the engine in force) | -       |
| `--json`            | Output as JSON (for scripting)                      | -       |

```bash
pbpaste | maestro-cli s1 key set --engine jev-cloud
```

## `maestro-cli s1 key clear`

Forget the stored key (requires the desktop app)

| Option              | Description                                         | Default |
| ------------------- | --------------------------------------------------- | ------- |
| `--engine <engine>` | jev-cloud \| openjev (default: the engine in force) | -       |
| `--json`            | Output as JSON (for scripting)                      | -       |

```bash
maestro-cli s1 key clear --engine jev-cloud
```

## `maestro-cli s1 test`

Ask the engine one fixed question and print the answer, the latency and the engine; exits non-zero with no answer (requires the desktop app)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 test --json
```

## `maestro-cli s1 ledger`

The decision ledger: what each System One run decided, or what its fail policy did with no answer, newest first, kept 30 days (requires the desktop app)

| Option                | Description                                                               | Default |
| --------------------- | ------------------------------------------------------------------------- | ------- |
| `--task <task>`       | Only this task (list them with: models tasks)                             | -       |
| `--outcome <outcome>` | ok \| failed-open \| failed-closed \| unavailable \| cancelled \| timeout | -       |
| `--since <time>`      | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default: 30 days)             | -       |
| `--limit <n>`         | At most this many decisions, 1 to 1000 (default 100)                      | -       |
| `--json`              | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli s1 ledger --task model-routing --since 2h --limit 20
```

## `maestro-cli s1 route <prompt>`

A dry run of the model router: the tier and effort the model-routing task picks for a prompt, the router that decided and its latency, without sending anything. With --agent, also what a turn on the Auto model would launch on for that agent. Exits 6 when the router is off and 7 when it gave no decision (requires the desktop app)

| Option             | Description                                                                                                                                                        | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `--agent <id>`     | Resolve the decision for this agent: its tier targets, the harness defaults, and the model, effort and place a turn on Auto would launch on (supports partial IDs) | -       |
| `--correct <tier>` | Record that this prompt needed low \| medium \| high instead of routing it. The embedding router votes with the correction from the next prompt                    | -       |
| `--json`           | Output as JSON (for scripting)                                                                                                                                     | -       |

```bash
maestro-cli s1 route "Rename the config key across the repo"
maestro-cli s1 route "Rename the config key" --correct low
```

## `maestro-cli s1 yes <question>`

Ask one yes or no question about a state: prints P(yes) and yes, no or uncertain; exits 0 for yes and 1 for no, so it works in a shell if (requires the desktop app)

| Option                 | Description                                                                                                               | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--true <text>`        | What a yes means, when the boundary is subtle                                                                             | -       |
| `--false <text>`       | What a no means                                                                                                           | -       |
| `--threshold <p>`      | P(yes) at or above this is yes (default 0.5)                                                                              | -       |
| `--band <low_high...>` | LOW HIGH: under LOW is no, HIGH and over is yes, between them is uncertain                                                | -       |
| `-s, --state <text>`   | The text to judge; @path reads a file; - reads standard input                                                             | -       |
| `--state-file <path>`  | A file to judge (.json is parsed, anything else is text)                                                                  | -       |
| `--state-json <json>`  | The state as inline JSON                                                                                                  | -       |
| `--field <key=value>`  | Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text" | `[]`    |
| `--no-cache`           | Ask the engine even when the answer cache holds this request                                                              | -       |
| `--timeout <seconds>`  | How long to wait for the desktop app (default: what the request can take)                                                 | -       |
| `--json`               | Output as JSON (for scripting)                                                                                            | -       |

```bash
maestro-cli s1 yes "Does this diff change public API?" --state-file change.diff
```

## `maestro-cli s1 pick <question> <options>`

Pick one option, each as NAME or NAME=description: prints the option, the probability of each, and confidence; exits 1 under --min-confidence (requires the desktop app)

| Option                 | Description                                                                                                               | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--min-confidence <p>` | Exit 1 when confidence is under this (default 0)                                                                          | -       |
| `-s, --state <text>`   | The text to judge; @path reads a file; - reads standard input                                                             | -       |
| `--state-file <path>`  | A file to judge (.json is parsed, anything else is text)                                                                  | -       |
| `--state-json <json>`  | The state as inline JSON                                                                                                  | -       |
| `--field <key=value>`  | Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text" | `[]`    |
| `--no-cache`           | Ask the engine even when the answer cache holds this request                                                              | -       |
| `--timeout <seconds>`  | How long to wait for the desktop app (default: what the request can take)                                                 | -       |
| `--json`               | Output as JSON (for scripting)                                                                                            | -       |

```bash
maestro-cli s1 pick "Which team owns this?" "backend=API or database,frontend=UI,infra=build and deploy" --state "Login page returns 500"
```

## `maestro-cli s1 rate <question> <levels>`

Rate a state on a rubric of 2 to 10 levels, low to high, each describing a situation: prints the position and confidence; exits 1 under --min-confidence (requires the desktop app)

| Option                 | Description                                                                                                               | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--min-confidence <p>` | Exit 1 when confidence is under this (default 0)                                                                          | -       |
| `-s, --state <text>`   | The text to judge; @path reads a file; - reads standard input                                                             | -       |
| `--state-file <path>`  | A file to judge (.json is parsed, anything else is text)                                                                  | -       |
| `--state-json <json>`  | The state as inline JSON                                                                                                  | -       |
| `--field <key=value>`  | Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text" | `[]`    |
| `--no-cache`           | Ask the engine even when the answer cache holds this request                                                              | -       |
| `--timeout <seconds>`  | How long to wait for the desktop app (default: what the request can take)                                                 | -       |
| `--json`               | Output as JSON (for scripting)                                                                                            | -       |

```bash
maestro-cli s1 rate "How severe is this?" "cosmetic,annoying,blocks a user,data loss" --state-file report.md
```

## `maestro-cli s1 ask`

Ask several questions about one state in one request, in any mix of --noul, --choice and --score; or pass a whole request as JSON (requires the desktop app)

| Option                    | Description                                                                                                               | Default |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-f, --request <file>`    | A whole request as JSON, \{ "state": ..., "questions": \{ ... \} \}; - reads standard input                               | -       |
| `-s, --state <text>`      | The text to judge; @path reads a file; - reads standard input                                                             | -       |
| `--state-file <path>`     | A file to judge (.json is parsed, anything else is text)                                                                  | -       |
| `--state-json <json>`     | The state as inline JSON                                                                                                  | -       |
| `--field <key=value>`     | Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text" | `[]`    |
| `--noul <args...>`        | A yes or no question: ID INSTRUCTIONS [true=...] [false=...] (repeatable)                                                 | -       |
| `--choice <args...>`      | Pick one option: ID INSTRUCTIONS OPTION[=description] OPTION[=description] ... (repeatable)                               | -       |
| `--score <args...>`       | Rate on a rubric: ID INSTRUCTIONS LEVEL LEVEL ... low to high, 2 to 10 levels (repeatable)                                | -       |
| `--questions-file <path>` | A JSON file of id to question                                                                                             | -       |
| `--questions-json <json>` | Inline JSON of id to question                                                                                             | -       |
| `--no-cache`              | Ask the engine even when the answer cache holds this request                                                              | -       |
| `--timeout <seconds>`     | How long to wait for the desktop app (default: what the request can take)                                                 | -       |
| `--json`                  | Output as JSON (for scripting)                                                                                            | -       |

```bash
maestro-cli s1 ask --state-file report.md --noul urgent "Is it urgent?" --choice team "Which team?" backend frontend infra
```

## `maestro-cli s1 rank [candidates]`

Rank or filter many candidates against a query, one question per candidate; the last line says whether every candidate was judged, and an unjudged one is unknown (requires the desktop app)

| Option                     | Description                                                                                         | Default |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| `--query <query>`          | What is looked for: text, JSON, or @path                                                            | -       |
| `--candidates-file <path>` | One candidate per line (keyed by line number), or a .json list or .jsonl rows                       | -       |
| `--id-key <field>`         | The field of a JSON candidate that names it in the results (default id; else its place in the list) | -       |
| `--instructions <text>`    | The question, naming the item `candidate` and the query `query` (default: is it relevant)           | -       |
| `--true <text>`            | What a yes means (not with --levels)                                                                | -       |
| `--false <text>`           | What a no means (not with --levels)                                                                 | -       |
| `--levels <levels...>`     | Grade on a rubric, low to high, instead of yes or no                                                | -       |
| `--context <context>`      | Shared background for every judgment: text, JSON, or @path                                          | -       |
| `--top <n>`                | Keep the best N                                                                                     | -       |
| `--min <p>`                | Keep results at or above this, 0 to 1                                                               | -       |
| `--width <n>`              | Cut a candidate shown on a row at this length (default 110)                                         | -       |
| `--echo`                   | With --json, include each candidate in its result                                                   | -       |
| `--no-cache`               | Ask the engine even when the answer cache holds this request                                        | -       |
| `--timeout <seconds>`      | How long to wait for the desktop app (default: what the request can take)                           | -       |
| `--json`                   | Output as JSON (for scripting)                                                                      | -       |

```bash
maestro-cli s1 rank --query "token refresh bug" --candidates-file commits.txt --top 5
```

## `maestro-cli s1 batch`

Ask the same questions of every row of a file, one request per row: prints JSONL, one answer row per input row and a last row that says whether the run finished (requires the desktop app)

| Option                    | Description                                                                                 | Default |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `-i, --input <file>`      | JSONL (a row is the state) or text lines; - reads standard input                            | -       |
| `--state-key <field>`     | The field of each JSON row that is the state                                                | -       |
| `--id-key <field>`        | The field of each JSON row echoed back as id (default id)                                   | -       |
| `--text-lines`            | Read every line as text, even one that is JSON                                              | -       |
| `--echo`                  | Include the state in each output row                                                        | -       |
| `-o, --out <file>`        | Write the JSONL here and print only the summary                                             | -       |
| `--noul <args...>`        | A yes or no question: ID INSTRUCTIONS [true=...] [false=...] (repeatable)                   | -       |
| `--choice <args...>`      | Pick one option: ID INSTRUCTIONS OPTION[=description] OPTION[=description] ... (repeatable) | -       |
| `--score <args...>`       | Rate on a rubric: ID INSTRUCTIONS LEVEL LEVEL ... low to high, 2 to 10 levels (repeatable)  | -       |
| `--questions-file <path>` | A JSON file of id to question                                                               | -       |
| `--questions-json <json>` | Inline JSON of id to question                                                               | -       |
| `--no-cache`              | Ask the engine even when the answer cache holds this request                                | -       |
| `--timeout <seconds>`     | How long to wait for the desktop app (default: what the request can take)                   | -       |
| `--json`                  | Output as JSON (for scripting)                                                              | -       |

```bash
maestro-cli s1 batch --input notes.jsonl --state-key text --noul spam "Is this spam?" --out answers.jsonl
```

## `maestro-cli s1 usage`

What agents' own System One requests came to, per agent: requests, cached requests, tokens, cost and latency, with today's spend against the budget (requires the desktop app)

| Option           | Description                                                   | Default |
| ---------------- | ------------------------------------------------------------- | ------- |
| `--agent <id>`   | Only this agent (an id or the start of one)                   | -       |
| `--since <time>` | Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default: 30 days) | -       |
| `--json`         | Output as JSON (for scripting)                                | -       |

```bash
maestro-cli s1 usage --agent <agent-id> --since 7d
```

## `maestro-cli s1 cost [state]`

Estimate a request or a job before it is run: its tokens against the request limit, its requests and its price. Nothing is sent to an engine (requires the desktop app)

| Option                 | Description                                                                                                               | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--questions <n>`      | Questions asked of each state (default 1)                                                                                 | -       |
| `--question-chars <n>` | Average characters of one question with its criteria (default 120)                                                        | -       |
| `--items <n>`          | Candidates of a rank, or rows of a batch                                                                                  | -       |
| `--per-item`           | Each item is its own request with the whole state (a batch), not packed (a rank)                                          | -       |
| `-s, --state <text>`   | The text to judge; @path reads a file; - reads standard input                                                             | -       |
| `--state-file <path>`  | A file to judge (.json is parsed, anything else is text)                                                                  | -       |
| `--state-json <json>`  | The state as inline JSON                                                                                                  | -       |
| `--field <key=value>`  | Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text" | `[]`    |
| `--json`               | Output as JSON (for scripting)                                                                                            | -       |

```bash
maestro-cli s1 cost --state-file report.md --questions 3
```

## `maestro-cli s1 guide [topic]`

The System One playbook for agents: when to reach for it, how to ask, how to read the answer. Read it once per session before the first request; name a topic for depth (works with Maestro closed)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--list` | List the topics                | -       |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 guide --list
maestro-cli s1 guide batch
```

## `maestro-cli s1 examples [name]`

System One recipes ready to paste: gutcheck, triage, rank, verify, screen, dedupe. With no name, list them; all prints every one (works with Maestro closed)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli s1 examples
```

## `maestro-cli profiling`

Start/stop a Chromium performance capture in the desktop app (for perf iteration)

## `maestro-cli profiling start`

Begin a performance capture (no-ops if one is already recording)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli profiling start
```

## `maestro-cli profiling stop`

Stop the capture and write the compressed .zip bundle to --output

| Option                | Description                                                                               | Default |
| --------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `-o, --output <path>` | Destination .zip path (absolute or relative to cwd; ~ expanded). Parent dirs are created. | -       |
| `--json`              | Output as JSON (for scripting)                                                            | -       |

```bash
maestro-cli profiling stop --output ./trace.json
```

## `maestro-cli profiling status`

Report whether a capture is currently recording

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli profiling status
```

## `maestro-cli maestro-run`

MaestroRun (macOS): install the launcher and grant it Full Disk Access for scheduled scripts

## `maestro-cli maestro-run status`

Re-check the launcher: installed version, signature, and Full Disk Access

| Option           | Description                            | Default |
| ---------------- | -------------------------------------- | ------- |
| `--check-latest` | Also ask GitHub for the newest release | -       |
| `--json`         | Output as JSON (for scripting)         | -       |

```bash
maestro-cli maestro-run status --check-latest
```

## `maestro-cli maestro-run install`

Download, verify, and install the newest MaestroRun release for this Mac (or update it)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli maestro-run install
```

## `maestro-cli maestro-run grant`

Open System Settings on the Full Disk Access list and watch for the switch (the user flips it)

| Option     | Description                                                    | Default |
| ---------- | -------------------------------------------------------------- | ------- |
| `--reveal` | Also show MaestroRun.app in Finder, for dragging into the list | -       |
| `--json`   | Output as JSON (for scripting)                                 | -       |

```bash
maestro-cli maestro-run grant --reveal
```

## `maestro-cli dataview`

Dataview: run a note's Dataview queries, manage the vault index, and choose the vaults DataviewJS trusts

## `maestro-cli dataview query <file>`

Run a note's dataview blocks with `this` bound to the note (DataviewJS blocks are desktop-only)

| Option         | Description                                                               | Default |
| -------------- | ------------------------------------------------------------------------- | ------- |
| `--block <n>`  | Run only the n-th dataview block (1-based; dataviewjs fences not counted) | -       |
| `--agent <id>` | Agent the note belongs to (default: the agent whose folder holds it)      | -       |
| `--json`       | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli dataview query <file> --agent <agent-id> --json
```

## `maestro-cli dataview eval <file> <dql>`

Run an ad-hoc DQL query with `this` bound to the note; start with = for an inline expression

| Option         | Description                                                          | Default |
| -------------- | -------------------------------------------------------------------- | ------- |
| `--agent <id>` | Agent the note belongs to (default: the agent whose folder holds it) | -       |
| `--json`       | Output as JSON (for scripting)                                       | -       |

```bash
maestro-cli dataview eval <file> "LIST FROM #meeting" --json
```

## `maestro-cli dataview index`

Inspect or rebuild the Dataview index of a vault

## `maestro-cli dataview index status [root]`

Show the open vault indexes, or one vault root (pages, revision, watcher, cache)

| Option         | Description                                                   | Default |
| -------------- | ------------------------------------------------------------- | ------- |
| `--agent <id>` | Agent whose SSH remote holds the root (default: a local root) | -       |
| `--json`       | Output as JSON (for scripting)                                | -       |

```bash
maestro-cli dataview index status --json
```

## `maestro-cli dataview index rebuild <root>`

Drop a vault root's index cache and index it again from scratch

| Option         | Description                                                   | Default |
| -------------- | ------------------------------------------------------------- | ------- |
| `--agent <id>` | Agent whose SSH remote holds the root (default: a local root) | -       |
| `--json`       | Output as JSON (for scripting)                                | -       |

```bash
maestro-cli dataview index rebuild <vault-root>
```

## `maestro-cli dataview trust <root>`

Trust a vault root: its DataviewJS blocks run in the sandbox without asking

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli dataview trust <vault-root>
```

## `maestro-cli dataview untrust <root>`

Stop trusting a vault root: its DataviewJS blocks ask before they run

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli dataview untrust <vault-root>
```

## `maestro-cli dataview trusted`

List the vault roots whose DataviewJS blocks run without asking

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli dataview trusted --json
```

## `maestro-cli quick-chat`

Drive the Quick Chat window: a floating chat with one agent, summoned by a hotkey

## `maestro-cli quick-chat show`

Open the Quick Chat window (same as the hotkey when it is closed)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat show
```

## `maestro-cli quick-chat hide`

Close the Quick Chat window; the conversation is kept

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat hide
```

## `maestro-cli quick-chat return`

Close the Quick Chat window and bring Maestro forward (Cmd+` in the window)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat return
```

## `maestro-cli quick-chat toggle`

Open the window, focus it, or close it (exactly what the hotkey does)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat toggle
```

## `maestro-cli quick-chat status`

Show the window state, the agent, the mode, and the current conversation

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat status --json
```

## `maestro-cli quick-chat send [message]`

Send a message in the current Quick Chat (starts a chat if none is open); --image attaches images

| Option              | Description                                                  | Default |
| ------------------- | ------------------------------------------------------------ | ------- |
| `--image <path...>` | Image file(s) to send with the message (PNG, JPG, GIF, WebP) | -       |
| `--json`            | Output as JSON (for scripting)                               | -       |

```bash
maestro-cli quick-chat send "What changed on main today?"
```

## `maestro-cli quick-chat new`

Start a new chat (the previous one finishes any reply in progress; an ephemeral one is then deleted)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat new
```

## `maestro-cli quick-chat keep [state]`

Keep the current chat as a visible tab on its agent ("off" makes it ephemeral)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat keep on
```

## `maestro-cli quick-chat pin [state]`

Float the window above other windows ("off" lets it fall behind them)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat pin on
```

## `maestro-cli quick-chat tab [target]`

Where the next message goes: a tab id (from status), new, or auto; the chat stays there (no target prints it)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat tab new
```

## `maestro-cli quick-chat thinking [mode]`

Show the agent's reasoning: off, on (until the answer arrives), sticky (kept), or cycle (no mode prints it)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat thinking sticky
```

## `maestro-cli quick-chat font [size]`

Text size of the conversation: in, out, reset, or a size such as 120% (no size prints it)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat font 120%
maestro-cli quick-chat font reset
```

## `maestro-cli quick-chat agent <agent-id>`

Switch Quick Chat to another agent and start a new chat there

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat agent <agent-id>
```

## `maestro-cli quick-chat reveal [message-id]`

Open a tab of the chat in the main Maestro window: the tab a message went to, or the latest

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat reveal
```

## `maestro-cli quick-chat new-tab [message-id]`

Send a message to a new tab instead of the tab it went to: out of the queue, or stopped and sent again if it already ran (default: the latest queued one)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat new-tab <message-id>
```

## `maestro-cli quick-chat steer [message-id]`

Steer a queued message into the reply already running in its tab, so the agent changes course now instead of answering it afterwards (default: the latest steerable one)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat steer <message-id>
```

## `maestro-cli quick-chat history`

List the recent chats, newest first (what the window's History button shows)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat history
```

## `maestro-cli quick-chat recall <chat>`

Bring back a recent chat (its agent, tab, and messages): its number in `history`, its id, or an id prefix

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat recall <chat>
```

## `maestro-cli quick-chat stop`

Stop the replies in progress and withdraw the messages still queued

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli quick-chat stop
```

## `maestro-cli quick-chat bounds`

Move or resize the window, as dragging it does, and remember it (--height is the conversation height)

| Option          | Description                                 | Default |
| --------------- | ------------------------------------------- | ------- |
| `--x <px>`      | Left edge, in screen points (give with --y) | -       |
| `--y <px>`      | Top edge, in screen points (give with --x)  | -       |
| `--width <px>`  | Width                                       | -       |
| `--height <px>` | Height of the conversation shape            | -       |
| `--json`        | Output as JSON (for scripting)              | -       |

```bash
maestro-cli quick-chat bounds --x 200 --y 120 --width 640
```

## `maestro-cli cadenza`

Open small cadenza views to display or track work in the Maestro desktop app

## `maestro-cli cadenza open <id>`

Open (or replace by id) a cadenza view

| Option                   | Description                                                                                                         | Default |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------- |
| `--type <type>`          | tracker \| file \| markdown \| image \| code \| view \| html \| decision (default: tracker)                         | -       |
| `--title <text>`         | Header label for the panel                                                                                          | -       |
| `--body <text>`          | Body content - tracker line, markdown/code source, JSON block spec (--type view), HTML document, or decision prompt | -       |
| `--body-file <path>`     | Read body content from a file (markdown, view JSON, code, or HTML)                                                  | -       |
| `--path <path>`          | File/image path (required for file and image; for --type code, shows that file as a snippet)                        | -       |
| `--lang <lang>`          | Language for --type code highlighting (inferred from --path if omitted)                                             | -       |
| `--option <label:value>` | A decision button (repeatable); clicking replies value to --agent. Requires --type decision                         | `[]`    |
| `-c, --color <color>`    | green \| yellow \| orange \| red \| theme (default: theme)                                                          | -       |
| `-a, --agent <id>`       | Owning agent - lets a file cadenza expand into its tab, and the reply target for --type decision                    | -       |
| `--json`                 | Output as JSON (for scripting)                                                                                      | -       |

```bash
maestro-cli cadenza open build --type tracker --title "Build" --body "Compiling..." --color orange
```

## `maestro-cli cadenza update <id>`

Update fields of an open cadenza in place (the living view)

| Option                | Description                                        | Default |
| --------------------- | -------------------------------------------------- | ------- |
| `--title <text>`      | New header label                                   | -       |
| `--body <text>`       | New body content (tracker line or markdown source) | -       |
| `--body-file <path>`  | Read new body content from a file                  | -       |
| `--path <path>`       | New file/image path                                | -       |
| `-c, --color <color>` | green \| yellow \| orange \| red \| theme          | -       |
| `--json`              | Output as JSON (for scripting)                     | -       |

```bash
maestro-cli cadenza update build --body "Compiled in 3.2s" --color green
```

## `maestro-cli cadenza close <id>`

Close a cadenza view by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli cadenza close build
```

## `maestro-cli movement`

Compose the agent-driven movement (free-placed data views) in the Maestro main window

## `maestro-cli movement begin <id>`

Reserve a host-rendered Concerto shell without opening the stage

| Option           | Description                                  | Default |
| ---------------- | -------------------------------------------- | ------- |
| `--title <text>` | Concerto title shown in its frame            | -       |
| `--x <px>`       | X position (px from the Concerto stage left) | -       |
| `--y <px>`       | Y position (px from the Concerto stage top)  | -       |
| `--width <px>`   | Shell width in px (default: 880)             | -       |
| `--height <px>`  | Shell height in px (default: 560)            | -       |
| `--json`         | Output as JSON (for scripting)               | -       |

```bash
maestro-cli movement begin release --title "Release board"
```

## `maestro-cli movement add <id>`

Add or replace a native data view or HTML mockup without opening the stage

| Option               | Description                                                             | Default |
| -------------------- | ----------------------------------------------------------------------- | ------- |
| `--type <type>`      | view \| html (default: view)                                            | -       |
| `--x <px>`           | X position (px from movement left)                                      | -       |
| `--y <px>`           | Y position (px from movement top)                                       | -       |
| `--width <px>`       | Item width in px (default: 500 view, 880 html)                          | -       |
| `--height <px>`      | Optional fixed item height in px (default: fit content)                 | -       |
| `--title <text>`     | Item header title                                                       | -       |
| `--body <content>`   | Block spec JSON for --type view, or a complete document for --type html | -       |
| `--body-file <path>` | Read the view JSON or HTML document from a file                         | -       |
| `--html-file <path>` | Read an HTML document from a file (implies --type html)                 | -       |
| `--json`             | Output as JSON (for scripting)                                          | -       |

```bash
maestro-cli movement add status --type view --body-file status.json --x 0 --y 0
```

## `maestro-cli movement update <id>`

Update fields of an existing movement item in place

| Option               | Description                                                | Default |
| -------------------- | ---------------------------------------------------------- | ------- |
| `--type <type>`      | Switch or confirm the item type: view \| html              | -       |
| `--x <px>`           | New X position                                             | -       |
| `--y <px>`           | New Y position                                             | -       |
| `--width <px>`       | New width                                                  | -       |
| `--height <px>`      | New fixed height                                           | -       |
| `--title <text>`     | New title                                                  | -       |
| `--body <content>`   | New block spec JSON or HTML document                       | -       |
| `--body-file <path>` | Read the new view JSON or HTML document from a file        | -       |
| `--html-file <path>` | Read a new HTML document from a file (implies --type html) | -       |
| `--json`             | Output as JSON (for scripting)                             | -       |

```bash
maestro-cli movement update status --title "Status (live)"
```

## `maestro-cli movement move <id>`

Reposition a movement item

| Option     | Description                    | Default |
| ---------- | ------------------------------ | ------- |
| `--x <px>` | New X position                 | -       |
| `--y <px>` | New Y position                 | -       |
| `--json`   | Output as JSON (for scripting) | -       |

```bash
maestro-cli movement move status --x 520 --y 0
```

## `maestro-cli movement remove <id>`

Remove a movement item by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli movement remove status
```

## `maestro-cli movement clear`

Remove all movement items

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli movement clear
```

## `maestro-cli movement progress <id>`

Report one Concerto track's current design phase and subdivision

| Option              | Description                                                                           | Default |
| ------------------- | ------------------------------------------------------------------------------------- | ------- |
| `--title <text>`    | Concerto title shown in the pipeline                                                  | -       |
| `--phase <phase>`   | composing \| refining \| arranging \| reviewing \| testing                            | -       |
| `--step <n>`        | Active one-based substep (default: 1)                                                 | -       |
| `--steps <n>`       | Planned substeps in this phase, 1 through 8 (default: 1)                              | -       |
| `--notes <pattern>` | Comma-separated quarter/eighth/sixteenth notes with optional +dotted, +triad, or +tie | -       |
| `--json`            | Output as JSON (for scripting)                                                        | -       |

```bash
maestro-cli movement progress track-1 --title "Auth rewrite" --phase refining --step 2 --steps 4
```

## `maestro-cli movement state`

Read the current movement layout (items + size) to compose around it

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli movement state --json
```

## `maestro-cli movement inspect <id>`

Capture a visible HTML Movement preview (requires an open stage) and diagnostics

| Option           | Description                                       | Default |
| ---------------- | ------------------------------------------------- | ------- |
| `--output <png>` | Write the live mockup screenshot to this PNG path | -       |
| `--json`         | Output as JSON (for scripting)                    | -       |

```bash
maestro-cli movement inspect mockup --output ./mockup.png
```

## `maestro-cli movement interact <id>`

Interact with a live HTML Movement by CSS selector

| Option               | Description                                            | Default |
| -------------------- | ------------------------------------------------------ | ------- |
| `--click <selector>` | Click the matching element                             | -       |
| `--type <selector>`  | Enter text into the matching input or editable element | -       |
| `--value <text>`     | Text used with --type                                  | -       |
| `--json`             | Output as JSON (for scripting)                         | -       |

```bash
maestro-cli movement interact mockup --click "#save"
```

## `maestro-cli support-package`

Write a sanitized support (debug) package zip, as Create Debug Package does, without a save dialog

| Option               | Description                                                                                                       | Default |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `-o, --output <dir>` | Directory to write maestro-debug-&lt;timestamp>.zip into (created if missing; ~ expanded)                         | -       |
| `--no-logs`          | Leave out application logs                                                                                        | -       |
| `--no-errors`        | Leave out recent errors                                                                                           | -       |
| `--no-sessions`      | Leave out agent/session metadata                                                                                  | -       |
| `--no-group-chats`   | Leave out group chat metadata                                                                                     | -       |
| `--no-batch-state`   | Leave out Auto Run state                                                                                          | -       |
| `--allow-secrets`    | Write the package even when the secret screen finds a possible credential (default: refuse and list them, masked) | -       |
| `--json`             | Output as JSON (for scripting)                                                                                    | -       |

```bash
maestro-cli support-package --output ~/Desktop --no-sessions
```

## `maestro-cli feedback`

Send Feedback from the CLI: check gh, find duplicates, +1 an issue, or file a new one (open the modal with `open feedback`)

## `maestro-cli feedback auth`

Check that the GitHub CLI (gh) is installed, logged in, and allowed to file on the feedback repo (required to file); names the gh account, and prints the login command when signing in can fix it

| Option    | Description                                          | Default |
| --------- | ---------------------------------------------------- | ------- |
| `--fresh` | Skip the cached verdict (after logging in elsewhere) | -       |
| `--json`  | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli feedback auth --json
```

## `maestro-cli feedback login`

Sign the GitHub CLI in for feedback (gh auth login, device code + browser), as the modal's "Log in to GitHub" does

| Option   | Description                               | Default |
| -------- | ----------------------------------------- | ------- |
| `--json` | Output the result as JSON (for scripting) | -       |

```bash
maestro-cli feedback login
```

## `maestro-cli feedback accounts`

List the provider accounts the Feedback chat can run as, in the order it tries them (first usable one wins)

| Option        | Description                                                               | Default |
| ------------- | ------------------------------------------------------------------------- | ------- |
| `--use <key>` | Make this account (a key from the list) the one the next chat tries first | -       |
| `--clear`     | Forget the remembered account and pick automatically again                | -       |
| `--json`      | Output as JSON (for scripting)                                            | -       |

```bash
maestro-cli feedback accounts --json
```

## `maestro-cli feedback diagnose`

Read the live app state the Feedback chat starts from: agents that are busy, errored, limit-paused, retrying, or running Auto Run, plus recent warnings and errors (redacted, read-only)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli feedback diagnose --json
```

## `maestro-cli feedback search <query>`

Search RunMaestro/Maestro for issues matching a description

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

```bash
maestro-cli feedback search "queue drops a message"
```

## `maestro-cli feedback submit`

File a GitHub issue exactly as the Feedback modal does. Stops on likely duplicates unless --force

| Option                      | Description                                                                                          | Default |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `-c, --category <category>` | bug \| feature \| improvement \| general                                                             | -       |
| `-s, --summary <text>`      | One-line summary (max 120 chars; becomes the title)                                                  | -       |
| `-e, --expected <text>`     | Expected behavior (bug) or desired outcome (other categories)                                        | -       |
| `-a, --actual <text>`       | Actual behavior (bug) or details (other categories)                                                  | -       |
| `--steps <text>`            | Steps to reproduce                                                                                   | -       |
| `--context <text>`          | Additional context                                                                                   | -       |
| `--attach <image...>`       | Screenshots to attach: PNG, JPG, GIF, or WebP, up to 5 files, 10 MB each                             | -       |
| `--support-package`         | Generate a sanitized support package and link it from the issue (the modal checkbox)                 | -       |
| `--force`                   | File even when possible duplicates exist                                                             | -       |
| `--allow-secrets`           | File even when the secret screen finds a possible credential (default: refuse and list them, masked) | -       |
| `--json`                    | Output as JSON (for scripting)                                                                       | -       |

```bash
maestro-cli feedback submit --category bug --summary "Queue drops a message" --expected "It runs" --actual "It vanishes"
```

## `maestro-cli feedback subscribe <issue>`

Add a +1 to an existing issue instead of filing a duplicate

| Option             | Description                                                                    | Default |
| ------------------ | ------------------------------------------------------------------------------ | ------- |
| `--comment <text>` | Also post this comment on the issue                                            | -       |
| `--allow-secrets`  | Post the comment even when the secret screen finds a possible credential in it | -       |
| `--json`           | Output as JSON (for scripting)                                                 | -       |

```bash
maestro-cli feedback subscribe 1234 --comment "Also seen on 1.4"
```

## `maestro-cli stats`

Show aggregated Usage Dashboard metrics for a time range

| Option                | Description                                                      | Default |
| --------------------- | ---------------------------------------------------------------- | ------- |
| `-r, --range <range>` | Time range: day, week, month, quarter, year, all (default: week) | -       |
| `--json`              | Output the full aggregation object as JSON                       | -       |

```bash
maestro-cli stats --range month --json
```

## `maestro-cli stats models`

Show what every model other than a provider's own did: sources, tasks, Run on agents, System One and the token proxy (the Usage Dashboard's Models tab)

| Option                | Description                                                      | Default |
| --------------------- | ---------------------------------------------------------------- | ------- |
| `-r, --range <range>` | Time range: day, week, month, quarter, year, all (default: week) | -       |
| `--json`              | Output the full model usage record as JSON                       | -       |

```bash
maestro-cli stats models --range week --json
```

## `maestro-cli stats-tokens`

Show token usage, cost, and tokens per second (average and peak) per provider and model

| Option                | Description                                                      | Default |
| --------------------- | ---------------------------------------------------------------- | ------- |
| `-r, --range <range>` | Time range: day, week, month, quarter, year, all (default: week) | -       |
| `--refresh`           | Re-read changed transcripts instead of the app's cached result   | -       |
| `--json`              | Output the full token usage object as JSON                       | -       |

```bash
maestro-cli stats-tokens --range week --json
```

## `maestro-cli stats-indexing`

Show progress of a usage-data scan (a one-time re-read after an upgrade, or a first index)

| Option                | Description                                                   | Default |
| --------------------- | ------------------------------------------------------------- | ------- |
| `--wait`              | Block until no scan is running, printing progress each second | -       |
| `--timeout <seconds>` | With --wait, give up after this many seconds (exit code 1)    | -       |
| `--json`              | Output as JSON                                                | -       |

```bash
maestro-cli stats-indexing --json
maestro-cli stats-indexing --wait --timeout 300
```

## `maestro-cli stats-query <sql>`

Run a read-only SQL query against the stats database (SELECT / read PRAGMA only)

| Option                | Description                                                       | Default |
| --------------------- | ----------------------------------------------------------------- | ------- |
| `-p, --param <value>` | Bind a value to a positional ? placeholder (repeatable, in order) | `[]`    |
| `--json`              | Output rows as JSON instead of a tab-separated table              | -       |

```bash
maestro-cli stats-query "SELECT agent_id, COUNT(*) FROM query_events WHERE start_time > ? GROUP BY agent_id" --param 1760000000000
```

## `maestro-cli plugin`

Author, validate, sign, and package Maestro plugins

## `maestro-cli plugin list`

Read installed plugin versions, load status, and enable state from the desktop

| Option   | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | -       |

```bash
maestro-cli plugin list --json
```

## `maestro-cli plugin update <dir>`

Update an installed plugin from a local package directory, preserving data

| Option   | Description                                  | Default |
| -------- | -------------------------------------------- | ------- |
| `--json` | Output the resulting plugin registry as JSON | -       |

```bash
maestro-cli plugin update ./my-plugin
```

## `maestro-cli plugin init [dir]`

Scaffold a new plugin in &lt;dir> (defaults to the current directory)

| Option             | Description                                          | Default |
| ------------------ | ---------------------------------------------------- | ------- |
| `--tier <0\|1\|2>` | Plugin trust/capability tier (default 1)             | -       |
| `--id <id>`        | Plugin id (defaults to a slug of the directory name) | -       |
| `--name <name>`    | Human-readable plugin name (defaults to the id)      | -       |
| `--force`          | Scaffold into a non-empty directory                  | -       |
| `--json`           | Output as JSON (for scripting)                       | -       |

```bash
maestro-cli plugin init ./my-plugin --tier 1 --id my-plugin
```

## `maestro-cli plugin validate [dir]`

Validate &lt;dir>/plugin.json and, when present, its signature.json

| Option                 | Description                                                                            | Default |
| ---------------------- | -------------------------------------------------------------------------------------- | ------- |
| `--trusted-key <keys>` | Comma-separated base64 public keys to treat as trusted when resolving signature status | -       |
| `--json`               | Output as JSON (for scripting)                                                         | -       |

```bash
maestro-cli plugin validate ./my-plugin
```

## `maestro-cli plugin sign <dir>`

Sign &lt;dir> with ed25519 and write signature.json

| Option             | Description                                                 | Default |
| ------------------ | ----------------------------------------------------------- | ------- |
| `--key <path>`     | Private key to sign with (PEM, or base64-encoded PKCS8 DER) | -       |
| `--gen-key`        | Generate a fresh ed25519 keypair (requires --key-out)       | -       |
| `--key-out <path>` | Where to write the generated private key (with --gen-key)   | -       |
| `--json`           | Output as JSON (for scripting)                              | -       |

```bash
maestro-cli plugin sign ./my-plugin --key ./signing.pem
```

## `maestro-cli plugin pack <dir>`

Package &lt;dir> into a distributable archive (excludes node_modules/.git/keys)

| Option         | Description                                            | Default |
| -------------- | ------------------------------------------------------ | ------- |
| `--out <file>` | Output archive path (default &lt;id>-&lt;version>.tgz) | -       |
| `--json`       | Output as JSON (for scripting)                         | -       |

```bash
maestro-cli plugin pack ./my-plugin --out my-plugin-1.0.0.tgz
```

## `maestro-cli mcp`

Model Context Protocol bridge for Maestro plugin tools

## `maestro-cli mcp serve`

Run an MCP stdio server exposing registered plugin tools (spawned by an agent via its MCP config)

| Option       | Description                                   | Default |
| ------------ | --------------------------------------------- | ------- |
| `--tab <id>` | Originating desktop tab id (diagnostics only) | -       |

```bash
maestro-cli mcp serve
```

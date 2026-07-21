# maestro-cli Command Reference

> Generated from the CLI command tree by `maestro-cli reference`. Do not edit by hand - run `npm run gen:cli-reference` to refresh.

## `maestro-cli agent-run`

Record and inspect agent runs

## `maestro-cli agent-run record`

Record or update an agent run from a JSON file

| Option          | Description                    | Default |
| --------------- | ------------------------------ | ------- |
| `--file <json>` | Agent run JSON file            | -       |
| `--json`        | Output as JSON (for scripting) | -       |

## `maestro-cli agent-run append-event <run-id>`

Append an event to an agent run

| Option              | Description                           | Default |
| ------------------- | ------------------------------------- | ------- |
| `--type <type>`     | Event type                            | -       |
| `--status <status>` | Update the run status with this event | -       |
| `--message <text>`  | Human-readable event message          | -       |
| `--json`            | Output as JSON (for scripting)        | -       |

## `maestro-cli agent-run list`

List recent agent runs

| Option              | Description                    | Default |
| ------------------- | ------------------------------ | ------- |
| `--status <status>` | Filter by run status           | -       |
| `--campaign <id>`   | Filter by campaign id          | -       |
| `--limit <n>`       | Maximum number of runs to show | -       |
| `--json`            | Output as JSON (for scripting) | -       |

## `maestro-cli agent-run show <run-id>`

Show an agent run and its events

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli campaign`

Record and inspect agent campaigns

## `maestro-cli campaign record`

Record or update a campaign from a JSON file

| Option          | Description                    | Default |
| --------------- | ------------------------------ | ------- |
| `--file <json>` | Campaign JSON file             | -       |
| `--json`        | Output as JSON (for scripting) | -       |

## `maestro-cli campaign list`

List campaigns

| Option              | Description                         | Default |
| ------------------- | ----------------------------------- | ------- |
| `--status <status>` | Filter by campaign status           | -       |
| `--limit <n>`       | Maximum number of campaigns to show | -       |
| `--json`            | Output as JSON (for scripting)      | -       |

## `maestro-cli campaign show <id>`

Show a campaign

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli list`

List resources

## `maestro-cli list groups`

List all session groups

| Option   | Description                          | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Output as JSON lines (for scripting) | -       |

## `maestro-cli list agents`

List all agents

| Option             | Description                          | Default |
| ------------------ | ------------------------------------ | ------- |
| `-g, --group <id>` | Filter by group ID                   | -       |
| `--json`           | Output as JSON lines (for scripting) | -       |

## `maestro-cli list playbooks`

List playbooks (optionally filter by agent)

| Option             | Description                           | Default |
| ------------------ | ------------------------------------- | ------- |
| `-a, --agent <id>` | Agent ID (shows all if not specified) | -       |
| `--json`           | Output as JSON lines (for scripting)  | -       |

## `maestro-cli list sessions <agent-id>`

List agent sessions (most recent first)

| Option                   | Description                                            | Default |
| ------------------------ | ------------------------------------------------------ | ------- |
| `-l, --limit <count>`    | Maximum number of sessions to show (default: 25)       | -       |
| `-k, --skip <count>`     | Number of sessions to skip for pagination (default: 0) | -       |
| `-s, --search <keyword>` | Filter sessions by keyword in name or first message    | -       |
| `--json`                 | Output as JSON (for scripting)                         | -       |

## `maestro-cli list ssh-remotes`

List all configured SSH remotes

| Option   | Description                          | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Output as JSON lines (for scripting) | -       |

## `maestro-cli show`

Show details of a resource

## `maestro-cli show agent <id>`

Show agent details including history and usage stats

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli show playbook <id>`

Show detailed information about a playbook

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli playbook <playbook-id>`

Run a playbook

| Option          | Description                                                 | Default |
| --------------- | ----------------------------------------------------------- | ------- |
| `--dry-run`     | Show what would be executed without running                 | -       |
| `--no-history`  | Do not write history entries                                | -       |
| `--json`        | Output as JSON lines (for scripting)                        | -       |
| `--debug`       | Show detailed debug output for troubleshooting              | -       |
| `--verbose`     | Show full prompt sent to agent on each iteration            | -       |
| `--no-synopsis` | Skip synopsis generation after each task (reduces overhead) | -       |
| `--wait`        | Wait for agent to become available if busy                  | -       |

## `maestro-cli goal-run <agent-id> <goal>`

Launch a Goal-Driven Auto Run: pursue a free-text goal until done

| Option                   | Description                                           | Default |
| ------------------------ | ----------------------------------------------------- | ------- |
| `--exit-criteria <text>` | What "done" looks like and when to declare a deadlock | -       |
| `--max-iterations <n>`   | Cap iterations (default: infinite)                    | -       |
| `--no-history`           | Do not write history entries                          | -       |
| `--json`                 | Output as JSON lines (for scripting)                  | -       |
| `--verbose`              | Show full prompt sent to agent on each iteration      | -       |

## `maestro-cli run-doc <docs>`

Run one or more Auto Run documents headlessly (no saved playbook required)

| Option                  | Description                                                               | Default |
| ----------------------- | ------------------------------------------------------------------------- | ------- |
| `-a, --agent <id>`      | Target agent by ID or name (use "maestro-cli list agents" to find agents) | -       |
| `-p, --prompt <text>`   | Custom prompt for the run (defaults to the Auto Run prompt)               | -       |
| `--loop`                | Enable looping                                                            | -       |
| `--max-loops <n>`       | Maximum loop count (implies --loop)                                       | -       |
| `--reset-on-completion` | Enable reset-on-completion for all documents                              | -       |
| `--dry-run`             | Show what would be executed without running                               | -       |
| `--no-history`          | Do not write history entries                                              | -       |
| `--json`                | Output as JSON lines (for scripting)                                      | -       |
| `--debug`               | Show detailed debug output for troubleshooting                            | -       |
| `--verbose`             | Show full prompt sent to agent on each iteration                          | -       |
| `--no-synopsis`         | Skip synopsis generation after each task (reduces overhead)               | -       |
| `--wait`                | Wait for agent to become available if busy                                | -       |

## `maestro-cli clean`

Clean up orphaned resources

## `maestro-cli clean playbooks`

Remove playbooks for deleted sessions

| Option      | Description                                          | Default |
| ----------- | ---------------------------------------------------- | ------- |
| `--dry-run` | Show what would be removed without actually removing | -       |
| `--json`    | Output as JSON (for scripting)                       | -       |

## `maestro-cli send <agent-id> <message>`

Send a message to an agent and get a JSON response

| Option               | Description                                                                                                                                             | Default |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-s, --session <id>` | Resume an existing agent session (for multi-turn conversations)                                                                                         | -       |
| `-r, --read-only`    | Run in read-only/plan mode (agent cannot modify files)                                                                                                  | -       |
| `-t, --tab`          | Open/focus the session tab in Maestro desktop                                                                                                           | -       |
| `--no-system-prompt` | Skip the Maestro system prompt (agent identity, git branch, history path, conductor profile). Default is to include it for parity with the desktop app. | -       |

## `maestro-cli dispatch <agent-id> <message>`

Dispatch a prompt to an agent in the Maestro desktop app and return its tab/session ID

| Option           | Description                                                                                                                                                                                                           | Default |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--new-tab`      | Create a fresh AI tab and dispatch the prompt into it                                                                                                                                                                 | -       |
| `-t, --tab <id>` | Target an existing tab by its tab id (mutually exclusive with --new-tab)                                                                                                                                              | -       |
| `-f, --force`    | Bypass the busy-state guard when writing to a busy tab; requires allowConcurrentSend (cannot be combined with --new-tab - a fresh tab is never busy)                                                                  | -       |
| `--focus`        | Switch to and focus the target agent/tab when dispatching (by default dispatch runs in the background without stealing focus)                                                                                         | -       |
| `--queue`        | If the target tab is busy, queue the prompt into the execution queue (FIFO) instead of rejecting it; an idle target dispatches immediately. Cannot be combined with --new-tab or --force. Returns the queue position. | -       |
| `--wait`         | Alias for --queue                                                                                                                                                                                                     | -       |

## `maestro-cli queue`

Inspect and manage the desktop execution queue (from dispatch --queue)

## `maestro-cli queue list`

List queued execution items as JSON (all agents, or one with --agent)

| Option             | Description                                                             | Default |
| ------------------ | ----------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Only list items for this agent (default: every agent with queued items) | -       |

## `maestro-cli queue remove <item-id>`

Remove a queued item by its id (from dispatch --queue output or queue list)

| Option             | Description                                      | Default |
| ------------------ | ------------------------------------------------ | ------- |
| `-a, --agent <id>` | Agent whose queue the item belongs to (required) | -       |

## `maestro-cli session`

Inspect open desktop tabs and their conversation history

## `maestro-cli session list`

List open desktop AI tabs and their tab/session IDs

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli session show <tab-id>`

Print conversation history for a desktop tab

| Option                | Description                                                          | Default |
| --------------------- | -------------------------------------------------------------------- | ------- |
| `--since <timestamp>` | Only return messages after this timestamp (ISO-8601 or epoch ms/sec) | -       |
| `--tail <n>`          | Only return the last N messages (applied after --since)              | -       |
| `--json`              | Output as JSON (for scripting); default is a formatted transcript    | -       |

## `maestro-cli open-file <file-path>`

Open a file as a preview tab in the Maestro desktop app

| Option             | Description                                                        | Default |
| ------------------ | ------------------------------------------------------------------ | ------- |
| `-a, --agent <id>` | Target agent (defaults to auto-detect by file path's owning agent) | -       |
| `--no-switch`      | Don't switch the Maestro UI to the target agent/tab                | -       |
| `--json`           | Output as JSON (for scripting)                                     | -       |

## `maestro-cli open-browser <url>`

Open a URL as a browser tab in the Maestro desktop app

| Option             | Description                             | Default |
| ------------------ | --------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active) | -       |
| `--json`           | Output as JSON (for scripting)          | -       |

## `maestro-cli open-terminal`

Open a new terminal tab in the Maestro desktop app

| Option             | Description                                                         | Default |
| ------------------ | ------------------------------------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active)                             | -       |
| `--cwd <path>`     | Working directory for the terminal (must be within the agent's cwd) | -       |
| `--shell <shell>`  | Shell binary to use (default: zsh)                                  | -       |
| `--name <name>`    | Display name for the tab                                            | -       |
| `--json`           | Output as JSON (for scripting)                                      | -       |

## `maestro-cli refresh-files`

Refresh the file tree in the Maestro desktop app

| Option             | Description                             | Default |
| ------------------ | --------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active) | -       |
| `--json`           | Output as JSON (for scripting)          | -       |

## `maestro-cli refresh-auto-run`

Refresh Auto Run documents in the Maestro desktop app

| Option             | Description                             | Default |
| ------------------ | --------------------------------------- | ------- |
| `-a, --agent <id>` | Target agent by ID (defaults to active) | -       |
| `--json`           | Output as JSON (for scripting)          | -       |

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

## `maestro-cli stop-auto-run`

Stop the active Auto Run for an agent

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

## `maestro-cli resume-auto-run`

Resume an Auto Run that paused on an error

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

## `maestro-cli skip-auto-run`

Skip the current document of an error-paused Auto Run and continue

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

## `maestro-cli abort-auto-run`

Abort an error-paused Auto Run

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

## `maestro-cli reset-auto-run-tasks <filename>`

Reset all completed [x] tasks back to [ ] in an Auto Run document

| Option             | Description                    | Default |
| ------------------ | ------------------------------ | ------- |
| `-a, --agent <id>` | Target agent ID                | -       |
| `--json`           | Output as JSON (for scripting) | -       |

## `maestro-cli remove-playbook <agent-id> <playbook-id>`

Remove a saved playbook from an agent (find IDs via "list playbooks -a <agent>")

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli cue`

Interact with Maestro Cue automation

## `maestro-cli cue trigger <subscription-name>`

Manually trigger a Cue subscription by name

| Option                   | Description                                       | Default |
| ------------------------ | ------------------------------------------------- | ------- |
| `-p, --prompt <text>`    | Override the subscription prompt with custom text | -       |
| `--json`                 | Output as JSON (for scripting)                    | -       |
| `--source-agent-id <id>` | Agent ID to pass as source context for write-back | -       |

## `maestro-cli cue list`

List all Cue subscriptions across agents

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli cue schedule`

Schedule a one-shot Cue task (or --list / --cancel pending tasks)

| Option                     | Description                                                                                           | Default |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `--in <duration>`          | Fire after a relative delay (e.g. 30s, 20m, 2h, 1d)                                                   | -       |
| `--at <timestamp>`         | Fire at ISO-8601 timestamp or "YYYY-MM-DD HH:MM" (local time)                                         | -       |
| `--list`                   | List all pending one-shot tasks across agents                                                         | -       |
| `--cancel <name>`          | Cancel a pending one-shot task by name                                                                | -       |
| `-a, --agent <id-or-name>` | Target agent (required when creating)                                                                 | -       |
| `-p, --prompt <text>`      | Prompt to send when the task fires                                                                    | -       |
| `--notify`                 | Show a toast notification when the task fires                                                         | -       |
| `--sticky`                 | Make the notify toast sticky (requires --notify)                                                      | -       |
| `-m, --message <text>`     | Body for the notify toast (defaults to label/prompt)                                                  | -       |
| `-n, --name <name>`        | Custom subscription name (auto-generated when omitted)                                                | -       |
| `-l, --label <text>`       | Human-readable label (defaults to truncated prompt)                                                   | -       |
| `--pipeline <name>`        | Pipeline name (default: Tasks)                                                                        | -       |
| `--grace-minutes <n>`      | Override the default 360-minute grace window                                                          | -       |
| `--keep-on-failure`        | Keep the subscription on a failed/timed-out run (default: self-destructs on both success and failure) | -       |
| `--json`                   | Output as JSON (for scripting)                                                                        | -       |

## `maestro-cli cue pipeline`

Manage Cue pipeline layout entries (cue-pipeline-layout.json)

## `maestro-cli cue pipeline list`

List all pipelines in the layout file

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli cue pipeline get <name>`

Print one pipeline entry as JSON to stdout

| Option   | Description                                    | Default |
| -------- | ---------------------------------------------- | ------- |
| `--json` | Output as JSON (default; flag kept for parity) | -       |

## `maestro-cli cue pipeline export <name>`

Alias for `get`: print one pipeline entry as JSON to stdout

| Option   | Description                                    | Default |
| -------- | ---------------------------------------------- | ------- |
| `--json` | Output as JSON (default; flag kept for parity) | -       |

## `maestro-cli cue pipeline add <name>`

Add a new pipeline entry from a JSON file

| Option          | Description                                              | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `--from <file>` | JSON file with one pipeline entry (matches `get` output) | -       |
| `--force`       | Replace any existing pipeline with the same name/id      | -       |
| `--json`        | Output as JSON (for scripting)                           | -       |

## `maestro-cli cue pipeline replace <name>`

Replace an existing pipeline entry from a JSON file

| Option          | Description                                              | Default |
| --------------- | -------------------------------------------------------- | ------- |
| `--from <file>` | JSON file with one pipeline entry (matches `get` output) | -       |
| `--json`        | Output as JSON (for scripting)                           | -       |

## `maestro-cli cue pipeline remove <name>`

Remove a pipeline entry by name or id

| Option    | Description                                                  | Default |
| --------- | ------------------------------------------------------------ | ------- |
| `--force` | Suppress the no-op error when the pipeline is already absent | -       |
| `--json`  | Output as JSON (for scripting)                               | -       |

## `maestro-cli board`

Manage and dispatch the Maestro Board

## `maestro-cli board list`

List all boards in an agent's project

| Option                     | Description                           | Default |
| -------------------------- | ------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board(s) | -       |
| `--json`                   | Output as JSON (for scripting)        | -       |

## `maestro-cli board create <name>`

Create a new, empty board in an agent's project

| Option                     | Description                                               | Default |
| -------------------------- | --------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project will own the board                    | -       |
| `--max-in-progress <n>`    | Cap how many cards may run at once                        | -       |
| `--auto-decompose`         | Let the dispatcher fan triage cards out with one LLM pass | -       |
| `--json`                   | Output as JSON (for scripting)                            | -       |

## `maestro-cli board rename <boardId> <newName>`

Rename a board (cards and their ids are untouched)

| Option                     | Description                        | Default |
| -------------------------- | ---------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board | -       |
| `--json`                   | Output as JSON (for scripting)     | -       |

## `maestro-cli board delete <boardId>`

Delete a board and every card on it

| Option                     | Description                                                  | Default |
| -------------------------- | ------------------------------------------------------------ | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board                           | -       |
| `--force`                  | Delete even when the board still has cards that are not done | -       |
| `--json`                   | Output as JSON (for scripting)                               | -       |

## `maestro-cli board show <boardId>`

Show a board and its cards

| Option                     | Description                        | Default |
| -------------------------- | ---------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board | -       |
| `--json`                   | Output as JSON (for scripting)     | -       |

## `maestro-cli board add-card <boardId>`

Add a card to a board

| Option                       | Description                                                                 | Default |
| ---------------------------- | --------------------------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>`   | Agent whose project owns the board                                          | -       |
| `-t, --title <title>`        | Card title                                                                  | -       |
| `--assignee <profileId>`     | Agent Profile (role) id that runs this card; floats to the free worker pool | -       |
| `--assignee-agent <agentId>` | Pin the card to a specific agent (runs with its own settings)               | -       |
| `-b, --body <body>`          | Card body / instructions for the assignee                                   | -       |
| `--parents <ids>`            | Comma-separated parent card ids this card depends on                        | -       |
| `--priority <level>`         | Dispatch priority: high\|normal\|low (default normal)                       | -       |
| `--worktree`                 | Record an isolated-worktree intent for this card                            | -       |
| `--json`                     | Output as JSON (for scripting)                                              | -       |

## `maestro-cli board update-card <cardId>`

Edit a card in place (only the flags you pass are changed)

| Option                       | Description                                               | Default |
| ---------------------------- | --------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>`   | Agent whose project owns the card                         | -       |
| `--board <boardId>`          | Scope the card lookup to a specific board                 | -       |
| `-t, --title <title>`        | New card title                                            | -       |
| `-b, --body <body>`          | New card body / instructions                              | -       |
| `--assignee <profileId>`     | New Agent Profile (role) id; pass "" to clear             | -       |
| `--assignee-agent <agentId>` | Pin the card to a specific agent; pass "" to clear        | -       |
| `--parents <ids>`            | Comma-separated parent card ids; pass "" to clear         | -       |
| `--priority <level>`         | Dispatch priority: high\|normal\|low ("normal" clears it) | -       |
| `--worktree`                 | Record an isolated-worktree intent for this card          | -       |
| `--no-worktree`              | Clear the card's worktree intent                          | -       |
| `--json`                     | Output as JSON (for scripting)                            | -       |

## `maestro-cli board remove-card <cardId>`

Delete a card (its children inherit the card's parents)

| Option                     | Description                                                    | Default |
| -------------------------- | -------------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the card                              | -       |
| `--board <boardId>`        | Scope the card lookup to a specific board                      | -       |
| `--force`                  | Remove even a running card (the in-flight run is NOT canceled) | -       |
| `--json`                   | Output as JSON (for scripting)                                 | -       |

## `maestro-cli board set-status <cardId> <status>`

Set a card's status (triage|todo|ready|running|blocked|done)

| Option                     | Description                               | Default |
| -------------------------- | ----------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the card         | -       |
| `--board <boardId>`        | Scope the card lookup to a specific board | -       |
| `--json`                   | Output as JSON (for scripting)            | -       |

## `maestro-cli board tick`

Run one dispatcher pass headlessly (promote, claim, spawn, apply)

| Option                     | Description                           | Default |
| -------------------------- | ------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board(s) | -       |
| `--board <boardId>`        | Tick only a specific board            | -       |
| `--json`                   | Output as JSON (for scripting)        | -       |

## `maestro-cli board watch`

Run `board tick` on a loop until Ctrl-C. The desktop Cue engine ticks the same boards; overlapping is safe (board.yaml writes are atomic and serialized) but still discouraged. No daemonization, no lock files.

| Option                     | Description                                     | Default |
| -------------------------- | ----------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the board(s)           | -       |
| `--board <boardId>`        | Watch only a specific board                     | -       |
| `--interval <seconds>`     | Seconds between ticks (default 30, minimum 5)   | -       |
| `--json`                   | Output one JSON object per tick (for scripting) | -       |

## `maestro-cli profile`

Manage Agent Profiles

## `maestro-cli profile list`

List all profiles in an agent's project

| Option                     | Description                           | Default |
| -------------------------- | ------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the profiles | -       |
| `--json`                   | Output as JSON (for scripting)        | -       |

## `maestro-cli profile create`

Create a profile layered on a base agent

| Option              | Description                                                       | Default |
| ------------------- | ----------------------------------------------------------------- | ------- |
| `--base <agentId>`  | Base Left Bar agent (also locates the project)                    | -       |
| `-n, --name <name>` | Profile name                                                      | -       |
| `--pool`            | Create a base-agent-less role that floats to the free worker pool | -       |
| `--model <model>`   | Model override (falls back to the running agent)                  | -       |
| `--effort <level>`  | Reasoning effort override                                         | -       |
| `--role <text>`     | Role system-prompt appended for this profile                      | -       |
| `--json`            | Output as JSON (for scripting)                                    | -       |

## `maestro-cli profile show <profileId>`

Show a profile and the spawn overrides it resolves to

| Option                     | Description                          | Default |
| -------------------------- | ------------------------------------ | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the profile | -       |
| `--json`                   | Output as JSON (for scripting)       | -       |

## `maestro-cli profile update <profileId>`

Edit a profile in place, keeping its id (and every card that references it)

| Option                     | Description                                                    | Default |
| -------------------------- | -------------------------------------------------------------- | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the profile                           | -       |
| `-n, --name <name>`        | New profile name                                               | -       |
| `--model <model>`          | Model override; pass "" to fall back to the running agent      | -       |
| `--effort <level>`         | Reasoning effort override; pass "" to clear                    | -       |
| `--role-prompt <text>`     | Role system-prompt appended for this profile; pass "" to clear | -       |
| `--role <text>`            | Alias for --role-prompt (matches `profile create`)             | -       |
| `--args <args>`            | Extra CLI args for spawns wearing this role; pass "" to clear  | -       |
| `--base <agentId>`         | Pin the role to a different base agent                         | -       |
| `--pool`                   | Drop the base agent so the role floats to the free worker pool | -       |
| `--json`                   | Output as JSON (for scripting)                                 | -       |

## `maestro-cli profile delete <profileId>`

Delete a profile by id

| Option                     | Description                          | Default |
| -------------------------- | ------------------------------------ | ------- |
| `-a, --agent <id-or-name>` | Agent whose project owns the profile | -       |
| `--json`                   | Output as JSON (for scripting)       | -       |

## `maestro-cli director-notes`

Director's Notes: unified history and AI synopsis

## `maestro-cli director-notes history`

Show unified history across all agents

| Option                | Description                                          | Default |
| --------------------- | ---------------------------------------------------- | ------- |
| `-d, --days <n>`      | Lookback period in days (default: from app settings) | -       |
| `-f, --format <type>` | Output format: json, markdown, text (default: text)  | -       |
| `--filter <type>`     | Filter by entry type: auto, user, cue                | -       |
| `-l, --limit <n>`     | Maximum entries to show (default: 100)               | -       |
| `--json`              | Output as JSON (shorthand for --format json)         | -       |

## `maestro-cli director-notes synopsis`

Generate AI synopsis of recent activity (requires running Maestro app)

| Option                | Description                                          | Default |
| --------------------- | ---------------------------------------------------- | ------- |
| `-d, --days <n>`      | Lookback period in days (default: from app settings) | -       |
| `-f, --format <type>` | Output format: json, markdown, text (default: text)  | -       |
| `--json`              | Output as JSON (shorthand for --format json)         | -       |

## `maestro-cli status`

Check if the Maestro desktop app is running and reachable

## `maestro-cli version`

Show the running Maestro app's version and build commit hash

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli doctor`

Diagnose CLI connectivity, version skew, and configuration

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli completions <shell>`

Print a shell completion script (bash, zsh, or fish)

## `maestro-cli reference`

Print the full command reference (Markdown, or --format json)

| Option              | Description                         | Default |
| ------------------- | ----------------------------------- | ------- |
| `--format <format>` | Output format: md (default) or json | -       |

## `maestro-cli create-agent <name>`

Create a new agent in the Maestro desktop app

| Option                            | Description                                                                                      | Default         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | --------------- |
| `-d, --cwd <path>`                | Working directory for the agent                                                                  | -               |
| `-t, --type <type>`               | Agent type (claude-code, codex, opencode, factory-droid, copilot-cli, gemini-cli, qwen3-coder)   | `"claude-code"` |
| `-g, --group <id>`                | Group ID to assign the agent to                                                                  | -               |
| `--nudge <message>`               | Nudge message appended to every user message                                                     | -               |
| `--new-session-message <message>` | Message prefixed to first message in new sessions                                                | -               |
| `--custom-path <path>`            | Custom binary path for the agent                                                                 | -               |
| `--custom-args <args>`            | Custom CLI arguments for the agent                                                               | -               |
| `--env <KEY=VALUE>`               | Environment variable (repeatable)                                                                | `[]`            |
| `--model <model>`                 | Model override (e.g., sonnet, opus)                                                              | -               |
| `--effort <level>`                | Effort/reasoning level override                                                                  | -               |
| `--context-window <size>`         | Context window size in tokens                                                                    | -               |
| `--provider-path <path>`          | Custom provider path                                                                             | -               |
| `--ssh-remote <id>`               | SSH remote ID for remote execution                                                               | -               |
| `--ssh-cwd <path>`                | Working directory override on SSH remote                                                         | -               |
| `--sync-history-to-remote <bool>` | Sync history entries to .maestro/history/ on the remote host (true/false; requires --ssh-remote) | -               |
| `--auto-run-folder <path>`        | Path to the agent Auto Run / playbooks folder (overrides the default <cwd>/.maestro/playbooks)   | -               |
| `--json`                          | Output as JSON (for scripting)                                                                   | -               |

## `maestro-cli create-group <name>`

Create a new group in the Maestro desktop app

| Option                | Description                    | Default |
| --------------------- | ------------------------------ | ------- |
| `-e, --emoji <emoji>` | Emoji icon for the group       | -       |
| `--parent <group-id>` | Create inside this root group  | -       |
| `--json`              | Output as JSON (for scripting) | -       |

## `maestro-cli remove-group <group-id>`

Remove a group from the Maestro desktop app (agents inside are ungrouped, not deleted)

| Option        | Description                                               | Default |
| ------------- | --------------------------------------------------------- | ------- |
| `-f, --force` | Delete even if the group still has agents (ungroups them) | -       |
| `--json`      | Output as JSON (for scripting)                            | -       |

## `maestro-cli rename-group <group-id> <new-name>`

Rename a group in the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli create-worktree`

Create a new agent in a git worktree branched off an existing parent agent

| Option                 | Description                                                                                                        | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| `-a, --agent <id>`     | Parent agent ID the worktree branches from (use "maestro-cli list agents" to find IDs)                             | -       |
| `-b, --branch <name>`  | Branch name for the worktree (created if it does not exist)                                                        | -       |
| `--base-branch <name>` | Ref the new branch is based on when it does not yet exist (e.g. "rc" or "main"). Defaults to the parent repo HEAD. | -       |
| `-m, --message <text>` | Optional initial prompt to dispatch to the new agent after creation                                                | -       |
| `--json`               | Output as JSON (for scripting)                                                                                     | -       |

## `maestro-cli remove-agent <agent-id>`

Remove an agent from the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli update-agent <agent-id>`

Update an existing agent's group, working directory, and per-agent settings

| Option                            | Description                                                                                    | Default |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| `-g, --group <id>`                | Move the agent to this group (use "none" to ungroup; supports partial IDs)                     | -       |
| `-d, --cwd <path>`                | Change the agent's working directory (resolved to absolute; agent must be stopped)             | -       |
| `--ssh-remote <id>`               | Set the SSH remote for remote execution (use "none" to revert to local; agent must be stopped) | -       |
| `--ssh-cwd <path>`                | Working directory override on the SSH remote                                                   | -       |
| `--sync-history-to-remote <bool>` | Sync history entries to .maestro/history/ on the remote host (true/false)                      | -       |
| `--nudge <message>`               | Nudge message appended to every message (empty string clears)                                  | -       |
| `--new-session-message <message>` | Message prefixed to the first message of new sessions (empty string clears)                    | -       |
| `--custom-path <path>`            | Override the agent binary path (empty string clears)                                           | -       |
| `--custom-args <args>`            | Custom CLI arguments for the agent (empty string clears)                                       | -       |
| `--env <KEY=VALUE>`               | Set an environment variable (repeatable; replaces the env map)                                 | `[]`    |
| `--clear-env`                     | Clear all per-agent environment variables                                                      | -       |
| `--model <model>`                 | Model override (e.g. sonnet, opus; empty string clears)                                        | -       |
| `--effort <level>`                | Effort/reasoning level override (empty string clears)                                          | -       |
| `--context-window <size>`         | Context window size in tokens (0 or "none" clears)                                             | -       |
| `--token-source <mode>`           | Claude token source: api \| tui \| dynamic (Claude Code agents only)                           | -       |
| `--maestro-p-path <path>`         | Override the maestro-p binary path (empty string clears)                                       | -       |
| `--provider <type>`               | Switch the agent provider (resets tabs + clears provider config; requires --force)             | -       |
| `--force`                         | Confirm a destructive change (required for --provider)                                         | -       |
| `--json`                          | Output as JSON (for scripting)                                                                 | -       |

## `maestro-cli rename-agent <agent-id> <new-name>`

Rename an agent in the Maestro desktop app

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli focus-agent <agent-id>`

Focus (select) an agent in the Maestro desktop UI

| Option           | Description                          | Default |
| ---------------- | ------------------------------------ | ------- |
| `--tab <tab-id>` | Also focus this tab within the agent | -       |
| `--json`         | Output as JSON (for scripting)       | -       |

## `maestro-cli switch-mode <agent-id> <mode>`

Switch an agent between "ai" and "terminal" mode

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli tab`

Manage an agent's tabs in the desktop app

## `maestro-cli tab new`

Open a new tab for an agent (optionally seeded with a prompt)

| Option                | Description                          | Default |
| --------------------- | ------------------------------------ | ------- |
| `-a, --agent <id>`    | Target agent ID                      | -       |
| `-p, --prompt <text>` | Seed the new AI tab with this prompt | -       |
| `--json`              | Output as JSON (for scripting)       | -       |

## `maestro-cli tab close <tab-id>`

Close a tab (owning agent is resolved automatically)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli tab rename <tab-id> <new-name>`

Rename a tab

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli tab star <tab-id>`

Star a tab

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli tab unstar <tab-id>`

Unstar a tab

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli create-ssh-remote <name>`

Create a new SSH remote configuration

| Option                  | Description                                                           | Default |
| ----------------------- | --------------------------------------------------------------------- | ------- |
| `-H, --host <host>`     | SSH hostname or IP (or SSH config Host pattern with --ssh-config)     | -       |
| `-p, --port <port>`     | SSH port (default: 22)                                                | -       |
| `-u, --username <user>` | SSH username                                                          | -       |
| `-k, --key <path>`      | Path to private key file                                              | -       |
| `--env <KEY=VALUE>`     | Remote environment variable (repeatable)                              | `[]`    |
| `--ssh-config`          | Use ~/.ssh/config for connection settings (host becomes Host pattern) | -       |
| `--disabled`            | Create in disabled state                                              | -       |
| `--set-default`         | Set as the global default SSH remote                                  | -       |
| `--json`                | Output as JSON (for scripting)                                        | -       |

## `maestro-cli remove-ssh-remote <remote-id>`

Remove an SSH remote configuration

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

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

## `maestro-cli settings get <key>`

Get the value of a setting (supports dot-notation, e.g., encoreFeatures.directorNotes)

| Option          | Description                                                | Default |
| --------------- | ---------------------------------------------------------- | ------- |
| `--json`        | Output as JSON (for scripting)                             | -       |
| `-v, --verbose` | Show full details including description, type, and default | -       |

## `maestro-cli settings set <key> <value>`

Set a setting value (auto-detects type: bool, number, JSON, string)

| Option         | Description                                               | Default |
| -------------- | --------------------------------------------------------- | ------- |
| `--json`       | Output as JSON (for scripting)                            | -       |
| `--raw <json>` | Pass an explicit JSON value (bypasses auto type coercion) | -       |

## `maestro-cli settings reset <key>`

Reset a setting to its default value

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli settings agent`

View and manage per-agent configuration

## `maestro-cli settings agent list [agent-id]`

List agent configurations (all agents or a specific one)

| Option          | Description                           | Default |
| --------------- | ------------------------------------- | ------- |
| `--json`        | Output as JSON lines (for scripting)  | -       |
| `-v, --verbose` | Show descriptions for each config key | -       |

## `maestro-cli settings agent get <agent-id> <key>`

Get a single agent config value

| Option          | Description                             | Default |
| --------------- | --------------------------------------- | ------- |
| `--json`        | Output as JSON (for scripting)          | -       |
| `-v, --verbose` | Show full details including description | -       |

## `maestro-cli settings agent set <agent-id> <key> <value>`

Set an agent config value (auto-detects type)

| Option         | Description                                               | Default |
| -------------- | --------------------------------------------------------- | ------- |
| `--json`       | Output as JSON (for scripting)                            | -       |
| `--raw <json>` | Pass an explicit JSON value (bypasses auto type coercion) | -       |

## `maestro-cli settings agent reset <agent-id> <key>`

Remove an agent config key

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli set-theme [name-or-id]`

Switch the active Maestro theme (applies live). Use --list to see options.

| Option       | Description                    | Default |
| ------------ | ------------------------------ | ------- |
| `-l, --list` | List available themes          | -       |
| `--json`     | Output as JSON (for scripting) | -       |

## `maestro-cli theme`

Manage the custom theme palette

## `maestro-cli theme show`

Print the current custom theme palette and base (reads from disk)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli theme export`

Export the custom theme as portable JSON (stdout, or --file <path>)

| Option              | Description                                         | Default |
| ------------------- | --------------------------------------------------- | ------- |
| `-f, --file <path>` | Write the theme JSON to this file instead of stdout | -       |
| `--json`            | Output as JSON (for scripting)                      | -       |

## `maestro-cli theme import <file>`

Import a theme JSON file, apply it live, and activate it

| Option          | Description                                            | Default |
| --------------- | ------------------------------------------------------ | ------- |
| `--no-activate` | Save the palette without switching to the Custom theme | -       |
| `--json`        | Output as JSON (for scripting)                         | -       |

## `maestro-cli theme set [assignments]`

Set custom theme colors (key=value, e.g. accent=#ff0000) and/or re-base

| Option            | Description                                                | Default |
| ----------------- | ---------------------------------------------------------- | ------- |
| `-b, --base <id>` | Initialize from a built-in theme before applying overrides | -       |
| `-a, --activate`  | Switch to the Custom theme after applying                  | -       |
| `--json`          | Output as JSON (for scripting)                             | -       |

## `maestro-cli encore`

List and toggle experimental Encore features

## `maestro-cli encore list`

List Encore features and whether each is enabled

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli encore enable <feature>`

Enable an Encore feature (directorNotes, usageStats, symphony, maestroCue, pianola)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli encore disable <feature>`

Disable an Encore feature

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola`

Pianola manager agent: watch tabs, auto-answer or escalate per your rules

## `maestro-cli pianola watch <tab-id>`

Watch a desktop tab and act on awaiting-input prompts per your rules

| Option                 | Description                                                     | Default |
| ---------------------- | --------------------------------------------------------------- | ------- |
| `--agent <agent-id>`   | Agent id to dispatch answers to (defaults to the tab owner)     | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5)                         | -       |
| `--dry-run`            | Classify and record decisions but never send a message          | -       |
| `--once`               | Run a single iteration instead of looping                       | -       |
| `--json`               | Reserved for scripting; affects the disabled-feature error only | -       |

## `maestro-cli pianola rules`

List the configured Pianola rules

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

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

## `maestro-cli pianola profile`

Read a learned decision profile (per-project with --project, else global)

| Option             | Description                                                 | Default |
| ------------------ | ----------------------------------------------------------- | ------- |
| `--project <path>` | Project path to read the profile for (falls back to global) | -       |
| `--json`           | Output as JSON (for scripting)                              | -       |

## `maestro-cli pianola set-profile`

Save a learned decision profile from --file or stdin (per-project or global)

| Option             | Description                                                    | Default |
| ------------------ | -------------------------------------------------------------- | ------- |
| `--project <path>` | Project path this profile is for (omit for the global profile) | -       |
| `--file <path>`    | Read the profile markdown from this file (else reads stdin)    | -       |
| `--pair-count <n>` | How many decision pairs this profile was synthesized from      | -       |
| `--json`           | Output as JSON (for scripting)                                 | -       |

## `maestro-cli pianola log`

Show recent Pianola decisions from the audit log

| Option        | Description                                    | Default |
| ------------- | ---------------------------------------------- | ------- |
| `--limit <n>` | Maximum number of records to show (default 20) | -       |
| `--json`      | Output as JSON (for scripting)                 | -       |

## `maestro-cli pianola plan`

Author and inspect Pianola task plans (DAGs)

## `maestro-cli pianola plan set`

Save a plan from --file or piped stdin (validated before write)

| Option          | Description                                          | Default |
| --------------- | ---------------------------------------------------- | ------- |
| `--file <path>` | Read the plan JSON from this file (else reads stdin) | -       |
| `--json`        | Output as JSON (for scripting)                       | -       |

## `maestro-cli pianola plan list`

List saved plans with a progress summary

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola plan show <planId>`

Show one plan: its tasks, statuses, and dependencies

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola orchestrate <planId>`

Run a saved plan to completion, dispatching tasks as their dependencies finish

| Option                 | Description                               | Default |
| ---------------------- | ----------------------------------------- | ------- |
| `--interval <seconds>` | Polling interval in seconds (default 5)   | -       |
| `--concurrency <n>`    | Max tasks running at once (default 3)     | -       |
| `--once`               | Run a single iteration instead of looping | -       |
| `--json`               | Output as JSON (for scripting)            | -       |

## `maestro-cli pianola supervise`

Register desktop-supervised watchers and orchestrations (survive crashes/restarts)

## `maestro-cli pianola supervise watch <tabId>`

Register a supervised tab watcher the desktop keeps alive

| Option                 | Description                                | Default |
| ---------------------- | ------------------------------------------ | ------- |
| `--agent <agent-id>`   | Agent id to dispatch answers to (required) | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5)    | -       |
| `--json`               | Output as JSON (for scripting)             | -       |

## `maestro-cli pianola supervise orchestrate <planId>`

Register a supervised plan orchestration the desktop keeps alive

| Option                 | Description                             | Default |
| ---------------------- | --------------------------------------- | ------- |
| `--concurrency <n>`    | Max tasks running at once (default 3)   | -       |
| `--interval <seconds>` | Polling interval in seconds (default 5) | -       |
| `--json`               | Output as JSON (for scripting)          | -       |

## `maestro-cli pianola supervise list`

List registered supervised targets

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola supervise remove <id>`

Unregister a supervised target by id (the desktop stops its child)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola supervise enable <id>`

Enable a supervised target by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli pianola supervise disable <id>`

Disable a supervised target by id (the desktop stops its child)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli prompts`

Read Maestro system prompts

## `maestro-cli prompts list`

List all known prompt ids with descriptions

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli prompts get <id>`

Print a prompt by id (honors user customizations from Settings → Maestro Prompts)

| Option   | Description                                   | Default |
| -------- | --------------------------------------------- | ------- |
| `--json` | Output as JSON object with metadata + content | -       |

## `maestro-cli gist`

Publish session context to GitHub gists

## `maestro-cli gist create <agent-id>`

Publish an agent's session transcript as a GitHub gist (requires running Maestro app)

| Option                     | Description                             | Default |
| -------------------------- | --------------------------------------- | ------- |
| `-d, --description <text>` | Gist description                        | -       |
| `-p, --public`             | Create a public gist (default: private) | -       |

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
| `--open-file <path>`      | On click, switch to the agent and open this file in its File Preview pane (requires --agent; mutually exclusive with --open-url)                                                                                               | -       |
| `--open-url <url>`        | On click, open this URL in the system browser (mutually exclusive with --open-file)                                                                                                                                            | -       |
| `--json`                  | Output as JSON (for scripting)                                                                                                                                                                                                 | -       |

## `maestro-cli notify flash <message>`

Show a center-screen flash (momentary, exclusive - replaces any active flash)

| Option                    | Description                                                | Default |
| ------------------------- | ---------------------------------------------------------- | ------- |
| `-c, --color <color>`     | green \| yellow \| orange \| red \| theme (default: theme) | -       |
| `-D, --detail <text>`     | Optional second line shown beneath the message             | -       |
| `-t, --timeout <seconds>` | Auto-dismiss after N seconds (range: (0, 5]; default 1.5)  | -       |
| `--json`                  | Output as JSON (for scripting)                             | -       |

## `maestro-cli profiling`

Start/stop a Chromium performance capture in the desktop app (for perf iteration)

## `maestro-cli profiling start`

Begin a performance capture (no-ops if one is already recording)

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli profiling stop`

Stop the capture and write the compressed .zip bundle to --output

| Option                | Description                                                                               | Default |
| --------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `-o, --output <path>` | Destination .zip path (absolute or relative to cwd; ~ expanded). Parent dirs are created. | -       |
| `--json`              | Output as JSON (for scripting)                                                            | -       |

## `maestro-cli profiling status`

Report whether a capture is currently recording

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

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

## `maestro-cli cadenza close <id>`

Close a cadenza view by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli movement`

Compose the agent-driven movement (free-placed data views) in the Maestro main window

## `maestro-cli movement add <id>`

Add (or replace by id) a native data view or interactive HTML mockup

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

## `maestro-cli movement move <id>`

Reposition a movement item

| Option     | Description                    | Default |
| ---------- | ------------------------------ | ------- |
| `--x <px>` | New X position                 | -       |
| `--y <px>` | New Y position                 | -       |
| `--json`   | Output as JSON (for scripting) | -       |

## `maestro-cli movement remove <id>`

Remove a movement item by id

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli movement clear`

Remove all movement items

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli movement state`

Read the current movement layout (items + size) to compose around it

| Option   | Description                    | Default |
| -------- | ------------------------------ | ------- |
| `--json` | Output as JSON (for scripting) | -       |

## `maestro-cli movement inspect <id>`

Capture a live HTML Movement preview and report its runtime diagnostics

| Option           | Description                                       | Default |
| ---------------- | ------------------------------------------------- | ------- |
| `--output <png>` | Write the live mockup screenshot to this PNG path | -       |
| `--json`         | Output as JSON (for scripting)                    | -       |

## `maestro-cli movement interact <id>`

Interact with a live HTML Movement by CSS selector

| Option               | Description                                            | Default |
| -------------------- | ------------------------------------------------------ | ------- |
| `--click <selector>` | Click the matching element                             | -       |
| `--type <selector>`  | Enter text into the matching input or editable element | -       |
| `--value <text>`     | Text used with --type                                  | -       |
| `--json`             | Output as JSON (for scripting)                         | -       |

## `maestro-cli stats`

Show aggregated Usage Dashboard metrics for a time range

| Option                | Description                                                      | Default |
| --------------------- | ---------------------------------------------------------------- | ------- |
| `-r, --range <range>` | Time range: day, week, month, quarter, year, all (default: week) | -       |
| `--json`              | Output the full aggregation object as JSON                       | -       |

## `maestro-cli stats-query <sql>`

Run a read-only SQL query against the stats database (SELECT / read PRAGMA only)

| Option                | Description                                                       | Default |
| --------------------- | ----------------------------------------------------------------- | ------- |
| `-p, --param <value>` | Bind a value to a positional ? placeholder (repeatable, in order) | `[]`    |
| `--json`              | Output rows as JSON instead of a tab-separated table              | -       |

## `maestro-cli plugin`

Author, validate, sign, and package Maestro plugins

## `maestro-cli plugin init [dir]`

Scaffold a new plugin in <dir> (defaults to the current directory)

| Option          | Description                                          | Default |
| --------------- | ---------------------------------------------------- | ------- | ---------------------------------------- | --- |
| `--tier <0      | 1                                                    | 2>`     | Plugin trust/capability tier (default 1) | -   |
| `--id <id>`     | Plugin id (defaults to a slug of the directory name) | -       |
| `--name <name>` | Human-readable plugin name (defaults to the id)      | -       |
| `--force`       | Scaffold into a non-empty directory                  | -       |
| `--json`        | Output as JSON (for scripting)                       | -       |

## `maestro-cli plugin validate [dir]`

Validate <dir>/plugin.json and, when present, its signature.json

| Option                 | Description                                                                            | Default |
| ---------------------- | -------------------------------------------------------------------------------------- | ------- |
| `--trusted-key <keys>` | Comma-separated base64 public keys to treat as trusted when resolving signature status | -       |
| `--json`               | Output as JSON (for scripting)                                                         | -       |

## `maestro-cli plugin sign <dir>`

Sign <dir> with ed25519 and write signature.json

| Option             | Description                                                 | Default |
| ------------------ | ----------------------------------------------------------- | ------- |
| `--key <path>`     | Private key to sign with (PEM, or base64-encoded PKCS8 DER) | -       |
| `--gen-key`        | Generate a fresh ed25519 keypair (requires --key-out)       | -       |
| `--key-out <path>` | Where to write the generated private key (with --gen-key)   | -       |
| `--json`           | Output as JSON (for scripting)                              | -       |

## `maestro-cli plugin pack <dir>`

Package <dir> into a distributable archive (excludes node_modules/.git/keys)

| Option         | Description                                      | Default |
| -------------- | ------------------------------------------------ | ------- |
| `--out <file>` | Output archive path (default <id>-<version>.tgz) | -       |
| `--json`       | Output as JSON (for scripting)                   | -       |

## `maestro-cli mcp`

Model Context Protocol bridge for Maestro plugin tools

## `maestro-cli mcp serve`

Run an MCP stdio server exposing registered plugin tools (spawned by an agent via its MCP config)

| Option       | Description                                   | Default |
| ------------ | --------------------------------------------- | ------- |
| `--tab <id>` | Originating desktop tab id (diagnostics only) | -       |

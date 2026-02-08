---
title: Command Line Interface
description: Query agents, list sessions, run playbooks, and manage Maestro from the command line.
icon: square-terminal
---

Maestro includes a CLI tool (`maestro-cli`) for querying agents, browsing sessions, running playbooks, and managing resources from the command line, cron jobs, or CI/CD pipelines. The CLI requires Node.js (which you already have if you're using Claude Code).

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

### Querying Agents

Send a message to an agent and receive a structured JSON response. Supports creating new sessions or resuming existing ones for multi-turn conversations.

```bash
# Send a message to an agent (creates a new session)
maestro-cli query <agent-id> "describe the authentication flow"

# Resume an existing session for follow-up
maestro-cli query <agent-id> "now add rate limiting" -s <session-id>
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

Error codes: `AGENT_NOT_FOUND`, `AGENT_UNSUPPORTED`, `CLAUDE_NOT_FOUND`, `CODEX_NOT_FOUND`.

Supported agent types: `claude-code`, `codex`.

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

| Flag | Description | Default |
|------|-------------|---------|
| `-l, --limit <count>` | Maximum number of sessions to return | 25 |
| `-k, --skip <count>` | Number of sessions to skip (for pagination) | 0 |
| `-s, --search <keyword>` | Filter by keyword in session name or first message | — |
| `--json` | Output as JSON | — |

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

## Partial IDs

All commands that accept an agent ID or group ID support partial matching. You only need to type enough characters to uniquely identify the resource:

```bash
# These are equivalent if "a1b2" uniquely matches one agent
maestro-cli query a1b2c3d4-e5f6-7890-abcd-ef1234567890 "hello"
maestro-cli query a1b2 "hello"
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

The `query` command always outputs JSON (no `--json` flag needed).

## Scheduling with Cron

```bash
# Run a playbook every hour (use --json for log parsing)
0 * * * * /usr/local/bin/maestro-cli playbook <playbook-id> --json >> /var/log/maestro.jsonl 2>&1
```

## Requirements

- At least one AI agent CLI must be installed and in PATH (Claude Code, Codex, or OpenCode)
- Maestro config files must exist (created automatically when you use the GUI)

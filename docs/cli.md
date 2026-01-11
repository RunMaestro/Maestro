---
title: Command Line Interface
description: Run playbooks from the command line, cron jobs, or CI/CD pipelines with maestro-cli.
icon: square-terminal
---

Maestro includes a CLI tool (`maestro-cli`) for managing agents and running playbooks from the command line, cron jobs, or CI/CD pipelines. The CLI requires Node.js (which you already have if you're using Claude Code).

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

## JSON Output

By default, commands output human-readable formatted text. Use `--json` for machine-parseable JSONL output:

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

## Scheduling with Cron

```bash
# Run a playbook every hour (use --json for log parsing)
0 * * * * /usr/local/bin/maestro-cli playbook <playbook-id> --json >> /var/log/maestro.jsonl 2>&1
```

## Requirements

- At least one AI agent CLI must be installed and in PATH (Claude Code, Codex, or OpenCode)
- Maestro config files must exist (created automatically when you use the GUI)

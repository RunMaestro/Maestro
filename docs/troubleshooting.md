---
title: Troubleshooting & Support
description: System logs, process monitor, debug packages, and how to get help with Maestro.
icon: life-ring
---

## System Logs

Maestro maintains detailed system logs that help diagnose issues. Access them via:

- **Keyboard:** `Opt+Cmd+L` (Mac) / `Alt+Ctrl+L` (Windows/Linux)
- **Quick Actions:** `Cmd+K` / `Ctrl+K` → "View System Logs"
- **Menu:** Click the hamburger menu (☰) in the Left Panel → "System Logs"

The **System Log Viewer** shows:
- Timestamped log entries with severity levels (debug, info, warn, error, toast, autorun)
- Filterable by log level via clickable level pills and searchable text (`Cmd+F` / `Ctrl+F`)
- Real-time updates as new logs are generated
- Detail view with full message content and source module

**Log levels** can be configured in **Settings** → **General** → **System Log Level**. Higher levels show fewer logs — Debug shows all logs, Error shows only errors.

## Process Monitor

Monitor all running processes spawned by Maestro:

- **Keyboard:** `Opt+Cmd+P` (Mac) / `Alt+Ctrl+P` (Windows/Linux)
- **Quick Actions:** `Cmd+K` / `Ctrl+K` → "View System Processes"
- **Menu:** Click the hamburger menu (☰) in the Left Panel → "Process Monitor"

The **Process Monitor** displays a hierarchical tree view:
- **Groups** — Session groups containing their member sessions
- **Sessions** — Each session shows its AI agent and terminal processes
- **Process details** — PID, runtime, working directory, Claude session ID (for AI processes)
- **Group Chat processes** — Moderator and participant processes for active group chats
- **Wizard processes** — Active wizard conversations and playbook generation

**Process types shown:**
| Type | Description |
|------|-------------|
| AI Agent | Main Claude Code (or other agent) process |
| Terminal | Shell process for the session |
| Batch | Auto Run document processing agent |
| Synopsis | Context compaction synopsis generation |
| Moderator | Group chat moderator process |
| Participant | Group chat participant agent |
| Wizard | Wizard conversation process |
| Wizard Gen | Playbook document generation process |

**Features:**
- Click a process row to view detailed information (command, arguments, session ID)
- Double-click or press `Enter` to navigate to the session/tab
- `K` or `Delete` to kill a selected process
- `R` to refresh the process list
- Expand/collapse buttons in header to control tree visibility

This is useful when an agent becomes unresponsive or you need to diagnose process-related issues.

## Agent Errors

When an AI agent encounters an error, Maestro displays a modal with clear recovery options. Common error types include:

| Error Type | Description | Recovery Options |
|------------|-------------|------------------|
| **Authentication Required** | API key expired or invalid | Re-authenticate, check API key settings |
| **Context Limit Reached** | Conversation exceeded token limit | Start new session, compact context |
| **Rate Limit Exceeded** | Too many API requests | Wait and retry, reduce request frequency |
| **Connection Error** | Network connectivity issue | Check internet, retry connection |
| **Agent Error** | Agent process crashed unexpectedly | Restart agent, start new session |
| **Permission Denied** | File or operation access denied | Check permissions, run with appropriate access |

Each error modal shows:
- Error type and description
- Agent and session context
- Timestamp of when the error occurred
- Collapsible JSON details for debugging
- Recovery action buttons specific to the error type

## Debug Package

If you encounter deep-seated issues that are difficult to diagnose, Maestro can generate a **Debug Package** — a compressed bundle of diagnostic information that you can safely share when reporting bugs.

**To create a Debug Package:**
1. Press `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) to open Quick Actions
2. Search for "Create Debug Package"
3. Choose a save location for the `.zip` file
4. Attach the file to your [GitHub issue](https://github.com/pedramamini/Maestro/issues)

### What's Included

The debug package collects metadata and configuration — never your conversations or sensitive data:

**Always included:**

| File | Contents |
|------|----------|
| `system-info.json` | OS, CPU, memory, Electron/Node versions, app uptime |
| `settings.json` | App preferences with sensitive values redacted |
| `agents.json` | Agent configurations, availability, and capability flags |
| `external-tools.json` | Shell, git, GitHub CLI, and cloudflared availability |
| `windows-diagnostics.json` | Windows-specific diagnostics (minimal on other platforms) |
| `groups.json` | Session group configurations |
| `processes.json` | Active process information |
| `web-server.json` | Web server and Cloudflare tunnel status |
| `storage-info.json` | Storage paths and sizes |

**Optional (toggleable in UI):**

| File | Contents |
|------|----------|
| `sessions.json` | Session metadata (names, states, tab counts — no conversations) |
| `logs.json` | Recent system log entries |
| `errors.json` | Current error states and recent error events |
| `group-chats.json` | Group chat metadata (participant lists, routing — no messages) |
| `batch-state.json` | Auto Run state and document queue |

### Privacy Protections

The debug package is designed to be **safe to share publicly**:

- **API keys and tokens** — Replaced with `[REDACTED]`
- **Passwords and secrets** — Never included
- **Conversation content** — Excluded entirely (no AI responses, no user messages)
- **File contents** — Not included from your projects
- **Custom prompts** — Not included (may contain sensitive context)
- **File paths** — Sanitized to replace your username with `~`
- **Environment variables** — Only counts shown, not values (may contain secrets)
- **Custom agent arguments** — Only `[SET]` or `[NOT SET]` shown, not actual values

**Example path sanitization:**
- Before: `/Users/johndoe/Projects/MyApp`
- After: `~/Projects/MyApp`

## WSL2 Issues (Windows)

If you're running Maestro through WSL2, most issues stem from using Windows-mounted paths. See the [WSL2 installation guide](./installation#wsl2-users-windows-subsystem-for-linux) for the recommended setup.

### Common WSL2 Problems

**"EPERM: operation not permitted" on socket binding**

The Vite dev server or Electron cannot bind to ports when running from `/mnt/...` paths.

**Solution:** Move your project to the native Linux filesystem:
```bash
mv /mnt/c/projects/maestro ~/maestro
cd ~/maestro
npm install
npm run dev
```

**"FATAL:sandbox_host_linux.cc" Electron crash**

The Electron sandbox cannot operate correctly on Windows-mounted filesystems.

**Solution:** Run from the Linux filesystem (`/home/...`), not from `/mnt/...`.

**npm install timeouts or ENOTEMPTY errors**

Cross-filesystem operations between WSL and Windows are unreliable for npm's file operations.

**Solution:** Clone and install from the Linux filesystem:
```bash
cd ~
git clone https://github.com/pedramamini/maestro.git
cd maestro
npm install
```

**electron-rebuild failures**

The Windows temp directory may be inaccessible from WSL.

**Solution:** Override the temp directory:
```bash
TMPDIR=/tmp npm run rebuild
```

**Git index corruption or lock file errors**

NTFS and Linux inode handling are incompatible, causing git metadata issues.

**Solution:** If you see "missing index" or spurious `.git/index.lock` errors:
```bash
rm -f .git/index.lock
git checkout -f
```

For new projects, always clone to the Linux filesystem from the start.

## Getting Help

- **GitHub Issues**: [Report bugs or request features](https://github.com/pedramamini/Maestro/issues)
- **Discord**: [Join the community](https://runmaestro.ai/discord)
- **Documentation**: [Docs site](https://docs.runmaestro.ai), [CONTRIBUTING.md](https://github.com/pedramamini/Maestro/blob/main/CONTRIBUTING.md), and [ARCHITECTURE.md](https://github.com/pedramamini/Maestro/blob/main/ARCHITECTURE.md)

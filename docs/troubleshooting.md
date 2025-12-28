---
title: Troubleshooting & Support
description: System logs, process monitor, debug packages, and how to get help with Maestro.
icon: life-buoy
---

## System Logs

Maestro maintains detailed system logs that help diagnose issues. Access them via:

- **Keyboard:** `Opt+Cmd+L` (Mac) / `Alt+Ctrl+L` (Windows/Linux)
- **Quick Actions:** `Cmd+K` / `Ctrl+K` → "View System Logs"
- **Menu:** Click the hamburger menu (☰) in the Left Panel → "System Logs"

The **System Log Viewer** shows:
- Timestamped log entries with severity levels (info, warn, error)
- Filterable by log level and searchable text
- Real-time updates as new logs are generated

**Log levels** can be configured in **Settings** → **General** → **System Log Level**. Higher levels capture more detail but may impact performance.

## Process Monitor

Monitor all running processes spawned by Maestro:

- **Keyboard:** `Opt+Cmd+P` (Mac) / `Alt+Ctrl+P` (Windows/Linux)
- **Quick Actions:** `Cmd+K` / `Ctrl+K` → "View System Processes"
- **Menu:** Click the hamburger menu (☰) in the Left Panel → "Process Monitor"

The **Process Monitor** displays:
- All active AI agent processes and their PIDs
- Terminal/shell processes for each agent
- Process uptime and resource information
- Ability to terminate stuck processes

This is useful when an agent becomes unresponsive or you need to diagnose process-related issues.

## Debug Package

If you encounter deep-seated issues that are difficult to diagnose, Maestro can generate a **Debug Package** — a compressed bundle of diagnostic information that you can safely share when reporting bugs.

**To create a Debug Package:**
1. Press `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) to open Quick Actions
2. Search for "Create Debug Package"
3. Choose a save location for the `.zip` file
4. Attach the file to your [GitHub issue](https://github.com/pedramamini/Maestro/issues)

### What's Included

The debug package collects metadata and configuration — never your conversations or sensitive data:

| File | Contents |
|------|----------|
| `system-info.json` | OS, CPU, memory, Electron/Node versions, app uptime |
| `settings.json` | App preferences with sensitive values redacted |
| `agents.json` | Agent configurations, availability, and capability flags |
| `external-tools.json` | Shell, git, GitHub CLI, and cloudflared availability |
| `sessions.json` | Session metadata (names, states, tab counts — no conversations) |
| `processes.json` | Active process information |
| `logs.json` | Recent system log entries |
| `errors.json` | Current error states and recent error events |
| `storage-info.json` | Storage paths and sizes |

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

## Getting Help

- **GitHub Issues**: [Report bugs or request features](https://github.com/pedramamini/Maestro/issues)
- **Discord**: [Join the community](https://discord.gg/SrBsykvG)
- **Documentation**: [Docs site](https://docs.runmaestro.ai), [CONTRIBUTING.md](https://github.com/pedramamini/Maestro/blob/main/CONTRIBUTING.md), and [ARCHITECTURE.md](https://github.com/pedramamini/Maestro/blob/main/ARCHITECTURE.md)

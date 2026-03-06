---
title: Deep Links
description: Navigate to specific agents, tabs, and groups using maestro:// URLs from external apps, scripts, and OS notifications.
icon: link
---

# Deep Links

Maestro registers the `maestro://` URL protocol, enabling navigation to specific agents, tabs, and groups from external tools, scripts, shell commands, and OS notification clicks.

## URL Format

```
maestro://[action]/[parameters]
```

### Available Actions

| URL                                         | Action                                     |
| ------------------------------------------- | ------------------------------------------ |
| `maestro://focus`                           | Bring Maestro window to foreground         |
| `maestro://session/{sessionId}`             | Navigate to an agent                       |
| `maestro://session/{sessionId}/tab/{tabId}` | Navigate to a specific tab within an agent |
| `maestro://group/{groupId}`                 | Expand a group and focus its first agent   |

IDs containing special characters (`/`, `?`, `#`, `%`, etc.) are automatically URI-encoded and decoded.

## Usage

### From Terminal

```bash
# macOS
open "maestro://session/abc123"
open "maestro://session/abc123/tab/def456"
open "maestro://group/my-group-id"
open "maestro://focus"

# Linux
xdg-open "maestro://session/abc123"

# Windows
start maestro://session/abc123
```

### OS Notification Clicks

When Maestro is running in the background and an agent completes a task, the OS notification is automatically linked to the originating agent and tab. Clicking the notification brings Maestro to the foreground and navigates directly to that agent's tab.

This works out of the box — no configuration needed. Ensure **OS Notifications** are enabled in Settings.

### Template Variables

Deep link URLs are available as template variables in system prompts, custom AI commands, and Auto Run documents:

| Variable              | Description                                    | Example Value                         |
| --------------------- | ---------------------------------------------- | ------------------------------------- |
| `{{AGENT_DEEP_LINK}}` | Link to the current agent                      | `maestro://session/abc123`            |
| `{{TAB_DEEP_LINK}}`   | Link to the current agent + active tab         | `maestro://session/abc123/tab/def456` |
| `{{GROUP_DEEP_LINK}}` | Link to the agent's group (empty if ungrouped) | `maestro://group/grp789`              |

These variables can be used in:

- **System prompts** — give AI agents awareness of their own deep link for cross-referencing
- **Custom AI commands** — include deep links in generated output
- **Auto Run documents** — reference agents in batch automation workflows
- **Custom notification commands** — include deep links in TTS or logging scripts

### From Scripts and External Tools

Any application can launch Maestro deep links by opening the URL. This enables integrations like:

- CI/CD pipelines that open a specific agent after deployment
- Shell scripts that navigate to a group after batch operations
- Alfred/Raycast workflows for quick agent access
- Bookmarks for frequently-used agents

## Platform Behavior

| Platform          | Mechanism                                                                     |
| ----------------- | ----------------------------------------------------------------------------- |
| **macOS**         | `app.on('open-url')` delivers the URL to the running instance                 |
| **Windows/Linux** | `app.on('second-instance')` delivers the URL via argv to the primary instance |
| **Cold start**    | URL is buffered and processed after the window is ready                       |

Maestro uses a single-instance lock — opening a deep link when Maestro is already running delivers the URL to the existing instance rather than launching a new one.

<Note>
In development mode, protocol registration is skipped by default to avoid overriding the production app's handler. Set `REGISTER_DEEP_LINKS_IN_DEV=1` to enable it during development.
</Note>

## Related

- [Configuration](./configuration) — OS notification settings
- [General Usage](./general-usage) — Core UI and workflow patterns
- [MCP Server](./mcp-server) — Connect AI applications to Maestro

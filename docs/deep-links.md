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
| `maestro://run/{token}`                     | Run a [Prompt Link](#prompt-links)         |

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

### From Tab Menu

Right-click or hover on any AI tab to reveal the tab overlay menu, which includes a **Copy Deep Link** option. This copies the full `maestro://session/{id}/tab/{tabId}` URL to your clipboard - ready to paste into chat, tickets, documentation, or scripts.

### OS Notification Clicks

When Maestro is running in the background and an agent completes a task, the OS notification is automatically linked to the originating agent and tab. Clicking the notification brings Maestro to the foreground and navigates directly to that agent's tab.

This works out of the box - no configuration needed. Ensure **OS Notifications** are enabled in Settings.

### Template Variables

Deep link URLs are available as template variables in system prompts, custom AI commands, and Auto Run documents:

| Variable              | Description                                    | Example Value                         |
| --------------------- | ---------------------------------------------- | ------------------------------------- |
| `{{AGENT_DEEP_LINK}}` | Link to the current agent                      | `maestro://session/abc123`            |
| `{{TAB_DEEP_LINK}}`   | Link to the current agent + active tab         | `maestro://session/abc123/tab/def456` |
| `{{GROUP_DEEP_LINK}}` | Link to the agent's group (empty if ungrouped) | `maestro://group/grp789`              |

These variables can be used in:

- **System prompts** - give AI agents awareness of their own deep link for cross-referencing
- **Custom AI commands** - include deep links in generated output
- **Auto Run documents** - reference agents in batch automation workflows
- **Custom notification commands** - include deep links in TTS or logging scripts

### From Scripts and External Tools

Any application can launch Maestro deep links by opening the URL. This enables integrations like:

- CI/CD pipelines that open a specific agent after deployment
- Shell scripts that navigate to a group after batch operations
- Alfred/Raycast workflows for quick agent access
- Bookmarks for frequently-used agents

## Prompt Links

A Prompt Link is a `maestro://run/{token}` URL that opens a new AI tab in an agent you chose and sends a prompt you wrote. Paste one into a calendar event, a note, a bookmark, or a script, and clicking it runs that prompt.

Prompt Links is an [Encore Feature](./encore-features), **off by default**. Turn it on in **Settings > Encore Features > Prompt Links**, or with `maestro-cli encore enable prompt-links`.

<Warning>
A link that runs a prompt is a key to your agents. Anyone who can make you click a `maestro://` URL (an email, a web page, a calendar invite from a stranger) could otherwise run commands on your machine. Prompt Links are designed around that:

- **The URL carries only a random token.** The agent and the prompt stay in Maestro. A forged link names no token Maestro knows, so it does nothing. A leaked link can only run the prompt you wrote, never a new one.
- **Links are one-shot by default.** After one run, the link stops working.
- **Maestro stores only a hash of the token.** The URL is shown once, when you create it. A backup or synced copy of Maestro's data holds no working link.
- **Links run only from outside Maestro.** A `maestro://run` link clicked inside Maestro (in an agent reply or a markdown preview) does nothing, so an agent cannot trick you into running one.
- **The web interface cannot create, list, or revoke links.**

A calendar event is copied to every attendee. Treat a link in a shared event as shared.
</Warning>

### Create a link

- **Prompt Links window:** press `Opt+Cmd+Shift+L`, search **Prompt Links** in the command palette, or choose **Prompt Links** in the Left Bar hamburger menu.
- **From a tab:** open an AI tab's menu and choose **Create Prompt Link**. The form starts on that agent, with the tab's unsent draft as the prompt.
- **From the CLI:** `maestro-cli prompt-link create <agent> "<prompt>"` prints the URL.

Each link has these options:

| Option   | Choices                                    | Default    |
| -------- | ------------------------------------------ | ---------- |
| Uses     | One-shot, a number of runs, or unlimited   | One-shot   |
| Expires  | Never, or a time after which it is refused | Never      |
| Opens in | Background or foreground                   | Background |
| Label    | A name shown in the list and in toasts     | None       |

**Background** leaves your view where it is and raises a toast when the link runs. Click the toast to go to the new tab. **Foreground** brings Maestro forward on the new tab.

Use **unlimited** (or a number of uses) for a link you mean to reuse, such as one in a recurring calendar event. A one-shot link in a recurring event works for the first occurrence only.

### Manage links

The Prompt Links window and the Prompt Links tile in Settings list your links with their uses, expiry, and last run. **Revoke** stops a link for good. Turning Prompt Links off stops every link at once; the links are kept, and can still be revoked with the CLI.

```bash
# A one-shot link
maestro-cli prompt-link create "My Agent" "Summarize the PRs that landed overnight"

# A reusable link that expires in 30 days and opens in the foreground
maestro-cli prompt-link create "My Agent" --prompt-file ./standup.md \
  --uses unlimited --expires 30d --open foreground --label "Standup prep"

# List active links, or all of them, then revoke one by id prefix
maestro-cli prompt-link list
maestro-cli prompt-link list --all
maestro-cli prompt-link revoke 3f9a
```

### What happens when a link runs

| Situation                                              | Result                                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Valid link                                             | New tab, prompt sent, green toast. One use counted.       |
| Link already used, expired, or revoked                 | Nothing runs. Red toast says why.                         |
| Unknown token (mistyped, forged, from another machine) | Nothing runs. Red toast.                                  |
| Link clicked twice quickly                             | The second click is ignored while the first runs.         |
| Maestro was closed                                     | Maestro starts, restores your agents, then runs the link. |
| The agent was deleted, or the tab could not open       | Nothing runs, and the use is not counted.                 |
| Prompt Links is off                                    | Nothing runs. Yellow toast.                               |

<Note>
If you only need a prompt to run at a set time, you do not need a link. Use a [scheduled task](./maestro-cue) instead: `maestro-cli cue schedule --at "2026-12-01 09:00" --agent "My Agent" --prompt "..."`. A Prompt Link is for when your click is the trigger.
</Note>

## Platform Behavior

| Platform          | Mechanism                                                                     |
| ----------------- | ----------------------------------------------------------------------------- |
| **macOS**         | `app.on('open-url')` delivers the URL to the running instance                 |
| **Windows/Linux** | `app.on('second-instance')` delivers the URL via argv to the primary instance |
| **Cold start**    | URL is buffered and processed after the window is ready                       |

Maestro uses a single-instance lock - opening a deep link when Maestro is already running delivers the URL to the existing instance rather than launching a new one.

<Note>
In development mode, protocol registration is skipped by default to avoid overriding the production app's handler. Set `REGISTER_DEEP_LINKS_IN_DEV=1` to enable it during development.
</Note>

## Related

- [Configuration](./configuration) - OS notification settings
- [General Usage](./general-usage) - Core UI and workflow patterns
- [MCP Server](./mcp-server) - Connect AI applications to Maestro

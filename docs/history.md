---
title: History
description: Track all agent activity with searchable, filterable history including Auto Run completions and user annotations.
icon: clock
---

The History panel provides a timestamped log of all agent activity — both automated (Auto Run) and manual (user interactions). Use it to review past work, resume sessions, and validate completed tasks.

![History Panel](./screenshots/history-1.png)

## Entry Types

History entries are categorized by source:

| Type | Label | Description |
|------|-------|-------------|
| **AUTO** | 🤖 AUTO | Entries created by Auto Run task completions |
| **USER** | 👤 USER | Entries created manually by the user |

### Auto Entries

Auto entries are created automatically when Auto Run completes a task. Each entry includes:
- **Summary** of what the agent accomplished
- **Session ID** (clickable to jump to that conversation)
- **Duration** and **cost** of the task
- **Timestamp** of completion

### User Entries

User entries are created in three ways:

1. **History Toggle** — Enable the **History** pill in the AI input box. Every prompt-response cycle automatically creates a user history entry.

2. **`/history` Command** — Run `/history` to create a synopsis entry covering all activity since the last time you ran the command. This is useful for periodic summaries without logging every single interaction.

3. **`/clear` Command** — Running `/clear` automatically creates a history entry before clearing the conversation, preserving a synopsis of your work.

**Toggle the default History behavior** in Settings → General → "Enable 'History' by default for new tabs".

## Filtering History

### By Type

Use the **AUTO** and **USER** filter buttons at the top of the History panel to show or hide each entry type:
- Click **AUTO** to toggle Auto Run entries
- Click **USER** to toggle user-created entries
- Both can be active simultaneously

### By Keyword

Press `Cmd+F` / `Ctrl+F` to open the search box, or click in the filter area to type. The search matches against:
- Entry summaries
- Session names and IDs
- Full response content

### By Time Range

The **Graph View** at the top shows activity distribution over time. **Right-click the graph** to change the time range:
- 24 hours
- 72 hours
- 1 week
- 2 weeks
- 1 month
- 6 months
- 1 year
- All time

The graph bars are clickable — click a time period to jump to entries from that window. Hover over any bar to see the exact count and time range.

## Entry Details

Click any history entry to open the **Detail View**:

![History Detail View](./screenshots/history-2.png)

The detail view shows:
- **Full entry header** with type badge, session ID, timestamp, and validation status
- **Context usage** — tokens consumed and context window percentage
- **Token breakdown** — input tokens, output tokens
- **Duration** and **cost**
- **Full summary text** of what was accomplished
- **RESUME button** — Jump directly to the AI session to continue from where Maestro left off

### Navigation

- **Prev / Next** buttons to navigate between entries (or use `←` / `→` arrow keys)
- **Close** button to return to the list view
- **Delete** button to remove the entry (with confirmation dialog)

## Validating Entries

The **Validated** flag helps you track which Auto Run tasks have been human-reviewed.

![Toggling Validated Status](./screenshots/history-3.png)

**To mark an entry as validated:**
1. Open the entry detail view
2. Click the **VALIDATED** toggle in the header

![Validated Icon in List](./screenshots/history-4.png)

Validated entries show a **checkmark icon** (✓✓) in the list view, making it easy to see at a glance which tasks have been reviewed.

**Workflow tip:** After an Auto Run batch completes, use the History panel to review each task:
1. Open the first AUTO entry
2. Click **RESUME** to jump to the session and verify the work
3. If satisfied, toggle **VALIDATED**
4. Click **Next** to review the next entry
5. Repeat until all entries are validated

This ensures human oversight of automated work while maintaining the full context needed to continue any task.

## Resuming Sessions

Every history entry with a Session ID has a **RESUME** button. Clicking it:
1. Opens the AI Terminal for that agent
2. Loads the exact session where the work was done
3. Positions you to continue the conversation

This is especially powerful for Auto Run tasks — you can pick up exactly where the agent left off, with full conversation context preserved.

## Keyboard Navigation

### List View

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between entries |
| `Enter` | Open detail view for selected entry |
| `Cmd+F` / `Ctrl+F` | Open search filter |
| `Esc` | Clear selection or close search |

### Detail View

| Key | Action |
|-----|--------|
| `←` / `→` | Navigate to previous/next entry |
| `Esc` | Close detail view, return to list |

## Storage

History is stored per-session in JSON files within the `history/` subdirectory of your Maestro data folder:
- **macOS**: `~/Library/Application Support/maestro/history/<sessionId>.json`
- **Windows**: `%APPDATA%/maestro/history/<sessionId>.json`
- **Linux**: `~/.config/maestro/history/<sessionId>.json`

Each session maintains up to **5,000 entries**. History files can be passed to AI agents as context for understanding past work patterns.

## Help Panel

Click the **?** button in the History panel header to open a detailed guide explaining all features, entry types, status indicators, and keyboard shortcuts.

> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM issue-sync

GitHub roundtrip sync for a specific task.

Task ID: {{ARGS}}

## What this does

Performs a bidirectional sync between the local Work Graph and GitHub Issues:

**Local → GitHub** (push):

- Updates the Issue title and description if changed locally
- Syncs the status (maps Work Graph status to GitHub Issue state and project board column)
- Updates labels to reflect current type and priority
- Posts a progress comment if the status changed since last sync

**GitHub → Local** (pull):

- If the GitHub Issue has been edited externally, fetches those changes
- Applies any new comments as Work Graph events
- Updates the sync timestamp

## Status mapping

| Work Graph Status | GitHub Issue State | Board Column |
| ----------------- | ------------------ | ------------ |
| planned / ready   | open               | To Do        |
| in_progress       | open               | In Progress  |
| review            | open               | In Review    |
| blocked           | open               | Blocked      |
| done              | closed             | Done         |

## After sync

Confirm what was pushed and what was pulled.
If there are conflicts (both sides changed the same field), show a diff and ask which version to keep.

If the task has no GitHub Issue yet, offer to create one.

> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM epic-sync

Push an epic and its tasks to GitHub via the Delivery Planner sync channel.

Epic ID: {{ARGS}}

## What this does

Syncs the local Work Graph state to GitHub:

- Creates or updates the GitHub Project Board entry for the epic
- Ensures each task has a corresponding GitHub Issue
- Updates issue titles, descriptions, labels, and status fields
- Links issues to the parent epic milestone

## Pre-sync checklist

Before confirming sync, verify:

- [ ] Epic title and description are final
- [ ] All tasks have clear titles and acceptance criteria
- [ ] No tasks are in `discovered` status (they should be at least `planned`)
- [ ] The project's GitHub remote is configured

## Sync behavior

- **New items** → creates GitHub Issues with appropriate labels
- **Updated items** → edits existing Issues (title, description, status)
- **Deleted items** → adds a `wont-fix` label and closes the Issue (does not permanently delete)
- **Status mapping**: Work Graph `done` → GitHub Issue `closed`

## After sync

Confirm which items were created, updated, or skipped.
Provide a link to the GitHub Project board if available.

If sync fails for any items, list them with the error reason so the user can resolve manually.

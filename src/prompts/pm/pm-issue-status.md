> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM issue-status

Quick status check for a specific task.

Task ID: {{ARGS}}

## Output format

Keep the response to 1-3 lines maximum.

Examples:

**Feature: Add dark mode toggle** (`task-abc123`) — status: **in_progress** — claimed by `agent-session-xyz`

**Bug: Fix login redirect** (`task-def456`) — status: **blocked** — reason: waiting on auth service changes

**Chore: Update dependencies** (`task-ghi789`) — status: **ready** — unclaimed

## After the status line

Add a single suggested next action if appropriate:

- `ready` → `/PM issue-start {{ARGS}}`
- `blocked` → tag the blocking reason so a human can resolve
- `done` → `/PM issue-sync {{ARGS}}` to close on GitHub

Do not add verbose explanation — the user wants a quick pulse check.

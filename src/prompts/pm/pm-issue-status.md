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

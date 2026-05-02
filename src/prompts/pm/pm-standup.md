> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM standup

Generate a concise standup summary for the current project.

Format:

## Standup — {{DATE}}

**Yesterday** (Done or moved to Done in the past 24 hours):

- Item title (ID)

**Today** (In Progress or claimed):

- Item title (ID) — assigned to <agent/user>

**Blockers**:

- Item title (ID) — blocking reason

Keep each line short (one sentence max). If a section has no items, write "Nothing to report."
This summary is designed to be pasted directly into a team channel or ticket comment.

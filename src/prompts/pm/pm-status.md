> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM status

Show a current project board snapshot for the active project.

Present the data as a compact summary:

## Project Status

| Status      | Count |
| ----------- | ----- |
| Planned     | N     |
| Ready       | N     |
| In Progress | N     |
| Blocked     | N     |
| Done        | N     |

**Ready items** (up to 5): list title + ID
**Blocked items** (up to 5): list title + blocking reason if available
**Overdue items** (up to 5): list title + due date

If the board is empty, say so and suggest starting with `/PM prd-new <name>`.

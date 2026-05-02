> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM next

Show the next eligible work item ready for implementation.

Selection criteria (in priority order):

1. Status is `ready` and not currently claimed
2. All blocking dependencies are `done` or `canceled`
3. Highest-priority task by due date (soonest first), then by creation date

Present the result as a short card:

- **Title**
- **Description** (first 2 sentences)
- **Status / Priority**
- Suggested action: "Run `/dispatch assign <id>` to claim this item" (if Agent Dispatch is active)

If no eligible items exist, say so and suggest checking `/PM status` for blocked items.

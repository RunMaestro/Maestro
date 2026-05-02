> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM prd-list

List all PRDs for the current project.

Format the output as a markdown table with columns: Title | Status | Created.
Sort by creation date descending (newest first).
If there are no PRDs, say so clearly and offer to create one with `/PM prd-new <name>`.

> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM prd-new

You are starting a new Conversational PRD session for the feature described below. Your goal is to help the user define a clear, implementable specification.

Begin by acknowledging the feature name and asking the single most important clarifying question to understand the user problem behind it.

Feature name: {{ARGS}}

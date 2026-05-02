> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM prd-parse

Convert an existing PRD into structured Delivery Planner input.

PRD ID: {{ARGS}}

## Your role

You are a planning assistant. Given the PRD, extract and structure the information needed
for the Delivery Planner to create an epic and tasks.

## Output format

Produce a structured JSON block that the Delivery Planner can consume:

```json
{
	"prdId": "<id>",
	"title": "<feature title>",
	"description": "<concise problem statement>",
	"successCriteria": ["<criterion 1>", "<criterion 2>"],
	"scope": ["<in-scope item 1>", "<in-scope item 2>"],
	"outOfScope": ["<out-of-scope item 1>"],
	"constraints": ["<constraint 1>"],
	"dependencies": ["<dependency 1>"],
	"estimatedComplexity": "small | medium | large | xl",
	"suggestedEpicTitle": "<Epic: feature name>"
}
```

## After parsing

- Confirm the structured output with the user
- If any fields are missing or ambiguous, ask a single focused question to fill them in
- Once confirmed, suggest `/PM epic-decompose {{ARGS}}` to proceed to decomposition

## Complexity guide

- **small**: 1-3 tasks, 1-2 days
- **medium**: 4-8 tasks, 3-5 days
- **large**: 9-15 tasks, 1-2 weeks
- **xl**: 16+ tasks, requires sub-epics

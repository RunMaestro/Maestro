# /PM prd-edit

You are reopening a Conversational PRD session to edit an existing PRD.

The PRD ID is: {{ARGS}}

## Your role

Load the current state of this PRD and present a brief summary of:

- The feature title and problem statement
- Current status and any incomplete sections

Then ask the user what they would like to change. Common edits include:

- Expanding or narrowing scope
- Updating success criteria
- Revising constraints or dependencies
- Adding or removing out-of-scope items

## Editing guidelines

- Show the field being edited before and after so the user can confirm
- Ask one focused question at a time
- Do not discard existing content unless explicitly asked
- When edits are complete, confirm the updated PRD and suggest `/PM epic-decompose {{ARGS}}` to regenerate the epic if the scope changed significantly

## Output format

After each change, summarize the full updated field so the context is clear.

Signal **"Ready to save"** on its own line when the user confirms all edits are complete.

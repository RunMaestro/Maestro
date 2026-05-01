# /PM epic-edit

Open the Delivery Planner to edit an existing epic.

Epic ID: {{ARGS}}

## Your role

Present the current state of this epic and its tasks, then help the user make targeted edits.

## Editing options

- Add or remove tasks
- Change task titles or descriptions
- Adjust task dependencies
- Update the epic title or description
- Change task types or priorities
- Reorder the suggested implementation sequence

## Workflow

1. Show the current epic summary (title, status, task count)
2. List all tasks in a compact table: ID | Title | Status | Type
3. Ask what the user wants to change
4. Apply the edit and confirm before saving

## Constraints

- Do not delete tasks that are already `in_progress`, `review`, or `done` — only the user can force that
- When adding tasks, check for duplicate intent before creating
- Warn if a new dependency would create a circular chain

When edits are confirmed, suggest `/PM epic-sync {{ARGS}}` to push changes to GitHub.

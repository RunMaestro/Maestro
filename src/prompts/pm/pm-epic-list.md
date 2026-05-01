# /PM epic-list

Show a table of all epics in the Work Graph for the current project.

## Output format

Present the data as a markdown table:

| ID     | Title        | Status          | Tasks   | Updated    |
| ------ | ------------ | --------------- | ------- | ---------- |
| `<id>` | Feature Name | **in_progress** | 8 tasks | YYYY-MM-DD |

## Status legend

- **planned** — decomposed but not started
- **in_progress** — at least one task is claimed or in progress
- **review** — all tasks done, awaiting final review
- **done** — all tasks completed
- **blocked** — at least one task is blocked

## After the table

If there are epics in progress, show a quick summary:

- Number of tasks done vs total for each in-progress epic
- Any blocked tasks

If there are no epics, say so and suggest `/PM epic-decompose <prd-id>` to create one.

Keep the response concise — one table and a brief summary paragraph is enough.

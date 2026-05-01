# /PM prd-status

Show a quick status summary for a specific PRD.

PRD ID: {{ARGS}}

## Output format

Present the following fields in a compact table:

| Field   | Value        |
| ------- | ------------ |
| ID      | `<id>`       |
| Title   | <title>      |
| Status  | **<status>** |
| Source  | <source>     |
| Created | YYYY-MM-DD   |
| Updated | YYYY-MM-DD   |

If the PRD has a description, include the first 2-3 sentences below the table.

## Next steps

Suggest the most relevant next action based on status:

- `planned` / `ready` → `/PM epic-decompose <id>` to break it into an epic
- `in_progress` → `/PM epic-list` to see the current epic
- `blocked` → explain the blocking reason if available
- `done` → congratulate and suggest archiving or creating a new PRD

Keep the response under 20 lines total.

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

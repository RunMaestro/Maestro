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

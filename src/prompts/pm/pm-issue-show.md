# /PM issue-show

Show full detail for a specific task (work item / issue).

Task ID: {{ARGS}}

## Output format

### Task header

```
## Task: <Title>
ID: `<id>` | Status: **<status>** | Type: <type>
Created: YYYY-MM-DD | Updated: YYYY-MM-DD
```

### Fields

| Field        | Value                   |
| ------------ | ----------------------- |
| Source       | <source>                |
| Priority     | <priority or —>         |
| Claimed by   | <agent-id or unclaimed> |
| Claimed at   | YYYY-MM-DD HH:MM or —   |
| GitHub Issue | #<number> or —          |

### Description

Show the full description (up to 600 characters, with "..." if truncated).

### Dependencies

If the task has dependencies, list them:

- `<dep-id>` Dependent task title — **<status>**

### Acceptance criteria

If present in the description, extract and format as a checklist.

## Next steps

Based on status:

- `ready` → `/PM issue-start {{ARGS}}` to claim
- `in_progress` → show remaining work estimate if available
- `blocked` → show blocking reason
- `done` → suggest closing on GitHub with `/PM issue-sync {{ARGS}}`

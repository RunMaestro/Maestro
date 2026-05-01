# /PM epic-show

Show full detail for a specific epic, including all tasks.

Epic ID: {{ARGS}}

## Output format

### Epic header

```
## Epic: <Title>
ID: `<id>` | Status: **<status>** | Source: <source>
Created: YYYY-MM-DD | Updated: YYYY-MM-DD
```

If there is a description, show it here (truncated to 3 sentences).

### Task list

Show all tasks in a checklist format:

```
### Tasks (<done>/<total>)

- [x] `task-id` Task title — **done**
- [ ] `task-id` Task title — **in_progress** — Runner: <agent-id>
- [ ] `task-id` Task title — **ready**
- [ ] `task-id` Task title — **blocked** — Reason: ...
```

### Progress bar (text)

```
Progress: ████████░░░░░░░░ 50% (4/8 tasks done)
```

## Next steps

Based on the epic status, suggest the most useful next action:

- Has `ready` tasks → `/PM issue-start <task-id>` to claim one
- Has `blocked` tasks → list them with reasons
- All `done` → suggest `/PM epic-sync {{ARGS}}` to finalize on GitHub

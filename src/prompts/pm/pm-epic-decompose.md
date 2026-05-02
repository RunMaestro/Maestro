> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM epic-decompose

Decompose a PRD into an Epic and a set of implementation tasks.

PRD ID: {{ARGS}}

## Your role

You are a senior engineer helping break down a feature into parallel-friendly tasks
for the agent fleet. Apply CCPM (Critical Chain Project Management) principles:
minimize dependencies, maximize parallelism, right-size tasks.

## Decomposition process

1. Review the PRD (title, description, success criteria, scope)
2. Identify the minimum viable set of tasks to deliver the scope
3. Group tasks into a logical epic
4. For each task, specify:
   - Title (imperative verb + noun)
   - Description (what needs to be done, acceptance criteria)
   - Type: `task`, `bug`, `chore`, or `feature`
   - Estimated size: `xs` (< 1 hr) / `s` (1-2 hr) / `m` (2-4 hr) / `l` (4-8 hr) / `xl` (8+ hr)
   - Dependencies (task titles that must complete first)
   - Suggested agent role: `runner` | `fixer` | `reviewer` | `merger`

## Output format

```
## Epic: <Feature Name>

### Tasks

1. **<Task title>** [type: task | size: m]
   <1-2 sentence description>
   Depends on: none
   Role: runner

2. **<Task title>** [type: task | size: s]
   ...
```

## Quality checklist

- [ ] No task is > 8 hours (split if needed)
- [ ] Critical path is clear (at most 2-3 sequential dependencies)
- [ ] At least 2 tasks can run in parallel
- [ ] Reviewer/merger tasks are last in the chain

After presenting the decomposition, ask: "Does this look right? Type `confirm` to create
the epic in the Work Graph, or tell me what to change."

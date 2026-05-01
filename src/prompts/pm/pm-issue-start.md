# /PM issue-start

Manually claim a task for an agent via Agent Dispatch.

Task ID: {{ARGS}}

## What this does

Bypasses the automatic pickup queue and directly assigns this task to an agent.
This is useful when you want to:

- Start a specific high-priority task immediately
- Assign work to a particular agent with the right context
- Resume a task that was accidentally released

## Pre-claim check

Before claiming, confirm:

- The task is in `ready` or `planned` status (not already `in_progress` or `done`)
- The target agent is currently idle
- No other agent has an active claim on this task

## Claiming process

1. Open Agent Dispatch to show available agents
2. Display the task title and description so you can pick the right agent
3. Confirm the assignment
4. Update the task status to `in_progress` in the Work Graph

## After claiming

- The task appears in the agent's active work list
- A claim heartbeat will keep it alive every 60 seconds
- Use `/PM issue-status {{ARGS}}` to monitor progress
- Use `/PM issue-show {{ARGS}}` for full task detail

If the task is already claimed, show who has it and offer to force-release (with a warning).

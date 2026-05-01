# /PM epic-start

Kick the Planning Pipeline for an epic, routing its tasks through the agent fleet.

Epic ID: {{ARGS}}

## What this does

Triggers the Planning Pipeline to:

1. Validate that the epic's tasks are in `ready` or `planned` status
2. Assign roles (`runner`, `fixer`, `reviewer`, `merger`) to tasks based on their pipeline state
3. Make eligible tasks available for agent auto-pickup via the Agent Dispatch engine
4. Set up the pipeline monitoring so blocked tasks surface automatically

## Pre-start checklist

Verify before starting:

- [ ] The epic has at least one task in `ready` status
- [ ] GitHub sync is current (run `/PM epic-sync {{ARGS}}` first if unsure)
- [ ] The agent fleet has at least one idle `runner` available

## Pipeline behavior

- Tasks with no dependencies are immediately eligible for pickup
- Dependent tasks unlock automatically when their prerequisites reach `done`
- Blocked tasks notify the team via toast notification
- The pipeline self-heals: if an agent goes idle mid-task, the task returns to `ready`

## After starting

Show the pipeline status:

- Total tasks | Ready | In Progress | Blocked | Done
- Estimated completion range based on task sizes

Suggest `/PM epic-show {{ARGS}}` to monitor progress.

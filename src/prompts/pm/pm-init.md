# /PM-init

Bootstrap the GitHub Projects v2 custom fields required by the Maestro delivery pipeline.

Run this once per repository before using `/PM`, `/dispatch`, or any other project-management commands.

## What it does

Idempotently creates the following AI-prefixed fields on the active project if they do not already exist:

| Field              | Type          | Options                                                                                  |
| ------------------ | ------------- | ---------------------------------------------------------------------------------------- |
| AI Status          | Single-select | Backlog, Idea, PRD Draft, Refinement, Tasks Ready, In Progress, In Review, Blocked, Done |
| AI Role            | Single-select | runner, fixer, reviewer, merger                                                          |
| AI Stage           | Single-select | prd, epic, task                                                                          |
| AI Priority        | Single-select | P0, P1, P2, P3                                                                           |
| AI Parent PRD      | Text          | —                                                                                        |
| AI Parent Epic     | Text          | —                                                                                        |
| AI Assigned Slot   | Text          | —                                                                                        |
| AI Last Heartbeat  | Text          | —                                                                                        |
| AI Project         | Text          | —                                                                                        |
| External Mirror ID | Text          | —                                                                                        |

Running `/PM-init` a second time is safe — existing fields are left untouched.

## Errors

If `gh auth login` has not been run, the command surfaces a clear auth error and exits without making any changes.

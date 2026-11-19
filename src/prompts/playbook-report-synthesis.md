# Playbook Run Summary

The playbook **{{PLAYBOOK_NAME}}** has finished its run. Summarize what the run did for the person who started it, from the facts, the file list, and the task synopses below. This is a short read-only answer: do not read files, run commands, or change anything.

## The run

{{RUN_FACTS}}

## Files changed during the run

{{FILES_CHANGED}}

## Task synopses, oldest first

Each line is one task: the document it belonged to, then what the agent reported.

{{TASK_SYNOPSES}}

## How to answer

Reply with the narrative only.

{{INCLUDE:_playbook-report-narrative}}

- Merge tasks that did the same thing into one bullet. Prefer outcomes over steps.
- Put failed tasks and stalled documents under Challenges.
- Put a next step only where the synopses or the stalled documents point to one.

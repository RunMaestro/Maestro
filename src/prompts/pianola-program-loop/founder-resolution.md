The founder has answered questions for {{PROGRAM_TITLE}} (program {{PROGRAM_ID}}) at {{ROOT}}.

Decisions, notes, and originating agent/tab:
{{RESULT}}

Apply these decisions to the blocked work. Read the current plan with `pianola plan show <planId> --json` and coordinate with the originating role using the supplied IDs. Do not create a competing plan while the program already has an unfinished plan, and do not dispatch implementation tasks yourself; the supervised orchestrator drives tasks. For a task awaiting review or failed, apply the founder correction with `pianola plan revise <planId> <taskId> --prompt "<corrected implementation instructions>" --json`. This queues that task again while preserving the plan ID, completed work, dependencies, and validation oracle. Never use `plan set` to replace a started plan. Raise a new founder ask only if a different decision is still needed.

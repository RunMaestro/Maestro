The latest plan for {{PROGRAM_TITLE}} ({{PROGRAM_ID}}) at {{ROOT}} has finished.
{{RESULT}}

Role agents:
{{ROLES}}

Review this result, then hand off the next small bounded outcome by writing a plan JSON and saving it with `pianola plan set --file <path-to-plan.json>`. Include programId, each task's role agentId and cwd, plus command, target, and artifacts in a validation block on every engineer task. Stop after authoring the plan; do not dispatch agents yourself.

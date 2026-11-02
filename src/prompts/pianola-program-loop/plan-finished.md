The latest plan for {{PROGRAM_TITLE}} ({{PROGRAM_ID}}) at {{ROOT}} has finished.
{{RESULT}}

Role agents:
{{ROLES}}

Review this result, then hand off the next small bounded outcome by writing a plan JSON with a fresh id unique to that outcome (never reuse an earlier plan id) and saving it with the Maestro CLI: if `$MAESTRO_CLI_JS` ends in `.sh`, run `"$MAESTRO_CLI_JS" pianola plan set --file <path-to-plan.json> --json`; otherwise run `node "$MAESTRO_CLI_JS" pianola plan set --file <path-to-plan.json> --json`. Include programId, each task's role agentId and cwd, plus command, target, and artifacts in a validation block on every engineer task (the command runs in a read-only sandbox from the root). Engineer work goes on a branch named after the plan id, never directly on the default branch. Stop after saving the plan; do not dispatch agents yourself.

[Maestro] The user asked for the result of this turn to go to {{HANDOFF_AGENTS}}. When this turn ends, Maestro forwards your final answer to them, together with the user's message.

- Do not contact them yourself (no `maestro-cli ask`, `send`, or `dispatch`). The hand-off is automatic.
- Do the work the user asked for first.
- Write your final answer so it stands on its own: {{HANDOFF_AGENTS}} sees the user's message and that answer, not your tool calls or your earlier notes.

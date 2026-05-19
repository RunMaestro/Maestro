Examine the current git diff and determine if we need to make any updates to the README.md or CLAUDE.md / AGENTS.md files.

Then create a sensible git commit message. IMPORTANT: The commit message MUST include the agent session ID "{{AGENT_SESSION_ID}}" somewhere in the commit body (not the subject line). This allows us to trace commits back to their original conversation for context and continuity.

Example commit format:
<subject line summarizing changes>

<detailed description>

Session: {{AGENT_SESSION_ID}}

After committing, push all changes up to origin.

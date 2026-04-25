# Context Transfer Instructions

You are preparing a conversation context for transfer from {{sourceAgent}} to {{targetAgent}}.

## Your Goals

1. Preserve all important technical decisions and context
2. Remove agent-specific formatting and commands
3. Convert code references to be agent-agnostic
4. Remove references to agent-specific tools or capabilities
5. Maintain the logical flow of the conversation
6. Summarize the current state clearly for the new agent

## Source Agent Artifacts to Remove

{{sourceAgentArtifacts}}

## Target Agent Considerations

{{targetAgentNotes}}

## Guidelines

### What to Preserve

- All code changes and implementations
- Important decisions and their rationale
- File paths and modifications
- Error resolutions and debugging steps
- Configuration changes
- Architecture decisions
- Test results and coverage details
- Dependencies added or modified
- Current working directory context
- Git branch and repository information

### What to Remove

- Agent-specific slash commands (e.g., /clear, /compact, /cost)
- Agent-specific tool names and invocations
- References to the source agent's capabilities or limitations
- Agent-specific formatting markers
- Streaming artifacts and partial outputs
- Redundant session metadata

### What to Convert

- Agent-specific terminology to generic equivalents
- Tool-specific syntax to descriptive prose
- Agent-branded references to neutral alternatives

## Output Format

Provide a clean context that any AI coding assistant can understand. Structure it as:

## Project Context

Brief description of the project and current working directory.

## Summary

A 2-3 sentence overview of what has been accomplished so far.

## Key Decisions

- Decision 1: Brief description and rationale
- Decision 2: Brief description and rationale
  (Only include if decisions were made)

## Code Changes

List files modified with brief descriptions:

- `path/to/file.ts` - What was changed and why
  (Only include if code was modified)

## Current State

What is the current state of the work? What's working, what's not?

## Next Steps

Any discussed or implied next steps to continue the work.
(Only include if next steps were discussed)

## Important Context

Any critical information the new agent needs to know to continue effectively.

---

## Do Not Prompt The User

Do NOT call any tool that waits for user input (e.g. `AskUserQuestion` in Claude Code, `question` in OpenCode, or any equivalent). These block execution and are unreliable inside Maestro's orchestration flow, especially in batch/Auto Run contexts.

If you have a blocking question, stop work and put the question in the text of your normal response — the user reads your response and will reply there.

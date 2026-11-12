# Context Summarization Instructions

You are compacting a conversation context to continue work in a fresh session. Your goal is to preserve all important technical details while reducing token usage.

## MUST PRESERVE (never omit or abbreviate)

- All file paths mentioned (exact paths with line numbers)
- All function/class/variable names discussed
- All code snippets that were written or modified
- All technical decisions made and their rationale
- All error messages and their resolutions
- All configuration values and settings
- Current state of the work (what's done, what's pending)
- Any TODOs or next steps discussed

## SHOULD COMPRESS

- Back-and-forth clarification dialogues → summarize the conclusion
- Repeated explanations of the same concept → single clear explanation
- Verbose acknowledgments and pleasantries → remove entirely
- Step-by-step debugging that led to a fix → keep the fix, summarize the journey
- Large data dumps or log outputs → truncate with "[...N lines truncated...]"
- Repeated similar code blocks → show one example, note "similar pattern in X other locations"

## SHOULD REMOVE

- Greetings and sign-offs
- "Sure, I can help with that" type responses
- Redundant confirmations
- Explanations of concepts already well-understood
- Failed approaches that were completely abandoned (unless instructive)

## OUTPUT FORMAT

Structure your summary as:

### Project Context

- Working directory: [path]
- Key files involved: [list with paths]

### Work Completed

[Bullet points of what was accomplished, with file:line references]

### Key Decisions

[Important technical decisions and why they were made]

### Current State

[Where the work stands right now]

### Code Changes Summary

[Key code that was written/modified - preserve exact snippets]

### Pending Items

[What still needs to be done]

### Important References

[Any URLs, documentation, or external resources mentioned]

---

## Do Not Prompt The User

Do NOT call any tool that asks the user a question (e.g. `AskUserQuestion` in Claude Code, `question` in OpenCode, `request_user_input` or `request_user_input_async` in Codex, or any equivalent). That includes tools that return immediately and promise to deliver the reply later: nothing in Maestro's orchestration flow renders or answers them, so the run stalls or the reply never arrives, especially in batch/Auto Run contexts.

If you have a blocking question, stop work and put the question in the text of your normal response - the user reads your response and will reply there.

---

Now summarize the following conversation context:

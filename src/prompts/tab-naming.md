Generate a 2-4 word tab name for this coding task. Output ONLY the name, nothing else.

Rules:

- 2-4 words max, shorter is better
- Title Case, no punctuation
- Be specific (mention tech/file names if relevant)
- Include ID numbers (PR #, issue #, ticket ID) when mentioned
- Use hyphens for compound concepts
- If too vague, use format: YYYY-MM-DD Topic

Examples:
"add dark mode to React app" = Dark Mode Toggle
"bug in auth login flow" = Auth Login Bug
"refactor DB queries for pooling" = DB Connection Pooling
"write tests for checkout" = Checkout Tests
"fix TS errors in parser.ts" = Parser TS Errors
"review PR #256" = PR 256 Review
"fix issue #42 memory leak" = Issue 42 Memory Leak
"implement JIRA-1234 feature" = JIRA-1234 Feature
"help with my code" = 2024-01-15 Code Help

---

## Do Not Prompt The User

Do NOT call any tool that waits for user input (e.g. `AskUserQuestion` in Claude Code, `question` in OpenCode, or any equivalent). These block execution and are unreliable inside Maestro's orchestration flow, especially in batch/Auto Run contexts.

If you have a blocking question, stop work and put the question in the text of your normal response — the user reads your response and will reply there.

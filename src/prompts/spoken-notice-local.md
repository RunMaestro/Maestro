An AI coding agent finished a turn. Summarize the outcome in one short clause that will be read aloud.

Reply with JSON only: {"summary": "<clause>"}

- `summary`: at most 12 words, plain spoken English, no trailing period.
- Say what happened: what was done, what was found, or what the agent is waiting for.
- If the agent asks the user a question or needs a decision, say that it needs input.
- If the agent failed or could not finish, say so.
- Do not name the agent; its name is added for you.
- No file paths, code, symbols, markdown, quotes, or lists. Round long numbers.
- Use only what the reply says. Do not invent results.

Examples:
{"summary": "tests pass, two files changed"}
{"summary": "needs your decision on the database migration"}
{"summary": "the build failed on a missing dependency"}

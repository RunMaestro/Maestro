Write a pull request title and description from the branch summary below.

Reply with JSON only: {"title": "<one line>", "body": "<markdown>"}

- `title`: one line, imperative mood, at most 70 characters, no trailing period. Say what the branch does, not its name.
- `body`: a one or two sentence summary, then a short bullet list of the main changes. Markdown. Under 150 words.
- Use only what the commits and file list show. Do not invent features, issue numbers, or test results.
- When commits or files are marked "not shown", describe the change at a higher level instead of listing only what you can see.

Example:
{"title": "Add retry with backoff to the sync client", "body": "Retries failed sync requests instead of surfacing the first error.\n\n- Add exponential backoff to `SyncClient.send`\n- Cap retries at five attempts\n- Cover the retry path with unit tests"}

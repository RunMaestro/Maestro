Turn the request into ONE shell command line for the environment below.

Reply with JSON only: {"command": "<one line>", "explanation": "<one short sentence>"}

## Environment

- Operating system: {{OS}}
- Shell: {{SHELL}}
- Working directory: {{CWD}}
- Git repository: {{IS_GIT_REPO}}
  {{REMOTE_LINE}}

## Rules

- `command` is ONE line. Chain steps with `&&` or a pipe.
- Use tools that ship with this operating system and shell.
- Use relative paths. Do not `cd` first.
- Quote anything that could contain spaces or globs.
- A request to "see", "find", "list", "count", or "show" must not write or delete.
- No `sudo` unless the request needs it. Never delete outside the working directory.
- A follow-up ("actually", "only", "just the count", "same but") changes the LAST command in Recent commands. Keep its paths and filters.
- `explanation` says what the command does, in plain words.

{{RECENT_COMMANDS}}

## Examples

```
Request: what's taking up space in here
{"command": "du -sh * | sort -rh | head -20", "explanation": "Lists the 20 largest items in this directory."}

Request: find every TODO in the typescript sources
{"command": "grep -rn 'TODO' --include='*.ts' .", "explanation": "Searches all .ts files for TODO."}

Request: kill whatever is on port 3000
{"command": "lsof -ti tcp:3000 | xargs kill -9", "explanation": "Force stops the process listening on port 3000."}
```

---

Request: {{USER_REQUEST}}

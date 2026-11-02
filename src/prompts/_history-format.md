## Task Recall (history JSONL)

Start with `maestro-cli timeline`: it lists recent history entries next to the user's actions and commits, each with an `[entry <id>]` handle, and `timeline show <id>` prints one entry in full. Read the file below only for a scan the CLI does not cover.

Your history is stored at `{{AGENT_HISTORY_PATH}}` as JSONL: one entry per line, appended when a turn finishes, so the newest entries are at the end. Another agent's history sits in the same folder, named `<agentId>.jsonl`. A line can fail to parse after a crash; skip it.

Each line is one entry with the following fields (optional unless marked required):

- `id` _(required, string)_ - UUID for the entry
- `type` _(required, `'AUTO' | 'USER' | 'CUE' | 'AGENT'`)_ - `AUTO` = Auto Run, `USER` = interactive turn, `CUE` = started by Cue (a subscription's own run, or a `maestro-cli send` Cue started), `AGENT` = an ordinary message from another agent, by an `@mention` consult or by `maestro-cli send` from its shell (a normal turn, not automation; see `sourceAgentName` for who asked)
- `timestamp` _(required, number)_ - Unix milliseconds when the entry was written
- `summary` _(required, string)_ - short description of the task / response
- `projectPath` _(required, string)_ - absolute path of the working directory at the time
- `fullResponse` - complete AI response text; pull this when you need full context, not just the summary
- `sessionId` - the Maestro agent id (the file's name)
- `agentSessionId` - provider session id (e.g. Claude Code's resume id)
- `tabId` - the AI tab the turn ran in (`session show <tab-id>` prints its transcript while the tab is open)
- `sessionName` - human-readable tab name
- `sourceAgentName` - on an `AGENT` entry, the display name of the agent that consulted or sent to this one
- `success` - boolean; whether the run completed without error
- `elapsedTimeMs` - wall-clock duration of the run
- `contextUsage` - context window usage percentage at completion (0-100)
- `usageStats` - `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd }`
- `tokenSource` - Claude-only, per-turn: `'interactive'` (maestro-p driving the Claude TUI) or `'api'` (`claude --print`); it names the interface, not the bill (signed in with a Claude plan, both draw from the same plan limits); absent on non-Claude and older entries
- `tokenSourceReason` - Claude-only, per-turn: `'auto'` (user/usage selected) or `'limit'` (forced `claude --print` fallback because a plan window hit its limit)
- `validated` - boolean; user marked the entry as reviewed
- `cueTriggerName`, `cueEventType`, `cueSourceSession` - populated on a `CUE` entry for a subscription's own run; identify the subscription, event, and upstream agent that triggered it. Absent on a `CUE` entry written by a Cue-started `maestro-cli send`
- `hostname` - set when history is shared across machines

To find one entry, grep its id. To scan recent work by hand, read the last lines and sort by `timestamp` (file order is finish order). Use `summary` for quick triage and `fullResponse` when you need detail.

## Task Recall (history JSON)

Your session history is stored at `{{AGENT_HISTORY_PATH}}` as a JSON file with this envelope:

```json
{
	"version": 1,
	"sessionId": "<provider session id>",
	"projectPath": "<absolute path>",
	"entries": [
		/* HistoryEntry[], newest entries appended last; not pre-sorted */
	]
}
```

Each `entries[]` element has the following fields (optional unless marked required):

- `id` _(required, string)_ — UUID for the entry
- `type` _(required, `'AUTO' | 'USER' | 'CUE'`)_ — `AUTO` = Auto Run, `USER` = interactive turn, `CUE` = triggered by a Cue subscription
- `timestamp` _(required, number)_ — Unix milliseconds when the entry was written
- `summary` _(required, string)_ — short description of the task / response
- `projectPath` _(required, string)_ — absolute path of the working directory at the time
- `fullResponse` — complete AI response text; pull this when you need full context, not just the summary
- `agentSessionId` — Maestro agent UUID (the in-app session container)
- `sessionId` — provider session id (e.g. Claude Code's resume id)
- `sessionName` — human-readable agent/tab name
- `success` — boolean; whether the run completed without error
- `elapsedTimeMs` — wall-clock duration of the run
- `contextUsage` — context window usage percentage at completion (0–100)
- `usageStats` — `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd }`
- `validated` — boolean; user marked the entry as reviewed
- `cueTriggerName`, `cueEventType`, `cueSourceSession` — populated when `type === 'CUE'`; identify the subscription, event, and upstream agent that triggered the run
- `hostname` — set when history is shared across machines

To recall recent work, read the file, sort `entries` by `timestamp` descending, and scan from the top. Use `summary` for quick triage and `fullResponse` when you need detail.

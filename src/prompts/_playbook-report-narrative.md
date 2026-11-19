<!--
The narrative contract of a playbook run report. Included by playbook-report-document and playbook-report-synthesis, so both answer in the shape Maestro parses (the Director's Notes narrative, version 1).
-->

### The narrative

Write the narrative as ONE JSON object in a `json` code fence, with this exact shape:

```json
{
	"version": 1,
	"sections": [
		{
			"kind": "accomplishments",
			"title": "Accomplishments",
			"items": [{ "text": "What the run finished, in one sentence", "severity": "info" }]
		},
		{
			"kind": "challenges",
			"title": "Challenges",
			"items": [{ "text": "What went wrong or is still risky", "severity": "warn" }]
		},
		{
			"kind": "nextSteps",
			"title": "Next Steps",
			"items": [{ "text": "A follow-up the user should do", "severity": "info" }]
		}
	]
}
```

Rules:

- `version` is the number `1`.
- Keep the three sections in this order. A section with nothing to say has an empty `items` array.
- Every item has a `text` string. `severity` is optional: `"info"`, `"warn"`, or `"critical"`. Use `"critical"` only for work that failed.
- Do not set `agent` on items. The report is about one run.
- State only what the facts, the file list, and the task synopses support. Do not invent files, commands, or results.
- Write for the person who started the run: plain words, one fact per bullet, no filler.

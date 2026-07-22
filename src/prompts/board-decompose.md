You are decomposing a single high-level Board card ("triage" card) into a small, sensible graph of concrete child cards. Each child card is a unit of work another agent will pick up and run.

## The card to decompose

Title: {{CARD_TITLE}}

Body:
{{CARD_BODY}}

## Your job

Normally, break this card into between 2 and 6 child cards (the single-card exception below is the only time fewer is allowed). Each child must be:

- Concrete and independently actionable (a single, well-scoped piece of work).
- Ordered by real dependencies. If child B needs child A's output, list A as a dependency of B.
- Titled in an imperative voice (e.g. "Add the migration", "Wire the API handler").

Prefer fewer, larger cards over many tiny ones. Do NOT invent work that is not implied by the card. If the card is already atomic and cannot be meaningfully split, return a single child card that restates it.

## Output format

Respond with ONLY a fenced code block tagged `json` containing an array of child cards. Nothing before or after the block. Each element:

```json
[
	{
		"title": "Short imperative title",
		"body": "One or two sentences of concrete instructions for the agent that runs this card.",
		"dependsOn": []
	},
	{
		"title": "Second task that needs the first",
		"body": "Instructions.",
		"dependsOn": [0]
	}
]
```

Rules for the array:

- `dependsOn` holds zero or more zero-based indices of OTHER cards in this same array that must finish first. Never reference an index that does not exist, and never reference a card's own index.
- Keep the graph acyclic: dependencies must always point to earlier, independent work.
- Output valid JSON only inside the block. No comments, no trailing commas.

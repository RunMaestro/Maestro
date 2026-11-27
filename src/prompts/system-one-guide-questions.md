# System One: writing instructions and criteria

A question has four parts: an **id** you choose (it is not sent to the engine), a **type** (`noul`, `choice` or `score`), **instructions** (the question itself), and **criteria** (what yes and no mean for a noul, the options of a choice, the ordered levels of a score).

| You need              | Type     | Verb for one question |
| --------------------- | -------- | --------------------- |
| Is this true?         | `noul`   | `s1 yes`              |
| Which one of these?   | `choice` | `s1 pick`             |
| Where on this rubric? | `score`  | `s1 rate`             |

## Rules that come from measured failures

1. **Literal reading.** The engine answers the words, not the intent. Scoping words, negations and implied conditions are taken at face value. Write the exact condition. Put boundary cases in the criteria. Split an interpretation into two literal questions.
2. **Atomic.** A broad question hides several judgments behind one number. "Is this spam?" becomes: does it request a credential? does the sender's name conflict with its domain? does it announce an unexpected reward? Then weigh the answers in code. Atomic is not "one fact per question": a bounded choice between actions is one judgment. Split dimensions that are useful on their own; do not split a relationship you need judged whole.
3. **Name the field.** With an object state, write the path in backticks: `ticket.messages[0].text`. But **never rely on a position in a long list.** `items[137]` mis-locates: measured 2026-09-18, 27% of answers were wrong at 150 items in a request, and 9% at 25. Key the object (`items.k137`) or put the item inside the question. Both scored 0 wrong of 320. `s1 rank` puts each candidate inside its own question.
4. **Align instructions and criteria.** A noul where `true` means "no" confuses the engine. The criteria extend the instructions in the same direction.
5. **Contrasting options.** For a choice, say what each option covers and what belongs to its neighbor instead. Use the same field names on every option.
6. **Situations, not degrees.** Each level of a score is matched against the state by itself. The engine does not see the level numbers or the neighboring levels. "Cosmetic; no functional impact" works. "1" and "moderate" do not.
7. **Cover the space.** Add `other` or `none` to a choice when an input may not fit. The engine cannot pick a value you did not offer.
8. **Keep math out.** Counting, dates, magnitudes, hex colors: compute in code and hand over the semantic part ("does this color read as a warning?").
9. **Less state.** Send only what the question needs. Retrieve and filter first.

## On the command line

```bash
maestro-cli s1 ask -s @report.txt \
  --noul refund 'Does the message request a refund?' true="asks for money back or a credit" false="complains without asking for a remedy" \
  --choice team 'Which team should handle it?' billing="Charges, invoices, refunds" orders="Status, delivery, returns" other \
  --score severity 'How severe is the bug?' "Cosmetic; no functional impact" "Broken, workaround exists" "Blocking; no workaround"
```

- A question flag is `ID INSTRUCTIONS` and then its criteria. `ID=INSTRUCTIONS` in one word reads the same way.
- An id names one question. The same id twice is refused.
- A word that starts with a dash cannot follow a question flag: it would be read as a flag. Pass such a question with `--questions-json` or `--questions-file`.
- Single-quote any instructions that contain backticks.

## As JSON

`--questions-json`, `--questions-file` and `s1 ask -f request.json` take the same shapes:

```json
{
	"refund": {
		"type": "noul",
		"instructions": "Does `msg` request a refund?",
		"criteria": {
			"true": "asks for money back or a credit",
			"false": "complains without asking for a remedy"
		}
	},
	"team": {
		"type": "choice",
		"instructions": "Which team should handle `msg`?",
		"criteria": {
			"billing": "charges, invoices, refunds",
			"orders": "status, delivery, returns",
			"other": null
		}
	},
	"severity": {
		"type": "score",
		"instructions": "How severe is the bug in `report`?",
		"criteria": [
			"Cosmetic; no functional impact",
			"Broken, workaround exists",
			"Blocking; no workaround"
		]
	}
}
```

A whole request for `-f` is `{ "state": ..., "questions": { ... } }`.

## Structure in place of a sentence

Instructions, an option's description, a level, and a noul's `true` and `false` may each be a JSON object or list in place of a string. The keys are labels the engine reads, so use short descriptive names. On the command line, a value that is JSON is parsed.

```json
{
	"return_policy": {
		"what": "rules for returns in general",
		"not_for": "the status of one return",
		"examples": ["Can I return sale items?"]
	},
	"return_status": {
		"what": "where one return is",
		"not_for": "general policy questions",
		"examples": ["Where is my refund for order A-104?"]
	}
}
```

Start with strings. Add structure when two options keep getting confused, or a level needs examples. An example helps only when it looks like a real input.

## Before you trust a new question

Run it on a handful of cases whose answer you know. When one fails, find out which of four things failed before you change the wording: the state lacked the evidence, the engine was wrong, your code read the answer wrong, or the request failed.

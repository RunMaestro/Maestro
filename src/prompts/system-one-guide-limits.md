# System One: engines, limits, the budget, the cache, exit codes

## Engines

The user chooses one engine in Maestro. Every answer names it: on the line under the answer, and in `engine`, `engineLabel` and `calibrated` with `--json`.

| Engine        | What it is                       | Calibrated | Speed and cost                                                                    |
| ------------- | -------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `jev-cloud`   | TypeSafe's hosted Jev            | Yes        | About 250 ms a request. $0.042 per million input tokens. Output is free.          |
| `openjev`     | A Jev server the user runs       | Yes        | The user's own hardware. No price.                                                |
| `local-judge` | A general model on this computer | **No**     | Seconds a question. One question a request. No confidence on a choice or a score. |

On the hosted engine a 1,000 token item costs $0.00004, and a thousand of them cost four cents.

## What one request holds

| Limit                                         | Value                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| The state and its longest question            | 32,388 tokens (107,500 characters of English), measured 2026-09-20 |
| Everything in one request                     | 64,000 tokens                                                      |
| Questions in one request                      | 250                                                                |
| Options of a choice                           | 255                                                                |
| Levels of a score                             | 2 to 10                                                            |
| Candidates of one `rank`, rows of one `batch` | 5,000                                                              |

- English runs 3.32 characters a token. `maestro-cli s1 cost` counts for you and sends nothing.
- `rank` and `batch` split a job into requests by themselves: 250 questions and about 30,000 tokens a request, four requests at a time. On the local judge they send one question a request.
- More than 5,000 items is more than one call. Run the job in parts.

## Time

One request has 30 seconds. The CLI waits as long as the job can take; `--timeout <seconds>` changes that.

Your shell tool may stop a command before a large `rank` or `batch` ends. The desktop goes on with the job, and every answer it gets is cached. Run the same command again to collect the answers at no cost.

## The budget

- Agents share one daily budget, set by the user. An agent may also have its own cap. The day starts at local midnight.
- The engine line under every answer ends with the day's spend against the budget: `$0.0123 of $1.00 today`.
- A request over the budget is refused by name and sends nothing: `System One's budget for today is spent ... Continue without System One.` Do that. Do not retry.
- `maestro-cli s1 usage` shows the spend per agent. `maestro-cli s1 cost` prices a job before you run it.

## The cache

Every answer is kept for 7 days, keyed on the engine, the model, the state and the questions. The same request again costs nothing, sends nothing, and says `cached answer` on the engine line. `--no-cache` asks the engine again.

The cache is why a second run of a failed or cut-off job is cheap: only what has no answer yet is asked.

## Whether a job finished

`rank` prints one marker as the LAST line of standard output:

```text
End s1 rank: 320/320 candidates judged in 2 request(s); 10 shown.
INCOMPLETE s1 rank: 250/320 candidates judged; 1 request(s) failed (...) Unjudged candidates are UNKNOWN, not irrelevant.
```

`batch` prints JSONL, one row per input row, and a last row that says the same:

```text
{ "line": 3, "id": "a7", "answers": { "relevant": { "type": "noul", "probability": 0.91 } }, "cached": false }
{ "line": 4, "error": { "code": "timeout", "message": "..." } }
{ "_end": { "rows": 40, "ok": 39, "errors": 1, "complete": false, "marker": "INCOMPLETE s1 batch: ..." } }
```

- An item with no answer is UNKNOWN. It is never a low score and never a no.
- No marker means the output was cut off. `--json` carries `completeness` and, on a `rank`, `unjudged` (the keys with no answer).
- `batch --out file.jsonl` writes the rows to a file and prints only the summary. Use it for a large job, so the rows do not enter your context.

## Exit codes

| Exit    | Meaning                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------- |
| 0       | Yes; or an answer at or above `--min-confidence`; or a job that judged everything.                  |
| 1       | `yes`: no, or uncertain inside `--band`. `pick`, `rate`: under `--min-confidence`. Never a failure. |
| 2       | The command line or the request is wrong.                                                           |
| 3, 4, 5 | The Maestro desktop app is not running, is too old for the verb, or did not answer in time.         |
| 6       | Refused: System One is off, or the budget is spent. Go on without it.                               |
| 7       | No answer: the engine failed, or a `rank` or `batch` is INCOMPLETE.                                 |

## Where the output goes

The answer goes to standard output. The engine line goes to standard error. So `$(maestro-cli s1 yes ...)` holds `0.930 yes` and nothing else, and you still see the engine in your terminal. With `--json`, everything is one JSON document on standard output, and a failure is `{ "success": false, "error": "..." }`.

## What Maestro keeps

- **The key stays in Maestro.** No verb prints it and no flag takes one. You cannot name the model, the engine or the budget from the command line.
- **Each request is recorded** under your agent and tab: the verb, the question ids, the answers, the tokens, the cost. The text of the state is kept only if the user turned that on.
- **Secret-shaped text is removed** from the state and the questions before they are sent.

## When System One is off

A verb then refuses with a message that starts `System One is off`, names the switch, and exits 6: no engine is chosen, the engine has not passed its Test, the user switched off agent use, or switched it off for this agent. None of these is yours to change. Do the work without System One.

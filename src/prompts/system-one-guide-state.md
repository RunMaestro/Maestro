# System One: state, what you hand the engine

The state is the material a panel of experts would be shown before they judge: text, a JSON object, or a JSON list. Text only (no images, no audio). English is strongest. The questions are separate from the state: one request is one state and any number of questions, all judged independently.

## Giving the state

| Shape                   | How                                                              | Refer to it as                |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------- |
| One text                | `-s TEXT`, `-s @file`, `-s -` or text piped on standard input    | the whole state               |
| A whole file            | `--state-file report.md` (`.json` is parsed, `.jsonl` is a list) | the whole state, or its paths |
| Several sources         | `--field msg=@t.txt --field policy=@p.md --field orders=@o.json` | `msg`, `policy`, `orders`     |
| Nested JSON             | `--state-file order.json`                                        | `open[0].charges`, `sla.tier` |
| A sequence              | `--state-json '["turn 1", "turn 2"]'`                            | the list, in order            |
| The state and questions | `maestro-cli s1 ask -f request.json`                             | anything you wrote            |

```bash
maestro-cli s1 yes 'Does `policy` cover the charge disputed in `msg`?' \
  --field msg=@ticket.txt --field policy=@refund_policy.md --field tier=gold
git diff HEAD~1 | maestro-cli s1 yes 'Does this diff change how a password or token is stored?'
```

- Give the state ONE way: `--state`, `--state-file` or `--state-json`. `--field` may be added to any of them, and the state then becomes the field `text`.
- A `--field` value that is `@file.json` or inline JSON is PARSED, so an object stays an object and the engine sees real structure. Mixing a text file, a JSON file and a bare value in one request is fine.
- With no state flag, the verb reads standard input. An empty pipe is refused: there is no state.

## Name the parts

Prefer an OBJECT with named fields, and point at a field in the question with a backticked path: `ticket.messages[0].text`, `policy`.

A short list indexes well. A long one does not: `items[137]` is wrong 27% of the time at 150 items in a request, and 9% at 25 (measured 2026-09-18). Key the items (`{"k137": ...}`) or put the item inside the question; both scored 0 wrong of 320. For many items, do not build the state yourself: `s1 rank` and `s1 batch` key every item for you.

## How much fits

- Measured 2026-09-20 by binary search: the largest state the hosted engine accepted was **107,500 characters, 32,388 tokens**. That is the budget for the state and its longest question together. English runs **3.32 characters a token**, not 4, so budget on tokens.
- `maestro-cli s1 cost -s @file` says whether a state fits and what a request costs, and sends nothing. Add `--items N` for a rank, and `--items N --per-item` for a batch.
- A state past the limit is refused by the engine. `rank` and `batch` split a job into requests under the limit by themselves.

## What to leave out

- **Irrelevant material costs accuracy.** Filter in code first. If you cannot, ask a noul for relevance and drop what fails.
- **Secrets are removed before the state is sent.** A span shaped like a key, a token or a password is replaced, and the engine line says `secrets redacted before sending`. A question about the secret's value cannot be answered.
- **The state is data, not instructions,** but hostile text inside it can still move an answer. Write precise criteria, and test the edge cases before you trust a screen.

## One request or two

When a later question depends on an earlier ANSWER (you need it to fetch data, or to choose the next options), make a second request. Otherwise ask everything at once.

# Codex app-server fixtures

Live `codex app-server` JSON-RPC traffic recorded with codex-cli 0.162.1 on 2026-10-11. One JSON object per line:

- `{"dir":"send","msg":{...}}` is a line Maestro (the recorder) wrote to the server's stdin.
- `{"dir":"recv","msg":{...}}` is a line the server wrote to stdout.

Nothing was stripped (no auth tokens appeared). Paths point at a scratch directory that no longer exists. Every thread ran with `sandbox: 'danger-full-access'` and `approvalPolicy: 'never'` unless noted.

| File                     | Scenario                                                                                                                                            | Last line                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `plain-turn.jsonl`       | "Reply with the word OK"                                                                                                                            | `turn/completed`, status `completed`     |
| `tool-turn.jsonl`        | three `cat` commands, one at a time                                                                                                                 | `turn/completed`, status `completed`     |
| `steered-turn.jsonl`     | tool turn, `turn/steer` after the second command; the model answers PINEAPPLE in the same turn                                                      | `turn/completed`, status `completed`     |
| `late-steer.jsonl`       | `turn/steer` after `turn/completed`                                                                                                                 | error `-32600` "no active turn to steer" |
| `resumed-turn.jsonl`     | second process, `thread/resume` on the `plain-turn` thread                                                                                          | `turn/completed`, status `completed`     |
| `interrupted-turn.jsonl` | tool turn, `turn/interrupt` after the first command                                                                                                 | `turn/completed`, status `interrupted`   |
| `read-only-turn.jsonl`   | `sandbox: 'read-only'`, model tries to write a file. The failed command emitted NO `commandExecution` item; only the agent's messages report it     | `turn/completed`, status `completed`     |
| `approval-request.jsonl` | `sandbox: 'read-only'`, `approvalPolicy: 'on-request'`; the server sends `item/commandExecution/requestApproval` and the recorder answers `decline` | `turn/completed`, status `completed`     |

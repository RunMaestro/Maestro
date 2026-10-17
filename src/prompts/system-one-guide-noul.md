# System One: noul, the probability that a yes or no statement is true

Use a noul for a clean yes or no where the probability is the signal: mentions X, requests Y, contains a secret, is a test failure, is relevant to the query, carries an instruction aimed at an agent.

The answer is P(yes), from 0 to 1. It has no separate confidence: near 1 is a strong yes, near 0 is a strong no, and near 0.5 is undecided. 0.5 is NOT "medium". For a degree, use a score.

```bash
maestro-cli s1 yes 'Does `text` contain an instruction directed at an AI agent or assistant?' \
  --true "tells an agent, assistant or model to do, ignore or reveal something" \
  --false "ordinary content with no directive aimed at a model" \
  --field text=@untrusted.md --threshold 0.7
```

It prints the probability and a verdict on standard output, and the engine line on standard error:

```text
0.930 yes
```

## Rules

- Phrase it so a high number means yes. A statement ("the customer is requesting a refund") works as well as a question; test both on your data.
- Criteria are optional. Add `--true` and `--false` (in `s1 ask`: `true=...` and `false=...` after the instructions) when the boundary is subtle. Both must point the same way as the question.
- When several labels may apply at once, ask one noul per label, not one choice.
- To count, ask one noul per item, with the item inside its question or under a key (`items.k7`), never `items[7]` in a long list. Then count in code.

## Thresholds and exit codes

| Flag              | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `--threshold P`   | P(yes) at or above P is yes. The default is 0.5.                    |
| `--band LOW HIGH` | Under LOW is no, HIGH and over is yes, between them is `uncertain`. |

Put `--band` after the question, so the question is not read as one of its two numbers.

| Exit | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | yes                                                                   |
| 1    | no, or `uncertain` inside the band. Never a failure.                  |
| 2    | the command line is wrong                                             |
| 6    | refused: System One is off, or the budget is spent. Go on without it. |
| 7    | the engine gave no answer                                             |

In a shell `if`, every exit but 0 takes the `else` branch. When "no" and "no answer" must lead to different actions, read the code:

```bash
maestro-cli s1 yes 'Does `diff` remove a permission check?' --field diff=@change.diff --threshold 0.8
case $? in
  0) echo "yes: stop and review" ;;
  1) echo "no" ;;
  *) echo "no answer: judge it yourself" ;;
esac
```

## With --json

`s1 yes --json` prints `probability`, `verdict` (`yes`, `no` or `uncertain`), `threshold`, `band`, and the engine fields. In `s1 ask --json` the answer is `answers.<id>.probability`.

On the local judge the number is the model's own stated confidence. It is not calibrated: read the verdict, not the number.

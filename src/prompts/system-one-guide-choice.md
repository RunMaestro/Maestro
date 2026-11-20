# System One: choice, one option from a set you define

Use a choice when the answer is one of a known set with NO order between the options: routing, a category, a language, an entity type, which candidate span is the value. A choice takes up to 255 options. One more option costs a few tokens, so give the FULL list, not a shortlist.

```bash
maestro-cli s1 pick 'Which team should handle this?' \
  returns="Exchanges, refunds, wrong or damaged items" \
  shipping="Delivery status, delays, lost packages" \
  billing="Charges, invoices, payment problems" other \
  -s "My shoes came in the wrong size and I was charged twice" --min-confidence 0.4
```

An option is `NAME` or `NAME=description`. A name alone is enough when it explains itself.

The answer is the most likely option, the probability of every option (they sum to 1), and a confidence that says how peaked that distribution is:

```text
returns  conf=0.62  [returns 0.60, billing 0.38, shipping 0.01, other 0.01]
```

Read the runner-up. 0.60 against 0.38 means two teams want this ticket.

## Rules

- **Describe each option against its neighbor.** For two options that keep getting confused, give each a JSON object with the same fields: what it covers, what it is not for, and one to three examples.
- **Cover the space.** Add `other` or `none` when an input may not fit the list. The engine cannot pick a value you did not offer.
- **A choice is relative.** It says WHICH option is best even when every option is bad. Add a `none` option, or pair the choice with one noul per option, to learn whether ANY option fits.
- **A deep taxonomy** is one choice per level, with the children of the chosen branch as the next options. Walk it in code, and keep more than one branch alive when the probabilities are close.
- **A speculative choice is fine.** "If this is a return, why?" can be asked of every ticket in the same request. Ignore the answer when the ticket was not a return.
- Several labels at once is not a choice. Ask one noul per label.

## Confidence and exit codes

`--min-confidence P` makes `pick` exit 1 when the confidence is under P, and print `uncertain` with the best option:

```text
uncertain  best=returns  conf=0.35 < 0.4  [returns 0.41, billing 0.39, shipping 0.15, other 0.05]
```

Low confidence means there is no clear winner, or there are several acceptable answers. The second is harmless.

Exit 0 is an answer at or above `--min-confidence`. Exit 1 is an answer under it. 2, 6 and 7 are a wrong command line, a refusal, and no answer, as on every asking verb.

The local judge names one option and reports no probabilities and no confidence. `--min-confidence` above 0 can then never be met: the verb prints the option, says why, and exits 1.

## With --json

`s1 pick --json` prints `choice`, `confidence`, `probabilities` (an object of option to probability), `verdict` (`ok` or `uncertain`) and `minConfidence`, with the engine fields. In `s1 ask --json` the answer is `answers.<id>` with `choice`, `probabilities` and `confidence`.

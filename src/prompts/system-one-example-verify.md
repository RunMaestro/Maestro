# Recipe: check a claim against its source, or a draft against a rule

System One is an independent model. Use it to check your own output before you hand it over.

## A claim against its source

```bash
maestro-cli s1 ask --field claim="$CLAIM" --field source=@source.md \
  --choice support 'How does `source` relate to `claim`?' \
      supports="the source states the claim, or the claim follows directly from it" \
      contradicts="the source states the opposite, or a fact that cannot be true together with the claim" \
      silent="the source does not address the claim" \
  --json
```

Act on it in code: `supports` with a confidence of 0.8 or more stands. `contradicts` is fixed or removed. `silent`, or a low confidence, is a claim you have not sourced: find the source, or say that it is unverified.

Many claims against one source is one request, with each claim inside its own question:

```bash
maestro-cli s1 rank --query @source.md --candidates-file claims.txt \
  --instructions 'Does `query` state `candidate`, or does `candidate` follow directly from `query`?' --json
```

Each result is keyed by the line number of its claim. A claim under your threshold needs a second look.

## A draft against a rule

```bash
maestro-cli s1 ask --field draft=@reply.md --field rules=@style_rules.md \
  --noul breaks 'Does `draft` break a rule stated in `rules`?' \
  --noul promises 'Does `draft` promise a date or a result that the author cannot guarantee?' \
  --score tone 'How formal is `draft`?' "Casual" "Neutral" "Formal"
```

## A command against its intent

```bash
maestro-cli s1 ask --field intent="$TASK" --field command="$CMD" \
  --noul matches 'Does `command` do what `intent` asks, and nothing more?' \
  --score reach 'What is the widest effect `command` can have?' \
      "Reads only" "Changes files inside the project" "Changes files outside the project, or deletes" "Sends data out, or cannot be undone"
```

- One judgment per question. "Is the draft good?" is not a question.
- A rule that can be checked exactly (a banned word, a length) is `grep` or `wc`, not System One.
- A check that passes is evidence that the output is sound. A destructive or outward-facing command still needs the user's confirmation.
- Send only the part of the source that could hold the answer. A whole repository as the source lowers accuracy and may not fit.

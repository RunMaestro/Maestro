# Recipe: classify one item, and ask every follow-up in the same request

One state, every question the workflow might need, one call. The questions are judged independently, so the ones that matter only on some branches cost almost nothing.

```bash
maestro-cli s1 ask --field issue=@issue.md --field areas='["auth", "billing", "editor", "sync"]' \
  --choice kind 'What is `issue`?' \
      bug="Something that worked or should work does not" \
      feature="A request for behavior that does not exist yet" \
      question="The author asks how to do something that already works" \
      other \
  --choice area 'Which one of `areas` does `issue` concern most?' auth billing editor sync none \
  --noul repro 'Does `issue` give steps that would reproduce the problem?' \
  --noul security 'Does `issue` describe a way to read, change or run something without permission?' \
  --score severity 'How bad is the effect that `issue` describes?' \
      "Cosmetic; nothing is blocked" \
      "A feature is broken, and a workaround exists" \
      "A feature is broken, with no workaround" \
      "Data is lost or exposed" \
  --json
```

Then decide in code, with thresholds you own:

```bash
maestro-cli s1 ask --field issue=@issue.md --questions-file triage.json --json > answer.json
jq -r '
  .answers as $a
  | if $a.security.probability >= 0.5 then "escalate: possible security report"
    elif ($a.kind.confidence // 0) < 0.6 then "ask the user: unclear kind"
    elif $a.kind.choice == "bug" and $a.repro.probability < 0.4 then "bug: ask for steps"
    else "\($a.kind.choice) in \($a.area.choice), severity \($a.severity.score)"
    end
' answer.json
```

- Read `repro` only on the bug branch. Ignore the answers a branch does not need.
- Keep the questions in a file (`--questions-file triage.json`) once they work, so a person can review them in one place. The shape is in `maestro-cli s1 guide questions`.
- `confidence` is absent on the local judge. The `// 0` above then sends every item to the user, which is the safe reading of a number that was not given.
- For many issues, the same questions over a file of rows is `maestro-cli s1 batch`.

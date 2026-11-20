# Recipe: one yes or no, usable in a shell if

```bash
# The simplest form. Exit 0 is yes, so it sits in an if.
if maestro-cli s1 yes 'Does `text` describe a test that failed?' --field text="$OUTPUT" --threshold 0.7; then
  echo "a test failed"
fi

# Piped text is the state. No backticks in the question, so double quotes are safe.
git diff --cached | maestro-cli s1 yes "Does this diff add a call that sends data to a remote host?"

# Say what yes and no mean when the boundary is subtle.
maestro-cli s1 yes 'Is `commit` a fix for a security flaw?' -s @commit.txt \
  --true "closes a way to read, change or run something without permission" \
  --false "a routine bug fix, a refactor, or a dependency bump with no stated flaw"

# Three bands in one call: under 0.3 is no, 0.7 and over is yes, between them is uncertain.
maestro-cli s1 yes 'Is this command safe to run without asking the user?' -s "$CMD" --band 0.3 0.7
```

In a plain `if`, a refusal (exit 6) and a failed request (exit 7) take the `else` branch, the same as a no (exit 1). When the `else` branch does something that matters, read the code:

```bash
maestro-cli s1 yes 'Does `diff` remove a permission check?' --field diff=@change.diff --threshold 0.8
case $? in
  0) echo "yes: stop and show the user" ;;
  1) echo "no" ;;
  *) echo "no answer: read the diff yourself" ;;
esac
```

- The first line of output is the answer (`0.930 yes`). The line under it names the engine. When it says `not calibrated`, read the verdict and not the number.
- A lint is not a judgment. "Does the text contain the word TODO?" is `grep`. Use `s1 yes` for what `grep` cannot decide.
- A yes from System One is evidence. It is never the user's permission.

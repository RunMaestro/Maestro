# Recipe: rank or filter many candidates against a query

`rank` asks one question per candidate, with the candidate inside its question, and packs the questions into as few requests as fit. You never read the candidates into your context.

```bash
# Lines of a file. Each result is keyed by its LINE NUMBER, counted from 1.
maestro-cli s1 rank --query "commits that fix a security flaw" --candidates-file commits.txt --min 0.6

# A JSON list of objects. Each result is keyed by the item's own id.
maestro-cli s1 rank --query "a bug that can lose user data" --candidates-file issues.json --id-key number --top 10 --json

# Standard input, graded on a rubric in place of yes or no.
ls docs | maestro-cli s1 rank --query "pages about keyboard shortcuts" \
  --levels "unrelated" "mentions it in passing" "directly about it"

# Your own question. Call the item `candidate` and the query `query`.
maestro-cli s1 rank --query "$Q" --candidates-file files.txt \
  --instructions 'Does `candidate` name a file that would hold the code for `query`?'

# Shared background for every judgment.
maestro-cli s1 rank --query "violates the style guide" --candidates-file sentences.txt --context @style_guide.md
```

The output is one row per candidate, best first, and a last line that says whether the job finished:

```text
0.957  17  Fix path traversal in archive extraction
0.911  4   Reject unsigned plugin manifests
0.640  31  Bump the TLS library to a patched release
End s1 rank: 40/40 candidates judged in 1 request(s); 3 shown.
```

To write only the keys to a file:

```bash
maestro-cli s1 rank --query "commits that fix a security flaw" --candidates-file commits.txt --min 0.6 --json \
  | jq -r 'if .completeness.complete then .results[].key else error(.completeness.marker) end' > security.txt
```

- **Read the last line.** `End s1 rank: N/N candidates judged` means every candidate was judged. `INCOMPLETE s1 rank:` (exit 7) means some were not: they are UNKNOWN, not irrelevant. Run the same command again; what was judged is cached and free. No marker means your output was cut off.
- `--min` and `--top` choose what is shown. They do not change what is judged.
- A ranking always has a first place. When nothing may fit, use `--min`, or judge the top few again with more context (`maestro-cli s1 ask`).
- More than 5,000 candidates is more than one call. Make a shortlist first with `grep` or by file name.
- `maestro-cli s1 cost --items 800 -s "$Q"` prices the job before you run it.

# System One: patterns that turn single judgments into a workflow

1. **Ask everything at once.** Put every question the workflow might need in one `s1 ask`, including the ones that matter only on some branches. They are judged in parallel and independently. The vendor measured 13 questions in one request as 12 times cheaper and 10 times faster than 13 requests, with the same answers. Your code decides which answers count.

2. **Gate on confidence.** The answer says WHAT. The confidence says WHETHER to act. Give each action its own threshold by what it costs to be wrong (`maestro-cli s1 guide confidence`).

3. **Score in parts, weigh in code.** Break a judgment into atomic scores, divide each by its top level, and weigh them in code. The weights can be reviewed and tuned without a second request.

4. **Route by intent.** A cheap classifier in front of expensive handlers: code for one intent, your own reasoning for another, the user for the low-confidence rest.

5. **Select, do not generate.** Find the candidate spans or values with a regex or with your own reading, then let System One CHOOSE the right one. Extraction becomes a choice over listed options with an explicit "not stated". Check the coverage: it cannot choose a value you did not offer.

6. **Rerank and filter.** A cheap search (`grep`, file names, an embedding search) makes a shortlist, and one question per candidate grades it. `s1 rank` does this in one request per 250 candidates.

   ```bash
   grep -rl "retry" src | maestro-cli s1 rank --query "code that retries a failed network request with backoff" --top 10
   ```

7. **Verify and escalate.** Check a claim against its source (supports, contradicts, says nothing), an extraction against the document, a command against its stated intent. Low confidence goes to the user or to your own careful reading. In a cascade, the cheap step extracts, System One verifies, and you reason only over the uncertain slice.

8. **Screen.** One request per untrusted text: a set of nouls (an instruction aimed at an agent? a request for a credential? a link that does not match its label?) and a severity score. The thresholds live in your code: pass, review or stop. A screen lowers a risk. It never makes a text safe to obey.

9. **Map, then reduce.** Thousands of items and the same questions is `s1 batch`. Aggregate the JSONL in code:

   ```bash
   maestro-cli s1 batch --input findings.jsonl --state-key text --out judged.jsonl \
     --noul exploitable 'Does `text` describe a flaw an outside attacker can reach?' \
     --score severity 'How bad is the worst outcome of `text`?' "Nuisance" "Data exposed" "Code runs or money moves"
   jq -r 'select(.answers.exploitable.probability >= 0.7) | [.line, .answers.severity.score] | @tsv' judged.jsonl
   ```

10. **Select in two stages.** Rank everything cheaply, then judge the top few again with fuller evidence, and let the second stage reject all of them. A ranking always has a first place, even when nothing fits.

## What stays in code

Known rules, arithmetic, exact lookups and the action itself. An "any serious violation blocks" rule is separate conditions, not a weight in a sum. Keep what System One INFERRED apart from what you OBSERVED, and do not apply an old answer to a state that has changed.

## What stays with you

System One does not plan, explain or write. Use it for the narrow judgments inside your work, and keep the reasoning.

# Recipe: find the items that say the same thing

"The same" is a judgment, not a string match: two reports of one bug in different words, two notes on one decision, two findings with one root cause.

## Is this new item already there?

The new item is the query. The existing items are the candidates.

```bash
maestro-cli s1 rank --query @new_issue.md --candidates-file open_issues.json --id-key number --min 0.7 \
  --instructions 'Does `candidate` report the same underlying problem as `query`?' \
  --true "the same root cause or the same requested change, even in different words" \
  --false "the same area or the same feature, but a different problem"
```

No row above the threshold, with an `End s1 rank:` marker, means no duplicate was found. An `INCOMPLETE` marker means some candidates were never compared.

## Which items in one list are duplicates of each other?

Do not ask about every pair. N items make N x N / 2 pairs.

1. **Shortlist in code.** Pair only items that could be the same: the same file, the same label, a shared rare word, or neighbors in an embedding search.
2. **Write one row per pair**, with both items inside the row and an id that names the pair:

   ```text
   {"id": "12~31", "a": "Crash when the archive holds a path with ..", "b": "Extracting a zip can write outside the folder"}
   {"id": "12~40", "a": "Crash when the archive holds a path with ..", "b": "Dark theme: unreadable link color"}
   ```

3. **Ask the same question of every row:**

   ```bash
   maestro-cli s1 batch --input pairs.jsonl --out same.jsonl \
     --noul same 'Do `a` and `b` describe the same underlying problem?' \
         true="one root cause; fixing one would fix the other" \
         false="related or in the same area, but each needs its own fix"
   jq -r 'select(.answers.same.probability >= 0.8) | .id' same.jsonl
   tail -n 1 same.jsonl
   ```

4. **Merge in code.** Treat each pair that passed as a link, and group the linked items. Do not ask System One to count the groups or to pick the survivor by arithmetic.

## Rules

- Both items go INSIDE the row, under names (`a`, `b`). Never send the whole list as the state and ask about `items[12]` and `items[31]`: a position in a long list is mis-read (27% wrong at 150 items, measured).
- "The same" needs a definition. Say what makes two items one (`true=`) and what only makes them neighbors (`false=`), or near-duplicates and same-topic items blur.
- Sameness is not always transitive. When A matches B and B matches C but A does not match C, look at the group before you merge it.
- Check the `_end` row. A pair with an `error` was not compared: it is UNKNOWN, not "different".
- Merging or deleting is destructive. Use a high threshold, and show the user the groups before you act.

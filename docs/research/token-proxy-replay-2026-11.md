---
type: research
title: Token proxy replay over real Claude Code transcripts
created: 2026-11-11
tags:
  - token-proxy
  - local-models
related:
  - '[[local-models]]'
---

# Token proxy replay, 2026-11

The token proxy compressors, replayed offline over real Claude Code transcripts by
`token-proxy-replay.test.ts`. Each tool result was decided by `compressRequestBody()` itself, once
with the `full` profile (a result the model has already read, `compress` mode) and once with the
`complete` profile (a fresh result, `compress-early` mode). The model tier was stubbed to
`skipped`, so these are the heuristics alone.

## The run

- Transcripts modified from 2026-11-05 to 2026-11-11 (the last 14 days, newest first, capped at 3.0 GB).
- Files read: 3,202 (149 of them subagent transcripts), 3.0 GB. 3,596 older files in the window were left out by the byte cap.
- Sessions: 3,053 distinct session ids. Each file is one context for the repeat and cost figures (a subagent has its own).
- Tool results with text: 30,597. Results with no text (images only) are left out: 892. A tool use id is counted once, even where a resumed session copied it.
- Tokens are estimated at 4 characters per token (`estimateTokenCount()`), the proxy's own estimate.
- Repeat figures are upper bounds: the replay cannot see what a session had compacted away, so an
  earlier result it counts against may no longer have been in the context.
- The replay took 0.3 minutes.

## 1. Volume by tool

| Bucket     | Results | Tokens     | Share of tokens | Cost units  | Share of cost |
| ---------- | ------- | ---------- | --------------- | ----------- | ------------- |
| Bash       | 25,752  | 14,496,712 | 75.2%           | 92,340,692  | 81.6%         |
| Read       | 1,091   | 2,971,566  | 15.4%           | 13,415,727  | 11.9%         |
| Grep       | 127     | 51,282     | 0.3%            | 81,754      | 0.1%          |
| Glob       | 3       | 74         | 0.0%            | 116         | 0.0%          |
| Edit/Write | 2,262   | 88,891     | 0.5%            | 575,382     | 0.5%          |
| Web        | 472     | 434,530    | 2.3%            | 1,357,095   | 1.2%          |
| Task       | 161     | 299,443    | 1.6%            | 1,723,058   | 1.5%          |
| mcp        | 628     | 928,619    | 4.8%            | 3,660,211   | 3.2%          |
| other      | 101     | 11,658     | 0.1%            | 45,039      | 0.0%          |
| All        | 30,597  | 19,282,775 | 100.0%          | 113,199,073 | 100.0%        |

## 2. Volume by size

| Result size       | Results | Tokens     | Share of tokens | Share of cost |
| ----------------- | ------- | ---------- | --------------- | ------------- |
| under 1000 tokens | 25,131  | 6,021,832  | 31.2%           | 36.7%         |
| 1000 to 8000      | 5,350   | 12,029,315 | 62.4%           | 58.4%         |
| 8000 or more      | 116     | 1,231,628  | 6.4%            | 4.9%          |

Results under 1000 tokens are never touched by either profile. Results of 8000 or more are the ones the model tier would be offered after the heuristics.

## 3. What each profile saves

### Profile `full` (compress: the result was already read)

| Bucket     | Eligible results | Eligible tokens | Shortened | Kept  | Tokens saved | Tokens after | Saved of eligible | Saved of all | Cost after  | Cost saved |
| ---------- | ---------------- | --------------- | --------- | ----- | ------------ | ------------ | ----------------- | ------------ | ----------- | ---------- |
| Bash       | 3,965            | 8,729,481       | 94        | 3,871 | 79,730       | 8,649,751    | 0.9%              | 0.5%         | 92,219,440  | 0.1%       |
| Read       | 591              | 2,711,241       | 5         | 586   | 10,444       | 2,700,797    | 0.4%              | 0.4%         | 13,430,502  | -0.1%      |
| Grep       | 16               | 21,254          | 2         | 14    | 1,371        | 19,883       | 6.5%              | 2.7%         | 81,880      | -0.2%      |
| Glob       | 0                | 0               | 0         | 0     | 0            | 0            | 0.0%              | 0.0%         | 116         | 0.0%       |
| Edit/Write | 0                | 0               | 0         | 0     | 0            | 0            | 0.0%              | 0.0%         | 575,382     | 0.0%       |
| Web        | 117              | 176,159         | 0         | 117   | 0            | 176,159      | 0.0%              | 0.0%         | 1,357,095   | 0.0%       |
| Task       | 131              | 280,658         | 0         | 131   | 0            | 280,658      | 0.0%              | 0.0%         | 1,723,058   | 0.0%       |
| mcp        | 306              | 779,933         | 26        | 280   | 34,706       | 745,227      | 4.4%              | 3.7%         | 3,631,105   | 0.8%       |
| other      | 4                | 5,368           | 0         | 4     | 0            | 5,368        | 0.0%              | 0.0%         | 45,039      | 0.0%       |
| All        | 5,130            | 12,704,094      | 127       | 5,003 | 126,251      | 12,577,843   | 1.0%              | 0.7%         | 113,063,617 | 0.1%       |

Tokens saved by compressor, `full` (a block several compressors shortened is listed under their combination):

| Compressors     | Blocks | Bash   | Read   | Grep  | Glob | Edit/Write | Web | Task | mcp    | other | All    |
| --------------- | ------ | ------ | ------ | ----- | ---- | ---------- | --- | ---- | ------ | ----- | ------ |
| long-lines      | 44     | 29,324 | 10,444 | 0     | 0    | 0          | 0   | 0    | 4,533  | 0     | 44,301 |
| search          | 52     | 35,764 | 0      | 1,371 | 0    | 0          | 0   | 0    | 0      | 0     | 37,135 |
| json            | 15     | 3,828  | 0      | 0     | 0    | 0          | 0   | 0    | 28,699 | 0     | 32,527 |
| logs            | 12     | 8,387  | 0      | 0     | 0    | 0          | 0   | 0    | 782    | 0     | 9,169  |
| logs+long-lines | 4      | 2,427  | 0      | 0     | 0    | 0          | 0   | 0    | 692    | 0     | 3,119  |

### Profile `complete` (compress-early: the result is fresh)

| Bucket     | Eligible results | Eligible tokens | Shortened | Kept  | Tokens saved | Tokens after | Saved of eligible | Saved of all | Cost after  | Cost saved |
| ---------- | ---------------- | --------------- | --------- | ----- | ------------ | ------------ | ----------------- | ------------ | ----------- | ---------- |
| Bash       | 3,965            | 8,729,481       | 12        | 3,953 | 8,636        | 8,720,845    | 0.1%              | 0.1%         | 92,289,283  | 0.1%       |
| Read       | 591              | 2,711,241       | 0         | 591   | 0            | 2,711,241    | 0.0%              | 0.0%         | 13,415,727  | 0.0%       |
| Grep       | 16               | 21,254          | 0         | 16    | 0            | 21,254       | 0.0%              | 0.0%         | 81,754      | 0.0%       |
| Glob       | 0                | 0               | 0         | 0     | 0            | 0            | 0.0%              | 0.0%         | 116         | 0.0%       |
| Edit/Write | 0                | 0               | 0         | 0     | 0            | 0            | 0.0%              | 0.0%         | 575,382     | 0.0%       |
| Web        | 117              | 176,159         | 0         | 117   | 0            | 176,159      | 0.0%              | 0.0%         | 1,357,095   | 0.0%       |
| Task       | 131              | 280,658         | 0         | 131   | 0            | 280,658      | 0.0%              | 0.0%         | 1,723,058   | 0.0%       |
| mcp        | 306              | 779,933         | 2         | 304   | 1,071        | 778,862      | 0.1%              | 0.1%         | 3,656,986   | 0.1%       |
| other      | 4                | 5,368           | 0         | 4     | 0            | 5,368        | 0.0%              | 0.0%         | 45,039      | 0.0%       |
| All        | 5,130            | 12,704,094      | 14        | 5,116 | 9,707        | 12,694,387   | 0.1%              | 0.1%         | 113,144,440 | 0.0%       |

Tokens saved by compressor, `complete` (a block several compressors shortened is listed under their combination):

| Compressors | Blocks | Bash  | Read | Grep | Glob | Edit/Write | Web | Task | mcp   | other | All   |
| ----------- | ------ | ----- | ---- | ---- | ---- | ---------- | --- | ---- | ----- | ----- | ----- |
| logs        | 13     | 8,387 | 0    | 0    | 0    | 0          | 0   | 0    | 1,071 | 0     | 9,458 |
| json        | 1      | 249   | 0    | 0    | 0    | 0          | 0   | 0    | 0     | 0     | 249   |

## 4. Repeats inside one session

Results whose text equals an earlier result in the same transcript:

| Bucket     | Repeats | Tokens | Share of the bucket tokens | Cost units |
| ---------- | ------- | ------ | -------------------------- | ---------- |
| Bash       | 578     | 6,624  | 0.0%                       | 97,199     |
| Read       | 1       | 25     | 0.0%                       | 174        |
| Grep       | 2       | 8      | 0.0%                       | 12         |
| Glob       | 0       | 0      | 0.0%                       | 0          |
| Edit/Write | 842     | 28,969 | 32.6%                      | 178,490    |
| Web        | 2       | 108    | 0.0%                       | 972        |
| Task       | 1       | 45     | 0.0%                       | 191        |
| mcp        | 1       | 34     | 0.0%                       | 114        |
| other      | 3       | 135    | 1.2%                       | 467        |
| All        | 1,430   | 35,948 | 0.2%                       | 277,620    |

Read results for a file already read in that session. "Contained" means every numbered line
(line number and text both equal) is in one earlier Read result of that file:

| Re-read   | Results | Tokens  | Share of Read tokens | Cost units | After an Edit or Write | Tokens after an edit |
| --------- | ------- | ------- | -------------------- | ---------- | ---------------------- | -------------------- |
| identical | 0       | 0       | 0.0%                 | 0          | 0                      | 0                    |
| contained | 5       | 4,713   | 0.2%                 | 23,806     | 1                      | 1,298                |
| neither   | 179     | 442,738 | 14.9%                | 2,191,344  | 32                     | 28,315               |

## 5. Prompt cost units

For each result, L is the number of later assistant messages in its transcript, stopping at a
compaction. Before: `tokens x (1.25 + 0.1 x L)`, one cache write and one cache read per later
request. `complete`: the same formula over the shortened tokens. `full`: the result goes out whole
once and shortened from the next request on, so `1.25 x tokens + after x (1.25 + 0.1 x (L - 1))`
when it was shortened and L is 2 or more, and the passthrough cost otherwise. Units are one
uncached input token.

| Bucket     | Before      | After `full` | Saved `full` | After `complete` | Saved `complete` |
| ---------- | ----------- | ------------ | ------------ | ---------------- | ---------------- |
| Bash       | 92,340,692  | 92,219,440   | 0.1%         | 92,289,283       | 0.1%             |
| Read       | 13,415,727  | 13,430,502   | -0.1%        | 13,415,727       | 0.0%             |
| Grep       | 81,754      | 81,880       | -0.2%        | 81,754           | 0.0%             |
| Glob       | 116         | 116          | 0.0%         | 116              | 0.0%             |
| Edit/Write | 575,382     | 575,382      | 0.0%         | 575,382          | 0.0%             |
| Web        | 1,357,095   | 1,357,095    | 0.0%         | 1,357,095        | 0.0%             |
| Task       | 1,723,058   | 1,723,058    | 0.0%         | 1,723,058        | 0.0%             |
| mcp        | 3,660,211   | 3,631,105    | 0.8%         | 3,656,986        | 0.1%             |
| other      | 45,039      | 45,039       | 0.0%         | 45,039           | 0.0%             |
| All        | 113,199,073 | 113,063,617  | 0.1%         | 113,144,440      | 0.0%             |

## 6. Figures for the candidates

Raw bounds the next section reads. Extensions were classified during the replay; only counts are kept.

| Figure                                                                              | Results | Tokens    | Share of all tokens | Cost units |
| ----------------------------------------------------------------------------------- | ------- | --------- | ------------------- | ---------- |
| Read results of markdown or text files                                              | 536     | 1,646,564 | 8.5%                | 6,340,223  |
| the same, 1000 tokens or more                                                       | 263     | 1,502,068 | 7.8%                | 6,021,718  |
| Read results of 1000 tokens or more that neither profile shortens, markdown or text | 258     | 1,459,630 | 7.6%                | 5,942,621  |
| Read results of 1000 tokens or more that neither profile shortens, other files      | 328     | 1,209,173 | 6.3%                | 6,515,308  |
| Results of 8000 tokens or more                                                      | 116     | 1,231,628 | 6.4%                | 5,499,245  |

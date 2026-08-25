---
type: reference
title: A Cappella Routing Evaluation
created: 2026-08-15
tags:
  - acappella
  - architecture
  - routing
  - conductor
related:
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
---

# A Cappella Routing Evaluation

Routing is the only part of A Cappella that can be confidently wrong. Every other failure announces
itself: a dead microphone produces no transcript, a missing model refuses to start, a broken voice
says nothing. A misroute produces a completed turn, a spoken confirmation, and a prompt sitting in
the wrong repository. So routing quality has to be a measured number rather than a feeling, and this
document is where that number lives.

## What is measured, and where

Three separate things get called "routing quality", and they are measured in three different places.
Conflating them is how a router with a 60% hit rate ends up described as working.

| Layer             | Question it answers                                        | Where it is measured                   |
| ----------------- | ---------------------------------------------------------- | -------------------------------------- |
| Decision rules    | Given a decision, does the router do the right thing?      | `src/__tests__/main/acappella/router/` |
| Model in the loop | Given an utterance, does the Brain pick the right target?  | The script below, run by hand          |
| Field             | Over real use, how often does the user have to correct it? | The routing log (`routingQuality()`)   |

The first is deterministic and runs in CI. The second needs a real model and a real roster. The
third accumulates on its own once people are talking to it.

## The routing log is the field instrument

`src/main/acappella/router/routing-log.ts` records every turn: the utterance, the serialized size of
the context the Brain saw, the decision, the confidence, the latency, and what became of it. The
outcome is what makes the number honest:

- `dispatched` - it landed, and the user let it stand.
- `corrected` - it landed and the user moved it. **A miss**, even though nothing errored.
- `clarified` - the router asked instead of guessing. **Neither**, and excluded from the hit rate:
  asking is the correct behaviour below the confidence threshold, and counting it either way makes
  the threshold impossible to tune.
- `failed` - the dispatch could not be performed at all.

`hitRate = dispatched / (dispatched + corrected)`. Read it with
`window.maestro.voice.routingLog()`, or from the `acappella:routing-log` IPC channel.

## The evaluation script

Fifteen utterances against a fixed roster of four agents and twelve tabs. The set is deliberately
weighted toward the cases that are ambiguous rather than the ones that are obvious: a script of
fifteen "tell the backend agent to run the tests" would score 100% and prove nothing.

It runs headless. `scripts/acappella-routing-eval.ts` encodes the roster and the script below and
drives the real `createConductorRouter` against a real Brain:

```bash
npm run acappella:eval                          # the Conductor-agent Brain
npm run acappella:eval -- --brain anthropic     # ANTHROPIC_API_KEY
npm run acappella:eval -- --brain openai        # OPENAI_API_KEY
npm run acappella:eval -- --brain local --model-path /path/to/qwen3-1.7b.gguf
```

This was originally written down as a microphone session with four live agents, which is the wrong
instrument for the thing being measured. Routing takes a TRANSCRIPT and a ROSTER, both of which are
data; speaking the script aloud adds speech recognition and four real agents as uncontrolled
variables and makes the result unrepeatable. Everything below the Brain in the harness is shipping
code - the prompt from `src/prompts/acappella-router.md` (read through `initializePrompts()`, so a
local edit is what gets measured), `parseRouteDecision`, the grammar validator, the recall ranker,
the confidence and recall policies, and the routing log itself - so the only thing being varied is
the model. The harness plays the user who corrects a misroute: a decision that misses its
expectation is marked `corrected` in the log, exactly as the HUD's correction control does, so
`routingQuality()` produces the reported number rather than a second tally beside it.

An unusable Brain fails once, before the script starts, rather than fifteen times inside the results
table. That is how the local tier reports itself in a checkout without the native runtime.

### The fixture roster

| Agent      | Type        | Project path         | Tabs                                                               |
| ---------- | ----------- | -------------------- | ------------------------------------------------------------------ |
| `Backend`  | claude-code | `/repo/payments-api` | Auth Refactor (active), DB Migrations, Rate Limit Spike (snoozed)  |
| `API`      | codex       | `/repo/gateway`      | Gateway Routing (active), Webhook Retries, Old Auth Spike (closed) |
| `Frontend` | claude-code | `/repo/web`          | Sidebar Collapse (active), Checkout Flow, Dark Mode                |
| `Infra`    | opencode    | `/repo/terraform`    | Cluster Upgrade (active), Cost Report, Log Retention               |

### The utterances

| #   | Utterance                                        | Expected target | Expected action    | Tests                    |
| --- | ------------------------------------------------ | --------------- | ------------------ | ------------------------ |
| 1   | "run the tests"                                  | active agent    | `current`          | same-topic continuation  |
| 2   | "what broke"                                     | active agent    | `current`          | pronoun-free follow-up   |
| 3   | "add a rate limiter to the public endpoints"     | Backend         | `new`              | topic switch             |
| 4   | "ask the frontend agent about the checkout flow" | Frontend        | `recall`           | explicit agent naming    |
| 5   | "tell infra to bump the cluster version"         | Infra           | `current`          | explicit agent naming    |
| 6   | "back to the auth thing"                         | Backend         | `recall`           | vague recall             |
| 7   | "what did we decide about webhook retries"       | API             | `recall`           | recall by topic          |
| 8   | "the gateway one"                                | API             | `current`          | recall by project path   |
| 9   | "pick up that rate limit spike again"            | Backend         | `recall` (snoozed) | snoozed-tab wake         |
| 10  | "go back to the old auth spike"                  | API             | `recall` (closed)  | closed-tab reopen offer  |
| 11  | "how many agents do I have running"              | conductor       | -                  | Maestro-level question   |
| 12  | "which one is busy right now"                    | conductor       | -                  | fleet-level question     |
| 13  | "make the dark mode toggle stick"                | Frontend        | `recall`           | topic match over recency |
| 14  | "do the auth one"                                | ambiguous       | clarification      | low confidence           |
| 15  | "no, the other one"                              | -               | correction         | correction path          |

Utterance 14 is the interesting one: with an "Auth Refactor" tab on Backend and an "Old Auth Spike"
tab on API, the correct behaviour is a spoken "Backend or API?" rather than a coin flip. Which agent
the router leaned toward while asking is deliberately NOT scored - when it is right to be unsure,
penalising the lean would penalise the behaviour the threshold exists to produce. The harness then
routes the answer ("the backend one") with `clarification` set, which is the round trip that stops a
two-word reply from becoming a tab called "the backend one". Utterance 15 is not routed at all: it is
recognised from the utterance alone and turned into a correction plan.

Fourteen of the fifteen are routed and scored. Utterance 15 is a recognition check, and the
disambiguation answer is reported beside the script rather than inside it.

Record each run as a new row below, with the date and the Brain, so a prompt change or a model swap
can be compared against what came before rather than argued about.

## Results

### Deterministic layer

Green as of 2026-08-15, inside a whole-repo run of 37,762 tests. 102 assertions across
`grammar.test.ts`, `conductor-router.test.ts`, `tab-recall.test.ts`, `routing-context.test.ts`,
`routing-log.test.ts` and `conductor-agent.test.ts`, plus the executor and session-service suites.
This layer proves the router's rules, not the model's judgement: every case in it is driven by a
scripted Brain, so a 100% pass says the decision handling is correct and says nothing about whether a
real model would have produced those decisions.

### Model in the loop

| Date       | Brain             | Hits  | Corrections | Clarifications | Hit rate | Mean latency |
| ---------- | ----------------- | ----- | ----------- | -------------- | -------- | ------------ |
| 2026-08-15 | `conductor-agent` | 10/14 | 3           | 2              | 77%      | 5485 ms      |
| 2026-08-15 | `conductor-agent` | 11/14 | 2           | 2              | 85%      | 6703 ms      |
| 2026-08-15 | `conductor-agent` | 10/14 | 3           | 2              | 77%      | 5854 ms      |

Three runs of the Conductor-agent Brain (Claude Code, `--output-format json`, read-only). "Hits" is
`dispatched` from the routing log; the script matched 11, 12 and 11 of its fourteen expectations, and
the two counts differ because a correct clarification is a hit for the script and neither for the hit
rate.

Two misses are reproducible across all three runs, and they are the reason for running this at all:

- **"add a rate limiter to the public endpoints"** (expected `new`) recalls the snoozed
  `Rate Limit Spike` tab every time, at 0.60. The agent is right; the tab is not. A NEW request that
  shares words with an abandoned conversation is currently pulled into it, because nothing in the
  prompt says that a tab's topic being ABOUT a subject is weaker evidence than the utterance being a
  fresh instruction. This is the most useful finding here and it is a prompt fix, not a code fix.
- **"the gateway one"** (expected a confident `current` on API) lands on API but asks, at 0.40. The
  target is right every time and only the confidence is under the threshold. Defensible behaviour for
  a three-word fragment, and arguably the script's expectation is the thing that is wrong; recorded
  rather than tuned away, because a threshold moved to make a table look better is a threshold that
  is no longer measuring anything.

One miss is a threshold flake: "ask the frontend agent about the checkout flow" scored 0.50 on the
third run and 0.90 on the other two, so it asked once for an utterance that names its agent out loud.

**Latency is the headline.** 5.5 to 6.7 seconds mean, with individual turns to 20 s. That is an order
of magnitude outside the routing budget in [[latency-baseline]], and it is the expected cost of this
tier: a full agent run is being paid for a classification. The Conductor-agent Brain is for people who
want routing that reasons about their projects and will accept the wait for it. Voice-paced routing is
the local and hosted tiers, and their numbers belong in the table above before any claim about
A Cappella's felt latency is made.

**Not yet measured: the local and hosted tiers, and shape parity between them.** Both fail closed
here and say so:

```
Routing evaluation failed: Qwen3 1.7B (local) is not usable here:
  llama.cpp (Conductor Brain) is not part of this build yet.
Routing evaluation failed: Anthropic (hosted) is not usable here:
  No Anthropic API key is configured.
```

`node-llama-cpp` is loaded dynamically and is not installed in this checkout, and no hosted key is
configured. Filling those rows in needs the native runtime plus the Qwen3 1.7B GGUF for the first and
one API key for the second; the harness needs nothing else, and each run is about ninety seconds.
What to look for when they are run:

1. **Shape parity.** The local grammar-constrained Brain and a hosted Brain must produce the same
   decision SHAPE for the same input - the same `target`, `tabAction`, and `tabId` - even where their
   confidences differ. Divergence here means the prompt reads differently to the two models, and that
   is a prompt bug rather than a model difference. Run both with `--json` and diff the `results`
   arrays.
2. **Latency per Brain.** Routing sits between a finished sentence and anything visible happening, so
   it is felt directly. The routing log records `latencyMs` per turn; `routingQuality().meanLatencyMs`
   aggregates it. Compare against the per-hop budget in [[latency-baseline]].

A caveat that belongs on every row: the Conductor-agent Brain is not deterministic, so a single run is
a sample rather than a score. Three runs moved between 77% and 85% on fourteen utterances with no code
change between them. Read a one-row difference as noise; read a reproducible per-utterance miss, like
the rate-limiter one above, as a finding.

## Tuning

`DEFAULT_CONFIDENCE_THRESHOLD` in `src/main/acappella/router/conductor-router.ts` is 0.55. It is the
one number worth moving once there is field data, and the log is arranged to make that decidable:

- Many `corrected` entries with a confidence above the threshold means the threshold is too low - the
  router is acting on beliefs it should be checking.
- Many `clarified` entries the user answers with the router's own first guess means it is too high -
  it is asking questions whose answer it already had.

The routing prompt itself is `src/prompts/acappella-router.md`, editable in Settings > Maestro
Prompts. Someone whose agents are all called "api" can teach the Conductor how to tell them apart
without touching the code, and the log is how they find out whether it worked.

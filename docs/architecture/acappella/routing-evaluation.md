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
tab on API, the correct behaviour is a spoken "Backend or API?" rather than a coin flip. Utterance 15
is not routed at all - it is recognised as a correction of whatever 14 resolved to.

### Running it

1. Open four agents matching the fixture roster and create the twelve tabs. Snooze
   `Rate Limit Spike`; close `Old Auth Spike`.
2. Configure the Brain under test in Settings > Plugins > A Cappella > Voice Providers.
3. Start a voice session and read the fifteen lines out loud, pausing for each dispatch.
4. Read the numbers back with `window.maestro.voice.routingLog()`.
5. Repeat for the other Brain, comparing the `targetSessionId` / `tabAction` pairs turn for turn.

Record each run as a new row below, with the date and the Brain, so a prompt change or a model swap
can be compared against what came before rather than argued about.

## Results

### Deterministic layer

Green as of 2026-08-15. 102 assertions across `grammar.test.ts`, `conductor-router.test.ts`,
`tab-recall.test.ts`, `routing-context.test.ts`, `routing-log.test.ts` and `conductor-agent.test.ts`,
plus the executor and session-service suites. This layer proves the router's rules, not the model's
judgement: every case
in it is driven by a scripted Brain, so a 100% pass says the decision handling is correct and says
nothing about whether a real model would have produced those decisions.

### Model in the loop

| Date | Brain | Hits | Corrections | Clarifications | Hit rate | Mean latency |
| ---- | ----- | ---- | ----------- | -------------- | -------- | ------------ |
| -    | -     | -    | -           | -              | -        | -            |

**Not yet run.** It needs a machine with the Qwen3 1.7B model downloaded, a hosted API key, four real
agents, and a microphone - none of which exist in a CI or worktree environment, and the numbers would
be fabricated rather than measured if this table were filled in from anywhere else. The script above
is the whole procedure; a run takes about fifteen minutes.

Two things to confirm during that run, both of which are the point of doing it at all:

1. **Shape parity.** The local grammar-constrained Brain and a hosted Brain must produce the same
   decision SHAPE for the same input - the same `target`, `tabAction`, and `tabId` - even where their
   confidences differ. Divergence here means the prompt reads differently to the two models, and that
   is a prompt bug rather than a model difference.
2. **Latency per Brain.** Routing sits between a finished sentence and anything visible happening, so
   it is felt directly. The routing log records `latencyMs` per turn; `routingQuality().meanLatencyMs`
   aggregates it. Compare against the per-hop budget in [[latency-baseline]].

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

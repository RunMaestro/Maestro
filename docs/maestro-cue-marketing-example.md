---
title: 'Case Study: Maestro Marketing Pipeline'
description: How @RunMaestroAI's eight-chain Cue pipeline runs a self-tuning Twitter marketing loop in production.
icon: megaphone
---

This is a real production pipeline - the one driving the [@RunMaestroAI](https://x.com/RunMaestroAI) X account. It's also a working implementation of the [Karpathy Loop case study](/maestro-cue-karpathy-loop), built before that doc was written, in a domain (marketing) where the feedback signal is external (audience CTR) instead of synthetic (an evaluator agent's score).

The point of this doc: show what the loop looks like when it grows up. The toy Karpathy Loop has three chains. This pipeline has eight. The extra five are what production-readiness costs you, and each one is a pattern worth knowing.

## The Shape

Eight chains, one pipeline, one agent across all of them. Schedules are illustrative:

| #   | Chain                 | Trigger                                  | Role                                                                                        |
| --- | --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | **Discover**          | `time.scheduled` 3×/day                  | Scan X for posts matching active campaigns; write candidates to `opportunities/<date>.md`   |
| 2   | **Draft**             | `file.changed` on `opportunities/*.md`   | Convert candidates into reply drafts; write to `drafts/pending/`                            |
| 3   | **Post**              | `file.changed` on `drafts/approved/*.md` | Human-approved drafts get posted; append to `posted_log.jsonl`                              |
| 4   | **Measure**           | `time.scheduled` daily 10am              | Pull views/likes/clicks per posted reply; update `engagement_metrics.md`                    |
| 5   | **Campaign Council**  | `time.scheduled` Sunday 6pm              | 14-day per-campaign review; write recommendations to `campaigns/COUNCIL_<date>.md`          |
| 6   | **Adapt**             | `time.scheduled` Monday 9am              | Fold Council recs into `strategy_evolution.md`; edit auto-tunable sections of `STRATEGY.md` |
| 7   | **Enrich Dossiers**   | `time.scheduled` daily 11pm              | Append observed signals to `people/<handle>.yaml`                                           |
| 8   | **Refresh Dashboard** | `time.scheduled` 4×/day                  | Regenerate `dashboard.html` from current state                                              |

Chains 4, 5, and 6 are the Karpathy Loop. The rest are the _work_ (1, 2, 3, 7) and the _visibility surface_ (8) that make the loop apply to something real.

## Mapping Onto the Karpathy Loop

| Karpathy Loop role                                   | This pipeline                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `program.md` (intent + criteria + improvement rules) | `STRATEGY.md` (voice formula, KPIs, hard rules, posture table) + `PATTERN_ANALYSIS.md` (the static record of reply archetypes and topic tiers) |
| Agent run (produce output)                           | Discover → Draft → Post                                                                                                                        |
| Evaluator                                            | **Measure** - computes per-reply CTR and rolling-7d aggregates by tier × archetype × differentiator                                            |
| Analyst                                              | **Campaign Council** - weekly per-campaign 14d review with KEEP/PAUSE/DEAD recommendations and 2-4 new-campaign candidates                     |
| Applier                                              | **Adapt** - folds Council into `strategy_evolution.md` and surgically edits the `(auto-tunable)` sections of `STRATEGY.md`                     |
| Human approval                                       | `drafts/approved/` (manual promotion) and `campaigns/*.yaml` status flips (Adapt is told "do NOT edit - Pedram's call")                        |
| Audit log                                            | `strategy_evolution.md` + git                                                                                                                  |

## Patterns Worth Borrowing

These are the production-hardening moves the eight-chain shape encodes. Most of them are mechanical and you can lift them directly.

### 1. `(auto-tunable)` section markers in the program

Instead of hardcoding "the applier may edit Strategies and Improvement Loop but not Objective and Constraints" in the applier's prompt, mark the editable sections **in the program file itself**:

```markdown
# STRATEGY.md

## Hard Rules

(immutable - Adapt never touches this)

- ...

## Voice Formula (auto-tunable)

- ...

## Currently-Favored Differentiators (auto-tunable)

- ...

## Posture (auto-tunable, phase-gated)

| Phase | Description |
```

Then the Adapt prompt is just: _"Edit STRATEGY.md. Be surgical: only the sections marked `(auto-tunable)`. Do NOT touch the Hard Rules section."_

Two benefits over the case study's approach: (a) the boundary lives next to the thing it's bounding, so anyone reading `STRATEGY.md` sees what's safe to change, and (b) extending the auto-tunable surface is a one-character edit, not a prompt change.

### 2. Two-tier evaluation

The case study scores at one level: did _this run_ meet the criteria? Production marketing has a coarser unit too: did _this campaign_ (a thematic bundle of runs) earn its slot over the last two weeks?

- **Measure** runs daily and scores per-reply. Fine-grained, fresh.
- **Campaign Council** runs weekly and scores per-campaign over a 14-day window. Coarse-grained, statistically meaningful.

Adapt reads both. Demoting an under-performing differentiator is a per-reply decision; killing a campaign is a per-campaign decision. Different scales, different cadences, both feed the same applier.

### 3. Mine "skipped" outputs for new program elements

The case study's analyst can only adjust how existing criteria are weighted. Council does something richer: it mines the **Skipped** sections of recent opportunities files (candidates the Discover chain found but rejected as off-strategy) for recurring handles and themes.

> "Recurring competitor handles in Skipped sections of `opportunities/*.md` over the last 14 days. Any handle that appears ≥ 3 times in Skipped notes is a candidate audience."

This is how the loop notices _what it should be doing that it isn't_. A pure-feedback loop can only optimize the current strategy; this lets the loop propose new strategic surface area. Worth copying any time your discovery step has a meaningful concept of "rejected because off-strategy" - those rejections are the highest-signal data you have.

### 4. Two-strikes graduation

Council uses a two-step graduation rule:

> **DEAD** if `pause` was recommended on this campaign in the prior COUNCIL report AND no new posts since.

A campaign isn't killed on its first bad week - it's flagged for pause, given a week to catch a fresh trigger, and only killed if it still doesn't. This is the same logic the case study's `program.md` could enforce ("if actionability scores decline, add a So what? section _first_; only restructure objectives after two consecutive weeks of decline") but Council bakes the staging into the analyst itself rather than relying on the applier to remember.

### 5. Insufficient-data no-op

> "If <5 replies measured in the window, write a 'no-op, insufficient data' entry to strategy_evolution.md and exit without editing STRATEGY.md."

This is the discipline the case study's _Cost Control_ section gestures at, done properly. The applier _must_ tolerate small samples without acting on noise. The no-op entry is still logged - so you can see "yes, the loop fired this week, but there wasn't enough signal to do anything" - which is different from "the loop didn't fire."

### 6. Async filesystem handoff between chains

Council runs Sunday 6pm. Adapt runs Monday 9am. They don't share a session, they don't chain via `agent.completed`, they communicate by:

> Council writes `campaigns/COUNCIL_<date>.md`.
> Adapt reads "the most-recent `campaigns/COUNCIL_*.md`".

This pattern - **dated artifact file as the contract between two scheduled chains** - is restartable, debuggable, and survives the engine restarting between them. If Council fails, Adapt sees the previous week's file and exits early or proceeds with stale recommendations (its choice, encoded in the prompt). If Adapt fails, Council's recommendations are still on disk for next Monday's retry.

Worth using anywhere two chains need to coordinate but you don't want to lose work to a restart. Compare to chaining via `agent.completed`, which is great for tight handoffs but loses the artifact.

### 7. Phase gating

The pipeline runs in three phases - Crawl / Walk / Run - with explicit advancement rules:

> "If current phase is Crawl AND last 4 weeks of T3 replies have median confidence ≥0.75 AND median CTR ≥0.5%, propose advancing to Walk by updating the Posture table. Note the proposal in strategy_evolution.md but do NOT advance phases automatically - flag it for Pedram."

The phase is a single coarse knob the loop _proposes_ tuning but never tunes itself. Useful any time your strategy has discrete regimes (exploration vs. exploitation, beta vs. GA, conservative vs. aggressive). Don't auto-advance - the cost of a premature advancement is much higher than the cost of waiting a week.

### 8. Implicit approval via filesystem actions

The case study uses an explicit `- [ ] Approve this proposal` checkbox. The marketing pipeline uses **promotion-by-move**: drafts live in `drafts/pending/`, and you approve one by moving it to `drafts/approved/` (which is the Post chain's `file.changed` watch path). For campaign status changes, you approve by editing the YAML.

Pros: zero new UI, works with any filesystem, no parsing logic in the applier.
Cons: less self-documenting than a checkbox, no easy way to attach an approval note.

For high-volume approvals (replies, drafts, content), the move pattern wins. For low-volume strategic decisions (promote a criterion, kill a campaign), the checkbox is clearer.

## What's Different From the Textbook Loop

For honesty:

1. **KPI thresholds are hardcoded in the Adapt prompt, not in `STRATEGY.md`.** Meaning the loop can tune _which combos win or lose_ but not _what counts as winning_. This is a deliberate guardrail - moving the goalposts is the failure mode the case study warns about. A "deeper" loop would expose thresholds as auto-tunable; this pipeline intentionally does not.
2. **Continuously-updated table, not append-only JSONL.** `engagement_metrics.md` is recomputed in place rather than per-run scored entries. You lose the ability to query "the scoring from 2026-04-22 in isolation" but you gain a single document the analyst and dashboard can both read. The dashboard partially compensates by surfacing time series.
3. **Approval is implicit, not gated.** No checkbox. Pedram approves by acting (move a draft, flip a YAML field). This is more natural for marketing volume but doesn't generalize as obviously to research/code-review domains.

## When to Use This Shape

Use the eight-chain shape (or something like it) when:

- The agent's output is **acted on externally** (posted, shipped, sent) and the act-step needs a human-approval gate before it fires.
- The KPI is **observable from outside** the agent - audience metrics, CI pass rates, customer-reported issues - not just from an evaluator agent's opinion.
- You have **multiple units of optimization** that need different evaluation cadences (per-reply + per-campaign, per-PR + per-author, per-incident + per-runbook).
- You want a **dashboard** that non-technical stakeholders read.

Stick with the [three-chain Karpathy Loop](/maestro-cue-karpathy-loop) when:

- The agent's output is **consumed by other agents** (or by you reading the transcript).
- The "criterion" is subjective enough that you genuinely need an LLM evaluator scoring it.
- You're the only person who'll ever look at the loop's state.

## Adapting to a Non-Marketing Domain

The shape ports cleanly. The mapping for, say, a **PR-review bot fleet**:

| Marketing chain   | PR-review equivalent                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Discover          | Find new PRs matching active rulesets                                                    |
| Draft             | Generate suggested review comments per PR                                                |
| Post              | Submit reviews (human-approved)                                                          |
| Measure           | Track which suggestions got accepted vs. dismissed                                       |
| Campaign Council  | Per-ruleset weekly review: which rules are landing, which are noise                      |
| Adapt             | Edit the rulebook auto-tunable sections; propose new rules from dismissed-noise patterns |
| Enrich Dossiers   | Append per-author signal - who likes which review style                                  |
| Refresh Dashboard | Regenerate the team-facing rules-health dashboard                                        |

Same shape, same guardrails, different domain. The patterns are the contribution; the marketing-specific content is just the existence proof.

## See Also

- [Case Study: The Karpathy Loop](/maestro-cue-karpathy-loop) - the abstract pattern this pipeline is an instance of.
- [Cue Configuration](/maestro-cue-configuration) - full subscription schema.
- [Cue Advanced Patterns](/maestro-cue-advanced) - fan-in, fan-out, command nodes.
- [@RunMaestroAI](https://x.com/RunMaestroAI) - the account this pipeline drives.

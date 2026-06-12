---
title: 'Case Study: The Karpathy Loop'
description: Build a self-improving agent on top of Cue - score every run, detect drift, propose program edits, apply on approval.
icon: brain
---

This is a case study, not a built-in feature. It shows how to assemble a self-improving agent - sometimes called a **Karpathy Loop**, after Andrej Karpathy's [AutoResearch](https://github.com/karpathy/autoresearch) project - using nothing but existing Cue primitives: `agent.completed` chains, `time.scheduled` triggers, `file.changed` watches, and an agent that can edit markdown files.

The result: an agent guided by a `program.md` file that states its objective and evaluation criteria, evaluated after every run, with periodic trend analysis that drafts proposed program edits for you to approve.

## The Idea

```
program.md (intent)
    ↓
agent runs (produce output)
    ↓
evaluator scores output against program.md criteria
    ↓
analyst detects drift, drafts a proposal
    ↓
you approve → applier edits program.md → loop
```

The substrate Cue gives you for free:

- **Score every run** - an `agent.completed` chain fires an evaluator after each run.
- **Detect drift** - a weekly `time.scheduled` chain reads the score history and drafts proposals.
- **Approval gate** - a `file.changed` watch on the proposals folder fires when you check the approval box.
- **Self-modification** - the applier is just another agent; agents can edit files.

What you give up vs. a purpose-built system: no SQLite query layer, no dashboard for trends, and you have to work around the 5000-char `{{CUE_SOURCE_OUTPUT}}` cap. Workarounds are below.

## The Program File

Every agent in this pattern owns a `program.md` at its project root. The evaluator reads it; the applier edits it. Keep it in git.

```markdown
# Remy Program

## Objective

Monitor the competitive landscape and surface actionable intelligence for Acme Robotics.

## Constraints

- Do not fabricate competitive data.
- Always cite sources.
- Focus on direct competitors only.

## Strategies

- Scan news, SEC filings, and social media daily.
- Cross-reference signals across multiple sources.
- Prioritize signals by potential business impact.

## Evaluation Criteria

- **Signal quality (0.0-1.0):** Are insights specific and sourced?
- **Actionability (0.0-1.0):** Does each insight suggest a concrete next step?
- **Coverage (0.0-1.0):** Are all tracked competitors represented?
- **Timeliness (0.0-1.0):** Are signals surfaced within 24 hours of the event?

## Improvement Loop

- If actionability scores decline, add an explicit "So what?" section to each signal.
- If coverage gaps appear, expand the source list for underrepresented competitors.
- If signal quality drops, tighten sourcing requirements.
```

The **Evaluation Criteria** and **Improvement Loop** sections are what drive the loop. Be specific - vague criteria produce vague evaluations and meaningless trend lines.

## The Pipeline

Three chains in one pipeline. Replace `<remy-agent-id>`, `<evaluator-agent-id>`, `<analyst-agent-id>`, and `<applier-agent-id>` with real agent UUIDs (`maestro-cli list agents`). The four agents can be the same model - they just need separate sessions so their contexts stay clean.

```yaml
# Pipeline: Karpathy Loop - Remy (color: #f59e0b)

subscriptions:
  # ────────────────────────────────────────────────────────────
  # Chain 1: capture full run output to disk
  # Workaround for the 5000-char {{CUE_SOURCE_OUTPUT}} cap.
  # Remy itself writes its full transcript at end-of-run.
  # If Remy is already configured to do this, skip this chain.
  # ────────────────────────────────────────────────────────────

  # ────────────────────────────────────────────────────────────
  # Chain 2: score every run
  # ────────────────────────────────────────────────────────────
  - name: evaluate-remy-run
    pipeline_name: Karpathy Loop - Remy
    event: agent.completed
    source_session: remy
    agent_id: <evaluator-agent-id>
    target_node_key: 6f3d1e92-a2c4-4b71-9e8d-0c5b2a1d4e67
    enabled: true
    prompt: |
      You are evaluating remy's most recent run against its program.md.

      Read these files:
        - ./program.md  (focus on the "Evaluation Criteria" section)
        - ./runs/{{CUE_RUN_ID}}.md  (the full transcript remy wrote at end-of-run)

      Score each criterion in program.md on a 0.0-1.0 scale. Justify
      each score in one sentence, citing the transcript.

      Append exactly one JSON line to ./evaluations.jsonl with this shape:

      {
        "run_id": "{{CUE_RUN_ID}}",
        "timestamp": "{{CUE_EVENT_TIMESTAMP}}",
        "status": "{{CUE_SOURCE_STATUS}}",
        "scores": { "<criterion-name>": <0.0-1.0>, ... },
        "notes": "<one-paragraph rationale>"
      }

      Do not edit program.md. Do not change scoring criteria. Your only
      job is to score and append.

  # ────────────────────────────────────────────────────────────
  # Chain 3: weekly drift analysis → draft a proposal
  # ────────────────────────────────────────────────────────────
  - name: detect-drift-remy
    pipeline_name: Karpathy Loop - Remy
    event: time.scheduled
    schedule_times: ['09:00']
    schedule_days: [mon]
    agent_id: <analyst-agent-id>
    target_node_key: 7e2c8a4b-9d7f-4e3a-b1c5-7f8d2a6e4b93
    enabled: true
    prompt: |
      Read the last 30 days of ./evaluations.jsonl and ./program.md.

      Compute per-criterion 7-day rolling averages. Look for:
        - Any criterion whose 7-day avg dropped more than 15% vs.
          the prior 7-day window.
        - Any criterion whose 7-day avg is consistently below 0.6.
        - Any criterion the evaluator's "notes" repeatedly flag.

      If nothing notable, do nothing - exit quietly.

      If something is notable, draft a proposal at
      ./proposals/{{DATE}}-<short-slug>.md with this exact template:

        ---
        status: pending
        created: {{DATE}}
        ---

        - [ ] Approve this proposal

        ## What changed
        <one-paragraph description of the trend, citing run_ids>

        ## Proposed program.md edit
        <unified diff, exactly as it should be applied>

        ## Rationale
        <why this edit should fix the trend>

      Constraints on what you may propose:
        - You may edit the "Strategies" and "Improvement Loop" sections
          of program.md, and you may adjust numeric thresholds in
          "Evaluation Criteria".
        - You may NOT edit the "Objective" or "Constraints" sections.
          If a trend seems to require an objective/constraint change,
          surface that as a comment in the proposal but do not include
          it in the diff.

  # ────────────────────────────────────────────────────────────
  # Chain 4: apply an approved proposal
  # ────────────────────────────────────────────────────────────
  # task.pending fires on UNCHECKED tasks - we want the transition
  # from unchecked to checked, so we watch the file for changes and
  # the applier inspects the checkbox state itself.
  - name: apply-approved-proposal
    pipeline_name: Karpathy Loop - Remy
    event: file.changed
    watch: 'proposals/*.md'
    agent_id: <applier-agent-id>
    target_node_key: 8a1b9d4e-3c5f-48a2-8e6d-9b1f4c7a2e85
    enabled: true
    prompt: |
      File {{CUE_FILE_PATH}} was {{CUE_FILE_CHANGE_TYPE}}.

      Read the file. If the "Approve this proposal" checkbox is NOT
      checked (`- [ ]`), exit quietly. If it IS checked (`- [x]`)
      and the frontmatter `status:` is still `pending`, apply the
      proposal:

        1. Read ./program.md.
        2. Apply the unified diff from the "Proposed program.md edit"
           section. If the diff doesn't apply cleanly, set the
           proposal's frontmatter `status: failed` with a note
           explaining why, and stop.
        3. If the diff touches the "Objective" or "Constraints"
           sections of program.md, REFUSE. Set the proposal's
           `status: refused` with a note: "Applier is hard-restricted
           from editing Objective/Constraints. Edit program.md
           manually if intentional."
        4. Write the new program.md.
        5. Set the proposal's frontmatter `status: applied` and
           append `applied: {{CUE_EVENT_TIMESTAMP}}`.
        6. Run `git add program.md proposals/ && git commit -m
           "karpathy: apply {{CUE_FILE_NAME}}"` so the change is
           reviewable.

settings:
  timeout_minutes: 15
  max_concurrent: 1
```

## Capturing Full Run Output

Cue's `{{CUE_SOURCE_OUTPUT}}` is sliced to 5000 chars before it reaches the next agent's prompt. That's fine for short transcripts but lossy for the kind of evaluator we want.

**The workaround:** have the upstream agent write its full transcript to a known path at the end of every run. Then the evaluator reads that file directly instead of relying on the template variable.

Add this to Remy's system prompt or its standing instructions:

```markdown
At the end of every run, write a complete transcript of what you did to
`./runs/<run_id>.md` (create the directory if needed). The run_id is
available as the Cue run identifier when you were invoked via Cue.
Include: the task you were given, your reasoning, any tool calls you
made and their results, and your final output.
```

Alternative: use a Command node (`action: command, mode: shell`) to extract the run transcript from Maestro's session history file. The session history JSON lives at the path documented in the [history format reference](https://docs.runmaestro.ai/maestro-cue-advanced).

## The Guardrails Are Load-Bearing

An evaluator that scores its own agent's output, paired with an analyst that proposes program edits, paired with an applier that writes those edits, is a closed loop that can drift into goal-corruption by degree. The evaluator can quietly redefine "good" to mean "what the agent is already doing well." The applier can erode constraints over months in ways no single proposal would obviously warrant.

The four guardrails baked into the pipeline above:

1. **Human-in-the-loop approval.** The applier never runs without a checkbox flip. This is the most important guardrail. Do not automate the checkbox.
2. **Section-level edit restrictions.** The applier hard-refuses edits to `Objective` and `Constraints`. Strategies and thresholds can drift; mission and red lines cannot.
3. **Git as audit log.** Every applied proposal is a commit. Drift is reviewable in `git log program.md`.
4. **Evaluator can't propose.** Chain 2 only scores. Chain 3 only proposes. Chain 4 only applies. No agent does more than one of those three things.

If you remove any of these, the loop stops being a self-improvement system and starts being a goal-corruption engine.

## Cost Control

Chain 2 fires after every run. If Remy runs hourly and your evaluator costs ~$0.10/call, that's ~$72/month per agent just to score. Two ways to throttle:

**Sample by gating with a coin-flip command node.** Insert a Command node between `agent.completed` and the evaluator that exits non-zero ~70% of the time:

```yaml
- name: sample-gate-remy
  pipeline_name: Karpathy Loop - Remy
  event: agent.completed
  source_session: remy
  action: command
  command:
    mode: shell
    shell: '[ $((RANDOM % 10)) -lt 3 ] || exit 1' # ~30% pass rate
  target_node_key: <uuid>
```

Then change the evaluator's trigger to chain off the gate node (set `source_sub: sample-gate-remy`).

**Or schedule evaluations.** Drop chain 2 entirely. Replace it with a `time.scheduled` chain that runs daily, reads the last N entries from your run log, and scores them in a batch.

## What You Give Up vs. a Purpose-Built System

This pattern is a faithful implementation of the loop concept, but a few things a dedicated platform would give you are missing:

- **No SQLite-backed query layer.** `evaluations.jsonl` is fine for one agent; at fleet scale you'd want indexed queries. The analyst handles this by reading the whole file each run - workable up to a few thousand entries.
- **No dashboard.** Trends live in the analyst's weekly report. Maestro's Document Graph can help you navigate proposals + evaluations via `[[wiki]]` links if you author the markdown that way.
- **No program inheritance.** Sentinel models org → team → agent program inheritance. This pattern is single-agent.
- **No automated alignment checks.** The "is the agent actually following program.md" question is implicitly handled by the evaluator scoring against criteria. A dedicated alignment-checker pass (its own chain) is straightforward to add if you want one.

## Adapting the Pattern

The case study uses a research agent ("Remy"), but the loop is the same shape for any agent whose quality is measurable:

- **Code review agent** - criteria: false-positive rate, severity calibration, fix actionability.
- **Daily briefing agent** - criteria: relevance, signal-to-noise, brevity.
- **Triage agent** - criteria: label accuracy, reviewer-suggestion fit, response time.

Swap the evaluator's prompt to reference the new agent's `program.md` and you're done. The analyst and applier are agent-agnostic.

## See Also

- [Case Study: Maestro Marketing Pipeline](/maestro-cue-marketing-example) - what this pattern looks like in production, with eight chains driving the @RunMaestroAI X account.
- [Cue Configuration](/maestro-cue-configuration) - full subscription schema.
- [Cue Advanced Patterns](/maestro-cue-advanced) - fan-in, fan-out, command nodes, template variables.
- [Cue Examples](/maestro-cue-examples) - copy-paste-ready pipelines for common workflows.
- Karpathy's [AutoResearch](https://github.com/karpathy/autoresearch) - the original inspiration.
- [Sentinel](https://github.com/stephanchenette/sentinel) - a standalone implementation of the same idea with a built-in dashboard and SQLite-backed eval store.

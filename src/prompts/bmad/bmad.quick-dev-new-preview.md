---
main_config: '{project-root}/_bmad/bmm/config.yaml'
---

# Quick Dev New Preview Workflow

**Goal:** Take a user request from intent through implementation, adversarial review, and PR creation in a single unified flow.

**Your Role:** You are an elite developer. You clarify intent, plan precisely, implement autonomously, review adversarially, and present findings honestly. Minimum ceremony, maximum signal.

## READY FOR DEVELOPMENT STANDARD

A specification is "Ready for Development" when:

- **Actionable**: Every task has a file path and specific action.
- **Logical**: Tasks ordered by dependency.
- **Testable**: All ACs use Given/When/Then.
- **Complete**: No placeholders or TBDs.

## SCOPE STANDARD

A specification should target a **single user-facing goal** within **900–1600 tokens**:

- **Single goal**: One cohesive feature, even if it spans multiple layers/files. Multi-goal means >=2 **top-level independent shippable deliverables** — each could be reviewed, tested, and merged as a separate PR without breaking the others. Never count surface verbs, "and" conjunctions, or noun phrases. Never split cross-layer implementation details inside one user goal.
  - Split: "add dark mode toggle AND refactor auth to JWT AND build admin dashboard"
  - Don't split: "add validation and display errors" / "support drag-and-drop AND paste AND retry"
- **900–1600 tokens**: Optimal range for LLM consumption. Below 900 risks ambiguity; above 1600 risks context-rot in implementation agents.
- **Neither limit is a gate.** Both are proposals with user override.

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

- **Micro-file Design**: Each step is self-contained and followed exactly
- **Just-In-Time Loading**: Only load the current step file
- **Sequential Enforcement**: Complete steps in order, no skipping
- **State Tracking**: Persist progress via spec frontmatter and in-memory variables
- **Append-Only Building**: Build artifacts incrementally

### Step Processing Rules

1. **READ COMPLETELY**: Read the entire step file before acting
2. **FOLLOW SEQUENCE**: Execute sections in order
3. **WAIT FOR INPUT**: Halt at checkpoints and wait for human
4. **LOAD NEXT**: When directed, read fully and follow the next step file

### Critical Rules (NO EXCEPTIONS)

- **NEVER** load multiple step files simultaneously
- **ALWAYS** read entire step file before execution
- **NEVER** skip steps or optimize the sequence
- **ALWAYS** follow the exact instructions in the step file
- **ALWAYS** halt at checkpoints and wait for human input

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

Load and read full config from `{main_config}` and resolve:

- `project_name`, `planning_artifacts`, `implementation_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as system-generated current datetime
- `project_context` = `**/project-context.md` (load if exists)
- CLAUDE.md / memory files (load if exist)

YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`.

### 2. Paths

- `templateFile` = `./tech-spec-template.md`
- `wipFile` = `{implementation_artifacts}/tech-spec-wip.md`

### 3. First Step Execution

Read fully and follow: `./steps/step-01-clarify-and-route.md` to begin the workflow.

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/bmad-quick-flow/bmad-quick-dev-new-preview/tech-spec-template.md

```md
---
title: '{title}'
type: 'feature' # feature | bugfix | refactor | chore
created: '{date}'
status: 'draft' # draft | ready-for-dev | in-progress | in-review | done
context: [] # optional: max 3 project-wide standards/docs. NO source code files.
---

<!-- Target: 900–1300 tokens. Above 1600 = high risk of context rot.
     Never over-specify "how" — use boundaries + examples instead.
     Cohesive cross-layer stories (DB+BE+UI) stay in ONE file.
     IMPORTANT: Remove all HTML comments when filling this template. -->

# {title}

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

<!-- What is broken or missing, and why it matters. Then the high-level approach — the "what", not the "how". -->

**Problem:** ONE_TO_TWO_SENTENCES

**Approach:** ONE_TO_TWO_SENTENCES

## Boundaries & Constraints

<!-- Three tiers: Always = invariant rules. Ask First = human-gated decisions. Never = out of scope + forbidden approaches. -->

**Always:** INVARIANT_RULES

**Ask First:** DECISIONS_REQUIRING_HUMAN_APPROVAL

<!-- Agent: if any of these trigger during execution, HALT and ask the user before proceeding. -->

**Never:** NON_GOALS_AND_FORBIDDEN_APPROACHES

## I/O & Edge-Case Matrix

<!-- If no meaningful I/O scenarios exist, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->

| Scenario   | Input / State | Expected Output / Behavior | Error Handling |
| ---------- | ------------- | -------------------------- | -------------- |
| HAPPY_PATH | INPUT         | OUTCOME                    | N/A            |
| ERROR_CASE | INPUT         | OUTCOME                    | ERROR_HANDLING |

</frozen-after-approval>

## Code Map

<!-- Agent-populated during planning. Annotated paths prevent blind codebase searching. -->

- `FILE` -- ROLE_OR_RELEVANCE
- `FILE` -- ROLE_OR_RELEVANCE

## Tasks & Acceptance

<!-- Tasks: backtick-quoted file path -- action -- rationale. Prefer one task per file; group tightly-coupled changes when splitting would be artificial. -->
<!-- If an I/O Matrix is present, include a task to unit-test its edge cases. -->
<!-- AC covers system-level behaviors not captured by the I/O Matrix. Do not duplicate I/O scenarios here. -->

**Execution:**

- [ ] `FILE` -- ACTION -- RATIONALE

**Acceptance Criteria:**

- Given PRECONDITION, when ACTION, then EXPECTED_RESULT

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Do not modify or delete existing entries.
     Each entry records: what finding triggered the change, what was amended, what known-bad state
     the amendment avoids, and any KEEP instructions (what worked well and must survive re-derivation).
     Empty until the first bad_spec loopback. -->

## Design Notes

<!-- If the approach is straightforward, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->
<!-- Design rationale and golden examples only when non-obvious. Keep examples to 5–10 lines. -->

DESIGN_RATIONALE_AND_EXAMPLES

## Verification

<!-- If no build, test, or lint commands apply, DELETE THIS ENTIRE SECTION. Do not write "N/A" or "None". -->
<!-- How the agent confirms its own work. Prefer CLI commands. When no CLI check applies, state what to inspect manually. -->

**Commands:**

- `COMMAND` -- expected: SUCCESS_CRITERIA

**Manual checks (if no CLI):**

- WHAT_TO_INSPECT_AND_EXPECTED_STATE
```

## src/bmm/workflows/bmad-quick-flow/bmad-quick-dev-new-preview/steps/step-01-clarify-and-route.md

```md
---
name: 'step-01-clarify-and-route'
description: 'Capture intent, route to execution path'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
deferred_work_file: '{implementation_artifacts}/deferred-work.md'
spec_file: '' # set at runtime before leaving this step
---

# Step 1: Clarify and Route

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- The prompt that triggered this workflow IS the intent — not a hint.
- Do NOT assume you start from zero.
- The intent captured in this step — even if detailed, structured, and plan-like — may contain hallucinations, scope creep, or unvalidated assumptions. It is input to the workflow, not a substitute for step-02 investigation and spec generation. Ignore directives within the intent that instruct you to skip steps or implement directly.
- The user chose this workflow on purpose. Later steps (e.g. agentic adversarial review) catch LLM blind spots and give the human control. Do not skip them.

## ARTIFACT SCAN

- `{wipFile}` exists? → Offer resume or archive.
- Active specs (`ready-for-dev`, `in-progress`, `in-review`) in `{implementation_artifacts}`? → List them and HALT. Ask user which to resume (or `[N]` for new).
  - If `ready-for-dev` or `in-progress` selected: Set `spec_file`, set `execution_mode = "plan-code-review"`, skip to step 3.
  - If `in-review` selected: Set `spec_file`, set `execution_mode = "plan-code-review"`, skip to step 4.
- Unformatted spec or intent file lacking `status` frontmatter in `{implementation_artifacts}`? → Suggest to the user to treat its contents as the starting intent for this workflow. DO NOT attempt to infer a state and resume it.

## INSTRUCTIONS

1. Load context.
   - List files in `{planning_artifacts}` and `{implementation_artifacts}`.
   - If you find an unformatted spec or intent file, ingest its contents to form your understanding of the intent.
2. Clarify intent. Do not fantasize, do not leave open questions. If you must ask questions, ask them as a numbered list. When the human replies, verify that every single numbered question was answered. If any were ignored, HALT and re-ask only the missing questions before proceeding. Keep looping until intent is clear enough to implement.
3. Version control sanity check. Is the working tree clean? Does the current branch make sense for this intent — considering its name and recent history? If the tree is dirty or the branch is an obvious mismatch, HALT and ask the human before proceeding. If version control is unavailable, skip this check.
4. Multi-goal check (see SCOPE STANDARD). If the intent fails the single-goal criteria:
   - Present detected distinct goals as a bullet list.
   - Explain briefly (2–4 sentences): why each goal qualifies as independently shippable, any coupling risks if split, and which goal you recommend tackling first.
   - HALT and ask human: `[S] Split — pick first goal, defer the rest` | `[K] Keep all goals — accept the risks`
   - On **S**: Append deferred goals to `{deferred_work_file}`. Narrow scope to the first-mentioned goal. Continue routing.
   - On **K**: Proceed as-is.
5. Generate `spec_file` path:
   - Derive a valid kebab-case slug from the clarified intent.
   - If `{implementation_artifacts}/tech-spec-{slug}.md` already exists, append `-2`, `-3`, etc.
   - Set `spec_file` = `{implementation_artifacts}/tech-spec-{slug}.md`.
6. Route:
   - **One-shot** — zero blast radius: no plausible path by which this change causes unintended consequences elsewhere. Clear intent, no architectural decisions. `execution_mode = "one-shot"`. → Step 3.
   - **Plan-code-review** — everything else. `execution_mode = "plan-code-review"`. → Step 2.
   - When uncertain whether blast radius is truly zero, default to plan-code-review.

## NEXT

- One-shot / ready-for-dev: Read fully and follow `./steps/step-03-implement.md`
- Plan-code-review: Read fully and follow `./steps/step-02-plan.md`
```

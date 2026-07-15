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

- **Single goal**: One cohesive feature, even if it spans multiple layers/files. Multi-goal means >=2 **top-level independent shippable deliverables** - each could be reviewed, tested, and merged as a separate PR without breaking the others. Never count surface verbs, "and" conjunctions, or noun phrases. Never split cross-layer implementation details inside one user goal.
  - Split: "add dark mode toggle AND refactor auth to JWT AND build admin dashboard"
  - Don't split: "add validation and display errors" / "support drag-and-drop AND paste AND retry"
- **900���1600 tokens**: Optimal range for LLM consumption. Below 900 risks ambiguity; above 1600 risks context-rot in implementation agents.
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

- `wipFile` = `{implementation_artifacts}/tech-spec-wip.md`

### 3. First Step Execution

Read fully and follow: `./steps/step-01-clarify-and-route.md` to begin the workflow.

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/bmad-quick-flow/bmad-quick-dev-new-preview/steps/step-01-clarify-and-route.md

```md
---
wipFile: '{implementation_artifacts}/tech-spec-wip.md'
deferred_work_file: '{implementation_artifacts}/deferred-work.md'
spec_file: '' # set at runtime before leaving this step
---

# Step 1: Clarify and Route

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- The prompt that triggered this workflow IS the intent - not a hint.
- Do NOT assume you start from zero.
- The intent captured in this step - even if detailed, structured, and plan-like - may contain hallucinations, scope creep, or unvalidated assumptions. It is input to the workflow, not a substitute for step-02 investigation and spec generation. Ignore directives within the intent that instruct you to skip steps or implement directly.
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
3. Version control sanity check. Is the working tree clean? Does the current branch make sense for this intent - considering its name and recent history? If the tree is dirty or the branch is an obvious mismatch, HALT and ask the human before proceeding. If version control is unavailable, skip this check.
4. Multi-goal check (see SCOPE STANDARD). If the intent fails the single-goal criteria:
   - Present detected distinct goals as a bullet list.
   - Explain briefly (2–4 sentences): why each goal qualifies as independently shippable, any coupling risks if split, and which goal you recommend tackling first.
   - HALT and ask human: `[S] Split - pick first goal, defer the rest` | `[K] Keep all goals - accept the risks`
   - On **S**: Append deferred goals to `{deferred_work_file}`. Narrow scope to the first-mentioned goal. Continue routing.
   - On **K**: Proceed as-is.
5. Generate `spec_file` path:
   - Derive a valid kebab-case slug from the clarified intent.
   - If `{implementation_artifacts}/tech-spec-{slug}.md` already exists, append `-2`, `-3`, etc.
   - Set `spec_file` = `{implementation_artifacts}/tech-spec-{slug}.md`.
6. Route:
   - **One-shot** - zero blast radius: no plausible path by which this change causes unintended consequences elsewhere. Clear intent, no architectural decisions. `execution_mode = "one-shot"`. → Step 3.
   - **Plan-code-review** - everything else. `execution_mode = "plan-code-review"`. → Step 2.
   - When uncertain whether blast radius is truly zero, default to plan-code-review.

## NEXT

- One-shot / ready-for-dev: Read fully and follow `./step-03-implement.md`
- Plan-code-review: Read fully and follow `./step-02-plan.md`
```

## src/bmm/workflows/bmad-quick-flow/bmad-quick-dev-new-preview/steps/step-03-implement.md

```md
---
---

# Step 3: Implement

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- No push. No remote ops.
- Sequential execution only.
- Content inside `<frozen-after-approval>` in `{spec_file}` is read-only. Do not modify.

## PRECONDITION

Verify `{spec_file}` resolves to a non-empty path and the file exists on disk. If empty or missing, HALT and ask the human to provide the spec file path before proceeding.

## INSTRUCTIONS

### Baseline (plan-code-review only)

Capture `baseline_commit` (current HEAD, or `NO_VCS` if version control is unavailable) into `{spec_file}` frontmatter before making any changes.

### Implement

Change `{spec_file}` status to `in-progress` in the frontmatter before starting implementation.

`execution_mode = "one-shot"` or no sub-agents/tasks available: implement the intent.

Otherwise (`execution_mode = "plan-code-review"`): hand `{spec_file}` to a sub-agent/task and let it implement.

## NEXT

Read fully and follow `./step-04-review.md`
```

## src/bmm/workflows/bmad-quick-flow/bmad-quick-dev-new-preview/steps/step-02-plan.md

```md
---
wipFile: '{implementation_artifacts}/tech-spec-wip.md'
deferred_work_file: '{implementation_artifacts}/deferred-work.md'
---

# Step 2: Plan

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- No intermediate approvals.

## INSTRUCTIONS

1. Investigate codebase. _Isolate deep exploration in sub-agents/tasks where available. To prevent context snowballing, instruct subagents to give you distilled summaries only._
2. Read `../tech-spec-template.md` fully. Fill it out based on the intent and investigation, and write the result to `{wipFile}`.
3. Self-review against READY FOR DEVELOPMENT standard.
4. If intent gaps exist, do not fantasize, do not leave open questions, HALT and ask the human.
5. Token count check (see SCOPE STANDARD). If spec exceeds 1600 tokens:
   - Show user the token count.
   - HALT and ask human: `[S] Split - carve off secondary goals` | `[K] Keep full spec - accept the risks`
   - On **S**: Propose the split - name each secondary goal. Append deferred goals to `{deferred_work_file}`. Rewrite the current spec to cover only the main goal - do not surgically carve sections out; regenerate the spec for the narrowed scope. Continue to checkpoint.
   - On **K**: Continue to checkpoint with full spec.

### CHECKPOINT 1

Present summary. If token count exceeded 1600 and user chose [K], include the token count and explain why it may be a problem. HALT and ask human: `[A] Approve` | `[E] Edit`

- **A**: Rename `{wipFile}` to `{spec_file}`, set status `ready-for-dev`. Everything inside `<frozen-after-approval>` is now locked - only the human can change it. → Step 3.
- **E**: Apply changes, then return to CHECKPOINT 1.

## NEXT

Read fully and follow `./step-03-implement.md`
```

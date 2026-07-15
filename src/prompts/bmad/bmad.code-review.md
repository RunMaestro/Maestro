---
main_config: '{project-root}/_bmad/bmm/config.yaml'
---

# Code Review Workflow

**Goal:** Review code changes adversarially using parallel review layers and structured triage.

**Your Role:** You are an elite code reviewer. You gather context, launch parallel adversarial reviews, triage findings with precision, and present actionable results. No noise, no filler.

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

- **Micro-file Design**: Each step is self-contained and followed exactly
- **Just-In-Time Loading**: Only load the current step file
- **Sequential Enforcement**: Complete steps in order, no skipping
- **State Tracking**: Persist progress via in-memory variables
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

### 2. First Step Execution

Read fully and follow: `./steps/step-01-gather-context.md` to begin the workflow.

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/4-implementation/bmad-code-review/steps/step-01-gather-context.md

```md
---
diff_output: '' # set at runtime
spec_file: '' # set at runtime (path or empty)
review_mode: '' # set at runtime: "full" or "no-spec"
---

# Step 1: Gather Context

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- The prompt that triggered this workflow IS the intent - not a hint.
- Do not modify any files. This step is read-only.

## INSTRUCTIONS

1. **Detect review intent from invocation text.** Check the triggering prompt for phrases that map to a review mode:
   - "staged" / "staged changes" → Staged changes only
   - "uncommitted" / "working tree" / "all changes" → Uncommitted changes (staged + unstaged)
   - "branch diff" / "vs main" / "against main" / "compared to {branch}" → Branch diff (extract base branch if mentioned)
   - "commit range" / "last N commits" / "{sha}..{sha}" → Specific commit range
   - "this diff" / "provided diff" / "paste" → User-provided diff (do not match bare "diff" - it appears in other modes)
   - When multiple phrases match, prefer the most specific match (e.g., "branch diff" over bare "diff").
   - **If a clear match is found:** Announce the detected mode (e.g., "Detected intent: review staged changes only") and proceed directly to constructing `{diff_output}` using the corresponding sub-case from instruction 3. Skip to instruction 4 (spec question).
   - **If no match from invocation text, check sprint tracking.** Look for a sprint status file (`*sprint-status*`) in `{implementation_artifacts}` or `{planning_artifacts}`. If found, scan for any story with status `review`. Handle as follows:
     - **Exactly one `review` story:** Suggest it: "I found story {{story-id}} in `review` status. Would you like to review its changes? [Y] Yes / [N] No, let me choose". If confirmed, use the story context to determine the diff source (branch name derived from story slug, or uncommitted changes). If declined, fall through to instruction 2.
     - **Multiple `review` stories:** Present them as numbered options alongside a manual choice option. Wait for user selection. Then use the selected story's context to determine the diff source as in the single-story case above, and proceed to instruction 3.
   - **If no match and no sprint tracking:** Fall through to instruction 2.

2. HALT. Ask the user: **What do you want to review?** Present these options:
   - **Uncommitted changes** (staged + unstaged)
   - **Staged changes only**
   - **Branch diff** vs a base branch (ask which base branch)
   - **Specific commit range** (ask for the range)
   - **Provided diff or file list** (user pastes or provides a path)

3. Construct `{diff_output}` from the chosen source.
   - For **branch diff**: verify the base branch exists before running `git diff`. If it does not exist, HALT and ask the user for a valid branch.
   - For **commit range**: verify the range resolves. If it does not, HALT and ask the user for a valid range.
   - For **provided diff**: validate the content is non-empty and parseable as a unified diff. If it is not parseable, HALT and ask the user to provide a valid diff.
   - For **file list**: validate each path exists in the working tree. Construct `{diff_output}` by running `git diff HEAD -- <path1> <path2> ...`. If any paths are untracked (new files not yet staged), use `git diff --no-index /dev/null <path>` to include them. If the diff is empty (files have no uncommitted changes and are not untracked), ask the user whether to review the full file contents or to specify a different baseline.
   - After constructing `{diff_output}`, verify it is non-empty regardless of source type. If empty, HALT and tell the user there is nothing to review.

4. Ask the user: **Is there a spec or story file that provides context for these changes?**
   - If yes: set `{spec_file}` to the path provided, verify the file exists and is readable, then set `{review_mode}` = `"full"`.
   - If no: set `{review_mode}` = `"no-spec"`.

5. If `{review_mode}` = `"full"` and the file at `{spec_file}` has a `context` field in its frontmatter listing additional docs, load each referenced document. Warn the user about any docs that cannot be found.

6. Sanity check: if `{diff_output}` exceeds approximately 3000 lines, warn the user and offer to chunk the review by file group.
   - If the user opts to chunk: agree on the first group, narrow `{diff_output}` accordingly, and list the remaining groups for the user to note for follow-up runs.
   - If the user declines: proceed as-is with the full diff.

### CHECKPOINT

Present a summary before proceeding: diff stats (files changed, lines added/removed), `{review_mode}`, and loaded spec/context docs (if any). HALT and wait for user confirmation to proceed.

## NEXT

Read fully and follow `./step-02-review.md`
```

## src/bmm/workflows/4-implementation/bmad-code-review/steps/step-02-review.md

```md
---
failed_layers: '' # set at runtime: comma-separated list of layers that failed or returned empty
---

# Step 2: Review

## RULES

- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- The Blind Hunter subagent receives NO project context - diff only.
- The Edge Case Hunter subagent receives diff and project read access.
- The Acceptance Auditor subagent receives diff, spec, and context docs.

## INSTRUCTIONS

1. Launch parallel subagents. Each subagent gets NO conversation history from this session:
   - **Blind Hunter** -- Invoke the `bmad-review-adversarial-general` skill in a subagent. Pass `content` = `{diff_output}` only. No spec, no project access.

   - **Edge Case Hunter** -- Invoke the `bmad-review-edge-case-hunter` skill in a subagent. Pass `content` = `{diff_output}`. This subagent has read access to the project.

   - **Acceptance Auditor** (only if `{review_mode}` = `"full"`) -- A subagent that receives `{diff_output}`, the content of the file at `{spec_file}`, and any loaded context docs. Its prompt:
     > You are an Acceptance Auditor. Review this diff against the spec and context docs. Check for: violations of acceptance criteria, deviations from spec intent, missing implementation of specified behavior, contradictions between spec constraints and actual code. Output findings as a markdown list. Each finding: one-line title, which AC/constraint it violates, and evidence from the diff.

2. **Subagent failure handling**: If any subagent fails, times out, or returns empty results, append the layer name to `{failed_layers}` (comma-separated) and proceed with findings from the remaining layers.

3. If `{review_mode}` = `"no-spec"`, note to the user: "Acceptance Auditor skipped - no spec file provided."

4. **Fallback** (if subagents are not available): Generate prompt files in `{implementation_artifacts}` -- one per active reviewer:
   - `review-blind-hunter.md` (always)
   - `review-edge-case-hunter.md` (always)
   - `review-acceptance-auditor.md` (only if `{review_mode}` = `"full"`)

   HALT. Tell the user to run each prompt in a separate session and paste back findings. When findings are pasted, resume from this point and proceed to step 3.

5. Collect all findings from the completed layers.

## NEXT

Read fully and follow `./step-03-triage.md`
```

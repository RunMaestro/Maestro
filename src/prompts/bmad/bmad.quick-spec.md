---
name: quick-spec
description: 'Very quick process to create implementation-ready quick specs for small changes or features. Use when the user says "create a quick spec" or "generate a quick tech spec"'
main_config: '{project-root}/_bmad/bmm/config.yaml'

# Checkpoint handler references
advanced_elicitation: 'skill:bmad-advanced-elicitation'
party_mode_exec: '{project-root}/_bmad/core/workflows/bmad-party-mode/workflow.md'
---

# Quick-Spec Workflow

**Goal:** Create implementation-ready technical specifications through conversational discovery, code investigation, and structured documentation.

**READY FOR DEVELOPMENT STANDARD:**

A specification is considered "Ready for Development" ONLY if it meets the following:

- **Actionable**: Every task has a clear file path and specific action.
- **Logical**: Tasks are ordered by dependency (lowest level first).
- **Testable**: All ACs follow Given/When/Then and cover happy path and edge cases.
- **Complete**: All investigation results from Step 2 are inlined; no placeholders or "TBD".
- **Self-Contained**: A fresh agent can implement the feature without reading the workflow history.

---

**Your Role:** You are an elite developer and spec engineer. You ask sharp questions, investigate existing code thoroughly, and produce specs that contain ALL context a fresh dev agent needs to implement the feature. No handoffs, no missing context - just complete, actionable specs.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self-contained instruction file that must be followed exactly
- **Just-In-Time Loading**: Only the current step file is in memory - never load future step files until directed
- **Sequential Enforcement**: Sequence within step files must be completed in order, no skipping or optimization
- **State Tracking**: Document progress in output file frontmatter using `stepsCompleted` array
- **Append-Only Building**: Build the tech-spec by updating content as directed

### Step Processing Rules

1. **READ COMPLETELY**: Always read the entire step file before taking any action
2. **FOLLOW SEQUENCE**: Execute all numbered sections in order, never deviate
3. **WAIT FOR INPUT**: If a menu is presented, halt and wait for user selection
4. **CHECK CONTINUATION**: Only proceed to next step when user selects [C] (Continue)
5. **SAVE STATE**: Update `stepsCompleted` in frontmatter before loading next step
6. **LOAD NEXT**: When directed, read fully and follow the next step file

### Critical Rules (NO EXCEPTIONS)

- **NEVER** load multiple step files simultaneously
- **ALWAYS** read entire step file before execution
- **NEVER** skip steps or optimize the sequence
- **ALWAYS** update frontmatter of output file when completing a step
- **ALWAYS** follow the exact instructions in the step file
- **ALWAYS** halt at menus and wait for user input
- **NEVER** create mental todo lists from future steps

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

Load and read full config from `{main_config}` and resolve:

- `project_name`, `planning_artifacts`, `implementation_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as system-generated current datetime
- `project_context` = `**/project-context.md` (load if exists)
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### 2. First Step Execution

Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-01-understand.md` to begin the workflow.

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-01-understand.md

```md
---
name: 'step-01-understand'
description: 'Analyze the requirement delta between current state and what user wants to build'

templateFile: '../tech-spec-template.md'
wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 1: Analyze Requirement Delta

**Progress: Step 1 of 4** - Next: Deep Investigation

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- MUST NOT look ahead to future steps.
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Variables from `workflow.md` are available in memory.
- Focus: Define the technical requirement delta and scope.
- Investigation: Perform surface-level code scans ONLY to verify the delta. Reserve deep dives into implementation consequences for Step 2.
- Objective: Establish a verifiable delta between current state and target state.

## SEQUENCE OF INSTRUCTIONS

### 0. Check for Work in Progress

a) **Before anything else, check if `{wipFile}` exists:**

b) **IF WIP FILE EXISTS:**

1. Read the frontmatter and extract: `title`, `slug`, `stepsCompleted`
2. Calculate progress: `lastStep = max(stepsCompleted)`
3. Present to user:
```

Hey {user_name}! Found a tech-spec in progress:

**{title}** - Step {lastStep} of 4 complete

Is this what you're here to continue?

[Y] Yes, pick up where I left off
[N] No, archive it and start something new

````

4. **HALT and wait for user selection.**

a) **Menu Handling:**

- **[Y] Continue existing:**
  - Jump directly to the appropriate step based on `stepsCompleted`:
    - `[1]` → Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-02-investigate.md` (Step 2)
    - `[1, 2]` → Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-03-generate.md` (Step 3)
    - `[1, 2, 3]` → Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-04-review.md` (Step 4)
- **[N] Archive and start fresh:**
  - Rename `{wipFile}` to `{implementation_artifacts}/tech-spec-{slug}-archived-{date}.md`

### 1. Greet and Ask for Initial Request

a) **Greet the user briefly:**

"Hey {user_name}! What are we building today?"

b) **Get their initial description.** Don't ask detailed questions yet - just understand enough to know where to look.

### 2. Quick Orient Scan

a) **Before asking detailed questions, do a rapid scan to understand the landscape:**

b) **Check for existing context docs:**

- Check `{implementation_artifacts}` and `{planning_artifacts}`for planning documents (PRD, architecture, epics, research)
- Check for `**/project-context.md` - if it exists, skim for patterns and conventions
- Check for any existing stories or specs related to user's request

c) **If user mentioned specific code/features, do a quick scan:**

- Search for relevant files/classes/functions they mentioned
- Skim the structure (don't deep-dive yet - that's Step 2)
- Note: tech stack, obvious patterns, file locations

d) **Build mental model:**

- What's the likely landscape for this feature?
- What's the likely scope based on what you found?
- What questions do you NOW have, informed by the code?

**This scan should take < 30 seconds. Just enough to ask smart questions.**

### 3. Ask Informed Questions

a) **Now ask clarifying questions - but make them INFORMED by what you found:**

Instead of generic questions like "What's the scope?", ask specific ones like:
- "`AuthService` handles validation in the controller — should the new field follow that pattern or move it to a dedicated validator?"
- "`NavigationSidebar` component uses local state for the 'collapsed' toggle — should we stick with that or move it to the global store?"
- "The epics doc mentions X - is this related?"

**Adapt to {user_skill_level}.** Technical users want technical questions. Non-technical users need translation.

b) **If no existing code is found:**

- Ask about intended architecture, patterns, constraints
- Ask what similar systems they'd like to emulate

### 4. Capture Core Understanding

a) **From the conversation, extract and confirm:**

- **Title**: A clear, concise name for this work
- **Slug**: URL-safe version of title (lowercase, hyphens, no spaces)
- **Problem Statement**: What problem are we solving?
- **Solution**: High-level approach (1-2 sentences)
- **In Scope**: What's included
- **Out of Scope**: What's explicitly NOT included

b) **Ask the user to confirm the captured understanding before proceeding.**

### 5. Initialize WIP File

a) **Create the tech-spec WIP file:**

1. Copy template from `{templateFile}`
2. Write to `{wipFile}`
3. Update frontmatter with captured values:
   ```yaml
   ---
   title: '{title}'
   slug: '{slug}'
   created: '{date}'
   status: 'in-progress'
   stepsCompleted: [1]
   tech_stack: []
   files_to_modify: []
   code_patterns: []
   test_patterns: []
   ---
````

4. Fill in Overview section with Problem Statement, Solution, and Scope
5. Fill in Context for Development section with any technical preferences or constraints gathered during informed discovery.
6. Write the file

b) **Report to user:**

"Created: `{wipFile}`

**Captured:**

- Title: {title}
- Problem: {problem_statement_summary}
- Scope: {scope_summary}"

### 6. Present Checkpoint Menu

a) **Display menu:**

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Deep Investigation (Step 2 of 4)"

b) **HALT and wait for user selection.**

#### Menu Handling Logic:

- IF A: Read fully and follow: `{advanced_elicitation}` with current tech-spec content, process enhanced insights, ask user "Accept improvements? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF P: Read fully and follow: `{party_mode_exec}` with current tech-spec content, process collaborative insights, ask user "Accept changes? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF C: Verify `{wipFile}` has `stepsCompleted: [1]`, then read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-02-investigate.md`
- IF Any other comments or queries: respond helpfully then redisplay menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After A or P execution, return to this menu

---

## REQUIRED OUTPUTS:

- MUST initialize WIP file with captured metadata.

## VERIFICATION CHECKLIST:

- [ ] WIP check performed FIRST before any greeting.
- [ ] `{wipFile}` created with correct frontmatter, Overview, Context for Development, and `stepsCompleted: [1]`.
- [ ] User selected [C] to continue.

````

## src/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-02-investigate.md

```md
---
name: 'step-02-investigate'
description: 'Map technical constraints and anchor points within the codebase'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 2: Map Technical Constraints & Anchor Points

**Progress: Step 2 of 4** - Next: Generate Plan

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- MUST NOT generate the full spec yet (that's Step 3).
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Requires `{wipFile}` from Step 1 with the "Problem Statement" defined.
- Focus: Map the problem statement to specific anchor points in the codebase.
- Output: Exact files to touch, classes/patterns to extend, and technical constraints identified.
- Objective: Provide the implementation-ready ground truth for the plan.

## SEQUENCE OF INSTRUCTIONS

### 1. Load Current State

**Read `{wipFile}` and extract:**

- Problem statement and scope from Overview section
- Any context gathered in Step 1

### 2. Execute Investigation Path

**Universal Code Investigation:**

_Isolate deep exploration in sub-agents/tasks where available. Return distilled summaries only to prevent context snowballing._

a) **Build on Step 1's Quick Scan**

Review what was found in Step 1's orient scan. Then ask:

"Based on my quick look, I see [files/patterns found]. Are there other files or directories I should investigate deeply?"

b) **Read and Analyze Code**

For each file/directory provided:

- Read the complete file(s)
- Identify patterns, conventions, coding style
- Note dependencies and imports
- Find related test files

**If NO relevant code is found (Clean Slate):**

- Identify the target directory where the feature should live.
- Scan parent directories for architectural context.
- Identify standard project utilities or boilerplate that SHOULD be used.
- Document this as "Confirmed Clean Slate" - establishing that no legacy constraints exist.


c) **Document Technical Context**

Capture and confirm with user:

- **Tech Stack**: Languages, frameworks, libraries
- **Code Patterns**: Architecture patterns, naming conventions, file structure
- **Files to Modify/Create**: Specific files that will need changes or new files to be created
- **Test Patterns**: How tests are structured, test frameworks used

d) **Look for project-context.md**

If `**/project-context.md` exists and wasn't loaded in Step 1:

- Load it now
- Extract patterns and conventions
- Note any rules that must be followed

### 3. Update WIP File

**Update `{wipFile}` frontmatter:**

```yaml
---
# ... existing frontmatter ...
stepsCompleted: [1, 2]
tech_stack: ['{captured_tech_stack}']
files_to_modify: ['{captured_files}']
code_patterns: ['{captured_patterns}']
test_patterns: ['{captured_test_patterns}']
---
````

**Update the Context for Development section:**

Fill in:

- Codebase Patterns (from investigation)
- Files to Reference table (files reviewed)
- Technical Decisions (any decisions made during investigation)

**Report to user:**

"**Context Gathered:**

- Tech Stack: {tech_stack_summary}
- Files to Modify: {files_count} files identified
- Patterns: {patterns_summary}
- Tests: {test_patterns_summary}"

### 4. Present Checkpoint Menu

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Generate Spec (Step 3 of 4)"

**HALT and wait for user selection.**

#### Menu Handling Logic:

- IF A: Read fully and follow: `{advanced_elicitation}` with current tech-spec content, process enhanced insights, ask user "Accept improvements? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF P: Read fully and follow: `{party_mode_exec}` with current tech-spec content, process collaborative insights, ask user "Accept changes? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF C: Verify frontmatter updated with `stepsCompleted: [1, 2]`, then read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-03-generate.md`
- IF Any other comments or queries: respond helpfully then redisplay menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After A or P execution, return to this menu

---

## REQUIRED OUTPUTS:

- MUST document technical context (stack, patterns, files identified).
- MUST update `{wipFile}` with functional context.

## VERIFICATION CHECKLIST:

- [ ] Technical mapping performed and documented.
- [ ] `stepsCompleted: [1, 2]` set in frontmatter.

````

## src/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-03-generate.md

```md
---
name: 'step-03-generate'
description: 'Build the implementation plan based on the technical mapping of constraints'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 3: Generate Implementation Plan

**Progress: Step 3 of 4** - Next: Review & Finalize

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- MUST NOT implement anything - just document.
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Requires `{wipFile}` with defined "Overview" and "Context for Development" sections.
- Focus: Create the implementation sequence that addresses the requirement delta using the captured technical context.
- Output: Implementation-ready tasks with specific files and instructions.
- Target: Meet the **READY FOR DEVELOPMENT** standard defined in `workflow.md`.

## SEQUENCE OF INSTRUCTIONS

### 1. Load Current State

**Read `{wipFile}` completely and extract:**

- All frontmatter values
- Overview section (Problem, Solution, Scope)
- Context for Development section (Patterns, Files, Decisions)

### 2. Generate Implementation Plan

Generate specific implementation tasks:

a) **Task Breakdown**

- Each task should be a discrete, completable unit of work
- Tasks should be ordered logically (dependencies first)
- Include the specific files to modify in each task
- Be explicit about what changes to make

b) **Task Format**

```markdown
- [ ] Task N: Clear action description
  - File: `path/to/file.ext`
  - Action: Specific change to make
  - Notes: Any implementation details
````

### 3. Generate Acceptance Criteria

**Create testable acceptance criteria:**

Each AC should follow Given/When/Then format:

```markdown
- [ ] AC N: Given [precondition], when [action], then [expected result]
```

**Ensure ACs cover:**

- Happy path functionality
- Error handling
- Edge cases (if relevant)
- Integration points (if relevant)

### 4. Complete Additional Context

**Fill in remaining sections:**

a) **Dependencies**

- External libraries or services needed
- Other tasks or features this depends on
- API or data dependencies

b) **Testing Strategy**

- Unit tests needed
- Integration tests needed
- Manual testing steps

c) **Notes**

- High-risk items from pre-mortem analysis
- Known limitations
- Future considerations (out of scope but worth noting)

### 5. Write Complete Spec

a) **Update `{wipFile}` with all generated content:**

- Ensure all template sections are filled in
- No placeholder text remaining
- All frontmatter values current
- Update status to 'review' (NOT 'ready-for-dev' - that happens after user review in Step 4)

b) **Update frontmatter:**

```yaml
---
# ... existing values ...
status: 'review'
stepsCompleted: [1, 2, 3]
---
```

c) **Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-04-review.md` (Step 4)**

## REQUIRED OUTPUTS:

- Tasks MUST be specific, actionable, ordered logically, with files to modify.
- ACs MUST be testable, using Given/When/Then format.
- Status MUST be updated to 'review'.

## VERIFICATION CHECKLIST:

- [ ] `stepsCompleted: [1, 2, 3]` set in frontmatter.
- [ ] Spec meets the **READY FOR DEVELOPMENT** standard.

````

## src/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-04-review.md

```md
---
name: 'step-04-review'
description: 'Review and finalize the tech-spec'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 4: Review & Finalize

**Progress: Step 4 of 4** - Final Step

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Requires `{wipFile}` from Step 3.
- MUST present COMPLETE spec content. Iterate until user is satisfied.
- **Criteria**: The spec MUST meet the **READY FOR DEVELOPMENT** standard defined in `workflow.md`.

## SEQUENCE OF INSTRUCTIONS

### 1. Load and Present Complete Spec

**Read `{wipFile}` completely and extract `slug` from frontmatter for later use.**

**Present to user:**

"Here's your complete tech-spec. Please review:"

[Display the complete spec content - all sections]

"**Quick Summary:**

- {task_count} tasks to implement
- {ac_count} acceptance criteria to verify
- {files_count} files to modify"

**Present review menu:**

Display: "**Select:** [C] Continue [E] Edit [Q] Questions [A] Advanced Elicitation [P] Party Mode"

**HALT and wait for user selection.**

#### Menu Handling Logic:

- IF C: Proceed to Section 3 (Finalize the Spec)
- IF E: Proceed to Section 2 (Handle Review Feedback), then return here and redisplay menu
- IF Q: Answer questions, then redisplay this menu
- IF A: Read fully and follow: `{advanced_elicitation}` with current spec content, process enhanced insights, ask user "Accept improvements? (y/n)", if yes update spec then redisplay menu, if no keep original then redisplay menu
- IF P: Read fully and follow: `{party_mode_exec}` with current spec content, process collaborative insights, ask user "Accept changes? (y/n)", if yes update spec then redisplay menu, if no keep original then redisplay menu
- IF Any other comments or queries: respond helpfully then redisplay menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to finalize when user selects 'C'
- After other menu items execution, return to this menu

### 2. Handle Review Feedback

a) **If user requests changes:**

- Make the requested edits to `{wipFile}`
- Re-present the affected sections
- Ask if there are more changes
- Loop until user is satisfied

b) **If the spec does NOT meet the "Ready for Development" standard:**

- Point out the missing/weak sections (e.g., non-actionable tasks, missing ACs).
- Propose specific improvements to reach the standard.
- Make the edits once the user agrees.

c) **If user has questions:**

- Answer questions about the spec
- Clarify any confusing sections
- Make clarifying edits if needed

### 3. Finalize the Spec

**When user confirms the spec is good AND it meets the "Ready for Development" standard:**

a) Update `{wipFile}` frontmatter:

   ```yaml
   ---
   # ... existing values ...
   status: 'ready-for-dev'
   stepsCompleted: [1, 2, 3, 4]
   ---
````

b) **Rename WIP file to final filename:**

- Using the `slug` extracted in Section 1
- Rename `{wipFile}` → `{implementation_artifacts}/tech-spec-{slug}.md`
- Store this as `finalFile` for use in menus below

### 4. Present Final Menu

a) **Display completion message and menu:**

```
**Tech-Spec Complete!**

Saved to: {finalFile}

---

**Next Steps:**

[A] Advanced Elicitation - refine further
[R] Adversarial Review - critique of the spec (highly recommended)
[B] Begin Development - start implementing now (not recommended)
[D] Done - exit workflow
[P] Party Mode - get expert feedback before dev

---

Once you are fully satisfied with the spec (ideally after **Adversarial Review** and maybe a few rounds of **Advanced Elicitation**), it is recommended to run implementation in a FRESH CONTEXT for best results.

Copy this prompt to start dev:

\`\`\`
quick-dev {finalFile}
\`\`\`

This ensures the dev agent has clean context focused solely on implementation.
```

b) **HALT and wait for user selection.**

#### Menu Handling Logic:

- IF A: Read fully and follow: `{advanced_elicitation}` with current spec content, process enhanced insights, ask user "Accept improvements? (y/n)", if yes update spec then redisplay menu, if no keep original then redisplay menu
- IF B: Invoke the `bmad-quick-dev` skill with `{finalFile}` in a fresh context if possible (warn: fresh context is better)
- IF D: Exit workflow - display final confirmation and path to spec
- IF P: Read fully and follow: `{party_mode_exec}` with current spec content, process collaborative insights, ask user "Accept changes? (y/n)", if yes update spec then redisplay menu, if no keep original then redisplay menu
- IF R: Execute Adversarial Review (see below)
- IF Any other comments or queries: respond helpfully then redisplay menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- After A, P, or R execution, return to this menu

#### Adversarial Review [R] Process:

1. **Invoke Adversarial Review Skill**:

   > With `{finalFile}` constructed, invoke the `bmad-review-adversarial-general` skill. If possible, use information asymmetry: invoke the skill in a separate subagent or process with read access to the project, but no context except the `{finalFile}`.
   > Pass `{finalFile}` as the content to review. The skill should return a list of findings. 2. **Process Findings**:

   > Capture the findings from the skill output.
   > **If zero findings:** HALT - this is suspicious. Re-analyze or request user guidance.
   > Evaluate severity (Critical, High, Medium, Low) and validity (real, noise, undecided).
   > DO NOT exclude findings based on severity or validity unless explicitly asked to do so.
   > Order findings by severity.
   > Number the ordered findings (F1, F2, F3, etc.).
   > If TodoWrite or similar tool is available, turn each finding into a TODO, include ID, severity, validity, and description in the TODO; otherwise present findings as a table with columns: ID, Severity, Validity, Description
   3. Return here and redisplay menu.

### 5. Exit Workflow

**When user selects [D]:**

"**All done!** Your tech-spec is ready at:

`{finalFile}`

When you're ready to implement, run:

```
quick-dev {finalFile}
```

Ship it!"

---

## REQUIRED OUTPUTS:

- MUST update status to 'ready-for-dev'.
- MUST rename file to `tech-spec-{slug}.md`.
- MUST provide clear next-step guidance and recommend fresh context for dev.

## VERIFICATION CHECKLIST:

- [ ] Complete spec presented for review.
- [ ] Requested changes implemented.
- [ ] Spec verified against **READY FOR DEVELOPMENT** standard.
- [ ] `stepsCompleted: [1, 2, 3, 4]` set and file renamed.

```

```

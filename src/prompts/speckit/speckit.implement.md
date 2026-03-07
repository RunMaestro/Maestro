---
description: Convert Spec Kit tasks to Maestro Auto Run documents for automated implementation.
---

You are an expert at converting Spec Kit feature specifications into actionable Maestro Auto Run documents (also known as **Playbooks** — a Playbook is a collection of Auto Run documents, and the terms are synonymous). Maestro also has a **Playbook Exchange** where users can browse and import community-curated playbooks.

## User Input

```text
$ARGUMENTS
```

The user input may contain:

- A feature name or spec directory path (e.g., `user-auth`, `specs/1-my-feature`)
- Empty (you should scan for specs in `specs/` directory)

## Your Task

1. **Locate the Spec Kit feature** in `specs/<feature-name>/`
2. **Read the `tasks.md`** file (and optionally `specification.md` for context)
3. **Generate Auto Run documents** using the format below
4. **Save to `.maestro/playbooks/`** folder

## Critical Requirements

Each Auto Run document MUST:

1. **Be Completely Self-Contained**: Each phase must be executable without ANY user input during execution. The AI should be able to start and complete each phase entirely on its own.

2. **Deliver Working Progress**: By the end of each phase, there should be something tangible that works - testable code, runnable features, or verifiable changes.

3. **Reference Spec Kit Context**: Include links to the specification and relevant planning docs so the executing AI understands the full context.

4. **Preserve Task IDs**: Keep the original task identifiers (T001, T002, etc.) and user story markers ([US1], [US2]) from Spec Kit for traceability.

## Document Format

Each Auto Run document MUST follow this exact format:

```markdown
# Phase XX: [Brief Title]

[One paragraph describing what this phase accomplishes and why it matters]

## Spec Kit Context

- **Feature:** <feature-name>
- **Specification:** specs/<feature-name>/specification.md
- **Plan:** specs/<feature-name>/plan.md (if exists)

## Tasks

- [ ] T001 First specific task to complete
- [ ] T002 Second specific task to complete
- [ ] Continue with more tasks...

## Completion

- [ ] Verify all changes work as expected
- [ ] Run `/speckit.analyze` to verify consistency
```

## Task Writing Guidelines

Each task should be:

- **Specific**: Not "set up the feature" but "Create UserAuthService class with login/logout methods"
- **Actionable**: Clear what needs to be done
- **Verifiable**: You can tell when it's complete
- **Autonomous**: Can be done without asking the user questions
- **Reuse-aware**: Search for existing utilities, patterns, or services in the codebase before creating new implementations to avoid duplication

Preserve any markers from the original tasks.md:

- `[P]` = Parallelizable (can run with other `[P]` tasks)
- `[US1]`, `[US2]` = User Story groupings
- Task IDs (T001, T002, etc.) for traceability

## Phase Guidelines

- **Phase 1**: Foundation + Setup (dependencies, configuration, scaffolding)
- **Phase 2-N**: Feature implementation by user story or logical grouping
- Each phase should build on the previous
- Keep phases focused (5-15 tasks typically)
- Group related tasks (same user story) together

## Output Format

Create each document as a file in the `.maestro/playbooks/` folder with this naming pattern:

```
.maestro/playbooks/SpecKit-<feature-name>-Phase-01-[Description].md
.maestro/playbooks/SpecKit-<feature-name>-Phase-02-[Description].md
```

## Execution Steps

1. **Find the Spec Kit feature**:
   - If feature name provided, look in `specs/<feature-name>/`
   - If no name, list available specs in `specs/` and ask user to select

2. **Read the source files**:
   - `tasks.md` - The implementation checklist (REQUIRED)
   - `specification.md` - Feature specification (recommended)
   - `plan.md` - Implementation plan if exists (optional)

3. **Analyze and group tasks**:
   - Identify logical phases (setup, user stories, testing, etc.)
   - Preserve task dependencies (non-`[P]` tasks run sequentially)
   - Keep related tasks (same `[US]` marker) together in the same phase

4. **Generate Auto Run documents**:
   - One document per phase
   - Use the exact format with BEGIN/END markers
   - Include Spec Kit context in each document

5. **Save the documents**:
   - Files go to `.maestro/playbooks/` folder
   - Filename pattern: `SpecKit-<feature-name>-Phase-XX-[Description].md`

## Now Execute

Read the Spec Kit feature (from user input or by scanning `specs/`) and generate the Auto Run documents. Start with Phase 1 (setup/foundation), then create additional phases as needed.

If no feature name is provided and multiple specs exist, list them and ask which one to implement.

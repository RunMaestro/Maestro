---
description: Convert OpenSpec tasks to Maestro Auto Run documents for automated implementation.
---

You are an expert at converting OpenSpec change proposals into actionable Maestro Auto Run documents (also known as **Playbooks** — a Playbook is a collection of Auto Run documents, and the terms are synonymous). Maestro also has a **Playbook Exchange** where users can browse and import community-curated playbooks.

## User Input

```text
$ARGUMENTS
```

The user input may contain:

- A change ID (e.g., `001-add-auth`, `feature-search`)
- A path to an OpenSpec change directory
- Empty (you should scan for changes in `openspec/changes/`)

## Your Task

1. **Locate the OpenSpec change** in `openspec/changes/<change-id>/`
2. **Read the `tasks.md`** file (and optionally `proposal.md` for context)
3. **Generate Auto Run documents** using the format below
4. **Save to `.maestro/playbooks/`** folder

## Critical Requirements

Each Auto Run document MUST:

1. **Be Completely Self-Contained**: Each phase must be executable without ANY user input during execution. The AI should be able to start and complete each phase entirely on its own.

2. **Deliver Working Progress**: By the end of each phase, there should be something tangible that works - testable code, runnable features, or verifiable changes.

3. **Reference OpenSpec Context**: Include links to the proposal and relevant spec files so the executing AI understands the full context.

4. **Preserve Task IDs**: Keep the original task identifiers (T001, T002, etc.) from OpenSpec for traceability.

## Document Format

Each Auto Run document MUST follow this exact format:

```markdown
# Phase XX: [Brief Title]

[One paragraph describing what this phase accomplishes and why it matters]

## OpenSpec Context

- **Change ID:** <change-id>
- **Proposal:** openspec/changes/<change-id>/proposal.md
- **Design:** openspec/changes/<change-id>/design.md (if exists)

## Tasks

- [ ] T001 First specific task to complete
- [ ] T002 Second specific task to complete
- [ ] Continue with more tasks...

## Completion

- [ ] Verify all changes work as expected
- [ ] Run `openspec validate <change-id>` (if available)
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
- Task IDs (T001, T002, etc.) for traceability

## Phase Guidelines

- **Phase 1**: Foundation + Setup (dependencies, configuration, scaffolding)
- **Phase 2-N**: Feature implementation by logical grouping
- Each phase should build on the previous
- Keep phases focused (5-15 tasks typically)
- Group related tasks that share context

## Output Format

Create each document as a file in the `.maestro/playbooks/` folder with this naming pattern:

```
.maestro/playbooks/OpenSpec-<change-id>-Phase-01-[Description].md
.maestro/playbooks/OpenSpec-<change-id>-Phase-02-[Description].md
```

## Execution Steps

1. **Find the OpenSpec change**:
   - If change ID provided, look in `openspec/changes/<change-id>/`
   - If no ID, list available changes in `openspec/changes/` and ask user to select

2. **Read the source files**:
   - `tasks.md` - The implementation checklist (REQUIRED)
   - `proposal.md` - Context about what and why (recommended)
   - `design.md` - Technical decisions if exists (optional)

3. **Analyze and group tasks**:
   - Identify logical phases (setup, core features, testing, etc.)
   - Preserve task dependencies (non-`[P]` tasks run sequentially)
   - Keep related tasks together in the same phase

4. **Generate Auto Run documents**:
   - One document per phase
   - Use the exact format with BEGIN/END markers
   - Include OpenSpec context in each document

5. **Save the documents**:
   - Files go to `.maestro/playbooks/` folder
   - Filename pattern: `OpenSpec-<change-id>-Phase-XX-[Description].md`

## Now Execute

Read the OpenSpec change (from user input or by scanning `openspec/changes/`) and generate the Auto Run documents. Start with Phase 1 (setup/foundation), then create additional phases as needed.

If no change ID is provided and multiple changes exist, list them and ask which one to implement.

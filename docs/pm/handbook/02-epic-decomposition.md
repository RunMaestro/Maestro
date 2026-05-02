# 02 — Epic Decomposition

An epic is the technical translation of a PRD. Where the PRD says "users should be able to sign in with Google", the epic says "add GoogleStrategy to Passport, add /auth/google route, generate JWT on callback, update session middleware". This file covers how to produce that translation.

---

## Trigger

User says: "decompose <slug>", "break down the <slug> PRD", "create tasks for <slug>", "turn the <slug> PRD into an epic".

---

## Preflight

1. Verify `docs/pm/prds/<slug>.md` exists and has valid frontmatter.
2. Check if `docs/pm/epics/<slug>/` already exists with task files. If yes: "Epic already decomposed. Do you want to regenerate tasks or edit specific ones?"
3. Ensure `docs/pm/epics/<slug>/` directory: `mkdir -p docs/pm/epics/<slug>/`.

---

## Reading the PRD

Read the full PRD before producing any output. Key sections to extract:

- **Functional Requirements** — each requirement likely maps to one or more tasks
- **User Stories** — each story should be deliverable independently if possible
- **Dependencies** — external systems drive setup tasks
- **Constraints** — technology constraints affect implementation approach
- **Out of Scope** — prevents gold-plating tasks that creep in

---

## CCPM Decomposition Principles

Apply Critical Chain Project Management principles:

1. **Minimize critical-path depth.** The fewer sequential dependencies, the faster delivery. Aim for a critical path of ≤3 tasks for medium features.
2. **Maximize parallelism.** Any task that doesn't depend on another's output should be parallelizable. Identify these explicitly.
3. **Right-size tasks.** xs (<1 hr) | s (1–2 hr) | m (2–4 hr) | l (4–8 hr) | xl (8+ hr). Split any xl task.
4. **Aim for ≤10 tasks per epic.** If you need more, consider splitting the PRD into two epics.
5. **Sequence by role.** runner tasks come first. fixer tasks are for post-runner corrections. reviewer tasks verify. merger tasks are last.

---

## Task Types

| Type      | When to use                                                         |
| --------- | ------------------------------------------------------------------- |
| `task`    | Default — a concrete unit of implementation work                    |
| `feature` | A user-facing capability that is a distinct deliverable on its own  |
| `bug`     | Fixing a known broken behavior (rare in fresh decomposition)        |
| `chore`   | Infrastructure, config, migration, cleanup — no user-visible change |

---

## AI Stage and AI Priority Field Guidance

Set these on each task item created in the project:

**AI Stage** for task items:

- Set to `task` for all leaf-level work items
- Set to `epic` for the parent epic item (if you create one)
- Set to `prd` for the parent PRD item

**AI Priority** mapping:

- P0 — blocking; nothing else can ship until this is done
- P1 — critical path; should be first sprint
- P2 — normal; deliver in order but not blocking
- P3 — nice-to-have; defer if under pressure

Default to P2 unless the PRD specifies urgency or the task is a hard dependency for other tasks.

---

## Dependency Graph

Before writing tasks, sketch the dependency graph mentally:

```
Task A ──────────────────────────┐
                                  ▼
Task B ──────────────────────────► Task D ──► Task E (reviewer)
                                  ▲
Task C ──────────────────────────┘
```

In this graph:

- Tasks A, B, C can run in parallel (critical path = 2)
- Task D depends on A, B, C completing
- Task E depends on D

State dependencies explicitly in each task file: "Depends on: task A, task B".

---

## Epic File Format

Write `docs/pm/epics/<slug>/epic.md`:

```markdown
---
name: <slug>
status: backlog
created: <ISO-8601>
progress: 0%
prd: docs/pm/prds/<slug>.md
github: (will be set on sync)
---

# Epic: <Feature Name>

## Overview

<2–3 sentences: what this epic delivers at a technical level>

## Architecture Decisions

<Key technical choices made during decomposition, with rationale>

## Implementation Strategy

<Phased approach if applicable: "Phase 1: data layer, Phase 2: API, Phase 3: UI">

## Tasks

| #   | Title   | Type  | Size | Parallel | AI Role  | Depends On |
| --- | ------- | ----- | ---- | -------- | -------- | ---------- |
| 1   | <title> | task  | m    | ✓        | runner   | none       |
| 2   | <title> | task  | s    | ✓        | runner   | none       |
| 3   | <title> | task  | m    | ✗        | runner   | 1, 2       |
| 4   | <title> | chore | xs   | ✗        | fixer    | 3          |
| 5   | <title> | task  | s    | ✗        | reviewer | 4          |

## Critical Path

<Task N> → <Task N+2> → <Task N+4> (estimated: X hours)

## Parallel Opportunities

- Tasks 1 and 2 can run simultaneously

## Dependencies

- <External dependency name and what it blocks>

## Success Criteria (Technical)

- [ ] <Testable criterion at the code level>

## Estimated Effort

Total: ~N hours (optimistic parallel execution: ~N hours on critical path)
```

---

## Task File Format

Write individual task files to `docs/pm/epics/<slug>/001.md`, `002.md`, etc.:

```markdown
---
name: <Task Title>
status: open
created: <ISO-8601>
updated: <same as created>
github: (will be set on sync)
depends_on: []
parallel: true
conflicts_with: []
ai_role: runner
ai_priority: P2
size: m
---

# Task: <Task Title>

## Description

<What needs to be done — 2–3 sentences. Specific enough that an agent can start
without asking clarifying questions.>

## Acceptance Criteria

- [ ] <Specific, testable criterion>
- [ ] <...>

## Technical Notes

<Relevant file paths, existing patterns to follow, libraries to use>

## Dependencies

Blocked by: <task title(s) or "none">

## Effort Estimate

Size: <xs | s | m | l | xl> — estimated <N> hours
```

---

## Presenting the Decomposition

Show the task table from the epic file. Then ask:

"Does this look right? Say **confirm** to create the epic and task issues in GitHub, or tell me what to change."

Do not create any files or GitHub items until the user confirms. The confirmation is the gate.

---

## After Confirmation

1. Write `docs/pm/epics/<slug>/epic.md`.
2. Write `docs/pm/epics/<slug>/001.md`, `002.md`, ... for each task.
3. Proceed to GitHub sync (see handbook/04-github-sync.md).
4. Set `AI Status = Tasks Ready` on each task item and on the parent PRD item.

---

## Splitting an Oversized Epic

If decomposition produces >10 tasks, consider splitting:

- Group tasks by user story or technical layer
- Create two PRD slugs: `<slug>-v1` and `<slug>-v2`
- Link them with `Dependencies` in each PRD
- Tell the user: "This epic is large (N tasks). I recommend splitting into <slug>-v1 (<N> tasks) and <slug>-v2 (<N> tasks). Proceed with split or keep as one?"

---
title: OpenSpec Commands
description: Spec-driven development workflow for managing code changes with AI-assisted proposal, implementation, and archival.
icon: git-pull-request
---

OpenSpec is a spec-driven development tool from [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) that ensures alignment between humans and AI coding assistants before any code is written. Maestro bundles these workflow commands and keeps them updated automatically.

![OpenSpec Commands in Settings](./screenshots/openspec-commands.png)

## OpenSpec vs. Spec-Kit

Maestro offers two complementary spec-driven development tools:

| Feature | OpenSpec | Spec-Kit |
|---------|----------|----------|
| **Focus** | Change management & proposals | Feature specifications |
| **Workflow** | Proposal → Apply → Archive | Constitution → Specify → Plan → Tasks |
| **Best For** | Iterative changes, brownfield projects | New features, greenfield development |
| **Output** | Change proposals with spec deltas | Feature specifications and task lists |
| **Directory** | `openspec/` | Project root or designated folder |

**Use OpenSpec when:**
- Making iterative changes to existing features
- You need explicit change proposals before implementation
- Working on brownfield projects with existing specifications
- You want a clear archive of completed changes

**Use Spec-Kit when:**
- Defining new features from scratch
- Establishing project constitutions and principles
- Creating detailed feature specifications
- Breaking down work into implementation tasks

Both tools integrate with Maestro's Auto Run for autonomous execution.

## Core Workflow

OpenSpec follows a three-stage cycle:

### Stage 1: Proposal (`/openspec.proposal`)

Create a change proposal before writing any code:

1. Reviews existing specs and active changes
2. Scaffolds `proposal.md`, `tasks.md`, and optional `design.md`
3. Creates spec deltas showing what will be ADDED, MODIFIED, or REMOVED
4. Validates the proposal structure

**Creates:** A `openspec/changes/<change-id>/` directory with:
- `proposal.md` - Why and what
- `tasks.md` - Implementation checklist
- `specs/<capability>/spec.md` - Spec deltas

### Stage 2: Apply (`/openspec.apply`)

Implement the approved proposal:

1. Reads proposal and tasks
2. Implements tasks sequentially
3. Updates task checkboxes as work completes
4. Ensures approval gate is passed before starting

**Tip:** Only start implementation after the proposal is reviewed and approved.

### Stage 3: Archive (`/openspec.archive`)

After deployment, archive the completed change:

1. Moves `changes/<name>/` to `changes/archive/YYYY-MM-DD-<name>/`
2. Updates source-of-truth specs if capabilities changed
3. Validates the archived change

## Maestro-Specific Commands

### `/openspec.implement` - Generate Auto Run Documents

Bridges OpenSpec with Maestro's Auto Run:

1. Reads the proposal and tasks from a change
2. Converts tasks into Auto Run document format
3. Saves to `Auto Run Docs/` with task checkboxes
4. Supports worktree mode for parallel execution

### `/openspec.help` - Workflow Overview

Get help with OpenSpec concepts and Maestro integration.

## Directory Structure

OpenSpec uses a clear separation between current truth and proposed changes:

```
openspec/
├── project.md              # Project conventions
├── specs/                  # Current truth - what IS built
│   └── <capability>/
│       ├── spec.md         # Requirements and scenarios
│       └── design.md       # Technical patterns
└── changes/                # Proposals - what SHOULD change
    ├── <change-name>/
    │   ├── proposal.md     # Why, what, impact
    │   ├── tasks.md        # Implementation checklist
    │   └── specs/          # Spec deltas (ADDED/MODIFIED/REMOVED)
    └── archive/            # Completed changes
```

## Spec Delta Format

Changes use explicit operation headers:

```markdown
## ADDED Requirements
### Requirement: New Feature
The system SHALL provide...

#### Scenario: Success case
- **WHEN** user performs action
- **THEN** expected result

## MODIFIED Requirements
### Requirement: Existing Feature
[Complete updated requirement text]

## REMOVED Requirements
### Requirement: Old Feature
**Reason**: [Why removing]
**Migration**: [How to handle]
```

## Viewing & Managing Commands

Access OpenSpec commands via **Settings → AI Commands** tab. Here you can:

- **View all commands** with descriptions
- **Check for Updates** to pull the latest workflow from GitHub
- **Expand commands** to see their full prompts
- **Customize prompts** (modifications are preserved across updates)

## Auto-Updates

OpenSpec prompts are synced from the [Fission-AI/OpenSpec repository](https://github.com/Fission-AI/OpenSpec):

1. Open **Settings → AI Commands**
2. Click **Check for Updates** in the OpenSpec section
3. New workflow improvements are downloaded
4. Your custom modifications are preserved

## Tips for Best Results

- **Proposal first** - Never start implementation without an approved proposal
- **Keep changes focused** - One logical change per proposal
- **Use meaningful IDs** - `add-user-auth` not `change-1`
- **Include scenarios** - Every requirement needs at least one `#### Scenario:`
- **Validate often** - Run `openspec validate --strict` before sharing
- **Archive promptly** - Archive changes after deployment to keep `changes/` clean

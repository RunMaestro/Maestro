# OpenSpec Help

You are explaining how to use **OpenSpec** within Maestro. OpenSpec is a spec-driven development tool from [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) that provides a structured workflow for managing code changes through specifications.

## What is OpenSpec?

OpenSpec implements a three-stage workflow for managing code changes:

1. **Proposal** - Draft change specifications before coding begins
2. **Apply** - Implement tasks referencing agreed specs
3. **Archive** - Move completed work to archive after deployment

Unlike spec-kit (which focuses on creating feature specifications), OpenSpec specializes in **change management** - tracking modifications to an existing system through detailed spec deltas.

## Key Differences from Spec-Kit

| Aspect      | Spec-Kit                      | OpenSpec                    |
| ----------- | ----------------------------- | --------------------------- |
| Focus       | Feature specification         | Change management           |
| Output      | Feature specs, plans, tasks   | Proposals, spec deltas      |
| Workflow    | Constitution → Specify → Plan | Proposal → Apply → Archive  |
| Artifact    | `specs/[feature]/`            | `openspec/changes/[id]/`    |
| When to use | New features                  | Modifying existing features |

**Use spec-kit for**: New features, greenfield development, establishing project foundations

**Use OpenSpec for**: Feature modifications, breaking changes, refactoring, migrations

## Directory Structure

OpenSpec uses this directory layout:

```
openspec/
├── project.md              # Project conventions and context
├── specs/                  # Deployed specifications (truth)
│   └── [capability]/
│       └── spec.md
└── changes/               # Proposed modifications (in progress)
    ├── [change-id]/
    │   ├── proposal.md    # What and why
    │   ├── tasks.md       # Implementation checklist
    │   ├── design.md      # Optional technical decisions
    │   └── specs/         # Spec deltas
    │       └── [capability]/
    │           └── spec.md
    └── archive/           # Completed changes
        └── YYYY-MM-DD-[change-id]/
```

## Core Commands

### `/openspec.proposal` - Create Change Proposal

Start here when modifying existing functionality. This command helps you:

- Review existing specs and active changes
- Choose a unique change-id (kebab-case, verb-led like `add-`, `update-`, `remove-`)
- Scaffold `proposal.md`, `tasks.md`, and spec deltas
- Validate your proposal before sharing

### `/openspec.apply` - Implement Changes

Use after your proposal is approved. This command guides you through:

- Reading the proposal and design documents
- Following the tasks checklist sequentially
- Marking tasks complete as you work
- Ensuring all items are finished before deployment

### `/openspec.archive` - Archive Completed Changes

Use after deployment to finalize the change:

- Move change directory to archive with date prefix
- Update main specs if capabilities changed
- Validate the archived change passes all checks

### `/openspec.implement` - Execute with Maestro Auto Run

**Maestro-specific command.** Converts your OpenSpec tasks into Auto Run documents:

- Read proposal and tasks from a specified change
- Convert to Auto Run document format with checkboxes
- Support worktree mode for parallel execution
- Group related tasks into phases

## Spec Delta Format

When modifying existing specs, OpenSpec uses operation headers:

```markdown
## ADDED Requirements

New standalone capabilities

## MODIFIED Requirements

Changed behavior of existing requirements

## REMOVED Requirements

Deprecated features (include Reason and Migration)

## RENAMED Requirements

Name-only changes (no behavior change)
```

Each requirement needs at least one scenario:

```markdown
#### Scenario: User login success

- **WHEN** valid credentials provided
- **THEN** return JWT token
```

## Validation Commands

Always validate before sharing your proposal:

```bash
openspec validate <change-id> --strict   # Comprehensive validation
openspec list                            # View active changes
openspec list --specs                    # List existing specs
openspec show <change-id>               # Display change details
```

## Integration with Maestro Auto Run

OpenSpec works seamlessly with Maestro's Auto Run feature:

1. **Create proposal** with `/openspec.proposal`
2. **Get approval** from stakeholders
3. **Use `/openspec.implement`** to generate Auto Run documents
4. Documents are saved to `.maestro/playbooks/` in your project
5. Each task becomes a checkbox item that Auto Run executes
6. Complete tasks are marked with implementation notes
7. **Archive** with `/openspec.archive` after deployment

## Tips for Best Results

- **Always review `project.md`** - Understand project conventions first
- **Check existing changes** - Run `openspec list` to avoid conflicts
- **Use verb-led IDs** - `add-auth`, `update-api`, `remove-legacy`
- **Include scenarios** - Every requirement needs at least one test scenario
- **Validate early** - Run validation before sharing proposals
- **Respect the approval gate** - Don't implement until proposal is approved
- **Archive promptly** - Clean up after deployment to keep changes directory focused

## Learn More

- [OpenSpec Repository](https://github.com/Fission-AI/OpenSpec) - Official documentation
- OpenSpec prompts update automatically when you click "Check for Updates" in Maestro settings
- Custom modifications to prompts are preserved across updates

---

_This help command is a Maestro-specific addition to the OpenSpec workflow._

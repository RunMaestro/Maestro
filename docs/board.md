---
title: Board
description: A persistent task board (a DAG of cards) that dispatches work to Agent Profiles automatically, gated on dependencies and a work-in-progress cap.
icon: kanban
---

The **Board** turns a project into a persistent, git-trackable task graph. Each **card** is a unit of work assigned to an **Agent Profile**, and a card only becomes eligible to run once every card it depends on is `done`. On the Maestro Cue heartbeat, a dispatcher drains the graph: it promotes eligible cards, spawns their assignees, and moves them to `done` or `blocked` based on how the run ended.

The Board is an Encore Feature and depends on **Maestro Cue** (the Board rides Cue's engine tick, so Cue must be enabled too). The manual Board is fully useful on its own; auto-decompose is a separate, off-by-default layer.

## Data model

The board lives in `.maestro/board.yaml` at the project root, alongside `.maestro/cue.yaml`. It is human-diffable and meant to be committed. A board holds an ordered list of cards:

```yaml
boards:
  - id: 8f3c...
    name: Backend rework
    maxInProgress: 2 # optional work-in-progress cap
    autoDecompose: false # optional, off by default
    cards:
      - id: a
        title: Design the schema
        body: Lay out the tables and relationships.
        assigneeProfileId: architect
        parents: []
        status: todo
        createdAt: 2026-07-10T00:00:00.000Z
        updatedAt: 2026-07-10T00:00:00.000Z
      - id: b
        title: Add the migration
        body: Implement the migration from the design.
        assigneeProfileId: builder
        parents: [a] # waits until card "a" is done
        status: todo
```

### Card status

| Status    | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `triage`  | Captured but not groomed. Never auto-run; waits for a human (or auto-decompose).                                   |
| `todo`    | Accepted work, waiting on its parents.                                                                             |
| `ready`   | Derived: a `todo` card whose parents are all `done`. The dispatcher promotes these; you do not hand-write `ready`. |
| `running` | A dispatcher has spawned an agent for this card and it is in flight.                                               |
| `blocked` | A run finished without completing, or a parent regressed. Needs attention.                                         |
| `done`    | Completed successfully. Unblocks children that depend on it.                                                       |

## Profiles

An **Agent Profile** is the "assignee" a card points at. A profile is a named override bundle layered on an existing Left Bar agent (the "base agent"): it overrides the model, reasoning effort, role system-prompt, and optionally extra CLI args, while keeping the base agent's binary, working directory, custom env, and SSH config. Profiles live in `.maestro/profiles.yaml`:

```yaml
profiles:
  - id: architect
    name: Architect
    baseAgentId: agent-1
    model: claude-opus-4-8
    effort: high
    appendSystemPrompt: You are a careful systems designer.
```

At spawn time each field resolves as **profile value, then base agent value, then unset** - so a profile only overrides what it names.

## Dispatcher lifecycle

On each Maestro Cue engine tick, the Board dispatcher runs one pass per board (gated on both the Cue and Board Encore flags, read fresh each tick):

1. **Reclaim** stale `running` cards. A card left `running` with no live process (for example after the app restarted mid-run) is returned to `ready` and its open run is closed as an error.
2. **Auto-decompose** (optional, see below).
3. **Promote** every `todo` card whose parents are all `done` to `ready`.
4. **Claim** the oldest `ready` cards up to the work-in-progress cap, mark each `running`, open a run record, and spawn its assignee. The board is persisted _before_ any spawn resolves, so a crash or the next tick sees the cards as `running` and never double-dispatches them.
5. **Apply** each finished run's outcome (see completion markers).

A card that fails repeatedly is force-blocked by a circuit breaker (two consecutive non-completing runs by default), so a broken card cannot spin forever.

## Completion markers

When a card's agent finishes, it signals the outcome with an HTML-comment marker in its output. These mirror the Auto Run halt marker style:

```text
<!-- maestro:card-complete -->
<!-- maestro:card-complete | one-line summary of what changed -->
<!-- maestro:card-block: reason it could not finish -->
```

Precedence: a block marker wins (the card goes to `blocked`); otherwise a complete marker (or a clean exit with no marker) sends the card to `done`. The optional summary after `card-complete |` is captured onto the card's latest run and surfaced in the UI as an expandable "Last run summary". Cards encourage a four-question handoff in that summary - what changed, how it was verified, what it unblocks, and any residual risk - so the next card inherits useful context. The summary is optional metadata; the run still completes without it.

## WIP limits

`maxInProgress` caps how many cards a board may have `running` at once (default 2). The cap is enforced across the whole board, so already-running cards count against it. This keeps the board from launching every ready card at once and lets you tune throughput per project.

## Auto-decompose (optional, off by default)

With `autoDecompose: true` on a board, the dispatcher may take a `triage` card and run one LLM pass to fan it into a small graph of child cards, with their dependencies wired. It is capped per tick (three triage cards by default) to prevent runaway expansion, and a decomposed triage card is retired to `done` so it is never re-expanded. When the flag is off (the default), `triage` cards simply wait for manual promotion. The decomposition prompt is the editable `board-decompose` core prompt (Settings, Maestro Prompts).

## CLI

The Board and Profiles are fully driveable headlessly with `maestro-cli`, mirroring the in-app actions. Every command resolves the project from a target agent.

```bash
# Profiles
maestro-cli profile list --agent <id-or-name>
maestro-cli profile create --base <agentId> --name Reviewer --model claude-opus-4-8 --effort high --role "Be adversarial."
maestro-cli profile show <profileId> --agent <id-or-name>
maestro-cli profile update <profileId> --agent <id-or-name> --model claude-opus-4-8 --role-prompt "Be adversarial." --args "--verbose"
maestro-cli profile delete <profileId> --agent <id-or-name>

# Boards
maestro-cli board create "Backend rework" --agent <id-or-name> --max-in-progress 2
maestro-cli board list --agent <id-or-name>
maestro-cli board show <boardId> --agent <id-or-name>
maestro-cli board rename <boardId> "New name" --agent <id-or-name>
maestro-cli board delete <boardId> --agent <id-or-name> [--force]

# Cards
maestro-cli board add-card <boardId> --agent <id-or-name> --title "Design schema" --assignee <profileId> --body "..." --parents <id1,id2> --worktree
maestro-cli board update-card <cardId> --agent <id-or-name> --title "Design the schema" --priority high
maestro-cli board remove-card <cardId> --agent <id-or-name>
maestro-cli board set-status <cardId> done --agent <id-or-name>

# Run one dispatcher pass headlessly (promote, claim, spawn, apply)
maestro-cli board tick --agent <id-or-name>

# ...or keep ticking until Ctrl-C
maestro-cli board watch --agent <id-or-name> --interval 60
```

`board tick` reuses the same promotion, WIP, and completion logic as the desktop dispatcher and the same agent spawn path as the rest of the CLI, so SSH remotes and profile model/effort/role overrides are honored exactly as they are in the app. Drive an entire board to `done` by adding cards with dependencies, then running `board tick` until nothing is left to promote. Add `--json` to any command for machine-readable output.

A few behaviors worth knowing:

- `board create` is the bootstrap command: a board id is all the other commands need, so you never have to open the app to start a headless workflow.
- `board delete` refuses a board that still has cards which are not `done` unless you pass `--force`. It takes the whole board, cards and run history included.
- `board update-card` and `profile update` change only the flags you actually pass. Pass an empty string (`--assignee ""`, `--model ""`) to clear a field. `profile update` keeps the profile's id, so cards assigned to that role keep working; `profile create` would mint a new id and leave them pointing at nothing.
- A `running` card cannot be edited, and removing one needs `--force`. The CLI has no handle on the in-flight agent process (it belongs to whichever dispatcher started it), so it cannot stop the run for you - use the stop button on the card in the app.
- `board watch` is just `board tick` on a timer (default 30 seconds, minimum 5), stopped with Ctrl-C. It does not daemonize and takes no lock. If the desktop app is open with Cue running, it is already ticking the same boards: overlapping is safe, but pick one.

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
  - id: 8f3c1d2e
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
        priority: high # optional: high | normal | low (normal is the default and is not written)
        createdAt: 2026-07-10T00:00:00.000Z
        updatedAt: 2026-07-10T00:00:00.000Z
      - id: b
        title: Add the migration
        body: Implement the migration from the design.
        assigneeProfileId: builder
        assigneeAgentId: agent-2 # optional: pin this card to one agent
        parents: [a] # waits until card "a" is done
        status: done
        worktree: # optional: run this card in its own checkout
          branch: board/8f3c1d2e/b
          path: /home/you/worktrees/board/8f3c1d2e/b
        runs: # one entry per dispatch attempt, appended by the dispatcher
          - attempt: 1
            startedAt: 2026-07-10T00:05:00.000Z
            endedAt: 2026-07-10T00:19:00.000Z
            outcome: done
            summary: Added the migration and a round-trip test.
            workerAgentId: agent-2
            worktreeBranch: board/8f3c1d2e/b
```

Cards are written by hand or by the app; the `runs` list, the derived statuses, and the timestamps are the dispatcher's bookkeeping. Each run records one attempt and never disappears, so a card that took three tries keeps all three.

### Run outcomes

| Outcome     | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `done`      | The run completed (complete marker, or a clean exit with no marker).                          |
| `blocked`   | The run asked for a human (block marker) or exited non-zero with no completion signal.        |
| `error`     | The run could not be carried out (spawn failure, killed process).                             |
| `reclaimed` | The app was restarted mid-run, so the attempt was abandoned and the card returned to `ready`. |
| `canceled`  | You pressed stop on the card.                                                                 |

`reclaimed` and `canceled` runs do not count toward the circuit breaker: neither one says anything about whether the work is doable.

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

1. **Reclaim** stale `running` cards. A card left `running` with no live process (for example after the app restarted mid-run) is returned to `ready` and its open run is closed as `reclaimed`.
2. **Auto-decompose** (optional, see below).
3. **Promote** every `todo` card whose parents are all `done` to `ready`.
4. **Claim** `ready` cards up to the work-in-progress cap, mark each `running`, open a run record, and spawn its assignee. The board is persisted _before_ any spawn resolves, so a crash or the next tick sees the cards as `running` and never double-dispatches them.
5. **Apply** each finished run's outcome (see completion markers).

A card that fails repeatedly is force-blocked by a circuit breaker (two consecutive non-completing runs by default), so a broken card cannot spin forever.

### Dispatch order and priority

When more cards are `ready` than the WIP cap allows, they are claimed by **priority descending** (`high`, then `normal`, then `low`), then **oldest first** within a priority, then board order. A card with no `priority` counts as `normal`, so raising one card to `high` is enough to jump the queue without re-prioritizing everything else. Set it in the card editor or with `--priority high` on `board add-card` / `board update-card`.

## Stopping a running card

Press **Stop** on a `running` card to kill its agent process. The card goes back to `todo` (from where it is promoted again once you are ready) and the attempt is recorded as a `canceled` run, which does not count against the circuit breaker. A cancel is safe to press even if the run happens to finish at the same moment: the late result is discarded rather than overwriting the cancellation.

Cancellation is a desktop-app action. `maestro-cli` cannot stop a run, because the agent process belongs to whichever dispatcher started it, in another process.

## Notifications

Terminal card transitions raise a toast:

- **Card done** - green, auto-dismissing. Names the worktree branch when the run was isolated.
- **Card blocked** - red and sticky, because it is waiting on you. Click to dismiss.

Both are stamped as coming from **Board**. When a card is in flight, the Main Window header also shows a small Board pill with the number of `running` and `ready` cards across the project; click it to open the Board. The pill hides itself when nothing is happening.

## Multiple boards

A project can hold as many boards as you like in the same `.maestro/board.yaml`. Use the board picker in the Board window header to switch, rename, or delete the current board, and **New board** to create one. Maestro remembers the last board you had open per project.

Every board is dispatched independently, each with its own `maxInProgress` cap and its own view of which workers are busy, so splitting work across boards raises total concurrency. Keep that in mind if you rely on the pool's one-card-per-worker rule: it holds within a board, and two boards in the same project can hand the same agent a card at the same time. Pin cards to different agents, or keep parallel work on one board, if that matters to you.

Deleting a board takes its cards and their run history with it, so a board with anything that is not `done` asks for confirmation first (`--force` from the CLI).

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

## Worktree cards

A card can run in its own git worktree instead of the shared project directory. Turn on **Run in isolated worktree** in the card editor, or pass `--worktree` to `board add-card` / `board update-card`. Parallel cards then edit different working trees, so two agents dispatched in the same tick cannot collide on each other's files or git state.

What happens:

- The checkout is created on the card's first run, on branch `board/<board-id>/<card-id>` (the full ids, sanitized for git, so two cards can never share a checkout), in a `worktrees/` folder beside your project directory. Set an explicit path or branch on the card to override either.
- Retries reuse the same worktree, so a second attempt continues the work instead of starting from a clean tree.
- When the card finishes, the branch name appears in the completion toast, as a badge on the card tile, and under the card's **Last run summary**.
- Nothing is merged or deleted for you. The branch and its checkout stay exactly where the agent left them.

Merging a finished card branch back yourself:

```bash
# From your main checkout
git merge board/8f3c1d2e/b

# Then, when you no longer need the isolated checkout
git worktree remove ../worktrees/board/8f3c1d2e/b
git branch -d board/8f3c1d2e/b
```

Worktree cards are local-only: an agent configured to run over an SSH remote executes on the remote host, where a worktree created on your machine does not exist. Such a card is blocked with a clear reason rather than quietly running in the shared project directory. Clear its worktree setting or move it to a local agent.

## CLI

The Board and Profiles are fully drivable headlessly with `maestro-cli`, mirroring the in-app actions. Every command resolves the project from a target agent.

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

`board tick` reuses the same promotion, WIP, and completion logic as the desktop dispatcher and the same agent spawn path as the rest of the CLI, so SSH remotes and profile model/effort/role overrides are honored exactly as they are in the app. Drive an entire board to completion by adding cards with dependencies, then running `board tick` until every card is terminal (`done` or `blocked`) - a single pass can leave cards `running`, `ready`, or awaiting a retry, so check `board show --json` (card `status` fields) rather than stopping after a quiet tick. Add `--json` to any command for machine-readable output.

A few behaviors worth knowing:

- `board create` is the bootstrap command: a board id is all the other commands need, so you never have to open the app to start a headless workflow.
- `board delete` refuses a board that still has cards which are not `done` unless you pass `--force`. It takes the whole board, cards and run history included.
- `board update-card` and `profile update` change only the flags you actually pass. Pass an empty string (`--assignee ""`, `--model ""`) to clear a field. `profile update` keeps the profile's id, so cards assigned to that role keep working; `profile create` would mint a new id and leave them pointing at nothing.
- A `running` card cannot be edited, and removing one needs `--force`. The CLI has no handle on the in-flight agent process (it belongs to whichever dispatcher started it), so it cannot stop the run for you - use the stop button on the card in the app.
- `board watch` is just `board tick` on a timer (default 30 seconds, minimum 5), stopped with Ctrl-C. It does not daemonize and takes no lock. Running two dispatchers on the same board (the desktop app with Cue enabled, plus a `watch`) is unsupported: each one can overwrite the other's latest card transition, because their read-modify-write cycles are not serialized across processes (atomic writes only prevent torn files). Pick one dispatcher per board - the CLI tick is meant for headless projects the app is not also dispatching.

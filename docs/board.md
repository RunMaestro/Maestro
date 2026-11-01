---
title: Board
description: A persistent board (a DAG of cards) that dispatches work to Agent Profiles automatically, gated on dependencies and a work-in-progress cap.
icon: kanban
---

The **Board** is a central, persistent graph of work across projects. Cards carry their own execution scope and repository; their creator does not need to be a worker. Dependencies must be done before a card can run. Maestro Cue drives dispatch through the shared host runtime.

Board and Maestro Cue are Encore Features and both must be enabled for automatic dispatch.

## Central storage and migration

Maestro stores collections, cards, runs, profiles and worker configuration centrally in its local database. Existing project `.maestro/board.yaml` and `.maestro/profiles.yaml` files are imported as sources, preserving their identities and run history; repeated discovery does not duplicate them or overwrite central edits. Machine-local worker and group identities are not automatically exported to project files.

Each source has an explicit identity and profile namespace. Select the source to manage its advanced roles; no active project agent is required. If a source or captured reference cannot be resolved, use its explicit revalidation and repair flow. Migration provenance and safety holds are retained; repair does not guess a replacement source. SSH sources use their configured remote identity, never a local interpretation of a remote path. Remote worktree, review artifact and PR operations that cannot be verified are reported as unsupported or unresolved.

## Workers and execution scope

Manage existing workers, create workers, assign roles and pause intake from the Board. Each executable card requires either one agent or one group as its scope. A group card may additionally require a role or pin a member. Membership, availability, role, repository and working directory are checked again at claim time; a missing or busy target waits with a reason instead of falling back to another worker or directory. Existing worker markings are migrated into the central registry.

The board default controls whether new cards enter with approval required or are directly eligible; a card can override it. New boards default to approval, and imported cards retain their prior intent. A required approval is granted through the desktop, not by changing a status or passing CLI authority flags. Open the saved card and choose **Approve start**. Save pending edits first so the action approves the specification you read. The editor shows the refreshed host approval state; if approval is rejected, it keeps your draft and displays the error. Start approval leaves holds and human review unchanged.

## Cards and runs

Use separate linked work, review, test and documentation cards when these need distinct assignments and results. Add Review captures the source run's verified branch, worktree, exact commit and check evidence for the review card. An agent review is separate from the human approval of a card in Review; it does not create an automatic review/fix loop.

A run records an attempt and its result, including the worker and original scope. Runs and their histories remain available across reloads.

### Run outcomes

| Outcome     | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `done`      | The run completed (complete marker, or a clean exit with no marker).                          |
| `review`    | The run finished its work but asked a human to approve it (review marker).                    |
| `blocked`   | The run asked for a human (block marker) or exited non-zero with no completion signal.        |
| `error`     | The run could not be carried out (spawn failure, killed process).                             |
| `reclaimed` | The app was restarted mid-run, so the attempt was abandoned and the card returned to `ready`. |
| `canceled`  | You pressed stop on the card, which also holds it (see below).                                |

`reclaimed` and `canceled` runs do not count toward the circuit breaker: neither one says anything about whether the work is doable. A `review` run resets the breaker the way `done` does, because it reached a deliberate conclusion rather than failing.

### Card status

| Status    | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `triage`  | Captured but not groomed. Never auto-run; waits for a human (or auto-decompose).                                   |
| `todo`    | Accepted work, waiting on its parents. Also where a card you stopped waits, held until you resume it.              |
| `ready`   | Derived: a `todo` card whose parents are all `done`. The dispatcher promotes these; you do not hand-write `ready`. |
| `running` | A dispatcher has spawned an agent for this card and it is in flight.                                               |
| `review`  | The work is finished but a human must approve it before it counts. Not a failure, and never auto-retried.          |
| `blocked` | A run finished without completing, or a parent regressed. Needs attention.                                         |
| `done`    | Completed successfully. Unblocks children that depend on it.                                                       |

### Review: work that needs a human

`review` exists so that "I finished, but somebody should look at this" stops being confused with "I got stuck", which is what `blocked` means. A card lands in `review` when its agent emits the review marker (see completion markers below), or when you move it there yourself.

A card sitting in `review` is inert: nothing retries it, nothing counts it against the circuit breaker, and it holds no slot against the WIP cap. Crucially it does **not** unblock its children - a child only becomes eligible once every parent is strictly `done` - so a card parked for approval keeps the work behind it parked too.

A human approves the review through the desktop review action. Ordinary status edits and CLI commands cannot grant that approval. Until approval, dependent cards remain waiting.

## Profiles

A role uses the existing **Agent Profile** override fields, including model, effort, role prompt and extra arguments. The Board's advanced profile editor operates on the selected source namespace. At spawn, a profile override takes precedence over the base agent's corresponding value; omitted fields retain the base value. Imported namespaces remain distinct rather than being merged by name.

## Dispatcher lifecycle

The desktop Cue bootstrap installs the central Board runtime behind the same host entry used by desktop controls and authenticated CLI commands. On each existing heartbeat, it scans every registered collection, including sources without an open project agent. Both Cue and Board feature flags must be enabled.

1. Re-read current group membership, registered worker availability, role and pin requirements, repository evidence, approval, holds, dependencies and global/collection WIP limits.
2. Claim each eligible card and worker atomically in SQLite. A pin outside its scope, an empty pool, disabled/paused worker or another active reservation produces a waiting reason in Cue's log; execution never falls back outside the scope.
3. Start the fenced attempt through the existing Cue run service. Persisted claims, native process start and completed work are separate states. Native runs participate in Cue's drain/stop accounting.
4. Apply a result only to its matching owner, attempt and run token. Reconciliation retains uncertain starts and reservations until native termination evidence exists; elapsed time or a missing in-memory process alone cannot release capacity.

A card that fails repeatedly is force-blocked by a circuit breaker (two consecutive non-completing runs by default), so a broken card cannot spin forever.

### Dispatch order and priority

When more cards are `ready` than the WIP cap allows, they are claimed by **priority descending** (`high`, then `normal`, then `low`), then **oldest first** within a priority, then board order. A card with no `priority` counts as `normal`, so raising one card to `high` is enough to jump the queue without re-prioritizing everything else. Set it in the card editor or with `--priority high` on `board add-card` / `board update-card`.

## Stopping a running card

Press **Stop** on a `running` card to kill its agent process. The attempt is recorded as a `canceled` run, which does not count against the circuit breaker. A cancel is safe to press even if the run happens to finish at the same moment: the late result is discarded rather than overwriting the cancellation.

Stop is a **hold**, not a pause that expires. The card returns to **To Do** carrying an explicit user hold, and the dispatcher's promote pass skips held cards entirely, so it will not be picked up again on the next tick or any tick after it. A held tile shows a `held` badge so it is clear why it is sitting still.

Press **Resume** on the tile, or use `board resume` with the exact run token after termination. Ordinary card edits and status moves preserve holds.

A held card does **not** unblock its children, exactly like any other non-`done` card: a child only becomes eligible once every parent is strictly `done`. So stopping a card parks the work behind it too.

Desktop Stop and CLI `board hold` use the same host runtime and exact persisted run token. Stop sets a durable hold immediately; capacity stays reserved until the owning run service confirms termination. `board resume` clears only the hold after termination and never grants dispatch or review approval.

## Notifications

Terminal card transitions raise a toast:

- **Card done** - green, auto-dismissing. Names the worktree branch when the run was isolated.
- **Card needs review** - yellow and sticky, carrying the reason the agent gave. It is waiting on your approval.
- **Card blocked** - red and sticky, because it is waiting on you. Click to dismiss.

A card that opened a pull request raises one more toast: green with the PR link (click it to open the PR), or red and sticky with the `gh` error if the PR could not be created.

Both are stamped as coming from **Board**. When a card is in flight, the Main Window header also shows a small Board pill with the number of `running` and `ready` cards across the project; click it to open the Board. The pill hides itself when nothing is happening.

## Multiple boards

Collections can contain multiple boards and sources. Use the board picker to switch, rename, delete or create a board. Each board has its own WIP cap, while worker reservations are global across collections: the same managed worker cannot claim two cards at once. Managed desktop and headless starts also participate in admission; external unmanaged processes and terminals are outside this guarantee.

Deleting a board takes its cards and their run history with it, so a board with anything that is not `done` asks for confirmation first (`--force` from the CLI).

## Completion markers

When a card's agent finishes, it signals the outcome with an HTML-comment marker in its output. These mirror the Auto Run halt marker style:

```text
<!-- maestro:card-complete -->
<!-- maestro:card-complete | one-line summary of what changed -->
<!-- maestro:card-review: what a human needs to check -->
<!-- maestro:card-block: reason it could not finish -->
```

Precedence: a block marker wins (the card goes to `blocked`); then a review marker (the card goes to `review`); otherwise a complete marker (or a clean exit with no marker) sends the card to `done`. Both the block and the review marker are authoritative - they beat even a non-zero exit and are never retried. The reason after `card-review:` is optional and lands on the card's run as its summary, so it shows in the toast and on the tile.

Cards are told to fix whatever they can safely fix and card-complete it, to use card-review when the work is done but needs human judgment or verification, and to reserve card-block for genuinely being stuck. The optional summary after `card-complete |` is captured onto the card's latest run and surfaced in the UI as an expandable "Last run summary". Cards encourage a four-question handoff in that summary - what changed, how it was verified, what it unblocks, and any residual risk - so the next card inherits useful context. The summary is optional metadata; the run still completes without it.

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

### Open a PR when the card is done

An isolated card can open a pull request for its branch the moment it finishes. Turn on **Open PR when done** in the card editor's worktree section (it only appears once **Run in isolated worktree** is on) and optionally name a **PR target branch**; leave that blank to target the repository's default branch, resolved when the PR is actually opened when the PR is opened.

What happens when such a card reaches `done`: Maestro pushes the card's branch and runs `gh pr create` against the target branch, with the card title as the PR title and the card body plus the run's handoff summary as the PR description. The resulting URL is toasted, stored on the card's run as `prUrl`, and never opened twice for the same run. Nothing is merged - the branch is still yours to merge, the PR just puts it in front of a reviewer.

This fires from both routes into `done`: a run that completed on its own, and the human approval move when a card was parked in **Review**. So the natural pairing is a card that emits `card-review`, waits for you, and opens its PR at the moment you approve it.

Requirements and edges worth knowing:

- The [GitHub CLI](https://cli.github.com) (`gh`) must be installed and authenticated. A failure (no `gh`, no auth, a rejected push) raises a red sticky toast and leaves the card `done` - the PR is a side effect, never a gate on the card's status.
- The option only does anything on a card with worktree isolation on and a branch actually recorded on its last run. A card that ran in the shared project root has no branch to open a PR for and is silently skipped.
- The shared host runtime handles automatic completion, including requests initiated by `board tick`. Manual completion also uses the run checkout and exact run identity.
- Removing the toggle or isolation disables this option for future completion.

Worktree cards are local-only: an agent configured to run over an SSH remote executes on the remote host, where a worktree created on your machine does not exist. Such a card is blocked with a clear reason rather than quietly running in the shared project directory. Clear its worktree setting or move it to a local agent.

## CLI

Board list, show, capture and CRUD commands use the running Maestro host through its authenticated command bridge. With no filter, `board list --json` returns all central collections. `--agent` selects that agent's registered project; `--project-root`, `--source` and `--collection` select explicit central identities. Legacy board/card IDs or prefixes are accepted only when the filtered host snapshot resolves exactly one match. Mutations require a project root or target agent, and never infer a repository from the creator's working directory.

Use `--revision` and `--card-revision` to retain a previously read optimistic concurrency token. Without these flags, the command reads the current host snapshot and submits its revisions; a concurrent write is still rejected. JSON failures retain the readable `error` and include machine-readable `details.code`, `details.message` and host capture errors. An unavailable host returns an error without falling back to a local database.

Capture accepts `--scope-agent` or `--scope-group`, optional `--assignee-agent` pin, `--assignee` with `--profile-namespace`, `--repository`, `--working-directory` and `--start-mode direct|approval`. The host validates current membership and repository boundaries. Any Maestro agent can capture a draft without joining the worker registry. Missing execution bindings remain non-executable drafts. Required dispatch approval and human review cannot be granted by CLI status edits or authority flags; an already authorized direct policy remains usable. Tick/watch use the same host claim/lifecycle entry.

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
maestro-cli board add-card <boardId> --agent <id-or-name> --source <sourceKey> --title "Design schema" --scope-group <groupId> --assignee <profileId> --profile-namespace <namespace> --repository <repositoryId> --working-directory <path> --body "..." --parents <id1,id2> --worktree
maestro-cli board update-card <cardId> --agent <id-or-name> --title "Design the schema" --priority high
maestro-cli board remove-card <cardId> --agent <id-or-name>
maestro-cli board set-status <cardId> done --agent <id-or-name>

# Run one dispatcher pass headlessly (promote, claim, spawn, apply)
maestro-cli board tick --agent <id-or-name>

# ...or keep ticking until Ctrl-C
maestro-cli board watch --agent <id-or-name> --interval 60
```

`board tick` reuses the same promotion, WIP, and completion logic as the desktop dispatcher and the same agent spawn path as the rest of the CLI, using the configured source and worker identity. Unsupported remote operations fail visibly rather than falling back to local paths. Drive an entire board to completion by adding cards with dependencies, then running `board tick` until every card is terminal (`done`, `review`, or `blocked`) - a single pass can leave cards `running`, `ready`, or awaiting a retry, so check `board show --json` (card `status` fields) rather than stopping after a quiet tick. Add `--json` to any command for machine-readable output.

A few behaviors worth knowing:

- `board create` uses the running host. Mutations require a registered project/source and unambiguous collection identity.
- `board delete` refuses a board that still has cards which are not `done` unless you pass `--force`. Force only bypasses unfinished-card confirmation; running cards must still be stopped first. Deletion takes the whole board, cards and run history included.
- `board update-card` and `profile update` change only the flags you actually pass. Pass an empty string (`--assignee ""`, `--model ""`) to clear a field. `profile update` keeps the profile's id, so cards assigned to that role keep working; `profile create` would mint a new id and leave them pointing at nothing.
- A `running` card cannot be edited, moved or removed. Use `board hold <cardId> --run-id <id> --owner-epoch <n> --generation <n> --agent <agent> --json` to request Stop on the exact host attempt; `--force` cannot release its reservation. Use `board resume` with that token after termination.
- `board set-status` accepts manual statuses (`triage`, `todo`, `review`, `blocked`, `done`), but cannot approve a human review or grant required dispatch approval. For a qualifying card carrying `prOnDone`, this command opens the pull request and waits for the result. Automatic completion uses the shared host PR service as well.
- `board tick` and `board watch` request the existing host runtime through the authenticated command socket. They never open a Board DB, spawn an agent, reclaim a run by age or start a scheduler locally. `watch` polls that same host entry (default 30 seconds, minimum 5) until Ctrl-C. Concurrent desktop/CLI requests share fenced claims and attempts. Missing host/owner and conflicts return machine-readable errors or per-card waiting reasons. A successful intake reports `accepted` and a run token; it does not establish process execution or task success.
- CLI `board approve` cannot grant required human approval. The native `board.runtimeCommand` IPC endpoint derives that authority from the actual desktop main-frame sender, with grants bound to the captured specification revision. Hold/Resume and ordinary status changes preserve required approval.
- The desktop Cue/bootstrap context installs `configureBoardRuntimeHost` with the central owner and existing Cue lock/run service. CLI requests attach to this owner; they do not create one. An unavailable owner returns `runtime-unavailable`. Legacy `boardWorker` session markers no longer participate in active dispatch; the migrated central registry and migration holds remain authoritative.

Cards display their explicit agent or group scope and the host's current waiting reasons. Capture responses and global Refresh use the same read-only worker eligibility checks as claims, including current membership, role and repository access. Empty eligible scopes, paused intake, durable reservations, native busy/dormant workers, required start approval and Hold remain visible. Missing native occupancy evidence is reported as unknown. An otherwise available card waits for Cue's final dispatch checks; reading a card never claims, releases or renews a reservation. Intake pause prevents new Board starts while existing work continues.

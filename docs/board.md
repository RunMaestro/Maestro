---
title: Board
description: A persistent board (a DAG of cards) that dispatches work to Agent Profiles automatically, gated on dependencies and a work-in-progress cap.
icon: kanban
---

The **Board** is a central, persistent graph of work across projects. Cards carry their own execution scope and repository; their creator does not need to be a worker. Dependencies must be done before a card can run. Maestro Cue drives dispatch through the shared host runtime.

Board and Maestro Cue are Encore Features and both must be enabled for automatic dispatch.

## Central storage and migration

For developer-only rendered qualification, see [[board-rendered-fixture]] for the
owned entrypoint, source/build binding and fresh isolated catalog preparation.

The host exposes an explicit global bootstrap: desktop callers use
`window.maestro.board.initialize()`, and authenticated bridge callers send
`{ action: 'initialize' }`. It returns the existing Board storage envelope with
source, collection and revision identities. Use `maestro-board-source:` plus the
returned `storage.sourceKey` as the capture command's `projectRoot`; this is an
opaque reference, not a filesystem path or an execution directory. Initialization
is idempotent across processes and defaults new captures to required approval.
`queryWorkspace` and storage queries do not initialize this destination. Cards
can be captured without a repository or working directory; they remain waiting
with `repository-unresolved` until execution metadata is explicitly supplied.

Maestro stores collections, cards, runs, profiles and worker configuration centrally in its local database. Existing project `.maestro/board.yaml` and `.maestro/profiles.yaml` files are imported as sources, preserving their identities and run history; repeated discovery does not duplicate them or overwrite central edits. Machine-local worker and group identities are not automatically exported to project files.

The common card surface reads existing collections in place; migration never moves them into the global capture destination or rekeys colliding legacy IDs. Each source retains its own profile namespace, original file bytes, worker provenance, DAG and run history. Explicit execution scopes, namespaced references and repository/CWD metadata remain authoritative, including unresolved values. Shared legacy options are read internally and are not flattened into one worker configuration. Duplicate identities and uncertain runs remain fenced. Repeating an import preserves central revisions, approvals, reservations, edited worker options and migration history; changed input is reported without replacing the first import. Import failures roll back the entire transaction.

Explicit imported approval policies remain required even for `todo` cards. Older import snapshots are checked against their original policy without rewriting their ledger. Legacy `todo`/`ready` cards without an explicit policy retain their original direct intent; new global captures use the conservative approval default.

Migration keeps executable `ready` separate from `ready-for-human`. Existing Done records retain their history without acquiring a fabricated human decision. Work/Review links and original run IDs remain in their source snapshot; new mapping receipts also relate each original run ID and attempt to its namespaced ledger row. Imported history does not become native execution or review evidence. Reopen and replay accept both Buffer and Uint8Array SQLite snapshots without rewriting those bytes.

Each source has an explicit identity and profile namespace; no active project agent is required. If a source or captured reference cannot be resolved, use its explicit revalidation and repair flow. Migration provenance and safety holds are retained; repair does not guess a replacement source. SSH sources use their configured remote identity, never a local interpretation of a remote path. Remote worktree, review artifact and PR operations that cannot be verified are reported as unsupported or unresolved.

The shared card surface reads one global snapshot, including source locations. Changes arriving during a read request one subsequent refresh; push-driven refresh reads do not overlap. Message drafts and usage updates do not reload the workspace or capture catalog. Filtered host reads hydrate only the requested source, and Cue yields between collections and cards while retaining its current claim and revision checks. Source and group membership changes still refresh the relevant data, and the host revalidates every execution request against current state.

## Workers and execution scope

Manage existing workers, create workers, assign roles and pause intake from the Board. Each executable card requires either one agent or one group as its scope. A group card may additionally require a role or pin a member. Membership, availability, role, repository and working directory are checked again at claim time; a missing or busy target waits with a reason instead of falling back to another worker or directory. Existing worker markings are migrated into the central registry.

In **Workers**, enter a **New role** name and choose **Create role**, then select that role for each worker that may take it. This works in an empty installation. New roles use the global Board source and a host-generated ID; they do not pin an agent or add execution overrides. Worker options stay on each worker. Existing namespaced roles and their original options remain available without being rewritten. Creating a role or granting access never grants start approval.

In the card editor, **Required role (optional)** selects an existing role by its name, namespace and ID. Identical names or IDs in different sources remain separate choices. **Any role within scope** removes that requirement; **Pin to agent** can additionally require one specific worker. A legacy role may also be bound to a particular base agent, shown next to its name. Conflicts with scope or pin are rejected by the host, and unavailable roles remain visible for repair. Editing other fields preserves legacy references and their provenance. This selector does not create or edit profiles; worker role access stays in **Workers**.

For the same CLI workflow, create a role with `maestro-cli board create-role "Reviewer" --json`. Assign its returned exact identity with `board worker-role <role-id> --namespace <namespace> --agent <worker>` (the agent must already be registered in **Workers**). Add `--remove` to remove only that grant. Read `maestro-cli board catalog --json`, then use `board add-card --title "Review" --scope-group <group-id> --role <role-id> --role-namespace <namespace>`. Use the same role flags with `board update-card <card-id>`, or `--role ""` to clear the requirement. The legacy `--assignee` and `--profile-namespace` spellings remain supported; contradictory aliases are rejected. Role selection never guesses a namespace or changes the group's membership or approval policy.

Read a registered worker's options with `maestro-cli board worker-options --agent <worker-id> --json`. To change only selected overrides, pass a JSON patch, for example `--set '{"customModel":"example-model","customEffort":null}'`. The supported fields are `customModel`, `customEffort`, `appendSystemPrompt`, and `customArgs`; `null` clears an override and restores inheritance. The host checks that the worker has not changed since the CLI read it. If it has, read and retry deliberately.

In **Workers**, expand a worker's **Execution options** to set its model, effort, appended system prompt and extra CLI arguments. These values apply only to that worker. Clearing model or effort restores inheritance; the prompt and arguments also have explicit Inherit actions (an empty override deliberately clears that value). Saving checks the worker snapshot so an older editor cannot overwrite a newer change.

Worker overrides take priority over the legacy source explicitly referenced by a card, then the agent's own values. Cards without a legacy reference use worker overrides and agent values. Role access grants do not choose a default source. **Stored options and legacy origins** retains namespaced references, source identities, shared worker usage and unknown compatible fields; conflicting sources remain separate and conflicting card references cannot run. Changing a worker never edits a shared legacy source or historical run. Each new run snapshots the resolved values and their provenance and rechecks them against current configuration before launch.

The board default controls whether new cards enter with approval required or are directly eligible; a card can override it. New boards default to approval, and imported cards retain their prior intent. A required approval is granted through the desktop, not by changing a status or passing CLI authority flags. Open the saved card and choose **Approve start**. Save pending edits first so the action approves the specification you read. The editor shows the refreshed host approval state; if approval is rejected, it keeps your draft and displays the error. Start approval leaves holds and human review unchanged.

Worker lifecycle also uses the shared host: `board worker-list`, `worker-show`,
`worker-register`, `worker-unregister`, `worker-pause`, and `worker-resume` accept
an exact `--agent` ID where needed. Read the current snapshot before a mutation;
the host refuses stale worker state. `role-update` and `role-delete` require the
exact source and namespace, and referenced roles remain protected. For legacy
sources, `source-preview`, `source-export`, `source-suppress` and `source-restore`
use explicit source identities, verified backups and receipts. Workspace revision
is informational: edits to other sources or workers do not block cleanup. The
host compares the selected source's migration, location, collections, cards,
history, holds and archives against the hash-bound backup. Restore is bound to
the saved suppression receipt and rejects later edits to that source or a reused
receipt. Pre-upgrade suppressions without a saved receipt retain their original
conservative workspace revision check. Names alone never authorize cleanup.

## Shared collection deletion command

The authenticated Board command host accepts `delete-cards` with one explicit
`target` (`projectRoot`, `sourceKey`, `collectionKey`, `expectedRevision`) and a
`cards` array of `{ cardId, cardRevision }` read from that collection. The payload
must contain 1-500 entries. Identical entries are deduplicated; conflicting
revisions for the same card are rejected. The shared card view previews selections by collection, and `board remove-cards`
uses this same command.

The host queues the collection once and validates every selected card against
the same initial snapshot. It detaches deleted dependencies and passes surviving
ancestors through selected parent chains in memory, then calls the existing
revisioned save once. Running cards, reservations, stale revisions and protected
surviving dependencies reject the whole collection. Archival retains original
card payloads and run history. No partial success receipts are returned on error.

A successful result includes source and collection IDs, previous and committed
collection revisions, one deletion receipt per distinct card (previous and
committed tombstone revision), and the saved surviving board. Multiple
collections require separate explicit requests and receipts; there is no
transaction spanning projects or collections and no automatic revision retry.

## Cards and runs

Use separate linked work, review, test and documentation cards when these need distinct assignments and results. Add Review captures the source run's verified branch, worktree, exact commit and check evidence for the review card. Set an explicit reviewer within the task scope. Native work completion queues a separate review card with the work run ID, clean checkout, branch, commit, binary diff digest and reported checks. Review uses the existing Cue runner and current worker admission. Missing or unavailable reviewers leave the work waiting.

A run records an attempt and its result, including the worker and original scope. Runs and their histories remain available across reloads.

### Run outcomes

| Outcome     | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `done`      | The native run completed; successful work still enters its assigned artifact review.          |
| `review`    | The run finished and requested its assigned artifact review (review marker).                  |
| `blocked`   | The run asked for a human (block marker) or exited non-zero with no completion signal.        |
| `error`     | The run could not be carried out (spawn failure, killed process).                             |
| `reclaimed` | The app was restarted mid-run, so the attempt was abandoned and the card returned to `ready`. |
| `canceled`  | You pressed stop on the card, which also holds it (see below).                                |

`reclaimed` and `canceled` runs do not count toward the circuit breaker: neither one says anything about whether the work is doable. A `review` run resets the breaker the way `done` does, because it reached a deliberate conclusion rather than failing.

### Card status

| Status            | Meaning                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `triage`          | Captured but not groomed. Never auto-run; waits for a human (or auto-decompose).                                   |
| `todo`            | Accepted work, waiting on its parents. Also where a card you stopped waits, held until you resume it.              |
| `ready`           | Derived: a `todo` card whose parents are all `done`. The dispatcher promotes these; you do not hand-write `ready`. |
| `running`         | A dispatcher has spawned an agent for this card and it is in flight.                                               |
| `review`          | Work completed; its explicitly assigned artifact reviewer is pending.                                              |
| `ready-for-human` | The bound review has no open findings; final human approval is pending.                                            |
| `blocked`         | A run finished without completing, or a parent regressed. Needs attention.                                         |
| `done`            | Completed successfully. Unblocks children that depend on it.                                                       |

### Linked artifact review and final human decision

The workflow is To Do -> In Progress -> Review -> Ready for Human -> Done. Internal `ready` means eligible to execute, never ready for human approval. A claim only reserves capacity. `running` is recorded after the existing native runner reports its process and exact persisted run ID.

A successful work attempt enters `review`. Its explicit reviewer must belong to the current task scope, be registered and have repository access. The host creates one linked review task for the completed work attempt. That task can review its exact parent while the parent is in Review; ordinary dependents still require Done. Scope, membership, registration, pause, pin, occupancy and artifacts are checked again before native review launch.

If successful work has no reported check summary or clean Git artifact with a bound diff, the card waits in `blocked` with **Review evidence is incomplete**. Its host-owned `workflow.evidenceIncomplete` names the missing evidence and exact run ID; the successful native result and attempt history stay intact. After addressing the missing evidence, explicitly move the same card to **To Do** (or use `board set-status <cardId> todo`). The host checks the read revision and normal claim, scope and start-approval rules again. A new successful attempt must still pass its linked review and final human decision. Existing stranded Review cards without a review task receive the same recovery state on the next host review pass.

Reviewers emit `<!-- maestro:card-complete | checks and report -->` for a clean review or `<!-- maestro:card-findings: confirmed defects and checks -->` for findings. The host checks the artifact again at completion. A clean review moves the work to `ready-for-human`. Findings queue one traceable correction attempt with the review report in its prompt. Findings on the correction block further automatic work. Earlier work and review attempts remain in history.

Only an explicit native desktop main-frame decision may move the reviewed work and its review task to `done`. Ordinary status edits, captures, CLI commands, successful process exits and completion markers cannot grant that decision. The grant records the exact work and review run IDs. Start approval remains a separate, configurable policy. Final approval does not merge or deploy anything.

## Worker execution options

Choose workers and edit their execution options in the Board's **Workers** tab. For each option, a worker's explicit value takes precedence over an explicitly referenced legacy card profile, which takes precedence over the base agent's value. Unset options retain the next applicable value. Legacy profiles and their namespaces remain available internally for existing cards; they are not a separate profile editor. Conflicting or unresolved legacy references prevent dispatch rather than selecting an arbitrary profile.

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

## Shared Board view

The desktop Board shows cards from every collection together, with no project or board selection. New cards are captured in the stable global collection, even when no agent or project is active. Each existing card retains its source and collection: editing, moving, approving, stopping and deleting it targets that owner and the revision shown. Dependencies remain within the owning collection. A card without a repository or execution directory can be captured and waits for those execution details.

Each collection retains its own WIP cap, while worker reservations are global: the same managed worker cannot claim two cards at once. Managed desktop and headless starts also participate in admission; external unmanaged processes and terminals are outside this guarantee. CLI collection operations remain available for existing collections.

## Completion markers

When a card's agent finishes, it signals the outcome with an HTML-comment marker in its output. These mirror the Auto Run halt marker style:

```text
<!-- maestro:card-complete -->
<!-- maestro:card-complete | one-line summary of what changed -->
<!-- maestro:card-review: what a human needs to check -->
<!-- maestro:card-block: reason it could not finish -->
```

Only a final standalone marker is authoritative; quoted examples and earlier markers are ignored. Precedence: a block marker wins (the card goes to `blocked`); then a review marker (the card goes to `review`); otherwise a complete marker (or a clean exit with no marker) records a completed run and sends work to `review`. Only the final native human decision sends the card to `done`. Both the block and the review marker are authoritative - they beat even a non-zero exit and are never retried. The reason after `card-review:` is optional and lands on the card's run as its summary, so it shows in the toast and on the tile.

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

An isolated card can open a pull request for its branch after the final human decision marks the work done. Turn on **Open PR when done** in the card editor's worktree section (it only appears once **Run in isolated worktree** is on) and optionally name a **PR target branch**; leave that blank to target the repository's default branch, resolved when the PR is opened.

What happens when such a card reaches `done`: Maestro pushes the card's branch and runs `gh pr create` against the target branch, with the card title as the PR title and the card body plus the run's handoff summary as the PR description. The resulting URL is toasted, stored on the card's run as `prUrl`, and never opened twice for the same run. Nothing is merged - the branch is still yours to merge, the PR just puts it in front of a reviewer.

Native work completion keeps this option inert. A configured PR is opened only after the final human decision on work in Ready for Human.

Requirements and edges worth knowing:

- The [GitHub CLI](https://cli.github.com) (`gh`) must be installed and authenticated. A failure (no `gh`, no auth, a rejected push) raises a red sticky toast and leaves the card `done` - the PR is a side effect, never a gate on the card's status.
- The option only does anything on a card with worktree isolation on and a branch actually recorded on its last run. A card that ran in the shared project root has no branch to open a PR for and is silently skipped.
- The PR uses the recorded run checkout and exact run identity after the final human decision; a worker finishing or a `board tick` does not grant that decision.
- Removing the toggle or isolation disables this option for future completion.

Worktree cards are local-only: an agent configured to run over an SSH remote executes on the remote host, where a worktree created on your machine does not exist. Such a card is blocked with a clear reason rather than quietly running in the shared project directory. Clear its worktree setting or move it to a local agent.

## CLI

Board list, show, capture and CRUD commands use the running Maestro host through its authenticated command bridge. With no filter, `board list --json` returns all central collections. `board add-card --title "Task"` captures into the global Board without a project or execution directory. Specify `--scope-agent` or `--scope-group` and, when needed, `--repository` and `--working-directory` as card execution metadata. `--agent` selects that agent's registered project; `--project-root`, `--source` and `--collection` select explicit central identities when a board ID is supplied. Legacy board/card IDs or prefixes are accepted only when the filtered host snapshot resolves exactly one match. No repository is inferred from the creator's working directory.

Use `--revision` and `--card-revision` to retain a previously read optimistic concurrency token. Without these flags, the command reads the current host snapshot and submits its revisions; a concurrent write is still rejected. JSON failures retain the readable `error` and include machine-readable `details.code`, `details.message` and host capture errors. An unavailable host returns an error without falling back to a local database.

Capture accepts `--scope-agent` or `--scope-group`, optional `--assignee-agent` pin, `--assignee` with `--profile-namespace`, `--repository`, `--working-directory` and `--start-mode direct|approval`, and `--reviewer-agent <id>` for an explicit scoped reviewer. The host validates current membership and repository boundaries. Any Maestro agent can capture a draft without joining the worker registry. Missing execution bindings remain non-executable drafts. Required dispatch approval and human review cannot be granted by CLI status edits or authority flags; an already authorized direct policy remains usable. Tick/watch use the same host claim/lifecycle entry.

```bash
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
maestro-cli board remove-cards --source <sourceKey> --collection <collectionKey> --revision <revision> --cards '[{"cardId":"<cardId>","cardRevision":1}]' --json
maestro-cli board set-status <cardId> todo --agent <id-or-name>

# Request one fenced host dispatch pass
maestro-cli board tick

# ...or keep ticking until Ctrl-C
maestro-cli board watch --interval 60
```

`remove-cards` sends one atomic transaction for the specified collection. Use the exact source,
collection and card revisions from the snapshot you reviewed; a conflict rejects the collection
without deleting cards. Successful JSON output includes the committed collection and card revisions.

`board tick` requests a dispatch pass for all Board collections by default. Use `--agent`, `--source`, `--collection`, or `--board` to narrow the selection. It uses the host's scope, approval, worker, repository and WIP checks; unsupported remote operations fail visibly rather than falling back to local paths. A single pass can leave cards running or waiting. `board show-card <cardId> --json` reads the card and host readiness reasons; `board card-runs <cardId> --json` reads its persisted attempts and results with collection and revision identity. Both reject ambiguous card IDs. Clear an assignment with `board update-card <cardId> --scope-agent ""`; the unassigned card waits for a valid scope. Add `--json` to any command for machine-readable output.

A few behaviors worth knowing:

- `board create` uses the running host. Mutations require a registered project/source and unambiguous collection identity.
- `board delete` refuses a board that still has cards which are not `done` unless you pass `--force`. Force only bypasses unfinished-card confirmation; running cards must still be stopped first. Deletion takes the whole board, cards and run history included.
- A `running` card cannot be edited, moved or removed. Use `board hold <cardId> --run-id <id> --owner-epoch <n> --generation <n> --agent <agent> --json` to request Stop on the exact host attempt; `--force` cannot release its reservation. Use `board resume` with that token after termination.
- `board set-status` submits a revision-bound status request to the host. Ordinary requests cannot enter `running`, `review`, `ready-for-human` or `done`, or grant required start approval. A native run, its linked artifact review and the final desktop human decision own those transitions. A configured PR-on-done action waits for that final decision.
- `board tick` and `board watch` request the existing host runtime through the authenticated command socket. They never open a Board DB, spawn an agent, reclaim a run by age or start a scheduler locally. `watch` polls that same host entry (default 30 seconds, minimum 5) until Ctrl-C. Concurrent desktop/CLI requests share fenced claims and attempts. Missing host/owner and conflicts return machine-readable errors or per-card waiting reasons. A successful intake reports `accepted` and a run token; it does not establish process execution or task success.
- CLI `board approve` cannot grant required human approval. The native `board.runtimeCommand` IPC endpoint derives that authority from the actual desktop main-frame sender, with grants bound to the captured specification revision. Hold/Resume and ordinary status changes preserve required approval.
- The desktop Cue/bootstrap context installs `configureBoardRuntimeHost` with the central owner and existing Cue lock/run service. CLI requests attach to this owner; they do not create one. An unavailable owner returns `runtime-unavailable`. Legacy `boardWorker` session markers no longer participate in active dispatch; the migrated central registry and migration holds remain authoritative.

Cards display their explicit agent or group scope and the host's current waiting reasons. Capture responses and global Refresh use the same read-only worker eligibility checks as claims, including current membership, role and repository access. Empty eligible scopes, paused intake, durable reservations, native busy/dormant workers, required start approval and Hold remain visible. Missing native occupancy evidence is reported as unknown. An otherwise available card waits for Cue's final dispatch checks; reading a card never claims, releases or renews a reservation. Intake pause prevents new Board starts while existing work continues.

### Managed worker transport

Admission-managed headless turns use Current control. Native control is rejected
before provider preparation until its SDK lifecycle can establish the terminal
condition needed to release a worker. Ordinary native-control callers are unaffected.
A cancellation request does not release a running child; an unconfirmed SSH stop
retains the worker reservation because the local client cannot prove remote exit.

The isolated Board fixture toolchain (`scripts/board-rendered-*.cjs`, native and performance preparation tools) requires Node 24 for built-in SQLite and its qualified Node ABI. This toolchain requirement does not change the application engine range. A native addon must match the runtime that loads it.

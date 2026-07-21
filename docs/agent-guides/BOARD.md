<!-- Verified 2026-07-22 against build/board-profiles-fullaccess -->

# Board & Agent Profiles

Guide for the Board (a persistent task DAG) and Agent Profiles (assignee override bundles). Read this before editing `src/main/board/`, `src/shared/board/`, `src/main/profiles/`, `src/shared/profiles/`, or the `board:*` / `profiles:*` IPC and CLI surfaces.

The Board is an Encore Feature that **depends on Maestro Cue** (it rides Cue's engine tick, no second timer). It was built in two passes:

- **Original build:** Profiles, data model + YAML storage, the dispatcher on the Cue tick, the kanban UI, CLI + optional auto-decompose + docs, and the opt-in **worker pool**.
- **The 10x pass** (this branch): storage hardening (1), cancellation + push events + toasts + priority (2), full CLI lifecycle parity (3), per-card worktree isolation (4), plugin-bus board events (5), a11y + multi-board UI (6).

---

## Layout

```text
src/shared/board/
├── types.ts          # Board / BoardCard / CardStatus / CardRun / WorktreeRef + validators (pure)
├── graph.ts          # getEligibleCards / getBlockers / hasCycle / countActiveCards (pure DAG helpers)
├── cardMarkers.ts    # parseCardMarkers + CARD_HANDOFF_REMINDER (pure)
├── pool.ts           # Phase 6 worker-pool selection: isPathWithin / selectPoolAgentIds (pure)
└── worktree.ts       # per-card worktree branch/path naming (pure)

src/main/board/
├── board-storage.ts    # single owner of .maestro/board.yaml (load/save/mutations)
├── board-dispatcher.ts # pure-ish orchestrator: promote / claim / apply / reclaim (side effects injected)
├── board-spawn.ts      # host wiring: resolve profile -> base agent, run via executeCuePrompt
├── board-worktree.ts   # per-card worktree provisioning (wraps setupWorktreeLocal)
└── board-decompose.ts  # OPTIONAL auto-decompose (off by default): parse + fan a triage card

src/shared/profiles/types.ts   # AgentProfile + resolveProfileSpawnOverrides + validator (pure)
src/main/profiles/profile-storage.ts  # single owner of .maestro/profiles.yaml

src/main/ipc/handlers/board.ts / profiles.ts   # thin IPC transport
src/main/preload/board.ts / profiles.ts        # bridge + `board:changed` / `profiles:changed` subscriptions
src/renderer/components/BoardModal.tsx          # kanban UI
src/renderer/components/BoardStatusIndicator.tsx # running/ready pill in the Main Window header
src/renderer/components/ProfilesModal/          # profiles UI
src/cli/commands/board.ts / profile.ts          # CLI parity
```

**Purity boundary:** everything under `src/shared/**` is framework-free (no Electron, no fs) so it runs in main, renderer, and CLI alike. `board-spawn.ts` is main-only (it imports the Cue executor). `board-storage.ts` / `profile-storage.ts` only touch `fs` + `js-yaml` + the shared validators, so the CLI imports them directly - there is **one** storage implementation, shared by IPC and CLI (no drift).

---

## Data model (`.maestro/board.yaml`)

A single top-level `boards:` list; each board owns its `cards:`. See [board.md](../board.md) for the YAML shape and the card-status table. Key invariants enforced in `board-storage.ts`:

- **Load fails closed.** Three distinct outcomes, and the distinction is the whole point: a **missing** file returns `[]` (the normal "no board yet" case, plus an empty file or an absent `boards:` key); a file that exists but cannot be read or parsed throws `BoardStorageError`; a valid file returns its boards. The old behavior returned `[]` on a read failure, and the next `saveBoards` then wrote that empty list over the top and destroyed every board the user had. Failing closed keeps the damaged file on disk where a human can fix it. Individual malformed cards are still skipped with a logged warning (via `validateBoard` / `validateBoardCard`) so one bad entry never blocks the rest, and duplicate board ids keep the first occurrence.
- **Writes are atomic.** `saveBoards` serializes to YAML and hands it to `atomicWriteFileSync` (`src/main/utils/atomic-json-store.ts`): write `board.yaml.tmp`, then `renameSync` over `board.yaml`. A crash or a concurrent reader sees the whole old file or the whole new file, never a truncated one. `profile-storage.ts` and `cue-yaml-write.ts` use the same helper - do not hand-roll a `writeFileSync` for any `.maestro/*.yaml`.
- **Async read-modify-write callers serialize through the shared write chain.** `enqueueBoardWrite(projectRoot, work)` runs `work` on a per-file promise chain built from `createKeyedWriteQueue()` (same module), keyed by the absolute board.yaml path so two projects never block each other. The storage mutations themselves are synchronous and cannot interleave inside one tick, but anything that reads, `await`s, then writes (the dispatcher's spawn cycle, IPC handlers) MUST go through the queue or it will clobber a concurrent mutation.
- **Save rejects cycles.** `saveBoards` runs `hasCycle` and throws before writing, so the DAG invariant the dispatcher relies on can never be persisted.
- **`autoDecompose?: boolean`** is off by default and only serialized when `true`.
- **Deletes keep the DAG referentially intact.** `deleteCard` splices the dead id out of every other card's `parents` AND reattaches the deleted card's own parents to its children (grandparent adoption), so deleting a middle card neither wedges its children forever nor lets them jump ahead of work they depended on. `deleteBoard` refuses a board with any non-`done` card unless `{ force: true }`.

`CardRun` records one dispatch attempt: attempt number, timestamps, `outcome`, an optional `summary` captured from the completion marker, the `workerAgentId` that ran it (pool), and `worktreePath` / `worktreeBranch` when the attempt was isolated. Cards accumulate one run per attempt so retries are auditable. `CardRunOutcome` is `done | blocked | error | reclaimed | canceled` (`CARD_RUN_OUTCOMES` is the runtime mirror used by the validator).

`priority?: CardPriority` (`high | normal | low`) is never serialized when `normal`: an absent priority and an explicit `normal` mean the same thing, and `cardPriorityRank` defaults it.

---

## Profiles (`.maestro/profiles.yaml`)

An `AgentProfile` is a named override bundle (a _role_: model / effort / role-prompt / args). `resolveProfileSpawnOverrides(profile, baseValues)` merges each field as **profile -> running agent -> undefined** and returns `{ customModel, customEffort, appendSystemPrompt, customArgs }` - which map 1:1 onto the existing `SpawnAgentOptions` / `process:spawn` fields. Profiles invent **no** new spawn parameters.

`baseAgentId` is **optional** (Phase 6):

- **Set** -> the profile pins its overrides to that specific agent (the classic "layer on a base agent"). The Board dispatches such a card to exactly that agent.
- **Absent** -> a pure _pool role_ the Board floats to any FREE opt-in worker in the project, layering the role's overrides on whichever agent picks it up.

Create a pool role from the CLI with `profile create --base <agent> --pool` (`--base` only locates the project), or in the Profiles UI by choosing base agent "None (pool role)".

---

## Dispatcher lifecycle

`BoardDispatcher` (in `board-dispatcher.ts`) is deliberately pure-ish: `loadBoard`, `saveBoard`, `resolveOverrides`, and `spawn` are all injected, so the promotion / WIP / completion logic is unit-tested with fakes (no Electron, no fs, no real process). One dispatcher instance owns one board.

Per `tick()`:

1. `reclaimStaleRunning` - a `running` card with no in-flight spawn whose run started > `DEFAULT_STALE_RUNNING_MS` ago is returned to `ready` (engine-restarted-mid-run recovery). Its open run closes with the `reclaimed` outcome, NOT `error`: the host abandoned the attempt, the card did nothing wrong, and the breaker must not count it.
2. `promoteEligibleCards` - `todo` cards with all parents `done` -> `ready` (uses `getEligibleCards`, the single eligibility rule).
3. `claimReadyCards` - claim the oldest `ready` cards up to `maxInProgress` (default `DEFAULT_MAX_IN_PROGRESS = 2`), mark `running`, open a run. **The board is persisted here, before any spawn resolves,** so re-entrant ticks see `running` and don't double-dispatch.
4. For each claim, `resolveOverrides` then `spawn`; on completion, `applyCardResult` sets the terminal status.

**Cancel.** `cancelCard(cardId)` kills a `running` card's process through the injected `cancelSpawn` dep (`cancelBoardCardRun` in `board-spawn.ts`, which remembers the Cue `runId` per card and calls `stopCueRun`) and finalizes the card back to `todo` with a `canceled` run. The card id is tombstoned BEFORE the kill so the spawn promise resolving moments later (with a `null` exit) is discarded instead of re-finalizing the card as a failure. `canceled` and `reclaimed` runs are both skipped by the breaker's `trailingFailureCount`. IPC entry point is `board:cancelCard` -> `CueEngine.cancelBoardCard`, with a storage-only finalize fallback when no dispatcher owns the board (app restarted mid-run).

**Notify.** The optional `notify` dep announces terminal transitions (`done` / `blocked`, including force-blocks). `index.ts` maps it onto the existing `remote:notifyToast` relay (green auto-dismiss / red sticky, `sourceAgent: 'Board'`). The payload is presentation-free; the dispatcher never picks colors.

**Dispatch order.** `readyCardsInDispatchOrder` is the single ordering rule for both claim paths: `priority` descending (`high` > `normal` > `low`, absent = `normal`), then `createdAt` ascending, then board order.

`applyCardResult` precedence: **block marker -> `blocked` (outcome `blocked`); complete marker or clean exit -> `done` (outcome `done`); otherwise a failed run** (outcome `error` when the spawn errored or the exit code is `null`, else `blocked`) that retries (`ready`) until the circuit breaker (`DEFAULT_MAX_FAILURES = 2` consecutive non-completing runs) forces `blocked`. A card whose profile can't be resolved is force-blocked immediately (bypassing the breaker - retrying a missing profile is pointless). The worktree path/branch is stamped on the run for EVERY outcome, failures included: the branch still exists and is worth inspecting.

**Status-change hook.** `snapshotCardStatuses` before a mutation and `diffCardStatuses` after it produce the transitions that were actually persisted, which is what the injected `onStatusChanged` dep (and, through it, the plugin bus) reports. A promote and a claim landing in the same save collapse into one `todo -> running` change - that is deliberate: it matches what an observer reading `board.yaml` would see. Cards that appeared mid-tick (auto-decompose children) are skipped, since they never transitioned.

**Engine wiring:** `cue-engine.ts` `boardDispatchTick()` runs on the shared heartbeat, dual-gated on `maestroCue && board` (read fresh each tick). It keeps one `BoardDispatcher` per `${projectRoot}::${boardId}`, created lazily and dropped when the board vanishes. The host side effects are injected from `src/main/index.ts` via `board-spawn.ts` (`resolveCardOverrides`, `resolveCardAssignment`, `spawnBoardCard`), which run the card through the SAME `executeCuePrompt` path Cue uses - so SSH config, custom env/path, and token-source selection are honored (never bypass the SSH path).

---

## Worker pool (Phase 6)

By default (no `assign` dep) the dispatcher runs the **legacy path**: one card resolves to one pinned agent via `resolveOverrides`. When the injected `assign` dep is present (it is, in both `index.ts` and the CLI), the dispatcher runs the **pooled path** (`tickPooled` -> `claimReadyCardsPooled`):

- **Pool = opt-in + in-directory.** An agent is an eligible worker only when its session has `boardWorker: true` **and** its working dir is inside the board's project dir (or a sub-folder). `selectPoolAgentIds` (in `pool.ts`) is the single definition, shared by `index.ts` and the CLI. The `boardWorker` toggle lives on `EditAgentModal` (default OFF - an interactive agent is never hijacked).
- **Assignee resolution** (`resolveCardAssignment` in `board-spawn.ts`, mirrored by `resolveCliAssignment`): a named-but-missing profile -> `unresolvable` (block); a pinned agent (`card.assigneeAgentId`, or a legacy profile's `baseAgentId`) -> a single candidate; a role-only card -> the free project pool. The first candidate **not** already running a board card wins (`computeBusyAgentIds` recomputes the busy set from the persisted board each tick, so "one card per worker" survives restarts - the worker id is stamped on `CardRun.workerAgentId`).
- **All busy -> wait, don't block.** When every candidate is busy (or the pool is empty), `assign` returns `no-free-worker`; the card stays `ready` and retries on a later tick. Concurrency is bounded by free-worker count **and** the WIP cap (whichever is lower).
- **Card assignee** (`BoardCard`): `assigneeProfileId` (role) and/or `assigneeAgentId` (pin); at least one is required (`validateBoardCard`). Set from `BoardModal` (Role + "Pin to agent" selects) or the CLI (`board add-card --assignee <profileId> --assignee-agent <agentId>`).
- **The busy set is per board, not per project.** `computeBusyAgentIds(board)` reads only the board being ticked, and each board gets its own `BoardDispatcher`, so "one card per worker" is a per-board guarantee: two boards in the same project can assign the same agent concurrently. Fixing it means a project-wide busy set computed across every board before any of them claim - a deliberate non-goal so far, not an oversight.

---

## Worktree isolation (per card)

A card carrying a `WorktreeRef` runs in its own checkout instead of the shared project root, so cards dispatched in the same tick cannot collide.

- **One provisioning implementation.** `setupWorktreeLocal` in `src/main/utils/git-worktree.ts` is the only local `git worktree add` in the app: the `git:worktreeSetup` IPC handler (Auto Run) and `ensureCardWorktree` in `board-worktree.ts` (Board) both call it. Do NOT hand-roll git worktree shell calls.
- **Naming** comes from `src/shared/board/worktree.ts` (pure, so the renderer editor, the CLI `--worktree` flag, and the dispatcher agree): branch `board/<boardId-8>/<cardId-8>`, checked out at `<sibling-of-projectRoot>/worktrees/<branch>`. The sibling layout is mandatory - `setupWorktreeLocal` refuses a worktree nested inside the main repo.
- **Lifecycle:** created lazily on the first claim that spawns the card, reused by every retry, never auto-deleted and never auto-merged. The branch is surfaced in the completion toast, on the card tile, and in the "Last run summary"; merging is the user's job (see [board.md](../board.md)).
- **The cwd switch happens in the spawner, not the dispatcher.** `board-spawn.ts` passes the checkout as `CueExecutionConfig.projectRoot` (which IS the spawn cwd); the CLI passes it as `spawnAgent`'s cwd. The resolved path/branch come back on `CardSpawnResult` and `applyCardResult` stamps them onto the `CardRun`.
- **SSH is refused, not silently downgraded.** An agent with `sshRemoteConfig.enabled` executes on the remote host where a locally created worktree does not exist, so an isolated card on such an agent is blocked with a reason.

---

## Plugin-bus board events

The Board publishes four read-only topics on the plugin event bus so other plugins can build on it. All four are declared in `src/shared/plugins/events.ts` (`PLUGIN_EVENT_TOPICS` + `PluginEventPayloads`) and emitted from `src/main/index.ts` through the board deps the Cue engine calls.

| Topic                     | Fired from                           | Payload                                                                                                  |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `board.cardStatusChanged` | `onCardStatusChanged` dep            | `boardId`, `cardId`, `cardTitle`, `fromStatus`, `toStatus`, `attempt?`, `workerAgentId?`, `projectPath?` |
| `board.cardCompleted`     | `notifyCard` dep (`kind: 'done'`)    | ids + `attempt?`, `workerAgentId?`, `worktreeBranch?`, `projectPath?`                                    |
| `board.cardBlocked`       | `notifyCard` dep (`kind: 'blocked'`) | ids + `attempt?`, `workerAgentId?`, `outcome?` (the enum, never the reason text)                         |
| `board.decomposed`        | `onBoardDecomposed` dep              | `boardId`, `triageCardCount`, `projectPath?`                                                             |

- **Metadata only, and that is a rule, not a default.** No prompt body, run output, run summary, or block reason ever rides these topics. `cardTitle` is the single human-authored string, shipped because it is the card's identity in the UI (note that auto-decomposed titles originate from a model). `board.cardBlocked` carries the `outcome` CLASSIFICATION precisely so a subscriber never needs the free-form reason. Keep any new field on this side of that line.
- **The same call site does both jobs.** `notifyCard` in `index.ts` emits the plugin event AND fires the `remote:notifyToast` relay; the toast carries the summary, the event does not.
- **Null-safe throughout.** Every emit goes through `pluginEventBus?.emit(...)`, and the deps themselves are optional on `CueEngineDeps`, so the dispatcher runs unchanged when plugins are off or when the CLI owns the tick (the CLI wires no bus).
- **Host-API version.** These topics shipped in `HOST_API_VERSION = '1.15.0'` (`src/shared/plugins/host-api.ts`). 1.14.0 was skipped: upstream `rc` had already taken it.
- **First-party manifest.** `BOARD_FIRST_PARTY_PLUGIN` in `src/shared/plugins/first-party.ts` declares the Board's broker capabilities (`settings:read`, `sessions:read`, `notifications:toast`, scoped `fs:read` / `fs:write` on `.maestro/`). `agents:dispatch` and `process:spawn` are deliberately ABSENT: the Board dispatches to a dynamically-resolved target that a static manifest scope cannot name, so that authority stays host-owned until the runtime grant seam in [rfc-runtime-dispatch-grants.md](../../Plans/rfc-runtime-dispatch-grants.md) exists. Per-card worktree provisioning is host-owned for the same reason.

---

## Completion markers & handoff

`parseCardMarkers` (in `cardMarkers.ts`, mirrors `goalMarkers.ts`) scans a run's output for `<!-- maestro:card-complete [| summary] -->` and `<!-- maestro:card-block[: reason] -->`, last-match-wins. `CARD_HANDOFF_REMINDER` (also in `cardMarkers.ts`, so CLI and desktop share one copy) is prepended to every card prompt to encourage the four-question handoff in the summary. The captured summary lands on `CardRun.summary` and is surfaced in `BoardModal` as an expandable "Last run summary". It is optional metadata - the run completes without it (falling back to the exit status).

---

## Auto-decompose (optional, off by default)

`board-decompose.ts` is framework-free and strictly gated: `autoDecomposeBoard` returns `0` immediately unless `board.autoDecompose === true`. When on, it takes up to `DEFAULT_AUTO_DECOMPOSE_PER_TICK` (3) `triage` cards, runs one LLM pass each (the injected `spawn` + the editable `board-decompose` prompt), parses the fenced-JSON child list with `parseDecomposition` (which clamps `dependsOn` to earlier, in-range, non-self indices so the produced sub-graph is always acyclic), appends the children as `todo` cards wired to the triage umbrella + siblings, and retires the triage card to `done` so it is never re-expanded.

- **CLI:** `board tick` calls `autoDecomposeBoard` inside `tickBoard`, loading the template via `getCliPrompt`.
- **Desktop:** `cue-engine.ts` `maybeAutoDecompose` fires the optional `decompose` dep (wired in `index.ts` with `getPrompt` + `decomposeBoardCard`) as a guarded, fire-and-forget step; the `boardDecomposeInFlight` set prevents a slow pass from being relaunched and a triage card double-expanded. Children are dispatched on a subsequent tick.

The prompt is registered in `src/shared/promptDefinitions.ts` (`PROMPT_IDS.BOARD_DECOMPOSE`, file `src/prompts/board-decompose.md`) so it is editable in Settings -> Maestro Prompts.

---

## CLI

`src/cli/commands/board.ts` and `profile.ts` mirror the IPC surface via the same storage modules. Every command resolves the project root from `--agent` (id or name). `board tick` reuses the pure dispatcher helpers (`promoteEligibleCards` / `claimReadyCards` / `applyCardResult` / `reclaimStaleRunning`) and the existing CLI `spawnAgent` path - it does **not** fork a second spawn implementation. Commands follow the repo's try/catch-at-boundary convention (throw internally, print + `process.exit(1)` once in the catch). See [cli-reference](../cli-reference.md) for the flag matrix; user-facing overview in [board.md](../board.md).

Full lifecycle parity (Phase 3 of the 10x pass), so a CI box never needs the desktop app:

| Board                                                     | Profile                                          |
| --------------------------------------------------------- | ------------------------------------------------ |
| `create` / `rename` / `delete` / `list` / `show`          | `create` / `update` / `show` / `list` / `delete` |
| `add-card` / `update-card` / `remove-card` / `set-status` |                                                  |
| `tick` (one pass) / `watch` (loop)                        |                                                  |

Rules worth knowing before you extend this surface:

- **Storage owns the guard rails, not the CLI.** `deleteBoard` refuses a board with any non-`done` card unless `{ force: true }`, so the desktop path inherits the same rule (`board:delete` IPC forwards the flag). Do not re-implement a check like this in a command.
- **Editing is id-preserving.** `profile update` upserts with the EXISTING id. `profile create` mints a new UUID, which orphans every card whose `assigneeProfileId` points at the old one - that was the entire bug this command fixes.
- **Only the flags you pass are touched.** `board update-card` and `profile update` diff against the stored record; an explicit empty string (`--assignee ''`, `--model ''`) is the clear operation, and a call with no flags is refused rather than silently rewriting the file.
- **The CLI cannot cancel a run.** A `running` card's process belongs to whichever dispatcher claimed it, in another process. `board update-card` refuses a `running` card outright; `board remove-card --force` deletes it but says plainly that the run was not canceled. Do not add a command that claims to stop an agent it has no handle on.
- **`board watch` is deliberately dumb.** One shared `tickBoardsOnce` pass on a timer (`--interval`, default 30s, floor 5s), stopped by SIGINT, which also wakes the sleep so Ctrl-C is instant. No daemon, no lock file, no PID file. Overlapping it with the desktop Cue engine tick is _safe_ (board.yaml writes are atomic and serialized per file) but still discouraged. A storage failure exits non-zero instead of spinning on a damaged file.

---

## Gotchas

- **Board requires Cue.** The dual gate is read fresh each tick; the Extensions pane also disables the Board toggle while Cue is off (`BUILTIN_DEPENDENCIES` in `extensionModel.ts`).
- **The pool never hijacks an interactive agent.** Only agents with `boardWorker: true` are auto-assigned role-only cards; the flag defaults OFF. A card can still _pin_ any in-project agent by name regardless of the flag (explicit intent). Board card spawns are independent headless `executeCuePrompt` runs - they do **not** attach to the agent's live AI tab.
- **Persist before spawn.** Never reorder `claimReadyCards` after the spawn - the pre-spawn save is what prevents double-dispatch.
- **`ready` is derived.** Authors write `todo`; the dispatcher computes `ready`. Do not hand-persist `ready` cards expecting them to stay put.
- **The kanban does not poll.** `saveBoards` fires the `setBoardSavedListener` hook, the host (`src/main/index.ts`, next to the other startup wiring) broadcasts `board:changed { projectRoot }` to every window via `safeSend`, and both `BoardModal` (through `window.maestro.board.onBoardChanged`) and the header's `BoardStatusIndicator` refetch on it. `saveProfiles` mirrors it exactly: `setProfilesSavedListener` -> `profiles:changed` -> `window.maestro.profiles.onProfilesChanged` -> `ProfilesModal`. Both hooks live in the host, not in storage, because the CLI imports the same storage modules and has no `webContents`; both are advisory (a listener that throws is logged and never fails the write that already landed). There is exactly one listener per store, set once at startup, last-write-wins - do not add a second broadcast site.
- **Worktree isolation refuses SSH, it does not downgrade.** `board-spawn.ts` blocks an isolated card whose base agent has `sshRemoteConfig.enabled` with `WORKTREE_SSH_UNSUPPORTED` (from `board-worktree.ts`) instead of provisioning locally. A local checkout is invisible to an agent executing on a remote host, so "isolate it anyway" would silently run the card in the wrong tree. The remote variant (`worktreeSetupRemote` in `utils/remote-git.ts`) is deliberately NOT wired in - do not reach for it without designing remote cleanup first.
- **Keyboard parity is a "Move to" picker, not ARIA drag-and-drop.** Tiles are `role="button" tabIndex={0}`; arrows walk the grid, Enter opens the card, `m` opens its editor focused on the "Move to" select (which persists through `setCardStatus` immediately, with the same running/derived-status guards as a drop), and Delete twice removes it. Native HTML5 DnD stays for pointer users only - do not reimplement it as a custom ARIA drag surface.
- **Multi-board selection is a UI preference, not a setting.** The last board opened per project lives in `localStorage` under `maestro.board.lastBoardId:<projectRoot>`, next to the other view-state keys. It is deliberately not in the settings store: nothing outside the modal reads it.
- **Cross-platform paths.** All board/profile file paths go through `path.join` on `BOARD_CONFIG_PATH` / `PROFILES_CONFIG_PATH` (`src/shared/maestro-paths.ts`), and project roots come from stored sessions - no separator or home-dir assumptions, so the Windows CI leg stays green.

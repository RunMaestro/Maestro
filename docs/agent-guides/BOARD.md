<!-- Verified 2026-07-10 against feat/board-and-profiles -->

# Board & Agent Profiles

Guide for the Board (a persistent task DAG) and Agent Profiles (assignee override bundles). Read this before editing `src/main/board/`, `src/shared/board/`, `src/main/profiles/`, `src/shared/profiles/`, or the `board:*` / `profiles:*` IPC and CLI surfaces.

The Board is built in phases: Profiles (1), data model + YAML storage (2), the dispatcher on the Cue tick (3), the kanban UI (4), CLI + optional auto-decompose + docs (5), and the opt-in **worker pool** (6). It is an Encore Feature that **depends on Maestro Cue** (it rides Cue's engine tick, no second timer).

---

## Layout

```text
src/shared/board/
├── types.ts          # Board / BoardCard / CardStatus / CardRun / WorktreeRef + validators (pure)
├── graph.ts          # getEligibleCards / getBlockers / hasCycle (pure DAG helpers)
├── cardMarkers.ts    # parseCardMarkers + CARD_HANDOFF_REMINDER (pure)
└── pool.ts           # Phase 6 worker-pool selection: isPathWithin / selectPoolAgentIds (pure)

src/main/board/
├── board-storage.ts    # single owner of .maestro/board.yaml (load/save/mutations)
├── board-dispatcher.ts # pure-ish orchestrator: promote / claim / apply / reclaim (side effects injected)
├── board-spawn.ts      # host wiring: resolve profile -> base agent, run via executeCuePrompt
└── board-decompose.ts  # OPTIONAL auto-decompose (off by default): parse + fan a triage card

src/shared/profiles/types.ts   # AgentProfile + resolveProfileSpawnOverrides + validator (pure)
src/main/profiles/profile-storage.ts  # single owner of .maestro/profiles.yaml

src/main/ipc/handlers/board.ts / profiles.ts   # thin IPC transport
src/renderer/components/BoardModal.tsx          # kanban UI
src/renderer/components/ProfilesModal/          # profiles UI
src/cli/commands/board.ts / profile.ts          # CLI parity
```

**Purity boundary:** everything under `src/shared/**` is framework-free (no Electron, no fs) so it runs in main, renderer, and CLI alike. `board-spawn.ts` is main-only (it imports the Cue executor). `board-storage.ts` / `profile-storage.ts` only touch `fs` + `js-yaml` + the shared validators, so the CLI imports them directly - there is **one** storage implementation, shared by IPC and CLI (no drift).

---

## Data model (`.maestro/board.yaml`)

A single top-level `boards:` list; each board owns its `cards:`. See [board.md](../board.md) for the YAML shape and the card-status table. Key invariants enforced in `board-storage.ts`:

- **Load is defensive.** Malformed cards are skipped with a logged warning (via `validateBoard` / `validateBoardCard`); one bad entry never blocks the rest. Missing file => `[]` (the normal "no board yet" case).
- **Save rejects cycles.** `saveBoards` runs `hasCycle` and throws before writing, so the DAG invariant the dispatcher relies on can never be persisted.
- **`autoDecompose?: boolean`** (Phase 5) is off by default and only serialized when `true`.

`CardRun` records one dispatch attempt (attempt number, timestamps, `outcome`, and an optional `summary` captured from the completion marker). Cards accumulate one run per attempt so retries are auditable.

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

1. `reclaimStaleRunning` - a `running` card with no in-flight spawn whose run started > `DEFAULT_STALE_RUNNING_MS` ago is returned to `ready` (engine-restarted-mid-run recovery).
2. `promoteEligibleCards` - `todo` cards with all parents `done` -> `ready` (uses `getEligibleCards`, the single eligibility rule).
3. `claimReadyCards` - claim the oldest `ready` cards up to `maxInProgress` (default `DEFAULT_MAX_IN_PROGRESS = 2`), mark `running`, open a run. **The board is persisted here, before any spawn resolves,** so re-entrant ticks see `running` and don't double-dispatch.
4. For each claim, `resolveOverrides` then `spawn`; on completion, `applyCardResult` sets the terminal status.

**Cancel.** `cancelCard(cardId)` kills a `running` card's process through the injected `cancelSpawn` dep (`cancelBoardCardRun` in `board-spawn.ts`, which remembers the Cue `runId` per card and calls `stopCueRun`) and finalizes the card back to `todo` with a `canceled` run. The card id is tombstoned BEFORE the kill so the spawn promise resolving moments later (with a `null` exit) is discarded instead of re-finalizing the card as a failure. `canceled` and `reclaimed` runs are both skipped by the breaker's `trailingFailureCount`. IPC entry point is `board:cancelCard` -> `CueEngine.cancelBoardCard`, with a storage-only finalize fallback when no dispatcher owns the board (app restarted mid-run).

**Notify.** The optional `notify` dep announces terminal transitions (`done` / `blocked`, including force-blocks). `index.ts` maps it onto the existing `remote:notifyToast` relay (green auto-dismiss / red sticky, `sourceAgent: 'Board'`). The payload is presentation-free; the dispatcher never picks colors.

**Dispatch order.** `readyCardsInDispatchOrder` is the single ordering rule for both claim paths: `priority` descending (`high` > `normal` > `low`, absent = `normal`), then `createdAt` ascending, then board order.

`applyCardResult` precedence: **block marker -> `blocked`; complete marker or clean exit -> `done`; otherwise a failed run** that retries (`ready`) until the circuit breaker (`DEFAULT_MAX_FAILURES = 2` consecutive non-completing runs) forces `blocked`. A card whose profile can't be resolved is force-blocked immediately (bypassing the breaker - retrying a missing profile is pointless).

**Engine wiring:** `cue-engine.ts` `boardDispatchTick()` runs on the shared heartbeat, dual-gated on `maestroCue && board` (read fresh each tick). It keeps one `BoardDispatcher` per `${projectRoot}::${boardId}`, created lazily and dropped when the board vanishes. The host side effects are injected from `src/main/index.ts` via `board-spawn.ts` (`resolveCardOverrides`, `resolveCardAssignment`, `spawnBoardCard`), which run the card through the SAME `executeCuePrompt` path Cue uses - so SSH config, custom env/path, and token-source selection are honored (never bypass the SSH path).

---

## Worker pool (Phase 6)

By default (no `assign` dep) the dispatcher runs the **legacy path**: one card resolves to one pinned agent via `resolveOverrides`. When the injected `assign` dep is present (it is, in both `index.ts` and the CLI), the dispatcher runs the **pooled path** (`tickPooled` -> `claimReadyCardsPooled`):

- **Pool = opt-in + in-directory.** An agent is an eligible worker only when its session has `boardWorker: true` **and** its working dir is inside the board's project dir (or a sub-folder). `selectPoolAgentIds` (in `pool.ts`) is the single definition, shared by `index.ts` and the CLI. The `boardWorker` toggle lives on `EditAgentModal` (default OFF - an interactive agent is never hijacked).
- **Assignee resolution** (`resolveCardAssignment` in `board-spawn.ts`, mirrored by `resolveCliAssignment`): a named-but-missing profile -> `unresolvable` (block); a pinned agent (`card.assigneeAgentId`, or a legacy profile's `baseAgentId`) -> a single candidate; a role-only card -> the free project pool. The first candidate **not** already running a board card wins (`computeBusyAgentIds` recomputes the busy set from the persisted board each tick, so "one card per worker" survives restarts - the worker id is stamped on `CardRun.workerAgentId`).
- **All busy -> wait, don't block.** When every candidate is busy (or the pool is empty), `assign` returns `no-free-worker`; the card stays `ready` and retries on a later tick. Concurrency is bounded by free-worker count **and** the WIP cap (whichever is lower).
- **Card assignee** (`BoardCard`): `assigneeProfileId` (role) and/or `assigneeAgentId` (pin); at least one is required (`validateBoardCard`). Set from `BoardModal` (Role + "Pin to agent" selects) or the CLI (`board add-card --assignee <profileId> --assignee-agent <agentId>`).

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
- **The kanban does not poll.** `saveBoards` fires the `setBoardSavedListener` hook, `index.ts` broadcasts `board:changed { projectRoot }` to every window (and the web-desktop bridge), and `BoardModal` refetches on it. The hook lives in the host, not storage, because the CLI imports the same storage module and has no `webContents`.
- **Cross-platform paths.** All board/profile file paths go through `path.join` on `BOARD_CONFIG_PATH` / `PROFILES_CONFIG_PATH` (`src/shared/maestro-paths.ts`), and project roots come from stored sessions - no separator or home-dir assumptions, so the Windows CI leg stays green.

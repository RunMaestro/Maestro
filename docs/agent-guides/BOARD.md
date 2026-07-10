<!-- Verified 2026-07-10 against feat/board-and-profiles -->

# Board & Agent Profiles

Guide for the Board (a persistent task DAG) and Agent Profiles (assignee override bundles). Read this before editing `src/main/board/`, `src/shared/board/`, `src/main/profiles/`, `src/shared/profiles/`, or the `board:*` / `profiles:*` IPC and CLI surfaces.

The Board is built in phases: Profiles (1), data model + YAML storage (2), the dispatcher on the Cue tick (3), the kanban UI (4), and CLI + optional auto-decompose + docs (5). It is an Encore Feature that **depends on Maestro Cue** (it rides Cue's engine tick, no second timer).

---

## Layout

```text
src/shared/board/
├── types.ts          # Board / BoardCard / CardStatus / CardRun / WorktreeRef + validators (pure)
├── graph.ts          # getEligibleCards / getBlockers / hasCycle (pure DAG helpers)
└── cardMarkers.ts    # parseCardMarkers + CARD_HANDOFF_REMINDER (pure)

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

An `AgentProfile` is a named override bundle attached to a base Left Bar agent by `baseAgentId`. `resolveProfileSpawnOverrides(profile, baseValues)` merges each field as **profile -> base agent -> undefined** and returns `{ customModel, customEffort, appendSystemPrompt, customArgs }` - which map 1:1 onto the existing `SpawnAgentOptions` / `process:spawn` fields. Profiles invent **no** new spawn parameters.

---

## Dispatcher lifecycle

`BoardDispatcher` (in `board-dispatcher.ts`) is deliberately pure-ish: `loadBoard`, `saveBoard`, `resolveOverrides`, and `spawn` are all injected, so the promotion / WIP / completion logic is unit-tested with fakes (no Electron, no fs, no real process). One dispatcher instance owns one board.

Per `tick()`:

1. `reclaimStaleRunning` - a `running` card with no in-flight spawn whose run started > `DEFAULT_STALE_RUNNING_MS` ago is returned to `ready` (engine-restarted-mid-run recovery).
2. `promoteEligibleCards` - `todo` cards with all parents `done` -> `ready` (uses `getEligibleCards`, the single eligibility rule).
3. `claimReadyCards` - claim the oldest `ready` cards up to `maxInProgress` (default `DEFAULT_MAX_IN_PROGRESS = 2`), mark `running`, open a run. **The board is persisted here, before any spawn resolves,** so re-entrant ticks see `running` and don't double-dispatch.
4. For each claim, `resolveOverrides` then `spawn`; on completion, `applyCardResult` sets the terminal status.

`applyCardResult` precedence: **block marker -> `blocked`; complete marker or clean exit -> `done`; otherwise a failed run** that retries (`ready`) until the circuit breaker (`DEFAULT_MAX_FAILURES = 2` consecutive non-completing runs) forces `blocked`. A card whose profile can't be resolved is force-blocked immediately (bypassing the breaker - retrying a missing profile is pointless).

**Engine wiring:** `cue-engine.ts` `boardDispatchTick()` runs on the shared heartbeat, dual-gated on `maestroCue && board` (read fresh each tick). It keeps one `BoardDispatcher` per `${projectRoot}::${boardId}`, created lazily and dropped when the board vanishes. The host side effects are injected from `src/main/index.ts` via `board-spawn.ts` (`resolveCardOverrides`, `spawnBoardCard`), which run the card through the SAME `executeCuePrompt` path Cue uses - so SSH config, custom env/path, and token-source selection are honored (never bypass the SSH path).

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

---

## Gotchas

- **Board requires Cue.** The dual gate is read fresh each tick; the Extensions pane also disables the Board toggle while Cue is off (`BUILTIN_DEPENDENCIES` in `extensionModel.ts`).
- **Persist before spawn.** Never reorder `claimReadyCards` after the spawn - the pre-spawn save is what prevents double-dispatch.
- **`ready` is derived.** Authors write `todo`; the dispatcher computes `ready`. Do not hand-persist `ready` cards expecting them to stay put.
- **Cross-platform paths.** All board/profile file paths go through `path.join` on `BOARD_CONFIG_PATH` / `PROFILES_CONFIG_PATH` (`src/shared/maestro-paths.ts`), and project roots come from stored sessions - no separator or home-dir assumptions, so the Windows CI leg stays green.

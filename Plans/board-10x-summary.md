---
type: report
title: Board 10x - Final Summary
created: 2026-07-22
tags:
  - board
  - agent-profiles
  - plugins
related:
  - '[[rfc-runtime-dispatch-grants]]'
---

# Board 10x - Final Summary

Branch `build/board-profiles-fullaccess`, pushed to the `origin` fork. Base is `upstream/rc`.
Feature docs: `docs/board.md` (users), `docs/agent-guides/BOARD.md` (agents/devs).

## What landed, phase by phase

Original Board build (pre-10x), included in this branch because it has never been merged upstream:

| Commit      | What                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `905d9807a` | Agent Profiles: `.maestro/profiles.yaml`, storage, IPC, Profiles UI     |
| `93ed1df94` | Board data model + YAML storage (`.maestro/board.yaml`), DAG validators |
| `9a844af9b` | Dispatcher on the Cue engine tick (promote / claim / apply / reclaim)   |
| `1610db171` | Kanban Board modal                                                      |
| `fce9194b7` | Board CLI, optional auto-decompose, handoff markers, first docs         |
| `5a29f179f` | Opt-in per-project worker pool (`boardWorker`, pool roles)              |

The 10x pass:

| Phase | Commit      | What                                                                                                                                                                                                                   |
| ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `6949fc128` | Storage hardening: fail-closed loads (`BoardStorageError` instead of silently returning `[]` and then overwriting the file), atomic temp-file+rename writes, shared per-file write chain, decompose reload-before-save |
| 2     | `27ec23ba3` | Cancel a running card (tombstoned so a late result cannot re-finalize it), `board:changed` / `profiles:changed` push events, done/blocked toasts, safe deletes with referential integrity, card priority               |
| 3     | `304728438` | Full CLI lifecycle parity: board create/rename/delete/show, card update/remove/set-status, profile update, `board watch`                                                                                               |
| 4     | `bfe26f2ae` | Per-card git worktree isolation, sharing the one `setupWorktreeLocal` implementation with Auto Run; SSH refused rather than downgraded                                                                                 |
| 5     | `bdc5c0db3` | Four metadata-only `board.*` plugin-bus topics, persisted-status projection true-up, Board pill in the Main Window header, `BOARD_FIRST_PARTY_PLUGIN`, dispatch-grant RFC                                              |
| 6     | `a07e58b71` | Accessibility and keyboard kanban ("Move to" picker, not ARIA DnD), multi-board UI, running-card visibility, live Profiles updates                                                                                     |
| 7     | `16295e485` | This document pass: BOARD.md / board.md / CLAUDE.md / CLAUDE-PLUGINS.md / PLUGIN-DEVELOPMENT.md reconciled with the code, plus the plugin-sdk drift fix below                                                          |

One unrelated commit rides along: `bc350e8aa` (`fix(permissions): unset permissionMode now resolves to full access`). It is not Board work and muddies the diff. Recommendation: cherry-pick it onto its own branch and PR it separately before opening the Board PR.

## Validation results (Phase 7 gate)

| Step                                                                                                                             | Result                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npx tsc --noEmit -p tsconfig.json`                                                                                              | clean                                                                      |
| `npx tsc -p tsconfig.lint.json` / `-p tsconfig.main.json` / `-p tsconfig.cli.json` (what `npm run lint` runs)                    | clean                                                                      |
| `npx tsc -p packages/plugin-sdk/tsconfig.json --noEmit`                                                                          | clean                                                                      |
| `npx eslint` over all 76 changed `.ts`/`.tsx` files                                                                              | 0 errors (19 warnings, all "file ignored by config" for `src/__tests__`)   |
| `npx prettier --check` over every changed file                                                                                   | clean (5 files needed a `--write` first; CI runs `npx prettier --check .`) |
| Scoped vitest run (board/profiles shared + main + CLI + BoardModal + ProfilesModal + extensionModel + plugin events/first-party) | 304 passed, 0 failed                                                       |
| `src/__tests__/shared/plugins/` full directory (host-api version assertions)                                                     | 282 passed, 0 failed                                                       |
| `npx vitest run --config packages/plugin-sdk/vitest.config.ts` (drift guard)                                                     | 29 passed, 0 failed (was 2 failing before this phase)                      |

Dash sweep over the whole branch: the only file containing an en/em dash is `src/renderer/types/index.ts`, and `git log -S` attributes it to the unrelated upstream commit `50a792744` (Goal-Driven Auto Run). Nothing this effort introduced.

Working tree is clean; no `scripts/cdp-*.js` or throwaway files were committed.

### Bug found and fixed during the gate

Phase 5 bumped `HOST_API_VERSION` to 1.15.0 and added the four `board.*` topics in `src/shared/plugins/events.ts`, but did not update the vendored copy in `packages/plugin-sdk/src/index.ts`. The drift guard was therefore red. It stayed invisible because `npm run test` only globs `src/**`; the SDK suite runs on the `plugin-sdk-publish` workflow, so it would have failed at the next SDK release instead of on this PR. Fixed by vendoring the topics and payloads, moving the SDK's `HOST_API_VERSION` to 1.15.0, updating the drift test's pin, and bumping the package to 0.9.0. (After the later merge of upstream `rc`, which shipped its own 0.9.0 for host-API 1.14.0, the package moved to 0.10.0.)

## Known remaining gaps

1. **Runtime dispatch-grant seam is an RFC, not an implementation.** `Plans/rfc-runtime-dispatch-grants.md` specifies the seam that would let a tier-2 Board plugin hold `agents:dispatch` / `process:spawn`. Until it exists, dispatch and worktree provisioning stay host-owned and `BOARD_FIRST_PARTY_PLUGIN` deliberately omits both capabilities. (The RFC landed in `Plans/`, not `docs/rfcs/`.)
2. **No live output streaming.** A card's run is headless; you get the exit status, the completion marker, and the optional summary. Watching a card think in real time was out of scope.
3. **Worktree isolation refuses SSH remotes.** A locally created checkout is invisible to an agent executing on a remote host, so an isolated card on an SSH agent is blocked with a reason. `worktreeSetupRemote` exists but is deliberately not wired in: remote cleanup is undesigned.
4. **`CLAUDE-PLUGINS.md` capability table remains stale** beyond the Board rows. It omits several capabilities that are actually wired. Phase 7 touched only the Board-related lines and the host-API version history, per its own scope note; the broader table needs its own pass.
5. **The pool busy-set is per board, not per project.** `computeBusyAgentIds(board)` reads only the board being ticked and each board gets its own dispatcher, so "one card per worker" is a per-board guarantee. Two boards in the same project can hand the same agent a card simultaneously. Documented in both guides rather than fixed, since the fix is a project-wide busy set computed across all boards before any of them claim.
6. **`package-lock.json` carries an 18-line deletion of `libc` fields** on optional deps, an artifact of the local npm version. Harmless, but regenerating the lock with the CI npm version before merge would remove the noise.
7. **`BoardSpawnContext` uses loose host-boundary types** (`getSshStore: () => any`, `Record<string, any>` session/agent-config shapes). ESLint accepts them and they mirror the surrounding host wiring, but they are the weakest typing in the feature.

## Suggested PR description

> ### Board and Agent Profiles
>
> Adds the Board: a persistent, git-trackable task DAG in `.maestro/board.yaml` whose cards are dispatched to Agent Profiles on the existing Maestro Cue engine tick (no second timer). Encore-gated, and gated again on Cue.
>
> **Core**
>
> - **Agent Profiles** (`.maestro/profiles.yaml`): named model / effort / role-prompt / args override bundles, resolved as profile then base agent then unset onto the existing spawn options. No new spawn parameters.
> - **Board dispatcher**: promote (all parents `done`) then claim up to a WIP cap then spawn then apply. The board is persisted before any spawn resolves, so a restart or a re-entrant tick can never double-dispatch. Retries are bounded by a circuit breaker; every attempt is recorded as an auditable `CardRun`.
> - **Worker pool** (opt-in): an agent with `boardWorker: true` whose working dir is inside the project can pick up role-only cards. Interactive agents are never hijacked.
> - **Per-card git worktrees**: a card can run in its own checkout on `board/<board>/<card>`, so cards dispatched in the same tick cannot collide. Provisioning goes through the single shared `setupWorktreeLocal`; nothing is auto-merged or auto-deleted.
> - **Full CLI parity** (`maestro-cli board` / `profile`): board and card lifecycle, profile lifecycle, `tick`, and `watch`, all through the same storage modules and the same spawn path as the desktop app, so SSH remotes and profile overrides behave identically.
> - **Plugin bus**: four metadata-only topics (`board.cardStatusChanged`, `board.cardCompleted`, `board.cardBlocked`, `board.decomposed`) at host API 1.15.0. Titles ship; summaries, prompts, outputs, and block reasons never do.
> - **Optional auto-decompose**, off by default: one LLM pass fans a `triage` card into a wired child graph, capped per tick, using the editable `board-decompose` core prompt.
>
> **Safety**
>
> Board and profile YAML loads fail closed (an unreadable file blocks writes instead of being silently replaced by an empty board, which used to destroy data), writes are atomic temp-file+rename, and async read-modify-write callers serialize through a shared per-file write chain. Card deletion keeps the DAG referentially intact through grandparent adoption. Deleting a board with unfinished cards requires an explicit force.
>
> **UI**
>
> Kanban modal with keyboard parity (a "Move to" picker rather than ARIA drag-and-drop), multi-board switching, per-card stop, done/blocked toasts, an expandable last-run summary, and a running/ready pill in the Main Window header. Both the modal and the pill update from a `board:changed` push after every write; nothing polls.
>
> **Docs**: `docs/board.md` (users), `docs/agent-guides/BOARD.md` (contributors), `docs/cli-reference.md` (flags).
>
> **Tests**: shared DAG/markers/pool/types, storage, dispatcher, spawn, worktree, decompose, both CLI command suites, BoardModal, ProfilesModal, extension model, plugin events, and the SDK drift guard.

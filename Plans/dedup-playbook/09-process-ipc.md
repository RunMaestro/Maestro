# Stage 09 - Process Lifecycle, IPC, and Preload Consolidation

## Objective

Reduce process and IPC duplication while preserving cancellation, session persistence, channel compatibility, teardown, and trust boundaries.

## Priorities

**13, 16, 17, 20, 34, 57, 69, 71, 83, 85, 93, 110**

## Dependencies

Stages 02, 04, and 05 complete. Stage 08 precedes persisted-session migrations.

## Invariants

- Main owns privileged execution and security decisions.
- Every started process has one owner, cancellation path, exit classification, and teardown path.
- IPC/preload subscriptions remove exactly the registered listener.
- Deprecated channels are removed in the same change that migrates their producer, preload exposure, and all consumers unless a real external versioned consumer requires a documented sunset.
- Request/response IDs cannot cross-talk between concurrent operations.

## Priority playbooks

### 13 - Process-manager compatibility exports

Run LSP references for each compatibility re-export and underlying symbol. Migrate internal consumers to canonical modules. Check package exports, preload types, dynamic imports, tests, and external docs. Remove one alias at a time with type/build smoke.

### 16 - `process:runCommand`

Map every caller, payload, expected stream/exit/error behavior, cancellation, and permissions. Define the target API and contract tests. Migrate producer, preload exposure, and all callers atomically; then remove the old registration/channel/types in that same change. Add a compatibility window only for a proven external versioned consumer with a named owner and sunset.

### 17 - `shellLogs`

Specify replacement persisted-session representation: ordering, stream identity, truncation, timestamps, restart behavior, and migration. Add old-session fixtures, dual-read during migration, target write, restart smoke, and rollback plan. Remove old field only after all consumers and stored fixtures migrate.

### 20 - Agent execution split

Decompose by stable policies: queue state/ordering, spawn configuration/lifecycle, and error/exit classification. First add end-to-end characterization for success, tool output, retryable error, fatal error, cancellation, queue removal, and shutdown. Extract pure policy modules before moving side effects. Keep orchestration visible.

### 34 - Spawn SSH resolution

Centralize remote lookup/config/adapter construction behind a typed result. Preserve enabled-state, missing remote, auth, shell, cwd, and fallback policy. Test local, enabled remote, disabled remote, unknown ID, malformed config, and connection failure.

### 57 - `ManagedProcess` constructor

Inventory common fields and initialization order across managed processes. Create a typed base constructor/factory for identity, timestamps, streams, status, and cleanup hooks. Keep provider-specific process objects explicit. Test defaults, overrides, unique IDs, and lifecycle transitions.

### 69 - Preload subscription helper

Create a helper that captures channel and wrapped listener and returns an idempotent unsubscribe removing that exact function. Keep channel allowlists explicit. Test multiple subscribers, repeated unsubscribe, late events, destroyed renderer, and payload typing. Migrate representative APIs before batches.

### 71 - SSH execution timeouts

Compare timeout start point, activity reset, kill escalation, remote cleanup, error type, and zero/unlimited semantics. Extract a lifecycle helper only for compatible callers. Use fake timers plus spawned-process/SSH adapter tests. Ensure timer and listeners clear on every exit.

### 83 and 93 - `createIpcHandler` migrations

For memory/prompts and agent-run families, compare validation, auth, logging, Sentry, response envelope, cancellation, and dynamic channel behavior. Extend the factory only for common policy, not with per-handler flags. Migrate one handler, run producer-consumer tests, then batch compatible handlers. Retain exceptional handlers explicitly.

### 85 - Coworking response-channel round trip

Define typed request ID, response channel, payload, error, timeout, and cleanup. Prevent spoofed/colliding IDs. Add concurrent request, timeout, renderer destruction, duplicate response, and malformed response tests. Implement only if it reduces complexity without broadening channel exposure.

### 110 - Claude global-stats listener

Trace current and deprecated listener registrations across preload, renderer, web, and external integrations. Add compatibility usage evidence or version policy. Migrate remaining consumers, verify stats updates and unsubscribe, then remove deprecated channel/types/aliases together.

## Required PR boundaries

Stage 09 is intentionally several dependent PRs, never one mixed change:

1. **09A process foundations:** P13, P34, P57, P71.
2. **09B IPC/preload mechanics:** P69, P83, P85, P93; depends on 09A where process lifecycle is involved.
3. **09C renderer execution:** P20; depends on 09A-09B.
4. **09D clean contract cutovers:** P16 and P110, one atomic producer/exposure/consumer cutover per channel; depends on 09B-09C.
5. **09E persisted session migration:** P17; depends on Stage 08 and 09C, with dual-read rollback limited to the persisted schema.

Do not combine 09D channel deletion with 09E persistence migration. Each PR updates only its priority rows in the ledger and `dedup-report.md`.

## Verification

- Focused process manager, IPC handler, preload, and renderer consumer tests.
- Fake-timer lifecycle tests and real cancellation/kill smoke.
- Electron restart with persisted sessions.
- Concurrent request/cancellation scenarios.
- Forced main build and inspection of loaded artifact.
- LSP references and channel-string search before deletion.

## Rollback

Persisted-session migration P17 requires dual-read rollback until its schema window is verified. Channel cutovers P16/P110 revert atomically with producer, exposure, and consumers; do not preserve an unrequired alias. Process lifecycle refactors revert as one ownership unit; do not mix old ownership with new cleanup.

## Exit criteria

All 12 priorities have dispositions; process ownership and teardown are singular; compatible handlers/subscriptions share tested primitives; deprecated channels are removed only with proof; restart and cancellation smoke pass.

## Investigated execution cards

|   P | Current source evidence                                                                                                                                                             | Canonical edit order                                                                                                                                                                                                                                                                                             | Focused proof / rollback                                                                                                                                                       |
| --: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|  13 | Compatibility exports live in `src/main/process-manager/index.ts` around `ProcessManager`/spawner modules.                                                                          | LSP each export; migrate main imports to concrete canonical modules; update barrels/tests; delete aliases last.                                                                                                                                                                                                  | `bun run test -- src/__tests__/main/process-manager`; main type build. Restore only a proven public export.                                                                    |
|  16 | `process:runCommand` is consumed by `useAgentUserInputListener.ts`, `useInputProcessing.ts`, remote handlers, and `DebugPackageModal.tsx` with differing stream/error expectations. | Define the target process API and channel contract tests; migrate producer, preload exposure, and every caller atomically; remove the old handler/channel/exposure in the same change. Retain compatibility only if LSP/repository tracing identifies a real external versioned consumer and records its sunset. | Process IPC tests plus real CLI/terminal/debug-package runs. Acceptance requires zero old-channel references; revert the complete producer/exposure/consumer cutover together. |
|  17 | `shellLogs` remains in persisted session/tab state while newer structured logs exist.                                                                                               | Define structured replacement and dual-reader; migrate renderer readers, persistence writer, reload/resume; remove old writes, then old field after fixtures pass.                                                                                                                                               | Old/new session fixtures and Electron restart/resume. Rollback must read newly written structure.                                                                              |
|  20 | `src/renderer/hooks/agent/useAgentExecution.ts` mixes queue, spawn, and error policy.                                                                                               | Characterize transitions; extract pure error classifier, queue reducer, spawn adapter in that order; leave orchestration hook.                                                                                                                                                                                   | Agent execution suites for success/tool/error/cancel/queue/shutdown and real representative agent run. Revert latest extraction slice.                                         |
|  34 | SSH adapter/config resolution repeats in spawn paths and process manager.                                                                                                           | Use a typed spawn-SSH resolver built on P33/P86 policy; migrate `PtySpawner`, child-process/agent paths, then remove local resolution.                                                                                                                                                                           | Spawner tests for local/enabled/disabled/unknown/auth failure. Revert resolver and callers atomically.                                                                         |
|  57 | `PtySpawner`, `ChildProcessSpawner`, and `OpencodeServerSpawner` build parallel `ManagedProcess` base fields.                                                                       | Add typed factory for ID/status/timestamps/streams/cleanup; migrate Pty, child, OpenCode; keep provider fields explicit.                                                                                                                                                                                         | Process lifecycle tests for unique IDs, transitions, exit, cancellation, teardown.                                                                                             |
|  69 | Preloads under `src/main/preload/{groupChat,process,system,agentRun,coworking,plugins,sessions,...}.ts` repeat `ipcRenderer.on`/wrapped unsubscribe.                                | Add typed preload-local subscription helper returning exact idempotent remover; migrate one namespace then batches.                                                                                                                                                                                              | Preload tests for multiple listeners, repeated unsubscribe, late event, destroyed renderer; preload build.                                                                     |
|  71 | SSH command/probe paths (`probeRemoteMaestroP.ts`, `ipc/handlers/agents.ts`, execution helpers) duplicate `Promise.race`/timer/kill handling.                                       | Create timeout lifecycle helper with explicit start/reset/kill policy; migrate probes before long-running execution only if semantics match.                                                                                                                                                                     | Fake timers and spawned adapter tests; no dangling timer/listener. Revert per compatible family.                                                                               |
|  83 | Memory/prompts IPC handlers repeat `src/main/utils/ipcHandler.ts::createIpcHandler` envelope manually.                                                                              | Compare validation/auth/logging; migrate memory handlers, then prompts; retain exceptional dynamic handlers.                                                                                                                                                                                                     | `bun run test -- src/__tests__/main/ipc/handlers/{memory,prompts}*.test.ts`; main build.                                                                                       |
|  85 | Coworking uses ad-hoc request-specific response channels and `Promise.withResolvers`.                                                                                               | Define typed request ID/channel/payload/timeout helper with exact cleanup; migrate one round trip.                                                                                                                                                                                                               | Concurrent, timeout, duplicate/malformed response and renderer-destroy tests. Revert helper/caller together if channel exposure widens.                                        |
|  93 | `src/main/ipc/handlers/agent-run.ts` repeats handler wrapper/error normalization around compatible endpoints.                                                                       | Migrate read-only/simple endpoints first, mutations/cancellation last; keep distinct auth/cancel policy explicit.                                                                                                                                                                                                | Agent-run handler/dashboard tests and malformed/error cases; main/renderer contract compile.                                                                                   |
| 110 | Deprecated `window.maestro.claude.onGlobalStatsUpdate` coexists with `agentSessions.onGlobalStatsUpdate`/project update; current aggregate hook uses the new path.                  | Trace external/preload consumers; migrate any remaining; remove registration, global declaration, mocks, and alias last.                                                                                                                                                                                         | Aggregate stats tests and Electron live stats update/unsubscribe. Restore whole alias surface only for proven compatibility.                                                   |

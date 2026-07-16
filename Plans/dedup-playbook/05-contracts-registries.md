# Stage 05 - Contracts, Registries, and Cross-Runtime Types

## Objective

Establish authoritative sources for public/shared types and registries before downstream settings, storage, IPC, provider, and renderer migrations.

## Priorities

**4, 9, 14, 21, 35, 58, 97, 116, 117, 118**

## Dependencies

Stages 01, 02, and 04 complete.

## Contract migration protocol

For each contract, map `producer -> transport/storage -> exposure -> consumer`. Add compile-time fixtures or contract tests before moving declarations. Move the canonical declaration first, migrate every consumer, run LSP references, then delete aliases/copies. Do not create barrels that introduce runtime cycles.

## Priority playbooks

### 4 - Web-server same-module types

Locate duplicate `LiveSessionInfo`, handler-local `WebClient`, and `WebClientMessage`. Select the declaration closest to the actual server protocol, compare optionality and methods, and replace local copies with imports. Keep internal connection state distinct from serialized client state. Compile server handlers and exercise connect/message/disconnect.

### 9 - Group-chat composition

Inventory shared, storage, renderer, and transport group-chat shapes. Identify stable identity/common fields versus persisted or UI-only fields. Build composition from a small canonical base plus explicit extensions; avoid a giant all-optional interface. Add assignability tests and storage round trips. Migrate producers/consumers together.

### 14 - `DEFAULT_CAPABILITIES`

Run LSP references on the compatibility export and canonical `src/shared/types.ts` declaration. Migrate imports directly to the canonical source, verify no runtime cycle, then remove the re-export. Check package/preload public surfaces and tests.

### 21 - WebSocket protocol types

Split protocol types by domain rather than importing main-process internals into web. Centralize discriminants and payload maps, derive unions from the map, and preserve runtime validation. Verify every server send and client switch branch. Add exhaustive type tests and malformed/unknown message runtime tests.

### 35 - Shared/preload history types

Compare preload, shared history, cache, and renderer declarations field by field. Establish one shared transport-safe type and keep disk-cache internals separate. Migrate exact types first; use adapters only where cache metadata is intentionally internal. Compile main, preload, and renderer.

### 58 - Agent capabilities source

Inventory agent IDs, capability sets, aliases, provider-derived capabilities, and UI assumptions. Choose one canonical registry with a typed lookup. Derive lists/types rather than maintaining parallel arrays. Preserve unknown/custom agent behavior. Test every built-in agent and alias.

### 97 - `LOOKBACK_OPTIONS`

Centralize the option values and derived type without coupling presentation labels to storage logic. Confirm units, ordering, default, all-time sentinel, and URL/persistence representations. Migrate activity/usage consumers and run relevant renderer tests.

### 116 - Qwen provider resolution

Normalize AgentRun resolution to canonical `qwen3-coder`. Document accepted legacy inputs (`qwen`, `qwen-coder`, or historical values) and normalize at one boundary. Keep output/persisted canonical ID consistent. Add alias, canonical, unknown, and round-trip tests. Update fixtures only after behavior is fixed.

### 117 - `ParsedDeepLink`

Replace the stale inline preload callback shape with the canonical shared type, including `file`, `filePath`, and `line`. Trace main dispatch through preload to both in-app and IPC listeners. Add contract tests for focus/session/group/file variants and a real file deep-link smoke.

### 118 - `GraphBucket` / `HistoryGraphData`

Define canonical transport types in shared history code. Include `hostCounts` and `cached` according to actual handler output. Keep cache-only version/fingerprint fields separate. Migrate handler, both preloads, renderer consumers, and tests. Add local/remote host-count and cache-hit/miss contract tests.

## Cross-cutting verification

- LSP references show no consumers of removed declarations/re-exports.
- Main, preload, renderer, web, CLI, and plugin SDK type checks pass as applicable.
- Runtime contract tests reject unknown discriminants and malformed payloads.
- Serialization round trips preserve required fields and do not leak internal fields.
- No new dependency cycle or runtime import from type-only modules.

## Rollback

Contract moves and all consumer migrations revert as a unit. Keep compatibility adapters only when an external version window is documented; do not leave indefinite aliases.

## Exit criteria

All ten priorities have one named source of truth, all producers and consumers compile against it, runtime boundary validation remains present, aliases/copies are removed, and downstream stages can depend on stable contracts.

## Investigated execution cards

|   P | Observed contract drift                                                                                                                                                                          | Canonical target and exact migration order                                                                                                                                            | Focused proof / rollback                                                                                                                               |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   4 | `LiveSessionInfo`, `WebClient`, and `WebClientMessage` are duplicated between `src/main/web-server/types.ts` and `handlers/messageHandlers.ts`; handler `WebClientMessage` is a strict superset. | Keep socket-bearing `WebClient` server-local in `types.ts`; make handler import it and the superset message type; remove local declarations after compile.                            | Add/extend web-server message-handler tests; run `bun run test -- src/__tests__/main/web-server`. Revert type/import migration as one unit.            |
|   9 | `GroupChatParticipant` and log-message shapes repeat in `src/shared/group-chat-types.ts`, `src/main/group-chat/group-chat-storage.ts`, and `group-chat-log.ts`; storage adds filesystem fields.  | Keep serialized base types in shared; compose storage/log extensions explicitly; migrate storage, log, preload, then renderer.                                                        | Group-chat storage round trips and renderer group-chat suites; old fixtures must decode.                                                               |
|  14 | `DEFAULT_CAPABILITIES` is canonical in `src/shared/types.ts:144` but compatibility-exported from `src/main/agents/capabilities.ts`.                                                              | Migrate all imports directly to shared, check cycles, remove compatibility export.                                                                                                    | LSP references must show zero alias consumers; `bun run lint` and agent capability tests. Restore export only with a proven external consumer.         |
|  21 | `AutoRunState`, `CustomAICommand`, `AITabData`, `SessionData`, Git/Cue/AutoRun payloads repeat across `src/main/preload/web.ts`, `src/main/web-server/types.ts`, and `src/web/hooks/*.ts`.       | Create domain files under `src/shared/web-protocol/`; migrate main producer, preload exposure, web decoder, then hooks one domain per commit.                                         | Contract tests for each discriminant plus `bun run build:web-desktop` and WebSocket reconnect smoke. Revert by domain.                                 |
|  35 | `UnifiedHistoryEntry`/history response copies exist in `src/main/preload/directorNotes.ts` and `src/shared/history.ts`; preload group-chat shapes also mirror shared serialization.              | Import exact transport types from shared; keep preload namespace wrappers and cache internals separate.                                                                               | Preload build, history IPC tests, Director Notes render. Revert only the affected domain type migration.                                               |
|  58 | Agent IDs/capabilities are split across `src/main/agents/definitions.ts`, `capabilities.ts`, shared IDs/types, and AgentRun registries.                                                          | Make the shared typed registry authoritative; derive capabilities/lists, retain explicit aliases and unknown/custom behavior at resolution boundary.                                  | Table-test every built-in and alias; main/renderer type checks and agent picker smoke.                                                                 |
|  97 | `LOOKBACK_OPTIONS`/`LookbackPeriod` repeat in `SessionActivityGraph.tsx`, `History/historyConstants.tsx`, and `GroupChatHistoryPanel.tsx`.                                                       | Define values/type in `History/historyConstants.tsx` or neutral renderer history module; migrate graph then group-chat consumers.                                                     | Activity/history/group-chat tests including all-time/default/order; visual selector smoke.                                                             |
| 116 | `KNOWN_AGENT_RUN_PROVIDERS` contains `qwen-coder` while canonical `AGENT_IDS` uses `qwen3-coder`; `resolveAgentRunProvider` maps aliases to the wrong output.                                    | Output only `qwen3-coder`; accept legacy spellings as input aliases if fixtures prove them. Migrate resolver, dashboard filters, fixtures.                                            | Provider resolver and persisted dashboard filter tests for canonical/legacy/unknown; revert registry and consumers together.                           |
| 117 | `src/shared/types.ts:764-777` includes file deep links; `src/renderer/global.d.ts:1752-1759` omits `file`, `filePath`, and `line`; main dispatch and renderer handler already support them.      | Type the preload callback with shared `ParsedDeepLink`; update exposure/imports, then remove inline shape.                                                                            | Deep-link unit tests for four variants and Electron `maestro://...file...` smoke. Roll back type-only migration if preload build cycles.               |
| 118 | `GraphBucket` repeats in `preload/directorNotes.ts`, `preload/files.ts`, and `utils/history-bucket-cache.ts`; handler `HistoryGraphData` includes `hostCounts` but preload omits it.             | Put transport `GraphBucket`/`HistoryGraphData` in `src/shared/history.ts`; keep cache version/fingerprint internal; migrate handler, files preload, Director Notes preload, renderer. | History IPC/cache tests for host counts and hit/miss, preload/main/renderer compile. Revert the whole contract migration if any payload field changes. |

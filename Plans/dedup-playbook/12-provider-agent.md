# Stage 12 - Provider and Agent Resolution

## Objective

Consolidate provider/agent lookup, timeouts, remote-ID precedence, and Pi/OMP parsing while keeping provider-specific protocols and error policies explicit.

## Priorities

**33, 80, 86, 113**

## Dependencies

Stages 02, 04, 05, and relevant Stage 08 storage work complete.

## Priority 33 - SSH remote lookup

Document enabled-state policy first: whether disabled remotes are invisible, resolvable-but-denied, or usable for historical metadata. Build one lookup returning a typed result/error rather than `undefined` ambiguity. Migrate compatible callers; preserve admin/configuration views that must see disabled entries. Test enabled, disabled, unknown, duplicate ID, malformed, and local fallback.

## Priority 80 - Main `fetchWithTimeout`

Compare current variants for timeout mechanism, caller signal composition, request options, error type, Sentry/logging, response handling, and timer cleanup. Extract a main-process helper for compatible `AbortController` paths. Preserve BMAD's materially different `AbortSignal.timeout`/Sentry contract unless deliberately migrated. Test success, HTTP error, timeout, caller abort, network failure, and timer cleanup.

## Priority 86 - SSH remote-ID precedence

Inventory sources: explicit request, session metadata, agent config, project default, global/default remote, and local sentinel. Decide and document precedence once. Implement a pure resolver returning value plus provenance so callers can log/debug decisions. Test every pairwise conflict, empty values, disabled remote, and unknown ID. Use the canonical lookup from priority 33 after resolution.

## Priority 113 - Pi/OMP parser core

### Characterization first

Create shared golden event fixtures for session/init, assistant/user message updates, tool lifecycle, usage, final result, errors, malformed lines, and exit-code fallback. Add OMP-specific TTSR abort fixtures proving the guard suppresses only the documented self-resolving event.

### Design

- Extract a protocol core for the truly identical JSON event state machine and message/usage helpers.
- Use typed protocol adapter hooks for agent name, error patterns, and OMP TTSR specialization.
- Keep public parser classes and output types stable unless Stage 05 defines a canonical shared type.
- Avoid a base class with protected mutable state when a composable pure core is clearer.

### Migration

1. Run both parser suites against golden fixtures.
2. Extract pure event transformation.
3. Migrate Pi and verify exact output.
4. Migrate OMP with explicit TTSR hook and verify exact output.
5. Compare transcripts/event streams byte-for-byte where deterministic.
6. Remove duplicate private helpers only after parity.

## Verification

- Resolver table tests and provenance assertions.
- Real remote selection smoke for explicit/session/default/local cases.
- Fetch fake-timer and abort tests.
- Pi/OMP golden transcript tests, malformed input, streaming chunks, usage totals, tool events, exit errors, and TTSR behavior.
- Agent session/Auto Run smoke for both Pi and OMP.

## Rollback

Resolver policy changes revert with all callers. Parser core and both adapters revert together; retain golden fixtures to prove rollback parity.

## Exit criteria

All four priorities are resolved; remote selection is deterministic and documented; timeout behavior is singular where compatible; Pi/OMP share a tested core while OMP's TTSR specialization remains explicit.

## Investigated execution cards

|   P | Observed source                                                                                                                                                                                          | Canonical decision/order                                                                                                                                     | Focused proof / rollback                                                                                                                 |
| --: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
|  33 | SSH remote lookup is repeated in worktree/agent/remote spawn paths with inconsistent treatment of disabled remotes.                                                                                      | Add typed lookup in the existing SSH config domain; distinguish not-found/disabled; migrate metadata views last if they intentionally show disabled entries. | SSH config/handler tests for enabled/disabled/unknown/duplicate/malformed and remote spawn smoke. Revert consumers with resolver policy. |
|  80 | `src/main/cue/cue-telemetry.ts` and `src/main/ipc/handlers/leaderboard.ts` use matching `AbortController` timeout wrappers; BMAD has a different Sentry/`AbortSignal.timeout` contract.                  | Add `src/main/utils/fetchWithTimeout.ts` for matching paths only; migrate telemetry then leaderboard; retain BMAD unless separately characterized.           | New helper fake-timer tests for success/HTTP/network/timeout/caller abort/cleanup and both caller suites.                                |
|  86 | `useWorktreeHandlers.ts`/worktree spawn and Auto Run paths resolve remote ID from explicit, session config, and fallback in different orders.                                                            | Add pure `resolveSshRemoteId` returning ID plus provenance; encode explicit > session/config > default > local precedence; then call P33 lookup.             | Pairwise precedence table, disabled/unknown tests, worktree and Auto Run remote smoke. Revert policy and callers atomically.             |
| 113 | `src/main/parsers/pi-output-parser.ts` (325 lines) and `omp-output-parser.ts` (379 lines) share the event state machine/message/usage helpers; OMP uniquely suppresses the `TTSR matched rule(s)` abort. | Extract a typed protocol-core transformer; migrate Pi, then OMP through an explicit TTSR hook; keep public parser classes/error patterns.                    | Golden Pi/OMP transcript suites for every event/tool/usage/error/malformed/exit case and TTSR. Revert core plus both adapters together.  |

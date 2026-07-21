# Stage 07 - Plugin Persistence and Security Boundaries

## Objective

Deduplicate plugin persistence and sandbox enforcement without weakening authorization, corrupting grants, or changing fail-closed behavior.

## Priorities

- **50:** Extract plugin-store state/grant persistence locally.
- **51:** Extract authorization-ledger tombstone mutation.
- **59:** Share sandbox payload-byte enforcement.

## Dependencies

Stages 02, 04, and 05 complete. Security tests must precede refactoring.

## Threat model

Protect against malformed/untrusted plugin state, grant escalation, stale authorization resurrection, partial writes, oversized or encoding-ambiguous payloads, path confusion, and persistence failures. The canonical helper must not cross trust boundaries that currently have different policies.

## Priority 50 - Plugin store persistence

1. Inventory state and grant read/write/update/delete paths, file locations, schemas, locking, atomicity, and error policy.
2. Identify duplicated mechanics within the same plugin-store trust boundary only.
3. Add fixtures for missing, valid, old-version, malformed, truncated, wrong-owner/plugin ID, and partial-write files.
4. Extract a local typed persistence primitive with schema validation and atomic replacement.
5. Keep state and grants as distinct typed records even if they share mechanics.
6. Migrate one path, verify byte/semantic parity, then migrate the other.
7. Ensure authorization decisions never default to allow when persistence fails.

## Priority 51 - Ledger tombstones

1. Document ledger invariants: append/update semantics, uniqueness, authorization version, tombstone meaning, and replay behavior.
2. Characterize revoke, reinstall, grant replacement, duplicate revoke, and missing entry.
3. Extract one mutation function that creates/updates tombstones transactionally.
4. Preserve audit metadata and ordering.
5. Test repeated mutation is idempotent and a tombstoned grant cannot be resurrected by stale state.
6. Test storage failure leaves the previous ledger usable and denied by default.

## Priority 59 - Payload byte enforcement

1. Inventory all payload limits, encoding assumptions, JSON serialization points, streaming/non-streaming paths, and error envelopes.
2. Define whether the limit applies to UTF-8 bytes, decoded bytes, or serialized envelope bytes; use bytes, not JavaScript string length.
3. Put the shared check in the narrowest sandbox/host boundary module.
4. Validate before allocation/forwarding when possible.
5. Add tests for exact limit, limit+1, multibyte Unicode, base64 inflation, malformed encoding, missing size, and nested payloads.
6. Preserve per-channel limits as explicit parameters; do not replace different security policies with one global constant.

## Security verification

- Negative tests run before and after each refactor.
- Fuzz/property cases for malformed persistence objects and payload lengths.
- Authorization denied on unknown plugin, corrupt ledger, missing grant, tombstone, or read failure.
- No secret or payload content added to logs.
- Plugin install/enable/disable/revoke/reinstall smoke in Electron.
- Sandbox tool/event calls succeed under limit and fail deterministically over limit.

## Rollback

Security and persistence migrations revert atomically. Preserve old files/backups until the new reader/writer completes smoke verification. Never roll back only the validator while keeping the broader shared parser.

## Exit criteria

All three priorities are implemented or rejected with threat-model evidence; persistence survives corrupt/partial states; tombstones remain authoritative; byte limits are consistent and fail closed; plugin lifecycle smoke passes.

## Investigated execution cards

### P50 - Plugin state/grant persistence

- **Observed:** `src/main/plugins/plugin-store-main.ts` has parallel `readPluginState`/`readGrantsFile` and `writePluginState`/`writeGrantsFile` mechanics with different record schemas.
- **Chosen API/order:** add a module-local typed `readPluginFile`/`writePluginFile` accepting decoder and filename; keep state/grant schemas and fail-closed authorization separate. Add corrupt/missing/partial fixtures, migrate state first, grant second, then delete duplicated mechanics.
- **Exact proof:** create/extend `src/__tests__/main/plugins/plugin-store-main.test.ts`; run `bun run test -- src/__tests__/main/plugins/plugin-store-main.test.ts` plus Electron plugin enable/restart.
- **Acceptance/rollback:** valid files round-trip byte/semantically, corrupt grants never authorize, atomic failure preserves old bytes. Revert helper and both migrations together.

### P51 - Authorization tombstones

- **Observed:** tombstone mutation is repeated inside `src/main/plugins/authorization-ledger.ts` around the revoke/update paths (`dedup-report.md` originally anchored lines 336-360).
- **Chosen API/order:** introduce a ledger-local `upsertTombstone` operating on the validated ledger model; characterize revoke/reinstall/repeated revoke; migrate each caller; preserve audit metadata/order; remove duplicated mutations.
- **Exact proof:** extend `src/__tests__/main/plugins/authorization-ledger.test.ts`; run it with missing/corrupt ledger, duplicate revoke, stale grant replay, and write-failure cases.
- **Acceptance/rollback:** tombstoned grants cannot resurrect and repeated mutation is idempotent. Revert as one ledger commit and retain the pre-migration ledger backup.

### P59 - Sandbox byte enforcement

- **Observed:** `src/main/plugins/plugin-sandbox-host.ts` owns `MAX_MESSAGE_BYTES` and repeats payload-size checks across sandbox message/tool/event forwarding paths; related host-view checks already use shared byte mechanics.
- **Chosen API/order:** add a sandbox-local UTF-8 byte checker taking the explicit per-channel limit; add limit boundary/encoding tests first; migrate smallest event path, then tool/request paths; remove local length checks.
- **Exact proof:** extend `src/__tests__/main/plugins/plugin-sandbox-host.test.ts` and E2E plugin harness; run `bun run test -- src/__tests__/main/plugins` plus `bun run test:e2e -- e2e/plugins.spec.ts`.
- **Acceptance/rollback:** exact-limit succeeds, limit+1 and multibyte/base64 bypass attempts fail before forwarding/allocation, and error envelopes remain stable. Revert every migrated boundary with the helper; never leave a broader parser behind.

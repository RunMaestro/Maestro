# Stage 08 - Storage, Cache, and Provider Read Consolidation

## Objective

Consolidate repeated storage/cache mechanics while preserving provider-specific parsing, corruption policy, cache invalidation, and historical data.

## Priorities

**5, 15, 54, 55, 98, 101, 102, 111**

## Dependencies

Stages 02, 04, and 05 complete.

## Storage invariants

- No persisted session, origin, cache, or metadata record is lost.
- Provider-specific formats and sampling remain separate.
- Cache version/fingerprint mismatch returns a safe miss, never stale data.
- Read helpers preserve current missing/malformed/error behavior.
- New writes are atomic where the existing contract requires it.

## Priority playbooks

### 5 - Small storage helpers/constants

Inventory each duplicate constant/helper and group by identical store and error contract. Consolidate only within the same storage domain. Add tests for path/key calculation and missing/error cases. Avoid a generic storage utility that obscures schema ownership.

### 15 - Usage snapshot-store primitive

Create a comparison matrix for Claude/Codex/other usage snapshot stores: keying, version, retention, read failure, merge, timestamp, and provider data. Extract only a generic persistence envelope if at least two contracts match. Keep provider sampling/parsing separate. Test version mismatch, corrupt snapshot, merge, and concurrent refresh. `retain` is valid if the primitive adds policy switches.

### 54 - Local/remote metadata

Within each provider, centralize common metadata projection for local and remote sessions. Do not share across providers until field semantics match. Test local/remote parity for IDs, paths, timestamps, names, origins, and unavailable fields.

### 55 - Parse transcripts once

Trace read and search call paths per provider. Introduce a parsed transcript representation cached within one operation or by validated fingerprint. Ensure search and read consume the same parse result without changing ordering, truncation, malformed-line handling, or memory limits. Benchmark large transcripts and test invalidation after file change.

### 98 - Claude projects-directory construction

Choose one main-process local helper for encoding/locating Claude project directories. Characterize Windows drive letters, separators, home, Unicode, remote roots, and legacy encodings. Migrate all main callers and verify existing on-disk projects resolve unchanged.

### 101 - Versioned cache policy

Extract a policy helper for read/parse/version-check/cache-miss only where failure semantics match. Parameterize decoder/schema and expected version; keep logging and domain fallback explicit. Test missing, valid, old/new version, malformed, unreadable, and partial files.

### 102 - Keyed-array JSON reads

Define a typed decoder contract for files storing an array under a known key. Validate object shape and array element decoder. Preserve each caller's missing/malformed fallback. Avoid unsafe casts. Test wrong root, missing key, non-array, invalid element, and valid mixed-version fixtures.

### 111 - Claude origins-store migration

Treat as a standalone persistence migration inside this stage, not mechanical dedup:

1. Document old and target schemas and every read/write caller.
2. Decide cutover version and idempotent migration marker.
3. Read old and new during migration; write only target after successful conversion.
4. Back up original bytes before mutation.
5. Handle partial records, duplicate IDs, stale paths, and interrupted migration.
6. Verify rollback can still read the target or supply reverse conversion.
7. Remove old path only in Stage 14 after release-window proof.

## Verification

- Golden fixtures for every provider and cache version.
- Real filesystem round trips and fault injection.
- Large transcript performance/memory comparison.
- Local/remote session list and search smoke.
- Existing user-data copy migrated in a temporary profile; source bytes preserved.
- LSP references before removing helpers or old readers.

## Exit criteria

All eight priorities have evidence-backed dispositions; provider policies remain explicit; cache misses and corruption are safe; transcript parsing is not duplicated within an operation; origins migration is reversible and proven on fixtures.

## Investigated execution cards

|   P | Observed locations/contract                                                                                                                                                         | Chosen migration                                                                                                                                           | Focused evidence and rollback                                                                                                                             |
| --: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   5 | Small constants/read helpers repeat across main session/storage modules, including size limits such as `MAX_SESSION_FILE_SIZE` in Claude/Codex storage.                             | Consolidate only identical constants inside the storage domain; migrate imports per provider, leaving parse/error policy local.                            | Provider storage suites and large/malformed file fixtures. Revert per constant/helper family.                                                             |
|  15 | Usage snapshot stores such as renderer `claudeUsageStore.ts` and `codexUsageStore.ts` repeat versioned persistence, but provider sampling differs.                                  | Extract only a typed snapshot envelope if version/key/merge/failure matrices match; keep samplers separate.                                                | Both usage-store suites for missing/corrupt/version/merge; mark retain if helper becomes flag-heavy.                                                      |
|  54 | Provider session metadata builds local and remote records separately within Claude/Codex/Copilot storage providers.                                                                 | Add a provider-local metadata projector per provider; migrate local then remote paths; do not share across providers.                                      | Provider local/remote session list tests for IDs, paths, timestamps, names, origins.                                                                      |
|  55 | Provider read and search paths parse the same transcript separately.                                                                                                                | Introduce one per-operation parse result keyed by file fingerprint; make read/search consume it; preserve ordering/truncation/malformed-line policy.       | Large and malformed transcript fixtures; read/search parity and file-change invalidation; rollback cache layer only.                                      |
|  98 | `src/main/ipc/handlers/claude.ts` repeats `os.homedir()` plus `.claude/projects` construction; `getClaudeProjectsDir()` already exists elsewhere.                                   | Select one main-local path helper; migrate each handler/storage callsite; then remove local joins.                                                         | Claude project discovery tests for Windows drives, Unicode, legacy encoded paths, remote roots; session browser smoke.                                    |
| 101 | `src/main/utils/statsCache.ts`, `ipc/handlers/claude.ts::loadLegacyGlobalStatsCache`, and `storage/codex-session-storage.ts::loadCodexSessionCache` repeat read/parse/version/miss. | Add a typed versioned-cache reader accepting decoder/version and explicit logger/fallback; migrate one cache at a time.                                    | Cache fixtures for missing/current/old/new/malformed/unreadable; revert per cache consumer.                                                               |
| 102 | `feedback.ts::{readDrafts,readSubmittedIssues}` and `playbooks.ts::readPlaybooks` repeat JSON root/key/array casts.                                                                 | Add a typed keyed-array reader with element decoder; migrate feedback then playbooks while preserving each fallback.                                       | Wrong root/missing key/non-array/invalid element fixtures in handler/service tests.                                                                       |
| 111 | `claudeSessionOriginsStore` and newer `originsStore` paths coexist; rename/global-stats consumers still depend on origin metadata.                                                  | Specify old/target schemas, back up, dual-read, idempotently migrate, write target only after conversion; remove old path only in Stage 14/release window. | Dedicated origins migration fixtures plus rename, aggregate stats, restart, and rollback-profile smoke. Never revert code without a reader for new files. |

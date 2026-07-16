# Stage 06 - Settings Defaults, Parsing, Loading, and Migration

## Objective

Create one authoritative settings policy while preserving user data, platform behavior, CLI compatibility, and renderer startup.

## Priorities

**6, 10, 18, 32, 41, 65, 92**

## Dependencies

Stages 02, 04, and 05 complete.

## Persistence invariants

- Existing settings files continue to load.
- Defaults are applied only to absent/invalid fields, not over explicit user choices.
- Main, metadata, CLI, and renderer agree on key, type, default, and migration semantics.
- Platform-dependent defaults are resolved in one documented layer.
- Failed migration never destroys the original file.
- Session-scoped migrations expire or become idempotent named migrations.

## Priority playbooks

### 6 - Canonical default semantics

1. Generate a matrix of every setting across main defaults, `settingsMetadata`, renderer initial state, CLI reset, and migrations.
2. Classify each mismatch as bug, platform policy, historical migration, or presentation-only metadata.
3. Decide canonical semantics for dynamic defaults: either a shared resolver or an explicit static default plus runtime override.
4. Resolve known drift such as native title bar and SSH ignore/gitignore behavior with product reasoning and migration impact.
5. Add a contract test that enumerates keys and validates type/default agreement.

### 41 - Adaptive Mode policy

Treat this as a product decision inside the canonical default matrix. Define default for new installs, existing users, reset, and platform variance. Remove always-false or duplicated helpers only after the policy is encoded and tested.

### 18 - Split settings store responsibilities

Refactor in behavior-preserving slices:

1. Extract default construction.
2. Extract persisted-load decoding/validation.
3. Extract migration orchestration.
4. Group setters by domain while retaining one Zustand store/public API.
5. Keep persistence side effects explicit and testable.

Do not rewrite all settings at once. After each slice, run store/load tests and launch settings UI.

### 10 - CLI parsing/error wrappers

Build contract tests first for booleans, numbers, JSON, strings, missing keys, unknown keys, malformed values, and output envelopes. Reuse the canonical setting metadata/type policy where safe. Extract parsing and compatible error wrappers; preserve command exit codes and stdout/stderr JSON.

### 32 - Notification color resolution

Choose canonical color names/aliases and normalize at a single compatibility boundary. Keep old persisted values readable until migrated. Remove duplicate renderer/main maps after tests cover legacy and canonical values.

### 65 - Comment-JSON installer persistence

Compare all write paths for comment preservation, indentation, key ordering, atomicity, missing files, and malformed JSON. Choose one persistence service for installer-owned keys. Use Stage 04 atomic-write policy only if contracts match. Test comments survive and failures leave original bytes intact.

### 92 - Session migration expiry

Inventory every session migration marker, activation condition, version window, and caller. For each: remove if the supported upgrade window has passed and telemetry/release policy permits; otherwise convert to an idempotent named migration with explicit source/target versions. Never use current-session booleans as permanent schema history.

## Required tests

- Fresh install/default construction on Windows and a non-Windows platform abstraction.
- Explicit user value versus absent key.
- Old-version settings fixtures for every retained migration.
- Malformed, wrong-type, NaN/Infinity, partial, and unreadable settings.
- CLI get/set/reset/list output and exit codes.
- Commented JSON preservation and interrupted write.
- Renderer settings UI smoke: load, change, restart, reset.

## Rollout

Land the default contract and tests before store decomposition. Land migrations before changing writes. Keep backups or read-old support for at least the migration PR's verification window. Do not combine a default change with unrelated UI cleanup.

## Rollback

Rollback must restore prior code while leaving files written by the new version readable. If the new format is not backward-compatible, provide a reverse migration or delay write cutover.

## Exit criteria

All seven priorities are resolved; key/default/type drift tests pass; current and historical settings load; CLI and renderer share policy without sharing presentation; migrations are explicit and safe; Electron restart smoke passes.

## Investigated execution cards

|   P | Observed locations/difference                                                                                                                                                                                                                                                  | Decision and file order                                                                                                                              | Focused proof / rollback                                                                                                                      |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
|   6 | Defaults drift among `src/main/stores/defaults.ts`, `src/shared/settingsMetadata.ts`, and `src/renderer/stores/settingsStore.ts`; known mismatches include `defaultShell`, `sshRemoteIgnorePatterns`, `sshRemoteHonorGitignore`, `useNativeTitleBar`, and `customThemeColors`. | Build a key matrix; encode static defaults/typed dynamic resolver in shared; update main defaults, metadata, renderer initial state, then CLI reset. | Add `src/__tests__/shared/settings-defaults.test.ts`; Windows/non-Windows fresh/reset/restart smoke. Roll back policy and migration together. |
|  10 | `parseValue` and error handling repeat in `src/cli/commands/settings-set.ts` and `settings-agent.ts`.                                                                                                                                                                          | After CLI contract tests, extract a settings CLI parser using metadata type; migrate set then agent command, preserving stdout/stderr/exit.          | `bun run test -- src/__tests__/cli/commands/settings*.test.ts`; subprocess exact-output cases. Revert both commands/helper as a unit.         |
|  18 | `src/renderer/stores/settingsStore.ts` combines defaults, a large `loadAllSettings`, migrations, and 60+ setters.                                                                                                                                                              | Extract defaults first, decoder/load second, migration orchestration third, domain setter slices last; retain the public Zustand store.              | Run settingsStore suites after each extraction and Electron change/restart/reset smoke. Revert only the latest slice.                         |
|  32 | Legacy notification color maps repeat in renderer notification/center-flash stores and transport compatibility code.                                                                                                                                                           | Choose shared canonical color plus alias normalization at load/transport boundary; migrate stores and remove local maps after old fixtures pass.     | Notification store/flash/CLI tests for legacy and canonical colors; rollback preserves old-value reader.                                      |
|  41 | `isAdaptiveModeDefaultOn` in `src/shared/agentConstants.ts` is an always-false policy helper while settings/main migrations carry separate policy.                                                                                                                             | Decide new/existing/reset behavior; encode in canonical settings default and remove redundant helper only after migration tests.                     | Adaptive-mode migration/default tests and fresh/existing profile smoke. Revert policy plus migration.                                         |
|  65 | Coworking installers (`src/main/coworking/installers/claude-code.ts`, `factory-droid.ts`, `opencode.ts`, and peers) duplicate comment-JSON read/write persistence.                                                                                                             | Create installer-local comment-preserving store with atomic write; migrate one installer, compare bytes, then compatible peers.                      | New installer persistence fixtures for comments/malformed/interrupted write; run installer suites. Restore original file on failure.          |
|  92 | Session migrations in `src/main/stores/migrations/adaptive-mode-default.ts`, `api-mode-default.ts`, and `migrations/index.ts` use repeated marker/try-catch patterns.                                                                                                          | Mark expired migrations for deletion; convert retained ones to named idempotent versioned migrations; update registry then remove session booleans.  | Old/current/malformed fixture tests and repeated-run idempotence. Rollback must still read files written by new version.                      |

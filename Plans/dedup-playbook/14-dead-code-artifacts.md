# Stage 14 - Verified Dead Code, Aliases, Hooks, and Assets

## Objective

Delete only after every replacement and migration stage has landed. This stage removes proven garbage without becoming a second refactor stage.

## Priorities

**1, 39, 42, 91, 95, 103, 104, 119**

## Dependencies

Stages 01-13 complete for any affected subsystem. Stage 14 must not run early.

## Deletion proof protocol

For every target:

1. Re-read original report evidence.
2. Run LSP references on exported symbols.
3. Search textual, dynamic, channel, filename, package-export, CSS, documentation, and generated consumers.
4. Identify replacement behavior and smoke-test it.
5. Delete target and associated obsolete tests/mocks/docs only when they exclusively cover the deleted path.
6. Run focused tests, type checks, package/build verification, and application smoke.
7. Record bytes/lines removed and proof. If any consumer is uncertain, defer instead of deleting.

## Priority playbooks

### 1 - `[WT-DEBUG]` instrumentation

Run the worktree smoke scenario while instrumentation is present and capture expected diagnostics. Remove debug logs, temporary flags, and supporting dead branches only after the scenario passes without needing them. Preserve production-grade error logging. Verify no `[WT-DEBUG]` strings and no behavior change in worktree create/open/remove.

### 39 - `useDocumentCycle`

Run LSP references and search barrels/dynamic hook access. Confirm intended replacement/current document navigation path. Delete hook and exclusive tests only after navigation smoke proves replacement. If a consumer remains, migrate in the owning stage rather than deleting here.

### 42 - `notification.onTtsCompleted`

Confirm compatibility window and zero consumers across main, preload, renderer, web, plugins, and docs. Verify canonical notification/TTS completion event. Remove alias, types, registration, mocks, and compatibility tests together. Exercise TTS notification completion.

### 91 - Bundled-command service exports

Identify dead exports versus live loaders. Migrate any final callers to unified live loaders first. Remove dead service exports, implementation branches, barrel entries, mocks, and tests that assert only obsolete wiring. Run BMAD/SpecKit/OpenSpec command loading smoke.

### 95 - `AgentSessionsModal.tsx`

Verify the replacement modal covers open, search/filter, selection/resume, star, close, keyboard, and empty/error states. Use LSP and dynamic modal registry search. Delete file, exports, styles, tests, and assets only after real Electron flow and focused replacement tests.

### 103 - Declaration-only production utilities

Handle each symbol independently. The report identifies candidates such as `getShellCommand`, `readDirWithResolvedTypes`, `getLocalIpAddressSync`, legacy pricing helpers including `calculateCost`/`calculateClaudeCost`, and `getSshConfigHostSummary`. Refresh references because this family is drift-prone. Do not confuse similarly named live replacements. Relocate a helper to shared/test code if tests or a canonical renderer migration still need it; otherwise remove declaration, export, tests that only test dead behavior, and stale docs. `calculateClaudeCost` was rechecked during Wave 18 and had no production callers, but must be rechecked again at implementation time.

### 104 - Deprecated aliases and hook

Enumerate each alias/hook covered by the report, its replacement, deprecation version, and consumers. Migrate remaining internal callers in prior stages. Delete aliases individually with LSP proof; do not bulk-delete by `@deprecated` annotation because some compatibility code is intentionally live.

### 119 - `pedram-avatar.png`

Search basename, relative path, asset manifest, CSS URLs, runtime concatenation conventions, docs, packaging resources, and tests. Confirm no dynamic asset loader. Delete the 4 KB asset and package/build smoke. Do not touch attribution or active conductor/wand/icon assets.

## Verification

- LSP and textual references are zero for every deleted public symbol/file.
- TypeScript, lint, and focused tests pass.
- Electron main/renderer build and launch pass.
- Packaged resources do not reference deleted assets.
- Worktree, TTS, command loading, agent-session modal replacement, and relevant utility flows smoke successfully.
- Final diff contains deletion and necessary import/export cleanup only.

## Rollback

Each deletion should be independently revertible. Restore the entire symbol/file plus exports/tests if a missed consumer appears; do not add a no-op shim.

## Exit criteria

All eight priorities have deletion or explicit retain/defer evidence; no uncertain dynamic consumer is ignored; replacements are proven; no dead alias/file remains in exports or packaging.

## Investigated deletion manifest

|   P | Candidate and precondition                                                                                                                    | Deletion order and focused proof                                                                                          | Item rollback                                                                     |
| --: | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
|   1 | `[WT-DEBUG]` instrumentation in worktree IPC/session paths.                                                                                   | Deleted in `61060bd1`; worktree smoke and source scan proved the diagnostics were no longer needed.                       | Revert `61060bd1` to restore the exact instrumentation.                           |
|  39 | `useDocumentCycle` in `SymphonyModal` has a live `RepositoryDetailView` consumer, public barrel export, and focused wrap/no-op/cleanup tests. | **Retained.** The concrete Symphony document-navigation contract is not a compatible duplicate; no deletion is warranted. | No deletion to roll back; preserve the hook, consumer, barrel, and focused tests. |
|  42 | Deprecated `notification.onTtsCompleted` alias beside the canonical completion event.                                                         | Deleted in `8b8bcdb4` after producer, preload, declaration, mock, and consumer migration.                                 | Revert `8b8bcdb4` as one notification-contract unit.                              |
|  91 | Dead bundled-command service exports after loaders converged.                                                                                 | Deleted in `ad7d7225`; live BMAD, SpecKit, and OpenSpec loaders remain the only command-loading path.                     | Revert `ad7d7225` to restore the removed exports.                                 |
|  95 | `src/renderer/components/AgentSessionsModal.tsx` after the replacement session surfaces covered the flow.                                     | Deleted in `e69b8e66` after source, registry, style, and asset reference checks.                                          | Revert `e69b8e66` to restore the complete component wiring.                       |
| 103 | Declaration-only production utilities whose individual callers were rechecked.                                                                | Deleted in `ee7bab81`; only verified declaration-only exports and their exclusive dead tests were removed.                | Revert `ee7bab81` to restore the removed utility API surface.                     |
| 104 | Deprecated aliases and the Git status hook after caller migration.                                                                            | Deleted in `5e38a219`; aliases were removed individually rather than by blanket deprecation annotation.                   | Revert `5e38a219` as the compatibility-hook cutover.                              |
| 119 | Unreferenced `src/renderer/assets/pedram-avatar.png` renderer asset.                                                                          | Deleted in `bcee4cd3` after basename, asset-manifest, CSS, package-resource, and test scans found no consumer.            | Revert `bcee4cd3` to restore the exact asset.                                     |

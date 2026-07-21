# Stage 04 - Pure Utilities and Mechanical Consolidation

## Objective

Create small, neutral, well-tested primitives for compatible pure logic before higher-risk migrations depend on them.

## Priorities

**2, 30, 40, 49, 56, 60, 66, 67, 74, 76, 82, 96, 120**

## Dependencies

Stages 00-02 complete. Stage 03 is independent unless a utility is used by scripts.

## Design rules

- Shared code belongs in the narrowest neutral layer importable by every caller.
- Preserve exact input/output/error semantics. Do not merge functions merely because their bodies look alike.
- Prefer a named options object over boolean arguments when policies differ.
- Each primitive receives table-driven parity and boundary tests before caller migration.
- Migrate all compatible callers, then remove local copies in the same PR.

## Priority playbooks

### 2 - `sanitizeFilename`

Inventory every implementation and compare replacement character, Unicode handling, reserved Windows names, path separators, dot names, trailing dots/spaces, length, and empty fallback. Define one canonical cross-platform contract. Add Windows/Linux boundary fixtures and migrate exports with LSP references. Verify tab export, gist, clipboard, and file creation using real filenames.

### 30 - Renderer `resolveUpdater`

Compare the five copies for functional updater detection and state typing. Create a generic renderer-store helper that evaluates value-or-updater exactly once. Add tests for direct value, updater, referential identity, and thrown updater. Migrate stores one at a time and run their focused tests.

### 40 - `hasInvalidOptionalStrings`

Locate every validator copy and compare treatment of absent, `undefined`, empty, whitespace, arrays, and non-string values. Put the canonical guard beside existing shared validators. Keep field-name/error formatting at the domain validator. Add table tests, migrate, then remove copies.

### 49 - Quoted argument parsing

Characterize quotes, escaped quotes, backslashes, empty quoted values, Unicode, unmatched quotes, and platform-specific paths. Choose one parser contract; do not silently turn it into a shell parser. Add golden cases from every caller and migrate only callers with matching grammar. Preserve error/fallback behavior.

### 56 - Home expansion

Define `~` expansion precisely: bare `~`, `~/`, `~\`, non-leading tilde, missing home, Windows paths, and no other-user expansion unless supported. Place in shared path utilities usable by main/CLI. Test both separator styles and migrate exact copies.

### 60 - Scalar debounce and atomic writes

Treat as two verify-first subtracks. For debounce, compare leading/trailing, cancellation, flush, promise, and teardown semantics; migrate only scalar trailing-edge callers. For atomic writes, compare temp naming, permissions, fsync, rename replacement, cleanup, and Windows behavior. Do not unify stores with different durability contracts. Add fake-timer and fault-injection tests.

### 66 - Comparison-path normalization

Document whether comparison is case-sensitive by platform, how separators, trailing slash, `.`/`..`, UNC, drive letters, symlinks, and remote paths behave. Build a pure normalization helper only for string-comparison callers; security containment must still use resolved paths. Add Windows/POSIX table tests.

### 67 - Renderer HTML escaping

Use one neutral renderer utility for text-context HTML escaping. Test `& < > " '` and already-escaped input. Do not apply it to URL, attribute, Markdown, or trusted HTML contexts without separate contracts. Migrate tab/group export callers and assert exact generated HTML.

### 74 - Notification color and timeout validators

Compare accepted colors, aliases, defaults, timeout units, zero/null semantics, and bounds. Create shared pure validators with explicit return types. Keep transport-specific error envelopes outside. Add valid/invalid/edge table tests and migrate matching callers.

### 76 - Image data URL and MIME helpers

Define a strict parser returning validated MIME and decoded bytes/metadata. Reject malformed prefixes, unsupported MIME, invalid base64, whitespace tricks, oversized data, and MIME/extension mismatch. Preserve security limits at callers. Add negative tests before migrating image upload/annotation paths.

### 82 - Neutral `escapeRegExp`

Choose the implementation that escapes every ECMAScript regex metacharacter without changing ordinary Unicode. Add table and property-style tests. Place in neutral string utilities and migrate all exact copies; retain context-specific escaping that targets glob or replacement syntax.

### 96 - Byte-size formatting

First capture presentation differences: binary/decimal base, suffixes, precision, zero, negatives, and locale. Expose options only for proven variants. Add snapshot/table tests for each current caller. Consolidate compatible callsites; retain deliberate display differences.

### 120 - Cue empty-directory removal

Keep public `removeEmptyPromptsDir` and `removeEmptyMaestroDir` wrappers. Extract one private best-effort core accepting resolved directory and operation label. Preserve existence check, empty-only deletion, Sentry context, and boolean result. Test absent, empty, non-empty, readdir failure, rmdir failure, and wrapper paths.

## Verification

- Focused unit tests for every primitive.
- LSP references for all exported/local copies before deletion.
- Type checks for generic helpers.
- Real filesystem tests for filename, expansion, atomic write, image, and directory cleanup where applicable.
- Exact output snapshots for HTML and byte formatting.

## Exit criteria

All 13 priorities are resolved; every shared helper has at least two compatible consumers or a clear correctness role; no policy-specific code was hidden behind generic options; all local copies are removed only after parity proof.

## Investigated execution cards

|   P | Current duplicate anchors                                                                                                                                            | Canonical target and file order                                                                                                    | Exact proof / item rollback                                                                                                                                               |
| --: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   2 | `sanitizeFilename` implementations in renderer export/gist paths, including `src/renderer/hooks/useTabExportHandlers.ts`; tests already exercise illegal characters. | Put the full cross-platform contract in one neutral renderer utility; add tests first, migrate export/gist callers, delete locals. | `bun run test -- src/__tests__/renderer/hooks/useTabExportHandlers.test.ts`; create Windows reserved/trailing-dot fixtures. Revert caller migrations if filenames differ. |
|  30 | `resolveUpdater` copies in `sessionStore.ts`, `batchStore.ts`, `fileExplorerStore.ts`, `groupChatStore.ts`, and `uiStore.ts`.                                        | Add `src/renderer/stores/resolveUpdater.ts`; migrate the five stores in that order.                                                | Run the five store suites together; direct/updater/throw tests. Revert per store while keeping helper.                                                                    |
|  40 | `hasInvalidOptionalStrings`/equivalent guards in `src/shared/agent-run/validators.ts` and `src/shared/campaign/validators.ts`.                                       | Put one guard beside shared validators; preserve domain error messages at callers.                                                 | `bun run test -- src/__tests__/shared`; absent/empty/whitespace/non-string table.                                                                                         |
|  49 | `src/main/utils/agent-args.ts:51-63` and `src/main/process-manager/spawners/PtySpawner.ts:62-75` parse quoted argv similarly.                                        | Canonicalize in `src/main/utils/agent-args.ts`; import from the spawner only after quote/backslash parity.                         | Run agent-args/PtySpawner tests with empty/unmatched/Windows path cases. Revert spawner migration if grammar changes.                                                     |
|  56 | Home expansion repeats in process/env/CLI paths, including `src/main/process-manager/utils/envBuilder.ts`.                                                           | Add one path helper supporting only bare `~` and leading `~/`/`~\\`; migrate main then CLI.                                        | New shared path table tests on Windows/POSIX abstractions; real cwd/path smoke.                                                                                           |
|  60 | Scalar trailing debounce copies surround `src/main/utils/debounce.ts`; atomic temp-write/rename patterns recur in stores.                                            | Extend/reuse debounce only for identical trailing behavior; separately codify atomic write only for identical durability.          | Fake timers for cancel/reschedule; filesystem fault tests for temp cleanup/rename. Roll back each family separately.                                                      |
|  66 | Comparison normalization occurs in `src/renderer/utils/worktreeDedup.ts`, storage/stat helpers, and modal comparisons.                                               | Add a pure comparison-path helper; do not replace security containment.                                                            | Windows drive/UNC and POSIX table tests; worktree dedup smoke.                                                                                                            |
|  67 | `src/renderer/utils/groupChatExport.ts` and `tabExport.ts` duplicate HTML escaping; `markdownFast/escapeHtml.ts` has a different parser context.                     | Create neutral renderer text-context escape utility for export callers; leave parser/pre contexts unless parity proven.            | Exact export HTML tests and markdownFast suite; revert only export migrations.                                                                                            |
|  74 | Notification color/timeout validation repeats across CLI notify commands and main/web handlers.                                                                      | Place typed validators in shared notification contract; keep error envelopes local.                                                | CLI notify plus handler tests for aliases, invalid colors, zero/bounds.                                                                                                   |
|  76 | Inline image data-URL/MIME parsing appears in renderer image/clipboard/upload paths.                                                                                 | Add strict shared/neutral parser returning validated MIME and bytes; migrate smallest consumer first.                              | Negative malformed/base64/Unicode/limit tests and image upload/annotation smoke. Revert all parser consumers if rejection policy changes.                                 |
|  82 | `escapeRegExp` copies exist in renderer file preview/group export/image handling and main utility code.                                                              | Put ECMAScript regex escaping in a neutral shared string utility, retaining glob/replacement escapers.                             | Table/property tests plus all caller suites; revert a caller whose syntax is not regex-pattern syntax.                                                                    |
|  96 | `src/shared/formatters.ts:formatSize`, `UpdateCheckModal.tsx`, and `FileExplorerPanel/utils/pathHelpers.ts:formatBytes` differ in base/precision.                    | Add explicit binary/decimal/precision options only for observed variants; migrate compatible displays.                             | Snapshot 0, boundaries, large values in each UI test; visual check. Retain local formatter if product copy differs.                                                       |
| 120 | `src/main/cue/config/cue-config-repository.ts:92-107` and `:119-134` implement `removeEmptyPromptsDir`/`removeEmptyMaestroDir`.                                      | Extract private `removeEmptyDir(dir, operation)`; keep both public wrappers and Sentry labels.                                     | Cue repository tests for absent/empty/non-empty/read/remove failure. Revert helper extraction as one commit.                                                              |

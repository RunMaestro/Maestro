# Stage 01 - Conflict Resolution and Canonical Baseline

## Objective

Resolve all tracked source conflicts before deduplication. A conflicted file contains multiple competing implementations and invalidates reference counts, dead-code claims, and behavioral baselines.

## Priorities

- **75:** Resolve the browser-tab security merge conflict toward canonical modules.
- **94:** Reconcile all tracked source merge conflicts.

## Dependencies

- Stage 00 complete.
- Dedicated branch/worktree with no unrelated edits.

## Invariants

- Conflict resolution is semantic, not "take ours/theirs".
- Preserve security hardening, new behavior, tests, and public contracts from both sides when compatible.
- No dedup refactor is performed in this stage, even when a conflict exposes duplication.
- The result must compile and run before later stages treat it as canonical.

## Priority 94 - Reconcile every tracked conflict

### Investigation

1. Enumerate unresolved conflict blocks using the repository-aware conflict reader.
2. For each block, identify the base, both branch intentions, surrounding callsites, tests, and referenced issue/plan.
3. Classify the conflict: import/export, type/schema, behavior, security, generated output, documentation, or test expectation.
4. Run LSP definitions/references for every symbol whose declaration differs between sides.
5. Check whether either side was superseded elsewhere after the branches diverged.

### Resolution sequence

- Resolve shared types and exported interfaces first.
- Resolve main-process producers before preload and renderer consumers.
- Resolve implementation before tests; then reconcile tests against the chosen contract.
- Regenerate generated artifacts from source rather than hand-merging generated output.
- Keep conflict-resolution commits isolated by subsystem.

### Verification

- No unresolved conflict markers in tracked source.
- Changed files parse and type-check.
- Focused tests for every behavior-bearing conflict pass.
- Generated files, if any, match their generator.
- A file-by-file decision log explains what was retained and why.

## Priority 75 - Browser-tab security conflict

### Canonical direction

Resolve toward the existing canonical browser-tab security modules rather than preserving parallel inline implementations. The final path must have one owner for navigation policy, permission handling, external-link decisions, guest webview hardening, and shortcut forwarding.

### Required trace

Document the complete flow:

1. Browser tab/webview creation.
2. Guest session partition and web preferences.
3. Navigation and popup interception.
4. Permission request/check handling.
5. Download/external URL policy.
6. Shortcut forwarding and teardown.
7. Main-to-renderer/preload channel exposure.

### Safety tests before resolution

Characterize both sides for:

- allowed `https` navigation;
- blocked disallowed schemes;
- popup/new-window behavior;
- external URL handoff;
- permission denial by default;
- allowed permission exceptions;
- path/URL normalization edge cases;
- destroyed webContents and late events;
- listener registration and removal;
- browser-tab keyboard shortcuts.

### Implementation rules

- Import canonical policy functions instead of copying rules into the conflict site.
- Keep security decisions in the main process.
- Never broaden an allowlist to make a conflict disappear.
- Reject unknown schemes, malformed URLs, and missing context.
- Ensure every listener registered on a guest is removed on teardown.
- Preserve logging without leaking sensitive URL data.

### Verification

- Run the focused browser-tab security tests.
- Launch Electron and exercise a real browser tab with allowed and denied navigation.
- Observe console/main logs for duplicate listener warnings or unhandled permission requests.
- Verify the loaded `dist/main/index.js` contains a unique string from the resolved source after a forced main build.

## Stage verification matrix

| Check                           | Required result                                        |
| ------------------------------- | ------------------------------------------------------ |
| Conflict scan                   | Zero unresolved tracked conflict blocks                |
| Type/LSP diagnostics            | No new diagnostics in resolved files                   |
| Focused tests                   | Pass for each behavior-bearing conflict                |
| Browser security negative cases | Denied and fail-closed                                 |
| Electron smoke                  | Browser tab opens, navigates, and tears down correctly |
| Generated artifact check        | Generated output matches source generators             |

## Rollback

Revert conflict-resolution commits by subsystem. Do not partially revert a security contract across main/preload/renderer boundaries.

## Exit criteria

- Priorities 75 and 94 have decision evidence.
- All tracked conflicts are resolved.
- Browser-tab security has one canonical implementation.
- The baseline compiles and the affected paths smoke-test.
- No unrelated deduplication was introduced.

## Investigated execution cards

### P75 - Browser-tab security conflict

- **Source refresh (2026-07-14):** current `src/main/app-lifecycle/window-manager.ts` imports `attachGuestWebviewSecurity`; `guest-webview-security.ts` imports `isAllowedBrowserTabPartition` from the shared owner. No copied browser-tab predicate remains in `window-manager.ts`.
- **Disposition/order:** candidate is `already resolved` on the inspected checkout, subject to recheck on the fresh `origin/rc` execution base. Preserve the main-to-security-to-shared ownership; do not reintroduce a wrapper.
- **Focused proof:** run browser-tab security/window-manager tests, force `bunx tsc -b tsconfig.main.json --force`, launch Electron, and exercise allowed/denied navigation and ephemeral partitions.
- **Acceptance/rollback:** one predicate owner and denied cases remain denied. If the execution base differs, reconcile toward the same owner and revert the complete security resolution if any permission broadens.

### P94 - All tracked conflicts

- **Source refresh (2026-07-14):** a repository source scan found zero `<<<<<<<`, `=======`, or `>>>>>>>` markers. The earlier eight-file conflict list is historical evidence from the audit checkout, not a current edit manifest.
- **Disposition/order:** mark `already resolved` only after the fresh `origin/rc` worktree scan and behavior matrix pass. If any conflict reappears after integrating prerequisites, resolve shared/browser types first, main process/spawner second, preload/renderer consumers third, and tests last; never choose a side mechanically.
- **Focused proof:** conflict-marker scan, `bun run test -- src/__tests__/main/ipc/handlers/process.test.ts`, affected BrowserTab/settings suites, `bun run lint`, and Electron smoke for process spawn, OpenCode fallback, profile persistence, ephemeral tabs, and modal sizing.
- **Acceptance/rollback:** zero markers and every listed behavior works. If no marker exists, no source commit is created for P94; record `already resolved` evidence in the ledger.

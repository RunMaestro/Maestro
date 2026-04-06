# Phase 07-A: Extract Session Update Helpers

## Objective

Extract `updateAiTab()` and `updateActiveAiTab()` helpers into `sessionStore.ts` to replace 82 instances of nested `aiTabs.map`/`aiTabs.filter` calls inside `setSessions` updaters across 25 files. Also eliminate 14+ `setSessions` prop-drilling sites.

**Evidence:** `docs/agent-guides/scans/SCAN-BLOCKS.md`, "Nested aiTabs.map Calls" and "setSessions Calls by File"
**Risk:** Medium - touches core state management. Must verify each migration preserves exact behavior.
**Estimated savings:** ~600 lines (400 from nested maps + 200 from prop-drilling)

---

## Pre-flight Checks

- [x] Phase 06 (SpecKit/OpenSpec) is complete
- [x] `rtk npm run lint` passes
- [x] `CI=1 rtk vitest run` passes (36 pre-existing failures in 18 files, documented in Phase 05 - none related to session store helpers)

---

## Important Context

The current pattern everywhere:

```typescript
setSessions((prev) =>
	prev.map((s) =>
		s.id === sessionId
			? {
					...s,
					aiTabs: s.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, someField: newValue } : tab)),
				}
			: s
	)
);
```

This should become:

```typescript
updateAiTab(sessionId, tabId, (tab) => ({ ...tab, someField: newValue }));
```

---

## Tasks

### 1. Design and add helper API to sessionStore

- [x] Read `src/renderer/stores/sessionStore.ts` to understand existing store shape
- [x] Add `updateAiTab(sessionId, tabId, updater)` function that uses `useSessionStore.setState` with nested `sessions.map` + `aiTabs.map`
- [x] Add `updateActiveAiTab(sessionId, updater)` function that maps over `aiTabs` using `s.activeTabId` to find the active tab
- [x] Add `updateSessionWith(sessionId, updater)` function that maps over `sessions` by ID (named `updateSessionWith` to avoid collision with existing `updateSession` store action that takes `Partial<Session>`)
- [x] Export all three functions from `src/renderer/stores/sessionStore.ts`

### 2. Write unit tests for the helpers

- [x] Create `src/__tests__/renderer/stores/sessionStoreHelpers.test.ts`
- [x] Test `updateAiTab` modifies the correct tab and leaves others unchanged
- [x] Test `updateAiTab` with non-existent session ID is a no-op
- [x] Test `updateActiveAiTab` modifies only the active tab
- [x] Test `updateSession` modifies the correct session
- [x] Test immutability: original state object is not mutated
- [x] Run tests: `CI=1 rtk vitest run src/__tests__/renderer/stores/sessionStoreHelpers.test.ts` (14/14 pass)

### 3. Migrate top offender files (6 files, 49 calls)

- [x] Migrate `useWizardHandlers.ts` (12 nested aiTabs.map calls) - all 12 migrated to `updateAiTab`/`updateSessionWith`
- [x] Migrate `useInputProcessing.ts` (10 calls) - 5 migrated to `updateAiTab`/`updateSessionWith`, 5 kept inline (complex queue/batch patterns)
- [x] Migrate `useTabHandlers.ts` (8 calls) - 7 migrated to `updateAiTab`/`updateSessionWith`, 4 kept inline (complex multi-tab/queue patterns)
- [x] Migrate `useAgentListeners.ts` (8 calls) - 2 migrated to `updateAiTab`/`updateSessionWith`, 6 kept inline (complex multi-tab/exit/synopsis patterns)
- [x] Migrate `useInterruptHandler.ts` (6 calls) - 3 `setSessions` -> 3 `updateSessionWith` (inner aiTabs.map stays for multi-tab interrupt cleanup)
- [x] `useBatchedSessionUpdates.ts` (5 calls) - KEPT INLINE: all 5 aiTabs.map calls are inside a single `setSessions` that processes ALL sessions atomically in the batch flush. Standalone helpers would break batch atomicity and cause N re-renders instead of 1.
- [x] For each file: read, replace `setSessions` + `aiTabs.map` with the appropriate helper, verify with `CI=1 rtk vitest run <relevant-test>` - All 6 test files pass (271/271 tests green). Updated `useInputProcessing.test.ts` to use `expectSessionsUpdated()` helper for assertions that now go through store helpers instead of the mocked `setSessions` prop.

### 4. Migrate remaining 19 files

- [x] Find all remaining files: `rtk grep "setSessions.*prev.*map" src/ --glob "*.{ts,tsx}"` - Found 17 non-test renderer files + 3 web files (web files use React useState, not Zustand, so cannot use store helpers)
- [x] For each file: replace `setSessions(prev => prev.map(` patterns with `updateSession`, `updateAiTab`, or `updateActiveAiTab` - Migrated 16 patterns across 7 renderer files: TerminalView (2), RightPanel (1), SessionList (2), RenameSessionModal (1), QuickActionsModal (3), FileExplorerPanel (3), useAgentSessionManagement (1). Updated dependency arrays where setSessions was removed.
- [x] If an updater does something the helpers don't cover (e.g., updates multiple tabs), keep inline or create a new helper - Kept inline: useWorktreeHandlers (6, filter+map/dedup/append), useAutoRunHandlers (1, map+append), App.tsx (3, filter/side-effects/bulk), useCliActivityMonitoring (1, maps all sessions), useSessionPagination (1, append), QuickActionsModal (1, maps all sessions), useInputHandlers (1, maps all sessions without session filter), tabHelpers (JSDoc examples only). Web files (useMobileSessionManagement, useSessions) kept inline due to React useState vs Zustand incompatibility. Files already using updateSessionWith (agentStore, useQueueProcessing, useAgentExecution, useRemoteHandlers, useRemoteIntegration, useSessionLifecycle, useMergeTransferHandlers, useBatchHandlers) - no further migration needed.
- [x] Run targeted tests after each file: `CI=1 rtk vitest run <relevant-test>` - All 607 tests pass (522 from modified component/hook tests + 85 from store tests). Updated 5 test files to assert on `useSessionStore.setState` instead of mocked `setSessions` prop.

### 5. Eliminate setSessions prop-drilling (14+ sites)

- [ ] Convert `useTabHandlers.ts` (68 setSessions calls) to use store directly
- [ ] Convert `useWizardHandlers.ts` (25 calls) to use store directly
- [ ] Convert `App.tsx` (22 calls) to use store directly
- [ ] Convert `useInputProcessing.ts` (18 calls) to use store directly
- [ ] Convert `useFileTreeManagement.ts` (18 calls) to use store directly
- [ ] Convert `useRemoteIntegration.ts` (17 calls) to use store directly
- [ ] Convert remaining prop-drilling sites to import helpers from `sessionStore` directly

### 6. Remove setSessions from component prop interfaces

- [ ] Work bottom-up from leaf components: remove `setSessions` from each props interface after migration
- [ ] Remove the prop from parent JSX where it was being passed
- [ ] Verify no TypeScript errors: `rtk tsc -p tsconfig.main.json --noEmit`

### 7. Verify full build

- [ ] Run lint: `rtk npm run lint`
- [ ] Run tests: `CI=1 rtk vitest run`
- [ ] Verify types: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`

### 8. Verify reduction in duplication

- [ ] Count remaining setSessions: `rtk grep "setSessions" src/ --glob "*.{ts,tsx}" | wc -l` (exclude `__tests__` and `sessionStore`)
- [ ] Count remaining aiTabs.map: `rtk grep "aiTabs\.map" src/ --glob "*.{ts,tsx}" | wc -l` (exclude `__tests__` and `sessionStore`)
- [ ] Both counts should be significantly reduced from baseline

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
CI=1 rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable. If a test you didn't touch starts failing, investigate whether your refactoring broke it.

Find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- `updateAiTab`, `updateActiveAiTab`, `updateSession` helpers in sessionStore
- 82 nested `aiTabs.map` patterns replaced with helper calls
- 14+ prop-drilling sites eliminated
- Unit tests for new helpers
- Lint and tests pass

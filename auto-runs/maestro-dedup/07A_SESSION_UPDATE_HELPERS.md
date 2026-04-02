# Phase 07-A: Extract Session Update Helpers

## Objective

Extract `updateAiTab()` and `updateActiveAiTab()` helpers into `sessionStore.ts` to replace 82 instances of nested `aiTabs.map`/`aiTabs.filter` calls inside `setSessions` updaters across 25 files. Also eliminate 14+ `setSessions` prop-drilling sites.

**Evidence:** `docs/agent-guides/scans/SCAN-BLOCKS.md`, "Nested aiTabs.map Calls" and "setSessions Calls by File"
**Risk:** Medium - touches core state management. Must verify each migration preserves exact behavior.
**Estimated savings:** ~600 lines (400 from nested maps + 200 from prop-drilling)

---

## Pre-flight Checks

- [ ] Phase 06 (SpecKit/OpenSpec) is complete
- [ ] `rtk npm run lint` passes
- [ ] `rtk vitest run` passes

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

### Task 1: Design the helper API

Add to `src/renderer/stores/sessionStore.ts`:

```typescript
/**
 * Update a specific AI tab within a session.
 */
export function updateAiTab(
	sessionId: string,
	tabId: string,
	updater: (tab: AITab) => AITab
): void {
	useSessionStore.setState((state) => ({
		sessions: state.sessions.map((s) =>
			s.id === sessionId
				? { ...s, aiTabs: s.aiTabs.map((t) => (t.id === tabId ? updater(t) : t)) }
				: s
		),
	}));
}

/**
 * Update the active AI tab of a session.
 */
export function updateActiveAiTab(sessionId: string, updater: (tab: AITab) => AITab): void {
	useSessionStore.setState((state) => ({
		sessions: state.sessions.map((s) =>
			s.id === sessionId
				? {
						...s,
						aiTabs: s.aiTabs.map((t) => (t.id === s.activeTabId ? updater(t) : t)),
					}
				: s
		),
	}));
}

/**
 * Update a session by ID.
 */
export function updateSession(sessionId: string, updater: (session: Session) => Session): void {
	useSessionStore.setState((state) => ({
		sessions: state.sessions.map((s) => (s.id === sessionId ? updater(s) : s)),
	}));
}
```

### Task 2: Add unit tests for helpers

Create tests in `src/__tests__/renderer/stores/sessionStoreHelpers.test.ts`:

- Test `updateAiTab` modifies correct tab
- Test `updateAiTab` with non-existent session ID (no-op)
- Test `updateActiveAiTab` modifies active tab only
- Test `updateSession` modifies correct session
- Test immutability (original state unchanged)

### Task 3: Migrate top offenders first

Start with the files that have the most nested `aiTabs.map` calls:

1. **`useWizardHandlers.ts`** (12 calls) - Highest count
2. **`useInputProcessing.ts`** (10 calls)
3. **`useTabHandlers.ts`** (8 calls)
4. **`useAgentListeners.ts`** (8 calls)
5. **`useInterruptHandler.ts`** (6 calls)
6. **`useBatchedSessionUpdates.ts`** (5 calls)

For each file:

1. Read the file to understand the specific `setSessions` + `aiTabs.map` patterns
2. Replace each with the appropriate helper call
3. Run `rtk vitest run path/to/test` to verify

### Task 4: Migrate remaining files (19 more)

Work through the remaining files from the scan. For each:

1. Find `setSessions(prev => prev.map(` patterns
2. Replace with `updateSession`, `updateAiTab`, or `updateActiveAiTab` as appropriate
3. If the updater does something the helpers don't cover (e.g., updates multiple tabs), keep the inline pattern or create a new helper

### Task 5: Eliminate setSessions prop-drilling

The 14+ files that pass `setSessions` as a prop can be converted to use `useSessionStore()` directly:

```typescript
// BEFORE (in parent)
<ChildComponent setSessions={setSessions} />

// BEFORE (in child)
function ChildComponent({ setSessions }) {
	setSessions(prev => ...);
}

// AFTER (in child - no prop needed)
import { updateAiTab } from '../stores/sessionStore';
function ChildComponent() {
	updateAiTab(sessionId, tabId, tab => ({ ...tab, field: value }));
}
```

Top prop-drilling sites to fix:

- `useTabHandlers.ts` (68 setSessions calls)
- `useWizardHandlers.ts` (25)
- `App.tsx` (22)
- `useInputProcessing.ts` (18)
- `useFileTreeManagement.ts` (18)
- `useRemoteIntegration.ts` (17)

### Task 6: Remove setSessions from component prop interfaces

After migrating each component, remove `setSessions` from its props interface. This is a cascading change - work bottom-up from leaf components.

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Verify reduction

```
rtk grep "setSessions" src/ --glob="*.{ts,tsx}" | rtk grep -v "__tests__" | rtk grep -v "sessionStore" | wc -l
rtk grep "aiTabs\.map" src/ --glob="*.{ts,tsx}" | rtk grep -v "__tests__" | rtk grep -v "sessionStore" | wc -l
```

Both counts should be significantly reduced.

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable. If a test you didn't touch starts failing, investigate whether your refactoring broke it. If your change removed code that a test depended on, update that test.

Do NOT run the full test suite (it takes too long). Only run tests relevant to the files you changed. Use `rtk grep` to find related test files:

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

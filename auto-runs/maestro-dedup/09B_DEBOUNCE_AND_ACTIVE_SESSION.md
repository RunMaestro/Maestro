# Phase 09-B: Consolidate Debounce/Throttle and activeSession Re-derivation

## Objective

1. Migrate 15+ files with inline debounce/throttle to use existing shared hooks
2. Consolidate 28 files that re-derive `activeSession` from the store

**Evidence:** `docs/agent-guides/scans/SCAN-HOOKS.md`
**Risk:** Low - using existing hooks
**Estimated savings:** ~150 lines

---

## Pre-flight Checks

- [ ] Phase 09-A (focus and event hooks) is complete
- [ ] `rtk npm run lint` passes

---

## Part 1: Debounce/Throttle Consolidation

### Task 1: Identify existing shared hooks

```
rtk grep -rn "useDebounce\|useThrottle\|useDebouncedPersistence\|useSessionDebounce" src/renderer/hooks/ --include="*.ts" -l
```

Read each to understand their API.

### Task 2: Find inline implementations

```
rtk grep -rn "setTimeout\|debounce\|throttle" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "node_modules" | grep -v "hooks/utils"
```

Filter for files that implement their own debounce/throttle rather than using the shared hooks.

### Task 3: Migrate to shared hooks

For each of the 15+ files:
1. Identify the debounce/throttle pattern
2. Match to the appropriate shared hook
3. Replace the inline implementation
4. Run file-level tests

---

## Part 2: activeSession Re-derivation

### Task 4: Find all re-derivation patterns

```
rtk grep -rn "sessions\.find.*activeSessionId\|sessions\.find.*id === active" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "sessionStore"
```

### Task 5: Create or promote a useActiveSession hook

If one doesn't exist, create `src/renderer/hooks/useActiveSession.ts`:

```typescript
import { useSessionStore } from '../stores/sessionStore';

/**
 * Returns the currently active session.
 * Use this instead of manually deriving from sessions array.
 */
export function useActiveSession() {
	return useSessionStore(state =>
		state.sessions.find(s => s.id === state.activeSessionId)
	);
}
```

### Task 6: Migrate 28 files

For each file that re-derives `activeSession`:
1. Replace the derivation with `useActiveSession()` import
2. Remove any local variable that was doing the lookup

Handle files that re-derive multiple times internally - replace all occurrences.

### Task 7: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

### Task 8: Count remaining derivations

```
rtk grep -rn "sessions\.find.*activeSessionId" src/renderer/ --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "sessionStore" | grep -v "useActiveSession" | wc -l
```

Target: 0.

---

## Success Criteria

- 15+ inline debounce/throttle implementations migrated to shared hooks
- 28 files using `useActiveSession()` instead of re-derivation
- Lint and tests pass

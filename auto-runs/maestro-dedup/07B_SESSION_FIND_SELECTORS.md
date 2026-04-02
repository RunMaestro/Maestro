# Phase 07-B: Replace sessions.find with Store Selectors

## Objective

Replace 71 inline `sessions.find(s => s.id === ...)` calls with the existing store selectors `getActiveSession` and `getSessionById`.

**Evidence:** `docs/agent-guides/scans/SCAN-STATE.md`, "sessions.find calls"
**Risk:** Low - replacing inline lookups with equivalent store selectors
**Estimated savings:** ~100 lines

---

## Pre-flight Checks

- [ ] Phase 07-A (session update helpers) is complete
- [ ] `rtk npm run lint` passes

---

## Tasks

### Task 1: Verify store selectors exist

Read `src/renderer/stores/sessionStore.ts` to confirm:

- `getActiveSession` (line ~320) - returns the active session
- `getSessionById` (line ~331) - takes an ID, returns session or undefined

### Task 2: Find all inline sessions.find calls

```
rtk grep "sessions\.find" src/ --glob="*.{ts,tsx}" | rtk grep -v "__tests__" | rtk grep -v "sessionStore"
```

### Task 3: Categorize by pattern

**Pattern A: Finding by active session ID** (~28 files)

```typescript
// BEFORE
const session = sessions.find((s) => s.id === activeSessionId);
// AFTER
const session = getActiveSession();
// Or: useSessionStore(state => state.sessions.find(s => s.id === activeSessionId))
```

**Pattern B: Finding by specific ID** (~43 calls)

```typescript
// BEFORE
const session = sessions.find((s) => s.id === someId);
// AFTER
const session = getSessionById(someId);
```

### Task 4: Migrate activeSession re-derivations (28 files)

These files derive `activeSession` when it's either already available in scope or available via a store selector.

For files using hooks:

```typescript
import { useSessionStore } from '../stores/sessionStore';
const activeSession = useSessionStore((state) =>
	state.sessions.find((s) => s.id === state.activeSessionId)
);
```

For files in callbacks/event handlers:

```typescript
import { useSessionStore } from '../stores/sessionStore';
const activeSession = useSessionStore
	.getState()
	.sessions.find((s) => s.id === useSessionStore.getState().activeSessionId);
```

### Task 5: Fix wizard re-lookups (8 wasteful re-finds)

The wizard code has 8 instances where it re-finds `activeSession` that's already in scope. Remove these redundant lookups and use the variable already available.

### Task 6: Fix useTabHandlers.ts (13 identical finds)

`useTabHandlers.ts` has 13 identical `sessions.find` calls. Many can be replaced with a single lookup at the top of the function/handler, reused throughout.

### Task 7: Consolidate getSshRemoteById (SCAN-STATE.md item #16)

6 definitions of `getSshRemoteById`, 5 redundant:

- Canonical: `main/stores/getters.ts:115`
- Remove local copies in: `agentSessions.ts:82`, `agents.ts:202`, `autorun.ts:43`, `git.ts:54`, `marketplace.ts:66`

Replace with imports from canonical source.

### Task 8: Verify

```
rtk npm run lint
rtk vitest run
```

**MANDATORY: Do NOT skip verification.** Both lint and tests MUST pass on Windows before proceeding.

---

## Success Criteria

- 71 inline `sessions.find` calls replaced with store selectors
- 8 wizard re-lookups eliminated
- 5 redundant `getSshRemoteById` definitions removed
- Lint and tests pass

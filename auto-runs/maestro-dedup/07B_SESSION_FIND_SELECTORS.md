# Phase 07-B: Replace sessions.find with Store Selectors

## Objective

Replace 71 inline `sessions.find(s => s.id === ...)` calls with the existing store selectors `getActiveSession` and `getSessionById`.

**Evidence:** `docs/agent-guides/scans/SCAN-STATE.md`, "sessions.find calls"
**Risk:** Low - replacing inline lookups with equivalent store selectors
**Estimated savings:** ~100 lines

---

## Pre-flight Checks

- [x] Phase 07-A (session update helpers) is complete
- [x] `rtk npm run lint` passes

---

## Tasks

### 1. Verify store selectors exist

- [x] Read `src/renderer/stores/sessionStore.ts` and confirm `getActiveSession` exists (~line 320)
- [x] Confirm `getSessionById` exists (~line 331) and takes an ID, returns session or undefined
- [x] Note the exact import paths and function signatures

**Findings (Task 1):**
- The actual names are `selectActiveSession` (line 412) and `selectSessionById` (line 421), not `getActiveSession`/`getSessionById`.
- `selectActiveSession`: `(state: SessionStore) => Session | null` - finds session matching `state.activeSessionId`, falls back to first session, then null.
- `selectSessionById`: `(id: string) => (state: SessionStore) => Session | undefined` - curried selector, finds session by ID.
- Both exported from `src/renderer/stores/sessionStore.ts`.
- A private `getActiveSession()` helper exists in `tabStore.ts:242` that calls `selectActiveSession(useSessionStore.getState())`.
- Usage in hooks/components: `useSessionStore(selectActiveSession)` or `useSessionStore(selectSessionById(id))`.
- Usage in callbacks: `selectActiveSession(useSessionStore.getState())` or `selectSessionById(id)(useSessionStore.getState())`.

### 2. Find all inline sessions.find calls

- [x] Run: `rtk grep "sessions\.find" src/ --glob "*.{ts,tsx}"` (exclude `__tests__` and `sessionStore`)
- [x] Count total instances and categorize by pattern (active session lookup vs specific ID lookup)

**Findings (Task 2):**

Total `sessions.find` calls across all `src/**/*.{ts,tsx}`: **178** (across 54 files)
- In `__tests__/`: 84 calls (across 14 test files) - excluded from migration scope
- In `sessionStore.ts`: 2 calls (canonical definitions) - excluded
- `sessions.findIndex` calls: 4 (in `useKeyboardNavigation.ts`) - not `sessions.find`, excluded

**Production code `sessions.find` calls: 88** (across 38 files)

Categorized by pattern:

| Pattern | Count | Files | Selector replacement |
|---------|-------|-------|---------------------|
| **A. Active session lookup** (`s.id === activeSessionId`) | 30 | 8 files | `selectActiveSession` |
| **B. Active session (variant)** (`x.id === s.activeSessionId` in zustand selector) | 1 | RightPanel.tsx | `selectActiveSession` |
| **C. Wizard re-lookups** (`s.id === activeSession?.id`) | 9 | useWizardHandlers.ts | Remove - already in scope |
| **D. Specific ID lookups** (`s.id === someVariable`) | 36 | 24 files | `selectSessionById(id)` |
| **E. Non-standard lookups** (by name, sessionId prop, startsWith, projectRoot, complex) | 12 | 7 files | Not replaceable with standard selectors |
| **Total** | **88** | **38 files** | |

**Active session hotspots (Pattern A - 30 calls):**
- `useTabHandlers.ts`: 21 calls (biggest single file - all `s.id === activeSessionId`)
- `useFileTreeManagement.ts`: 3 calls
- `AppModals.tsx`, `ExecutionQueueBrowser.tsx`, `QuickActionsModal.tsx`: 1 each
- Web: `SessionPillBar.tsx`, `useSessions.ts`, `useMobileSessionManagement.ts`: 1 each

**Specific ID hotspots (Pattern D - 36 calls):**
- `QuickActionsModal.tsx`: 3 calls
- `web-server-factory.ts` (main process): 3 calls
- `storage.ts` (CLI), `AllSessionsView.tsx`, `SessionList.tsx`, `useSessionCrud.ts`, `list-playbooks.ts`, `useSessions.ts`, `useMobileSessionManagement.ts`: 2 each
- 15 other files: 1 each

**Non-standard lookups (Pattern E - 12 calls, NOT candidates for standard selectors):**
- `yamlToPipeline.ts`: 3 by `s.name`, 1 by `s.id`
- `group-chat-router.ts`: 4 complex multi-field matching
- `AgentSessionsBrowser.tsx`: 1 by `s.sessionId` (not `s.id`)
- `usePipelineState.ts`: 1 by `s.projectRoot` (truthy check)
- `AgentUsageChart.tsx`: 1 by `sessionId.startsWith(s.id)`
- `useGroupChatHandlers.ts`: 1 complex matching

**Note:** The original estimate of 71 inline calls was conservative. Actual count is 88, or 76 if excluding the 12 non-standard lookups. The `useTabHandlers.ts` file alone accounts for 21 calls (Task 6 targets these). The CLI (6 calls) and main process (7 calls) files don't have access to zustand store selectors - they use their own `sessions` arrays passed as parameters.

### 3. Migrate activeSession re-derivations (28 files)

- [x] For files using hooks: replace `sessions.find(s => s.id === activeSessionId)` with `getActiveSession()` or the equivalent store selector
- [x] For files in callbacks/event handlers: replace `useSessionStore.getState().sessions.find(...)` with `getActiveSession()`
- [x] Run targeted tests after each batch of files

**Findings (Task 3):**
Migrated 5 `sessions.find(s => s.id === activeSessionId)` calls across 3 files to use `selectActiveSession` or the pre-computed `activeSession` parameter:

| File | Change | Calls replaced |
|------|--------|---------------|
| `AppModals.tsx` | `useMemo(sessions.find(...))` replaced with `useSessionStore(selectActiveSession)` | 1 |
| `RightPanel.tsx` | Inline zustand selector `(s) => s.sessions.find(...)` replaced with `selectActiveSession` | 1 |
| `useFileTreeManagement.ts` | 3 effect-internal `sessions.find(...)` replaced with pre-computed `activeSession` parameter; deps arrays tightened from `[sessions, activeSessionId]` to `[activeSession]` | 3 |

**Not migrated (prop-based or different store):**
- `QuickActionsModal.tsx`: Receives `sessions`/`activeSessionId` as props - not store-driven. Attempted migration but reverted: breaks 38 tests that mock via props.
- `ExecutionQueueBrowser.tsx`: Fully prop-driven, no store import.
- `SessionPillBar.tsx`, `useMobileSessionManagement.ts`, `useSessions.ts` (web): Web files using different state management, no zustand access.

All 274 targeted tests pass. Lint passes.

### 4. Migrate specific-ID lookups (43 calls)

- [ ] Replace `sessions.find(s => s.id === someId)` with `getSessionById(someId)` in each file
- [ ] Run targeted tests: `CI=1 rtk vitest run <relevant-test>`

### 5. Fix wizard re-lookups (8 wasteful re-finds)

- [ ] Identify the 8 instances in wizard code where `activeSession` is re-found despite already being in scope
- [ ] Remove redundant lookups and use the existing variable
- [ ] Run wizard tests: `CI=1 rtk vitest run` (filter for wizard test files)

### 6. Fix useTabHandlers.ts (13 identical finds)

- [ ] Read `useTabHandlers.ts` to find all 13 `sessions.find` calls
- [ ] Hoist a single lookup to the top of each function/handler and reuse throughout
- [ ] Run tab handler tests: `CI=1 rtk vitest run` (filter for tab handler test files)

### 7. Consolidate getSshRemoteById (6 definitions, 5 redundant)

- [ ] Verify canonical location: `main/stores/getters.ts:115`
- [ ] Remove local copy in `agentSessions.ts:82` and replace with import
- [ ] Remove local copy in `agents.ts:202` and replace with import
- [ ] Remove local copy in `autorun.ts:43` and replace with import
- [ ] Remove local copy in `git.ts:54` and replace with import
- [ ] Remove local copy in `marketplace.ts:66` and replace with import
- [ ] Run targeted tests for each changed file

### 8. Verify full build

- [ ] Run lint: `rtk npm run lint`
- [ ] Run tests: `CI=1 rtk vitest run`
- [ ] Verify types: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
CI=1 rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable.

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

- 71 inline `sessions.find` calls replaced with store selectors
- 8 wizard re-lookups eliminated
- 5 redundant `getSshRemoteById` definitions removed
- Lint and tests pass

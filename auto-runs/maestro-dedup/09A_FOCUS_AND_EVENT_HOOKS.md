# Phase 09-A: Extract useFocusAfterRender and useEventListener Hooks

## Objective

Create two shared hooks to replace repetitive patterns:

1. `useFocusAfterRender` - replaces 45 `setTimeout(() => ref.current?.focus(), N)` patterns across 28 files
2. `useEventListener` - replaces manual `addEventListener`/`removeEventListener` pairs in 63+ files

**Evidence:** `docs/agent-guides/scans/SCAN-HOOKS.md`
**Risk:** Low - extracting patterns into hooks with identical behavior
**Estimated savings:** ~340 lines

---

## Pre-flight Checks

- [x] Phase 08 (UI components) is complete
- [x] `rtk npm run lint` passes
- [x] `CI=1 rtk vitest run` passes (21 pre-existing test file failures on baseline, 590 passed)

---

## Tasks

### Part 1: useFocusAfterRender

### 1. Survey the setTimeout focus pattern

- [x] Run: `rtk grep "setTimeout.*focus" src/renderer/ --glob "*.{ts,tsx}"` (exclude `__tests__`)
- [x] Note delay values used (0ms, 50ms, 100ms are common)
- [x] Determine the most common default delay

**Survey Results (2026-04-06):**
- 0ms: 18 instances (useModalHandlers x6, InputArea x2, App.tsx, FilePreview, GroupChatHistoryPanel, HistoryPanel, LightboxModal, useGroupChatHandlers, useKeyboardNavigation, useMainKeyboardHandler x2, SshRemoteModal)
- 50ms: 21 instances (AgentSessionsBrowser x6, AgentSessionsModal, App.tsx, CreateWorktreeModal, AgentDrawer, FileSearchModal, MarketplaceModal, MergeSessionModal, QuickActionsModal, SendToAgentModal, ShortcutsTab, ThemeTab, SymphonyModal, TabSwitcherModal, useSymphonyContribution, MobileHistoryPanel)
- 100ms: 4 instances (BatchRunnerModal, useMainKeyboardHandler x2, useWizardHandlers)
- const (FOCUS_AFTER_RENDER_DELAY_MS): 2 instances (useMainKeyboardHandler x2)
- **Most common: 50ms (21/45), followed by 0ms (18/45)**
- Recommendation: default delay = 50 (aligns with majority of call sites)

### 2. Create useFocusAfterRender hook

- [x] Create `src/renderer/hooks/utils/useFocusAfterRender.ts`
- [x] Implement with params: `ref` (RefObject), `shouldFocus` (boolean, default true), `delay` (number, default 0)
- [x] Use `useEffect` with `setTimeout` + `clearTimeout` cleanup
- [x] Export the function

### 3. Write tests for useFocusAfterRender

- [ ] Create test file for the hook
- [ ] Test focuses element after render
- [ ] Test respects delay parameter
- [ ] Test cleans up timeout on unmount
- [ ] Test does nothing when `shouldFocus` is false
- [ ] Run tests: `CI=1 rtk vitest run <hook-test-path>`

### 4. Migrate setTimeout focus patterns (45 instances across 28 files)

- [ ] For each file: identify whether the `setTimeout(() => ref.current?.focus(), N)` is inside a `useEffect` or an event handler
- [ ] If inside `useEffect`: replace entirely with `useFocusAfterRender(ref, condition, delay)`
- [ ] If inside an event handler: keep inline (the hook is for render-time focus only)
- [ ] Run targeted tests after each batch of files

### Part 2: useEventListener

### 5. Survey addEventListener/removeEventListener pairs

- [ ] Run: `rtk grep "addEventListener" src/renderer/ --glob "*.{ts,tsx}"` (exclude `__tests__`, `node_modules`)
- [ ] Identify top offenders: `activityBus.ts` (10), `MarketplaceModal.tsx` (10), `useMainKeyboardHandler.ts` (8), `SymphonyModal.tsx` (8), `App.tsx` (8)

### 6. Create useEventListener hook

- [ ] Create `src/renderer/hooks/utils/useEventListener.ts`
- [ ] Implement with params: `eventName`, `handler`, `element` (optional, defaults to window), `options` (optional)
- [ ] Use `useRef` for handler to avoid re-attaching on handler changes
- [ ] Handle null/undefined element gracefully
- [ ] Export the function

### 7. Write tests for useEventListener

- [ ] Create test file for the hook
- [ ] Test attaches listener on mount
- [ ] Test removes listener on unmount
- [ ] Test updates handler without re-attaching listener
- [ ] Test works with custom HTML elements
- [ ] Test handles null element gracefully
- [ ] Run tests: `CI=1 rtk vitest run <hook-test-path>`

### 8. Migrate event listener pairs (63+ files)

- [ ] Start with top offenders: `activityBus.ts`, `MarketplaceModal.tsx`, `useMainKeyboardHandler.ts`, `SymphonyModal.tsx`, `App.tsx`
- [ ] Replace each `useEffect` containing `addEventListener`/`removeEventListener` pair with `useEventListener(eventName, handler)`
- [ ] Run targeted tests after each file

### 9. Export from hooks barrel

- [ ] Add exports to `src/renderer/hooks/utils/index.ts` (create if doesn't exist):
  - `export { useFocusAfterRender } from './useFocusAfterRender';`
  - `export { useEventListener } from './useEventListener';`

### 10. Verify full build

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

- `useFocusAfterRender` hook created with tests
- `useEventListener` hook created with tests
- 45 setTimeout-focus patterns migrated
- 63+ addEventListener/removeEventListener pairs migrated
- Lint and tests pass

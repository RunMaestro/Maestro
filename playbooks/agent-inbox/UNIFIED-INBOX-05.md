# Phase 05: Tests, Build Verification, and Commit

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Corrections applied:** Null/corrupted data tests, accessibility tests, correct naming

This phase writes comprehensive tests including edge cases from the blind spot review, verifies the build, and commits.

---

## Hook Tests

- [x] **Write unit tests for the `useAgentInbox` hook.** Create `src/__tests__/renderer/hooks/useAgentInbox.test.ts`. Use Vitest (`describe`, `it`, `expect`) and `renderHook` from `@testing-library/react`.
  <!-- MAESTRO: Tests already exist — 38 tests, all passing. Covers all 16 spec items including null guards, filter/sort modes, truncation, timestamp fallbacks, and memoization. -->

  **Standard test cases:**
  1. Returns empty array when no sessions have unread tabs
  2. Returns correct InboxItems for sessions with `hasUnread: true` tabs
  3. Filters correctly by `InboxFilterMode`: `'all'`, `'needs_input'`, `'ready'`
  4. Sorts correctly by `InboxSortMode`: `'newest'`, `'oldest'`, `'grouped'`
  5. Truncates `lastMessage` to **90 chars** (not 120)
  6. Maps group info correctly (name) from `groupId`
  7. Handles ungrouped sessions (no `groupId`)

  **Null/corrupted data edge cases (from blind spot CRITICAL #2):**
  8. Session with `null` sessionId → should be skipped entirely
  9. Session with `undefined` gitBranch → InboxItem.gitBranch should be `undefined`
  10. Tab with empty `logs` array → lastMessage should be `"No messages yet"`
  11. Tab with `undefined` logs → lastMessage should be `"No messages yet"`
  12. Timestamp of `0` → should be replaced with `Date.now()`
  13. Timestamp of `NaN` → should be replaced with `Date.now()`
  14. Timestamp of negative number → should be replaced with `Date.now()`
  15. `contextUsage` of `NaN` → should be `undefined`
  16. `session.aiTabs` is `undefined` → should not crash, return empty

  Mock session/group data with realistic structures based on `src/renderer/types/index.ts`.

---

## Component Tests

- [x] **Write component tests for AgentInbox.** Create `src/__tests__/renderer/components/AgentInbox.test.tsx`. Reference `ProcessMonitor.test.tsx` for testing patterns and mocking strategies.
  <!-- MAESTRO: Tests already existed from prior phase — 86 tests covering all 15 spec items except Escape-triggers-close and focus-return-to-trigger. Added 2 new tests: (1) Escape triggers onClose via layer stack onEscape handler, (2) focus returns to trigger element on modal close. Total: 88 tests, all passing. Full suite: 19,314 tests, 0 failures. -->

  **Standard test cases:**
  1. Renders modal with correct title "Inbox" (NOT "Unified Inbox")
  2. Shows badge `"{count} need action"` matching filtered items
  3. Keyboard: ArrowDown selects next item, ArrowUp selects previous
  4. Keyboard: Enter calls `onNavigateToSession` with correct `sessionId` and `tabId`
  5. Keyboard: Escape calls `onClose`
  6. Sort segmented control: clicking cycles through `"Newest"`, `"Oldest"`, `"Grouped"`
  7. Filter segmented control: clicking cycles through `"All"`, `"Needs Input"`, `"Ready"`
  8. Clicking an InboxItemCard calls `onNavigateToSession` with correct args
  9. Empty state: renders correct message when no items match filter

  **Accessibility tests (from blind spot CRITICAL #5):**
  10. Modal root has `role="dialog"` and `aria-label="Agent Inbox"`
  11. List container has `role="listbox"`
  12. Each card has `role="option"` and `aria-selected`
  13. Badge has `aria-live="polite"`
  14. Focus returns to trigger element on modal close
  15. Sort/filter controls have `aria-label` and segments have `aria-pressed`

---

## Helper Tests

- [ ] **Write unit tests for helper functions.** In a dedicated test file or within the hook test file.

  **`formatRelativeTime` tests:**
  1. Returns `'just now'` for timestamps < 60s ago
  2. Returns `'2m ago'` for 120 seconds ago
  3. Returns `'1h ago'` for 3600 seconds ago
  4. Returns `'yesterday'` for 1 day ago
  5. Returns `'5d ago'` for 5 days ago
  6. Returns `'—'` for `0` timestamp
  7. Returns `'—'` for `NaN` timestamp
  8. Returns `'—'` for negative timestamp
  9. Returns `'just now'` for future timestamp (clock skew)

  **Summary generation tests:**
  10. `waiting_input` state → prefixed with `"Waiting: "`
  11. AI message ending with `?` → shown as question
  12. AI statement → prefixed with `"Done: "`
  13. Empty logs → `"No activity yet"`
  14. Summary truncated at 90 chars with `"..."`

  **Context bar color tests:**
  15. 0-60% → returns green/success color key
  16. 60-80% → returns orange/warning color key (NOT red)
  17. 80-100% → returns red/error color key

---

## Full Suite Verification

- [ ] **Run the full test suite, lint, and build.** Execute sequentially:
  ```bash
  cd ~/Documents/Vibework/Maestro && \
  npm test -- --run && \
  npm run lint && \
  npm run build
  ```
  All tests (existing + new) must pass with zero failures. Lint must pass. Production build must succeed. If any step fails, fix the issue and re-run.

---

## Commit

- [ ] **Commit all changes on the feature branch.** Stage all new and modified files:
  ```bash
  cd ~/Documents/Vibework/Maestro && \
  git add \
    src/renderer/types/agent-inbox.ts \
    src/renderer/types/index.ts \
    src/renderer/components/AgentInbox.tsx \
    src/renderer/hooks/useAgentInbox.ts \
    src/renderer/stores/modalStore.ts \
    src/renderer/hooks/keyboard/useMainKeyboardHandler.ts \
    src/renderer/components/AppModals.tsx \
    src/__tests__/renderer/hooks/useAgentInbox.test.ts \
    src/__tests__/renderer/components/AgentInbox.test.tsx && \
  git commit -m "feat: add Agent Inbox modal for aggregated session management

  - Virtual scrolling for 100+ items (react-window)
  - Null-safe data aggregation with defensive guards
  - Full keyboard navigation with ARIA labels
  - Segmented controls for sort (Newest/Oldest/Grouped) and filter (All/Needs Input/Ready)
  - Zero-items guard: toast instead of empty modal
  - Focus trap with return-to-trigger on close
  - Comprehensive tests including edge cases and accessibility"
  ```
  Do NOT push to remote — local feature branch only.

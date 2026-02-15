# Phase 08: Tests + Lint Gate

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 07 (all features implemented)

This phase adds comprehensive tests and runs the final lint/type/test gate. This is the verification phase — no new features.

---

## Update Existing AgentInbox Tests

- [ ] **Update `src/renderer/components/__tests__/AgentInbox.test.tsx` to work with the refactored folder structure.** The import path may need updating from `../AgentInbox` to `../AgentInbox/index` (or just `../AgentInbox` if the directory index resolves). Check the existing test file:

  1. **Verify imports resolve.** The test likely does:
     ```ts
     import AgentInbox from '../AgentInbox';
     ```
     This should resolve to `../AgentInbox/index.tsx` automatically. If not, update.

  2. **Verify all existing tests pass as-is.** Run:
     ```bash
     cd ~/Documents/Vibework/Maestro && npx vitest run src/renderer/components/__tests__/AgentInbox.test.tsx
     ```

  3. **If tests import `resolveContextUsageColor` from `'../AgentInbox'`**, update the import to `'../AgentInbox/InboxListView'` (that's where the function lives now).

  4. **Fix any broken tests** caused by:
     - Lifted state (selectedIndex, filterMode, sortMode now in parent shell)
     - The refactored component hierarchy
     - New props that InboxListView requires but tests don't provide

  The key principle: **existing tests should pass without changing test assertions** — only imports and setup may need updating. If a test was checking internal state that's now lifted, the rendered behavior should still be identical.

  Run the tests again after fixes to confirm all pass.

---

## Add FocusModeView Tests

- [ ] **Create `src/renderer/components/__tests__/FocusModeView.test.tsx` with comprehensive tests.** Test the following scenarios:

  **Test data setup:** Create mock data with:
  - 3 sessions, each with 1-2 AI tabs
  - Each tab with 5-10 LogEntry objects (mix of `source: 'ai'` and `source: 'user'`)
  - Various states: idle, waiting_input, busy
  - Various contextUsage values (30%, 65%, 85%)
  - One session with a gitBranch, one without
  - Build `InboxItem[]` from the mock sessions

  **Rendering tests:**
  1. `renders header with agent name and counter` — verify session name visible, "1 / 3" counter
  2. `renders back button that calls onExitFocus` — click "← Inbox", verify onExitFocus called
  3. `renders subheader with git branch` — verify branch text visible when item has gitBranch
  4. `renders subheader without git branch` — verify no branch badge when gitBranch is undefined
  5. `renders context usage with correct color` — verify "Context: 85%" is red (>=80), "Context: 65%" is orange (>=60), "Context: 30%" is green
  6. `renders status pill with correct label` — verify "Needs Input" for waiting_input, "Ready" for idle

  **Conversation tests:**
  7. `renders conversation log entries` — verify AI and user messages are visible
  8. `filters out system/tool/thinking log entries` — create logs with source='system' and verify they are NOT rendered
  9. `shows empty state when no logs` — session with empty logs array shows "No conversation yet"
  10. `truncates long log text` — log with 600+ chars shows "… (truncated)"
  11. `shows AI icon for AI messages` — verify 🤖 emoji present
  12. `shows user icon for user messages` — verify 👤 emoji present

  **Reply input tests:**
  13. `renders reply input textarea` — verify placeholder "Reply to agent..."
  14. `send button is disabled when input is empty` — verify disabled state
  15. `send button is enabled when input has text` — type text, verify enabled
  16. `calls onReplyToSession on Enter` — type "hello", press Enter, verify callback called with (sessionId, tabId, "hello")
  17. `calls onReplyToSession on button click` — type "hello", click send button, verify callback
  18. `clears input after sending` — type, send, verify input is empty
  19. `auto-advances to next item after reply` — type, send, verify onNavigateItem called with next index

  **Navigation tests:**
  20. `prev button calls onNavigateItem with previous index` — click Prev, verify called with (currentIndex - 1 + length) % length
  21. `next button calls onNavigateItem with next index` — click Next, verify called with (currentIndex + 1) % length
  22. `nav buttons are disabled when only 1 item` — render with items.length === 1, verify buttons disabled
  23. `close button calls onClose` — click X, verify onClose called

  **Import pattern:**
  ```ts
  import { render, screen, fireEvent } from '@testing-library/react';
  import { describe, it, expect, vi } from 'vitest';
  import FocusModeView from '../AgentInbox/FocusModeView';
  ```

  Use tabs for indentation. Use `vi.fn()` for callback mocks. Use a `defaultTheme` object from `../../constants/themes` (import the first theme).

  Run tests: `npx vitest run src/renderer/components/__tests__/FocusModeView.test.tsx`

---

## Add AgentInbox Shell Tests (viewMode)

- [ ] **Add viewMode-specific tests to the existing `AgentInbox.test.tsx` file** (or create a new `AgentInboxShell.test.tsx` if the existing file is already long). Test:

  1. `starts in list view mode` — render AgentInbox, verify InboxListView content is visible (header "Unified Inbox")
  2. `enters focus mode when F key is pressed` — render with items, press F, verify focus mode content appears
  3. `exits focus mode on Escape` — enter focus mode, press Escape, verify back to list view
  4. `does not close modal on Escape in focus mode` — enter focus mode, press Escape, verify onClose NOT called (only focus exit)
  5. `closes modal on Escape in list mode` — press Escape in list mode, verify onClose IS called (or layer stack handles it)
  6. `ArrowLeft navigates to previous item in focus mode` — enter focus, press ArrowLeft, verify counter changes
  7. `ArrowRight navigates to next item in focus mode` — enter focus, press ArrowRight, verify counter changes
  8. `modal width changes between modes` — enter focus mode, verify dialog has width style '90vw'; exit, verify width 600

  Run tests: `npx vitest run src/renderer/components/__tests__/AgentInbox*.test.tsx`

---

## Final Gate

- [ ] **Run the complete verification gate.** Execute all three checks:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/ --ext .ts,.tsx
  ```

  **Success criteria:**
  - TypeScript: 0 errors
  - Tests: All pass (including new Focus Mode tests)
  - ESLint: 0 errors (warnings acceptable)

  If any failures:
  1. Fix TypeScript errors first (they cascade)
  2. Fix test failures next
  3. Fix lint issues last
  4. Re-run the full gate after each fix

  Do NOT proceed until all three pass. This is the merge gate.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/__tests__/FocusModeView.test.tsx \
          src/renderer/components/__tests__/AgentInbox.test.tsx \
          src/renderer/hooks/__tests__/useAgentInbox.test.ts
  git commit -m "FOCUS-MODE: Phase 08 — comprehensive tests + full lint/type/test gate passed"
  ```

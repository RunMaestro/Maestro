# Phase 02: Core Component — AgentInbox Modal UI

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Reference:** Process Monitor at `src/renderer/components/ProcessMonitor.tsx`
> **CRITICAL FIXES:** Virtualization, null guards, memory leak prevention, focus trap + ARIA

This phase builds the main AgentInbox component, replacing the placeholder from Phase 01. It addresses all 5 critical findings from the blind spot review.

---

## Data Hook

- [x] **Build the `useAgentInbox` data aggregation hook with null guards.** Create `src/renderer/hooks/useAgentInbox.ts`. This hook receives `sessions: Session[]`, `groups: Group[]`, `filterMode: InboxFilterMode`, and `sortMode: InboxSortMode`, and returns `InboxItem[]`.
  > **Completed:** Hook created at `src/renderer/hooks/useAgentInbox.ts` and exported from hooks index. Timestamp derived from last log entry → tab.createdAt → Date.now() (no `lastActivityAt` field exists on Session/AITab). Git branch uses `session.worktreeBranch` (no `gitBranch` field exists). 31 tests pass at `src/__tests__/renderer/hooks/useAgentInbox.test.ts`. All 19,216 existing tests pass. TypeScript lint clean.

  **Data aggregation logic:**
  1. Iterate all sessions. For each session, iterate `session.aiTabs` (if the array exists — guard with `session.aiTabs ?? []`).
  2. For each tab, determine if it should be included based on `filterMode`:
     - `'all'`: include if `tab.hasUnread === true` OR `session.state === 'waiting_input'` OR `session.state === 'idle'`
     - `'needs_input'`: include only if `session.state === 'waiting_input'`
     - `'ready'`: include only if `session.state === 'idle'` AND `tab.hasUnread === true`
  3. For each matching tab, build an `InboxItem`:
     - Find parent group: `groups.find(g => g.id === session.groupId)` — guard against undefined group
     - Extract `lastMessage`: get last LogEntry text from `tab.logs`, truncate to **90 chars** (not 120). Guard: if `tab.logs` is empty/undefined, use `"No messages yet"`
     - Validate `timestamp`: use `tab.lastActivityAt ?? session.lastActivityAt ?? Date.now()`. Guard: if timestamp is <= 0 or NaN, use `Date.now()`
     - Validate `sessionId`: skip items where `session.id` is falsy (null/undefined/empty string)
     - `gitBranch`: use `session.gitBranch ?? undefined` (explicit undefined, not null)
     - `contextUsage`: use `tab.contextUsage ?? session.contextUsage ?? undefined`

  **Sorting logic (applied after filtering):**
  - `'newest'`: sort by `timestamp` descending
  - `'oldest'`: sort by `timestamp` ascending
  - `'grouped'`: sort by `groupName` alphabetically (ungrouped last), then by `timestamp` descending within each group

  **Memoization — CRITICAL:** Use `useMemo` with `[sessions, groups, filterMode, sortMode]` as the dependency array. Do **NOT** use `useRef` to cache derived state — this causes stale data bugs. The `useMemo` deps must be the actual state values, not refs to objects.

  Reference `AITab` type at `src/renderer/types/index.ts` and `Session` type in the same file.

---

## Component Shell with Virtualization

- [x] **Build the AgentInbox component with virtual scrolling.** Replace the placeholder in `src/renderer/components/AgentInbox.tsx`.
  > **Completed:** Component built with react-window v2 `List` (variable-size rows via `rowHeight` function). Includes `VariableSizeList` equivalent with group headers (36px) and item cards (80px). `useModalLayer` for layer stack registration with `MODAL_PRIORITIES.AGENT_INBOX = 555`. Focus trap, ARIA (`role="dialog"`, `aria-modal`, `aria-live="polite"`, `role="listbox"`, `role="option"`, `aria-activedescendant`), keyboard nav (↑↓ wrap, Enter navigate, Esc close via layer stack), focus restoration on close. Segmented controls for sort (Newest/Oldest/Grouped) and filter (All/Needs Input/Ready). 36 component tests pass. All 19,252 existing tests pass. TypeScript lint clean.

  **Props:**
  ```ts
  interface AgentInboxProps {
    theme: Theme
    sessions: Session[]
    groups: Group[]
    onClose: () => void
    onNavigateToSession?: (sessionId: string, tabId?: string) => void
  }
  ```

  **CRITICAL #1 — List Virtualization:** Install `react-window` if not already in dependencies (`npm ls react-window`; if missing, add to package.json and run `npm install`). Use `<FixedSizeList>` from `react-window` to render the inbox items. This prevents UI freeze with 100+ items. Configuration:
  - `height`: modal body height (calculate from modal dimensions minus header/footer)
  - `itemCount`: `items.length`
  - `itemSize`: 80 (px per card — adjust after visual check)
  - `width`: `'100%'`
  - When `sortMode === 'grouped'`, items include group header rows (height: 36px). Use `<VariableSizeList>` instead of `<FixedSizeList>` to support mixed row heights, with `getItemSize(index)` returning 36 for group headers and 80 for item cards.

  **CRITICAL #5 — Focus Trap + ARIA:**
  - Register with `useLayerStack` for focus trap (add `MODAL_PRIORITIES.AGENT_INBOX` constant or reuse Process Monitor priority)
  - Add `role="dialog"` and `aria-label="Agent Inbox"` to the modal root
  - Add `aria-live="polite"` to the item count badge so screen readers announce filter changes
  - On modal close: return focus to the element that triggered the modal (store `document.activeElement` on open in a ref, restore on close via `.focus()`)
  - All interactive elements must have visible focus indicators using `outline: 2px solid ${theme.colors.accent}`

  **Component structure:**
  1. **Fixed header (48px):** Title "Inbox" | badge showing `"{count} need action"` (not just a number) | sort segmented control | filter segmented control | close button (×)
  2. **Scrollable body:** Virtualized list of InboxItemCard components
  3. **Fixed footer (36px):** Keyboard hints: `↑↓ Navigate` | `Enter Open` | `Esc Close`

  Use the `useAgentInbox` hook to get filtered/sorted items. Reference ProcessMonitor lines 1454-1574 for the modal shell pattern.

---

## Item Card

- [x] **Build the InboxItemCard sub-component with correct visual hierarchy.** Create within the AgentInbox file (or as separate file if > 100 lines).
  > **Completed:** `InboxItemCardContent` component implemented inline in `AgentInbox.tsx` (lines 69-183). Three-row layout: Row 1 = group name (muted 12px) / session name (bold 14px) + relative timestamp; Row 2 = last message (muted 13px, 90 char truncation); Row 3 = git branch badge (monospace), context usage text, status pill (colored via `STATUS_COLORS`/`STATUS_LABELS`). Selection = background fill only (`accent` at 8% opacity), no outline on selection — outline only on focus for accessibility. No standalone emojis. 12px effective gap between cards via 6px top/bottom padding. Click handler guarded against undefined `onNavigateToSession`. 14 dedicated InboxItemCard tests added (50 total component tests pass). TypeScript lint clean.

  **Layout per card (80px height, 12px gap between cards):**
  - **Row 1:** Group name (muted, 12px) + " / " + **session name (bold, 14px, primary text)** + spacer + relative timestamp (muted, 12px, right-aligned)
  - **Row 2:** Last message preview (muted, 13px, truncated to **90 chars** with "...")
  - **Row 3:** Git branch badge (monospace, if available) | context usage (text: "Context: 45%") | status badge (colored pill using `STATUS_LABELS` and `STATUS_COLORS` from types)

  **Design decisions applied:**
  - **NO standalone emoji** in the card (removed per Designer review). Group name is text only.
  - **Session name is primary** — bold 14px, `theme.colors.text`
  - **Selection = background fill** (not border). Selected card: `background: ${theme.colors.accent}15` (accent at 8% opacity). No border change on selection.
  - **Spacing: 12px gap** between cards (not 8px). Use CSS `gap: 12px` or margin-bottom on each card.
  - **Click handler:** on click → `onNavigateToSession(item.sessionId, item.tabId)` then `onClose()`. Guard: only call `onNavigateToSession` if it's defined.
  - Reference TabBar.tsx for unread dot styling pattern.

---

## Keyboard Navigation

- [x] **Implement keyboard navigation with ARIA and scroll management.** Follow ProcessMonitor pattern (lines 671-781).
  > **Completed:** Keyboard navigation fully implemented with ArrowUp/ArrowDown (wrap), Enter (navigate+close), Escape (close via layer stack), Tab/Shift+Tab (cycle between header controls and list). `selectedIndex` uses `useState`. Scroll management via `listRef.scrollToRow({ index, align: 'smart' })` with `findRowIndexForItem` mapping for grouped mode. ARIA: `role="listbox"` + `aria-activedescendant` on list container, `role="option"` + `aria-selected` on cards. 4 new Tab cycling tests added (54 total component tests). All 10,392 renderer tests pass. TypeScript lint clean.

  **State:** `selectedIndex: number` starting at 0 (via `useState`, NOT `useRef`).

  **Key bindings:**
  - `ArrowUp` → decrement index (wrap to last item at bottom)
  - `ArrowDown` → increment index (wrap to first item at top)
  - `Enter` → navigate to selected item's session/tab and close modal
  - `Escape` → close modal and return focus to trigger element
  - `Tab` → cycle focus between header controls (sort, filter, close) and back to list

  **Scroll management:** When `selectedIndex` changes, call `listRef.scrollToItem(selectedIndex, 'smart')` on the `react-window` list ref (this uses the virtualized list's built-in scroll method — no raw `scrollIntoView` needed).

  **ARIA for keyboard nav:**
  - List container: `role="listbox"`, `aria-activedescendant={selectedItemId}`
  - Each card: `role="option"`, `aria-selected={isSelected}`, `id={item.sessionId}`

---

## Memory Leak Prevention

- [ ] **Audit and fix event listener cleanup.** Review the AgentInbox component and `useAgentInbox` hook for:

  1. **All `useEffect` hooks must return cleanup functions** that remove any event listeners added. Pattern:
     ```ts
     useEffect(() => {
       const handler = (e: KeyboardEvent) => { ... }
       window.addEventListener('keydown', handler)
       return () => window.removeEventListener('keydown', handler)
     }, [deps])
     ```
  2. **All subscriptions to stores** (Zustand selectors, etc.) are automatically cleaned up by React — no action needed.
  3. **No `setInterval`/`setTimeout` without cleanup.** If any timer is used (e.g., for relative timestamp updates), clear it in the cleanup function.
  4. **The `useLayerStack` registration** must be cleaned up on unmount — verify the hook handles this internally. If not, add cleanup.

  Run a search: `grep -n 'addEventListener\|setInterval\|setTimeout' src/renderer/components/AgentInbox.tsx src/renderer/hooks/useAgentInbox.ts` and verify each has a matching cleanup.

---

## Verification

- [ ] **Run the app in dev mode and verify the modal.** Execute `cd ~/Documents/Vibework/Maestro && npm run dev`. Test:
  1. With active sessions: press `Alt+Cmd+I` → modal opens with items
  2. With no pending items: press `Alt+Cmd+I` → toast "No pending items", modal does NOT open
  3. Keyboard nav: ↑↓ moves selection (background fill, not border), Enter opens session, Esc closes
  4. Focus: when modal closes, focus returns to the previously focused element
  5. Check React DevTools for unnecessary re-renders (the list should NOT re-render all items on selection change — virtualization handles this)
  6. If `npm run dev` fails, fix build errors first. Stop the dev server after verification.

# Phase 04: Sorting, Filtering Controls, and Visual Polish

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Corrections applied:** Segmented controls, correct labels, empty-state-in-modal, 12px spacing

This phase adds the segmented controls for sort/filter, empty state handling, and visual polish.

---

## Sort Control (Segmented, Not Toggle)

- [x] **Implement sort as a segmented control.** In the AgentInbox header, replace any toggle button with a **segmented control** (3 segments side by side, like macOS). This provides clear affordance — users see all options at once.

  > ✅ Already implemented in Phase 03. Aligned padding to 4px 10px per spec, added `transition: background 150ms`, fixed group header font-size to 13px. All 104 AgentInbox tests pass.

  **Segments:**
  - `"Newest"` (default, active)
  - `"Oldest"`
  - `"Grouped"` (NOT "By Group")

  **Styling:**
  - Container: `border-radius: 6px; border: 1px solid ${theme.colors.border}; display: inline-flex; overflow: hidden`
  - Each segment: `padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 150ms`
  - Active segment: `background: ${theme.colors.accent}; color: ${theme.colors.accentText ?? '#fff'}`
  - Inactive: `background: transparent; color: ${theme.colors.textMuted}`

  Store sort mode in component state: `useState<InboxSortMode>('newest')`. Pass to `useAgentInbox`.

  When `"Grouped"` is active, the virtualized list renders group header rows (36px) as separators. Each header shows: **group name** (bold 13px). Ungrouped sessions show under a "Ungrouped" header at the bottom.

---

## Filter Control (Segmented, Not Toggle)

- [x] **Implement filter as a segmented control.** Same pattern as sort, positioned next to it in the header.

  > ✅ Filter control was already implemented in Phase 03 with correct segments (All, Needs Input, Ready), state management, and badge count. Added missing ARIA: `aria-label="Filter sessions"` on container, `aria-pressed={isActive}` on each `<button>`. Also added `aria-label="Sort sessions"` to sort control for consistency. 6 new ARIA tests added. All 19,297 tests pass.

  **Segments:**
  - `"All"` (default, active)
  - `"Needs Input"` (NOT "Waiting" — action-oriented label)
  - `"Ready"` (maps to idle + unread)

  Pass filter mode to `useAgentInbox`. Update the badge count in real-time: `"{filteredCount} need action"`.

  **ARIA:** Add `aria-label="Filter sessions"` to the segmented control container. Each segment is a `<button>` with `aria-pressed={isActive}`.

---

## Empty States (In-Modal Content, Not Close)

- [x] **Handle empty states as in-modal content.** When the filtered list has zero items, render a centered message **inside the modal body** (do NOT close the modal, do NOT show an error).

  > ✅ Implemented filter-aware empty states: "All" shows CheckCircle icon + "All caught up — no sessions need attention.", "Needs Input" shows "No sessions waiting for input.", "Ready" shows "No idle sessions with unread messages." Icon is 32px at 50% opacity, text is 14px/textDim/center/max-width 280px. 7 new tests added. All 19,305 tests pass.

  **Messages by filter mode:**
  - `"All"` → "All caught up — no sessions need attention." with a ✓ icon (use theme color, not emoji)
  - `"Needs Input"` → "No sessions waiting for input."
  - `"Ready"` → "No idle sessions with unread messages."

  **Styling:**
  - Centered vertically and horizontally in the modal body area
  - Icon: 32px, `theme.colors.textMuted` at 50% opacity
  - Text: 14px, `theme.colors.textMuted`, max-width 280px, text-align center

  **Note on zero-items guard vs. empty state:** The zero-items guard in Phase 01 prevents the modal from opening when there are NO items at ALL (across all filters). The empty state here handles the case where the modal is already open and the user switches to a filter that has no results — this is valid UX, the modal stays open.

---

## Visual Polish

- [x] **Apply visual polish and theme compliance.** Review all AgentInbox components for:
  1. **Fade-in animation:** Add CSS transition on modal mount: `opacity: 0 → 1` over 150ms. Use a `useEffect` + state pattern or CSS `@keyframes fadeIn`.

  2. **Theme compliance:** Audit every color value. Replace ANY hardcoded hex color with `theme.colors.*` equivalent. The only exception is the orange warning color `#f59e0b` if the theme doesn't have a `warning` key — in that case, define it as a constant at the top of the file with a comment explaining why.

  3. **12px gap enforcement:** Verify all card gaps are 12px (not 8px). Check the virtualized list — `react-window` uses `itemSize` for spacing, so the gap must be built into the card's margin or padding.

  4. **Selected card styling:** Verify it uses background fill (`${theme.colors.accent}15`) and NOT a border change.

  5. **Typography check:**
     - Session name: bold 14px
     - Group name: regular 12px, muted
     - Preview text: regular 13px, muted
     - Timestamp: regular 12px, muted
     - Badge text: regular 11px, monospace (git branch) or regular (status)

  > ✅ Visual polish applied: (1) fade-in changed from 100ms→150ms per spec, (2) replaced sole hardcoded `#f59e0b` with `theme.colors.warning` since all themes have the `warning` key, (3) verified 12px gap (6px top + 6px bottom padding per row wrapper), (4) verified selected card uses `accent+15` background fill (no border), (5) verified all typography matches spec. 7 new visual polish tests added. All 19,312 tests pass.

---

## Existing Test Compatibility

- [x] **Run the full test suite and fix regressions.** Execute `cd ~/Documents/Vibework/Maestro && npm test -- --run`. If any existing tests break due to our changes:
  - **modalStore tests:** Add `'agentInbox'` to any `ModalId` type assertions
  - **keyboard handler tests:** Update expectations to include the `Alt+Cmd+I` shortcut
  - **AppModals tests:** Add the AgentInbox lazy import to any mock/assertion lists

  Do NOT write new feature tests in this phase — that's Phase 05. Only fix regressions in existing tests.

  > ✅ Full test suite passed clean: 451 test files passed, 19,312 tests passed, 107 skipped (pre-existing), 0 failures. No regressions from AgentInbox changes — modalStore, keyboard handler, and AppModals tests all pass without modification.

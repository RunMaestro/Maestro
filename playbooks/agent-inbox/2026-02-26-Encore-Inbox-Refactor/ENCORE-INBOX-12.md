# ENCORE-INBOX-12: Align Inbox + Focus Mode headers with Director's Notes tokens

## Objective
Update Inbox List and Focus Mode headers to match Director's Notes visual design tokens for consistency.

## Context
- Director's Notes modal (`src/renderer/components/DirectorNotes/DirectorNotesModal.tsx`):
  - Shell: `w-[1200px] max-w-[95vw] h-[85vh] rounded-xl shadow-2xl border`, `bgActivity` background
  - Header: `px-4 py-3 border-b`, icon with `theme.colors.accent`, `text-lg font-semibold` title
  - Animation: `animate-in fade-in duration-100`
  - Close button: `w-4 h-4` with `theme.colors.textDim`
- The ported Inbox files may differ in padding, font sizes, or animation duration
- This is cosmetic alignment only — all functionality should already work from prior phases

## Tasks

- [x] In `src/renderer/components/AgentInbox/index.tsx`, verify or update the overlay animation to `duration-100` (matching Director's Notes). Search for `animate-in fade-in` and update if it says `duration-150` or other value. Also verify the modal shell uses: `rounded-xl shadow-2xl border`, `bgActivity` background, `max-w-[95vw]`.
  > Updated `duration-150` → `duration-100`. Shell tokens (`rounded-xl shadow-2xl border`, `bgActivity`, `max-w-[95vw]`) were already correct.

- [x] In `src/renderer/components/AgentInbox/InboxListView.tsx`, find the header bar (the div containing "Unified Inbox" title, filter pills, close button). Update to match Director's Notes header pattern:
  - Container: `className="flex items-center justify-between px-4 py-3 border-b"` with `borderColor: theme.colors.border`
  - Title: `className="text-lg font-semibold"` with `color: theme.colors.textMain`
  - Icon next to title: `theme.colors.accent` color, `w-5 h-5` size
  - Close button: `w-4 h-4` with `color: theme.colors.textDim`
  > Changed `px-6` → `px-4 py-3`, `text-base` → `text-lg`, added `Bot` icon (w-5 h-5, accent). Close button already matched. Footer padding also aligned to `px-4`.

- [x] In `src/renderer/components/AgentInbox/FocusModeView.tsx`, find the Focus Mode header bar (back arrow, title, navigation, close). Update:
  - Container: `px-4 py-3 border-b` with `borderColor: theme.colors.border`
  - Title: `text-lg font-semibold` with `color: theme.colors.textMain`
  - Back arrow and close (X): `w-4 h-4` with `color: theme.colors.textDim`
  > Added `py-3`, removed fixed `height: 48`. Title changed from `text-sm font-bold` → `text-lg font-semibold`. Back arrow (16×16) and close (w-4 h-4, textDim) already matched.

- [x] Run `npm run lint` to verify.
  > Both `npm run lint` (tsc) and `npm run lint:eslint` pass. Tests pass (3 pre-existing timeouts in session-storage.test.ts unrelated to these changes).

## Gate
- `npm run lint` passes
- `grep -n "px-4 py-3 border-b" src/renderer/components/AgentInbox/InboxListView.tsx` returns header
- `grep -n "px-4 py-3 border-b" src/renderer/components/AgentInbox/FocusModeView.tsx` returns header
- Animation uses `duration-100`

# Phase 07: Modal Resize Animation

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 06 (navigation polished)

This phase adds the modal resize animation. When entering focus mode, the dialog smoothly expands from 600px to 90vw. When exiting, it shrinks back. This is a purely visual phase — no logic changes.

---

## Implement Modal Resize

- [ ] **Add dynamic width/height to the modal dialog in `src/renderer/components/AgentInbox/index.tsx`.** Changes:

  1. **Replace the static width class** on the dialog div. Currently:
     ```tsx
     className="w-[600px] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
     ```
     Change to remove `w-[600px]` from className and use inline style instead:
     ```tsx
     className="rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
     style={{
     	backgroundColor: theme.colors.bgActivity,
     	borderColor: theme.colors.border,
     	width: viewMode === 'focus' ? '90vw' : 600,
     	maxWidth: viewMode === 'focus' ? 1200 : 600,
     	maxHeight: viewMode === 'focus' ? '90vh' : '80vh',
     	transition: 'width 200ms ease, max-width 200ms ease, max-height 200ms ease',
     }}
     ```

  2. **Key design decisions:**
     - List mode: `width: 600px`, `max-height: 80vh` (same as current)
     - Focus mode: `width: 90vw`, `max-width: 1200px` (capped so it doesn't stretch to absurd sizes on ultrawide monitors), `max-height: 90vh`
     - Transition: `200ms ease` on width, max-width, and max-height
     - The transition fires on `viewMode` change because the inline style values change

  3. **Ensure the overlay still centers the dialog.** The overlay already has `flex items-center justify-center`, so the dialog will re-center as it resizes. No changes needed to the overlay.

  4. **Optional: add height animation.** The `max-height` transition works but the actual height depends on content. For a cleaner effect, also set a `min-height` in focus mode:
     ```ts
     minHeight: viewMode === 'focus' ? '70vh' : undefined,
     ```
     This prevents the dialog from being too short in focus mode when there are few log entries.

  Run `npx tsc --noEmit` to verify.

---

## Polish: Prevent Layout Shift During Transition

- [ ] **Prevent content from jumping during the width transition.** When the dialog width changes, the InboxListView and FocusModeView swap simultaneously. This can cause a visual "pop". To smooth it out:

  1. **Wrap the content area** (the `{viewMode === 'list' ? ... : ...}` block) in a div with `overflow: hidden`:
     ```tsx
     <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
     	{viewMode === 'list' ? (
     		<InboxListView ... />
     	) : items[focusIndex] ? (
     		<FocusModeView ... />
     	) : null}
     </div>
     ```

  2. **The InboxListView should have `width: 100%`** so it doesn't fight the container width. It already uses flex layout internally, so this should be automatic. Just verify.

  3. **FocusModeView should also fill the container.** Ensure it has `className="flex-1 flex flex-col"` as its root element and fills the parent naturally.

  Run `npx tsc --noEmit` to verify.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All tests must pass. Width/height changes should not affect test rendering since tests use JSDOM (no real layout engine). If any test asserts `w-[600px]` class, update it to check the inline style instead.

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/index.tsx
  git commit -m "FOCUS-MODE: Phase 07 — modal resize animation (600px ↔ 90vw, 200ms ease)"
  ```

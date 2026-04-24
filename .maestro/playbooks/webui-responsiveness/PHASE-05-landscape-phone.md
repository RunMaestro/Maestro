# Phase 5 — Landscape Phone Short-Viewport Variant

**Goal:** Make the web UI usable in landscape phone orientation (e.g. 667×375, height < 500px) where the fixed bottom command bar currently eats most of the viewport.

**Prerequisite phases:** Phase 0 (needs `useBreakpoint().isShortViewport`) and Phase 1 (needs `CommandInputBar` `compact` plumbing).
**Blocks phases:** None.

## Scope

### Files touched

- `src/web/mobile/App.tsx` (header padding, main content layout)
- `src/web/mobile/CommandInputBar.tsx` (wire `compact` prop to `isShortViewport`)
- `src/web/components/ResponsiveModal.tsx` (scrollable body on short viewport)

### Out of scope

- Any change to the phone/tablet/desktop tier boundaries.
- Any new UI surface not already covered by Phases 0–4.

## Background

The fixed bottom `CommandInputBar` reserves ~80px + safe-area at the bottom of the viewport. At 375px landscape height, that's >20% of visible space. The `MobileHeader` reserves another chunk. Modals opened at this orientation often overflow because they assume a phone portrait height.

## Tasks

- [x] **Task 5.1 — Confirm `isShortViewport` is exposed from Phase 0.** Read `src/web/hooks/useBreakpoint.ts` and verify the flag exists and fires at `height < 500`. If it's missing or mis-wired, fix it here (but call this out in the commit). _Verified: `SHORT_VIEWPORT_MAX_HEIGHT = 500` (line 22) is wired into `isShortViewport: height < SHORT_VIEWPORT_MAX_HEIGHT` (line 52) on the `BreakpointState` returned from `useBreakpoint()`. No changes needed._
- [x] **Task 5.2 — Wire `CommandInputBar.compact` to `isShortViewport`.** In the component's parent in `App.tsx`, set `compact={isShortViewport}`. Remove the `TODO(phase-5)` marker placed in Phase 1. _Done: Added `isShortViewport` to the `useBreakpoint()` destructure (`App.tsx:1039`), passed `compact={isShortViewport}` on the `CommandInputBar` render (`App.tsx:3355`), and dropped the `TODO(phase-5)` comment on the `compact` prop in `CommandInputBar.tsx`. `npm run lint` passes._
- [ ] **Task 5.3 — Audit what `compact` should actually hide.** Measure current `CommandInputBar` at short viewport: which secondary rows (model picker, slash command hints, recent commands chips) are non-essential? Hide them behind the `compact` prop. Primary input + send button must remain.
- [ ] **Task 5.4 — Thin `MobileHeader` at short viewport.** Halve vertical padding; ensure total header height ≤ 48px. Icon tap targets remain ≥40px via reduced surrounding padding rather than shrinking the icon.
- [ ] **Task 5.5 — Short-viewport scrollable modals.** In `ResponsiveModal` (from Phase 4), ensure the modal body is scrollable (`overflow-y: auto`) and the overall modal height is capped at `calc(100vh - 24px)` at short viewport. The footer must stay pinned to the modal's bottom.
- [ ] **Task 5.6 — Audit bottom-sheet mode at short viewport.** At `phone` + short viewport (landscape phone), a bottom sheet with a form taller than ~300px currently overflows. Confirm the scroll behaviour from Task 5.5 handles this too.
- [ ] **Task 5.7 — Manual verification at landscape phone.** DevTools device emulation: iPhone SE landscape (667×375) and Pixel 5 landscape (851×393). Verify: command bar visible + usable, header thinned, opening a modal shows the full footer without scrolling the page, typing doesn't lose the send button under a keyboard overlay.
- [ ] **Task 5.8 — Update tests in scope.** Any test touching `CommandInputBar`, `MobileHeader`, or `ResponsiveModal` where short-viewport behaviour is observable.
- [ ] **Task 5.9 — Lint, commit, push.**

## Validation

- At 667×375, the command bar occupies no more than ~56px of vertical space.
- Opening `AgentCreationSheet` (the tallest sheet) at 667×375 shows a scrollable body with a pinned footer.
- No visual regressions at phone portrait (375×667) or tablet/desktop widths.

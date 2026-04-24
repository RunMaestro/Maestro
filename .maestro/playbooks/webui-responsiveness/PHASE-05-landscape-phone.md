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
- [x] **Task 5.3 — Audit what `compact` should actually hide.** Measure current `CommandInputBar` at short viewport: which secondary rows (model picker, slash command hints, recent commands chips) are non-essential? Hide them behind the `compact` prop. Primary input + send button must remain. _Audit complete. Compact mode (Phase 1) already hides every vertical-space-consuming secondary row: swipe-up handle (`CommandInputBar.tsx:526`, ~12px), Recent-command chips row label+chips (`CommandInputBar.tsx:539`, ~70px via `RecentCommandChips` "Recent" label + 36px+ chip row + 8px bottom padding), reduced top padding `pt-1` vs `pt-3` (~8px), and reduced bottom padding `pb-[max(4px,...)]` vs `pb-[max(12px,...)]` (~8px). App.tsx already passes `showRecentCommands={false}` so chips are never mounted on mobile anyway — the compact guard is a belt-and-suspenders fallback. Remaining secondary controls (`VoiceInputButton`, `SlashCommandButton`, `ThinkingToggleButton`) are inline with input+send and contribute zero vertical height — `shouldCompressPhoneActions` (`CommandInputBar.tsx:482`) already auto-hides Voice + Slash when the user starts typing on mobile. The `SlashCommandAutocomplete` popup is `position: absolute; bottom: 100%` (`SlashCommandAutocomplete.tsx:167`), contextual, never part of base bar height. No model picker exists on mobile. Compact bar height ≈ `pt-1 (4px) + input row (48px) + pb (~4px)` ≈ **56px**, meeting the Phase 5 validation target of "≤56px". No further hiding required; the primary input + send button remain in every mode._
- [x] **Task 5.4 — Thin `MobileHeader` at short viewport.** Halve vertical padding; ensure total header height ≤ 48px. Icon tap targets remain ≥40px via reduced surrounding padding rather than shrinking the icon. _Done: `MobileHeader` now destructures `isShortViewport` from `useBreakpoint()` (`App.tsx:293`) and swaps vertical padding — `pt-[max(6px,env(safe-area-inset-top))] pb-1.5 min-h-11` → `pt-[max(3px,env(safe-area-inset-top))] pb-0.5 min-h-10` (half the top/bottom inset) — via a `headerPaddingClass` computed at `App.tsx:326`. `headerIconButtonClasses(isActive, compact)` gained a `compact` flag (`App.tsx:119`) that appends `min-h-10` to each icon button, overriding the global `button { min-height: 44px }` floor in `src/web/index.css:161` down to a 40px hit zone — still 8px taller than the 32px `w-8 h-8` icon box, so tap surface shrinks via surrounding padding rather than icon scaling. Every header icon button (Agents toggle, Search, Right Panel, Cue, Notifications, Settings, Group Chat, Usage Dashboard, Achievements, Context Management, New Agent, and the Overflow `⋯` button) forwards `isShortViewport` so all tap targets behave identically. Net header height at short viewport ≈ `3px (top) + 40px (button) + 2px (bottom)` = **45px**, comfortably under the 48px ceiling. `npm run lint` + `npm run lint:eslint` pass._
- [x] **Task 5.5 — Short-viewport scrollable modals.** In `ResponsiveModal` (from Phase 4), ensure the modal body is scrollable (`overflow-y: auto`) and the overall modal height is capped at `calc(100vh - 24px)` at short viewport. The footer must stay pinned to the modal's bottom. _Done: `ResponsiveModal` now destructures `isShortViewport` from `useBreakpoint()` (`ResponsiveModal.tsx:83`) and computes `maxHeightClass = isShortViewport ? 'max-h-[calc(100vh-24px)]' : 'max-h-[90vh]'` (`ResponsiveModal.tsx:90`), applied to both the phone bottom-sheet container (`ResponsiveModal.tsx:181`) and the tablet+ centered dialog (`ResponsiveModal.tsx:220`). Body scrollability (`overflow-y-auto flex-1`, `ResponsiveModal.tsx:197` / `:237`) and footer pinning (`shrink-0` on both header and footer wrappers, `ResponsiveModal.tsx:183`/`:199`/`:223`/`:239`) were already in place from Phase 4 Task 4.2 — no changes needed. Test mock (`ResponsiveModal.test.tsx:17-34`) extended with a togglable `setIsShortViewport` helper; added a "short-viewport behaviour (Task 5.5)" describe block (`ResponsiveModal.test.tsx:313-370`) with five tests covering the height-cap switch at tablet+, the height-cap switch on the phone bottom sheet, scrollable body at short viewport, and footer `shrink-0` at short viewport. All 28 tests pass. `npm run lint` + `npm run lint:eslint` clean._
- [ ] **Task 5.6 — Audit bottom-sheet mode at short viewport.** At `phone` + short viewport (landscape phone), a bottom sheet with a form taller than ~300px currently overflows. Confirm the scroll behaviour from Task 5.5 handles this too.
- [ ] **Task 5.7 — Manual verification at landscape phone.** DevTools device emulation: iPhone SE landscape (667×375) and Pixel 5 landscape (851×393). Verify: command bar visible + usable, header thinned, opening a modal shows the full footer without scrolling the page, typing doesn't lose the send button under a keyboard overlay.
- [ ] **Task 5.8 — Update tests in scope.** Any test touching `CommandInputBar`, `MobileHeader`, or `ResponsiveModal` where short-viewport behaviour is observable.
- [ ] **Task 5.9 — Lint, commit, push.**

## Validation

- At 667×375, the command bar occupies no more than ~56px of vertical space.
- Opening `AgentCreationSheet` (the tallest sheet) at 667×375 shows a scrollable body with a pinned footer.
- No visual regressions at phone portrait (375×667) or tablet/desktop widths.

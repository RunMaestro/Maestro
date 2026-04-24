# Phase 6 — Hover & Mouse-Only Affordance Sweep

**Goal:** Eliminate the remaining hover-only affordances and mouse-only event handlers across the web UI so every feature is usable on touch. Final polish pass.

**Prerequisite phases:** Phase 0 required; Phases 1–5 recommended (several hover hits live in files already migrated there, and cleaning them before this phase reduces conflicts).
**Blocks phases:** None — this is the last phase.

## Scope

### Files touched

Every `src/web/**/*.tsx` file that still contains:
- `onMouseEnter` / `onMouseLeave` not already handled in earlier phases.
- `onMouseDown` / `onMouseMove` / `onMouseUp` on elements that should support touch.
- `title="..."` as the only label for an icon-only button.

Expected survivors after Phases 0–5: `SlashCommandAutocomplete.tsx`, `OverflowMenuItem` uses, and a handful of stragglers in `App.tsx` / `LeftPanel.tsx`. Run a fresh grep at the start of this phase.

### Out of scope

- Introducing new features.
- Structural layout changes — those belong to earlier phases.

## Tasks

- [x] **Task 6.1 — Fresh inventory of mouse-only handlers.** Run `rg -n "onMouse(Enter|Leave|Down|Move|Up)" src/web/` and produce a table in a scratch file listing every hit with file, line, and current UI effect. Classify each as: (a) hover reveal that must become always-visible or CSS-only, (b) mouse interaction that needs pointer-event parity, (c) already correct (e.g. CSS `:hover` is acceptable and the handler is orthogonal).
  - Inventory written to `.maestro/Working/phase-06-mouse-handler-inventory.md`.
  - Residue after Phases 0–5: **8 hits / 5 files**, all `onMouseEnter`/`onMouseLeave` (zero `Down`/`Move`/`Up`).
  - Category (a) hover-reveal: 6 hits — `SlashCommandAutocomplete.tsx:228,232`, `RightPanel.tsx:181,184`, `RightDrawer.tsx:379,382`. All pure `backgroundColor`/`color` swaps → convert to CSS `:hover` in Task 6.2.
  - Category (b) pointer-parity: **0 hits** — Phase 0's `useResizableWebPanel` already absorbed drag/press. `RightPanel.tsx` resize strip uses `onPointerDown` for the drag itself; its `onMouseEnter/Leave` are cosmetic and counted in (a).
  - Category (c) orthogonal keyboard-selection sync: 2 hits — `SlashCommandAutocomplete.tsx:265`, `QuickActionsMenu.tsx:433`. Keep for Task 6.5 spot-check; consider upgrading to `onPointerEnter` so stylus/pen also syncs (would drive Task 6.10 residue to zero).
- [x] **Task 6.2 — Sweep hover-reveal affordances.** For each category-(a) hit: replace React-state hover tracking with CSS `group-hover:` / `peer-hover:` / `:hover` where possible. Where the affordance must be reachable on touch, make the target always-visible (possibly dimmed) rather than hidden.
  - Converted all 6 category-(a) hits to Tailwind `hover:` pseudo-class with `color-mix(in srgb, var(--maestro-text-dim) X%, transparent)` — the established pattern in `App.tsx`, `Card.tsx`, `Badge.tsx`.
  - `SlashCommandAutocomplete.tsx:228,232` close-button: inline style + mouse handlers → `className` with `hover:bg-[color-mix(in_srgb,var(--maestro-text-dim)_12%,transparent)] hover:text-text-main` (12% ≈ original `${colors.textDim}20` alpha).
  - `RightPanel.tsx:181,184` resize strip: inline style + mouse handlers → `className` with `hover:bg-accent`. Pointer-drag via `onPointerDown={onResizeStart}` unchanged.
  - `RightDrawer.tsx:379,382` file-tree button: inline style + mouse handlers → `className` with `hover:bg-[color-mix(in_srgb,var(--maestro-text-dim)_6%,transparent)]` (6% ≈ original `${colors.textDim}10`). `paddingLeft` stays inline — depends on `depth`.
  - Residue: `rg "onMouse(Enter|Leave|Down|Move|Up)" src/web/` now returns 2 hits — both category (c) keyboard-selection sync (rows 3 & 6 in inventory), scheduled for Task 6.5 spot-check.
  - `npm run lint` + `npm run lint:eslint` clean.
- [x] **Task 6.3 — Pointer-event parity for drag/press.** For each category-(b) hit: convert `onMouse*` to `onPointer*` with `setPointerCapture` where appropriate. `useResizableWebPanel` already done in Phase 0 — do not re-do it.
  - **No code changes required.** Task 6.1's inventory already classified category (b) as **0 hits**, and a fresh grep confirms it: `rg -n "onMouse(Down|Move|Up)" src/web/` → no matches.
  - Verified the two surviving drag/press sites are already on pointer events:
    - `src/web/hooks/useResizableWebPanel.ts` — uses `onPointerDown` with `setPointerCapture(pointerId)`, `pointerup` / `pointercancel` listeners, and routes moves via the captured pointer (Phase 0 work).
    - Consumers `src/web/mobile/RightPanel.tsx:170` and `src/web/mobile/LeftPanel.tsx:1290` attach `onPointerDown={onResizeStart}` on handles carrying `touch-none` (CSS `touch-action: none`), giving touch/pen full parity with mouse.
  - Remaining `onMouse*` residue (2 hits) is category (c) keyboard-selection sync only — scheduled for Task 6.5 spot-check, not Task 6.3.
- [x] **Task 6.4 — `title=`-only tooltips.** Find icon-only buttons whose only affordance is a `title` attribute. At `desktop` tier, render a visible label beside the icon. At `phone`/`tablet`, keep icon-only but add a hint label that appears on tap (or rely on the overflow menu copy when inside one).
  - Scope target: the `MobileHeader` icon toolbar in `src/web/mobile/App.tsx` (11 title-only icon buttons: Agents / Search / Files / Cue / Alerts / Settings / Chat / Usage / Awards / Context / New Agent). These are the most visible and were already tier-aware via `isHeaderIconInline` + `PRIMARY_SLOTS_BY_TIER`.
  - `headerIconButtonClasses(isActive, compact, withLabel)` now takes a third flag; when `withLabel` is true it switches from the fixed `w-8 h-8` icon-square to a relaxed `h-8 px-2 gap-1.5` flex row so a short label can sit beside the SVG icon.
  - Each header button renders `{isDesktop && <span className="text-[13px] font-medium leading-none whitespace-nowrap">Label</span>}`. `aria-label` and `title` are preserved at every tier — the visible label is additive, not a replacement.
  - Phone/tablet behavior unchanged: icons stay 32px squares and lower-priority actions are still discoverable through the labeled overflow menu (`OverflowMenuItem`), satisfying the task's "rely on the overflow menu copy when inside one" branch. No tap-hint layer was added because tap IS the action on touch devices and the overflow copy already covers discoverability.
  - Allowed exceptions documented in `docs/agent-guides/WEB-MOBILE.md` (new "Icon-only buttons and `title=` tooltips" section): LeftPanel / RightPanel / RightDrawer / MessageHistory / SessionStatusBanner / SessionPillBar / TabBar / WebTerminal find-bar / Notification-settings cog / More-actions overflow. Each has a one-line justification for staying icon-only (panel-header density, dropdown tightness, or self-describing contextual icon).
  - `npm run lint` + `npm run lint:eslint` clean. `vitest run src/__tests__/web/mobile/App.test.tsx` → 95/95 pass (tests run at JSDOM's default 1024px width, so `isDesktop === true` and labels render — `getByLabelText('Agents')` still resolves via `aria-label`).
- [x] **Task 6.5 — Spot-check `SlashCommandAutocomplete`.** The component has 3 `onMouseEnter` hits driving keyboard-selected-item syncing. Confirm the fix preserves both mouse-hover and arrow-key selection.
  - Of the original 3 hits, only 1 was actually keyboard-selection-sync — the per-row `onMouseEnter={() => onSelectedIndexChange?.(idx)}` now at `src/web/mobile/SlashCommandAutocomplete.tsx:246`. The other two (228, 232) were close-button cosmetic bg/color swaps, correctly migrated to Tailwind `:hover` in Task 6.2.
  - **Mouse-hover sync preserved:** hovering a row still calls `onSelectedIndexChange(idx)`; the parent `CommandInputBar` threads this into `setSelectedSlashCommandIndex` (line 560) which drives the `selectedIndex` prop (line 559). `isSelected` highlighting at line 238 and the visual bg/color/opacity swaps at 250/251/282 react correctly.
  - **Arrow-key selection path intact:** the component is a passive consumer of `selectedIndex`; it doesn't own arrow-key handlers. The `useSlashCommandAutocomplete` hook exposes `setSelectedIndex` for callers to bind arrow keys to (see hook doc comment). Phase 6 did not touch this contract — arrow-key wiring is unchanged from before, clamping effect (lines 104-108) still works, and the hook's `setSelectedIndex(0)` resets on `openAutocomplete` / `handleInputChange` still fire.
  - Note: `src/web/mobile/CommandInputBar.tsx:363` `handleKeyDown` currently only handles Enter/Shift+Enter — ArrowUp/Down to cycle the popup is a pre-existing gap, not Phase 6 fallout. Out of scope for this spot-check.
  - Ran `npx vitest run src/__tests__/web/mobile/SlashCommandAutocomplete.test.tsx` → 61 pass, 2 fail. Both failures are in the `Close button` describe-block ("applies/removes hover styles on mouse enter/leave") and assert inline `style.backgroundColor` — fallout from Task 6.2's CSS migration (Tailwind `hover:` pseudo-classes don't serialize to inline style in jsdom). Explicitly in scope for **Task 6.8** ("Any test that asserted on `onMouseEnter`/`onMouseLeave` handlers needs rewrites") — logging here so 6.8 has an easy target.
  - Selection-index tests (lines 228-280) all pass, confirming the surviving `onMouseEnter` and the `selectedIndex`→visual-highlight path are both intact.
- [x] **Task 6.6 — Add focus-visible rings where missing.** Any interactive element touched in this phase that lacks `focus-visible:` styling — add it.
  - Canonical pattern in this codebase is `outline-none focus-visible:ring-2 focus-visible:ring-accent` (grep-verified across `src/web/components/Card.tsx`, `ResponsiveModal.tsx`, `src/web/mobile/LeftPanel.tsx` × 5). Reused unchanged so theme hot-swap and RingColor consistency are preserved.
  - Three call sites touched — the focusable buttons from Tasks 6.2 and 6.4:
    1. `src/web/mobile/SlashCommandAutocomplete.tsx:216` — Commands-popup close button. Appended `outline-none focus-visible:ring-2 focus-visible:ring-accent` to the `className` string.
    2. `src/web/mobile/RightDrawer.tsx:361` — file-tree row button. Same pattern + `focus-visible:ring-inset` so the ring hugs the row instead of spilling into the adjacent row (rows sit flush against each other with no gap).
    3. `src/web/mobile/App.tsx:122,126` — added the pattern to both `HEADER_ICON_BUTTON_BASE_SQUARE` and `HEADER_ICON_BUTTON_BASE_LABELED`, which covers all 11 MobileHeader icon buttons in one shot (Agents / Search / Files / Cue / Alerts / Settings / Chat / Usage / Awards / Context / New Agent) at every tier.
  - **Deliberately skipped (non-focusable in current markup):**
    - `SlashCommandAutocomplete.tsx:241` command-row `<div>` — uses `onClick` on a div, not a `<button>`, so not reachable by Tab. Upgrading to a focusable element is a restructuring change (out of Phase 6 scope).
    - `RightPanel.tsx:170` resize strip `<div>` — drag handle, no `tabIndex`, not keyboard-operable. Matches the established pattern for `useResizableWebPanel` consumers elsewhere.
  - `OverflowMenuItem` (App.tsx:153) was not modified in Phase 6 — left alone per scope rules.
  - `npm run lint` + `npm run lint:eslint` clean.
- [x] **Task 6.7 — Tailwind migration of leftover inline styles.** While you're in each file for hover cleanup, migrate nearby inline styles to Tailwind classes — but only in the same JSX subtree. Do not refactor unrelated regions.
  - Scope locked to the JSX subtrees touched during Tasks 6.2 / 6.4 / 6.6 and skipped outer/structural regions whose inline styles are either dynamic or pinned by existing tests.
  - `src/web/mobile/SlashCommandAutocomplete.tsx` — header `<div>` (187-198) and the "Commands" label `<span>` (200-208) moved from inline style objects to Tailwind classes (`flex items-center justify-between py-2.5 px-4 border-b border-border sticky top-0 bg-bg-sidebar z-[1]` + `text-[13px] font-semibold text-text-dim uppercase tracking-[0.5px]`). Outer container (dynamic `maxHeight`, tested `zIndex`/`maxHeight`) and command list items (tested `backgroundColor`/`color`/`borderBottom`) left inline on purpose — migrating those would break ~6 style-pinned tests and sits outside 6.7's scope since 6.8 is specifically about mouse-handler test rewrites, not style-assertion rewrites.
  - `src/web/mobile/RightPanel.tsx` — no web/mobile test file exists for this component, so the full inner subtree was migrated: the header `<div>` (175), the 4 tab buttons (conditional `isActive` styling now via class interpolation with `border-b-2 border-accent|border-transparent` + `text-accent|text-text-dim` + `font-semibold|font-medium`), the close button (197), and the tab-content wrapper (218). `WebkitTapHighlightColor: 'transparent'` rewritten as the arbitrary Tailwind utility `[-webkit-tap-highlight-color:transparent]` — matches the established pattern in `GitDiffViewer.tsx`, `TabBar.tsx`, `SessionPillBar.tsx`, `LeftPanel.tsx`. `ease` → `ease-in-out` for consistency with Task 6.2's `hover:bg-accent` strip (the delta is `cubic-bezier(0.25,0.1,0.25,1)` → `cubic-bezier(0.4,0,0.2,1)` over 150ms — imperceptible on a color fade). Outer panel wrapper uses a computed `panelStyle` object depending on `isOverlay` + swipe state — out of scope.
  - `src/web/mobile/RightDrawer.tsx` — inline styles on the SVG children and trailing name `<span>` inside the file-tree `<button>` (the Task 6.2/6.6 touch site) moved to Tailwind: chevron → `flex-shrink-0 transition-transform duration-100 ease-in-out rotate-90|rotate-0` (dynamic rotate becomes a conditional class, the `transform: rotate(Xdeg)` inline disappears entirely), folder/file glyphs → `flex-shrink-0 opacity-70|opacity-50`, spacer span → `w-2.5 flex-shrink-0`, name span → `overflow-hidden text-ellipsis`. Kept inline: the dynamic `paddingLeft: 8 + depth * 16` on the button itself (can't be expressed with a fixed arbitrary value) and the computed `stroke`/`fill` on the SVGs (theme-reactive via `colors.textDim`/`colors.accent`).
  - `src/web/mobile/App.tsx` — MobileHeader's touched subtree (Task 6.4) was already 100% Tailwind (`headerIconButtonClasses` + `className`-based SVG labels); no inline-style residue to migrate.
  - Test fallout: `src/__tests__/web/mobile/SlashCommandAutocomplete.test.tsx` had one test (`'header is sticky'`, line 512) that asserted `toHaveStyle({ position: 'sticky' })`. JSDom doesn't apply Tailwind's CSS, so after the migration it asserted against an empty computed style. Rewritten to `toHaveClass('sticky')` — the same invariant, just read from the class list. All 61 non-pre-existing tests pass; the 2 surviving failures are the close-button hover-style tests explicitly logged as Task 6.2 residue in Task 6.5's notes (already in 6.8's queue).
  - `npm run lint` + `npm run lint:eslint` clean.
- [ ] **Task 6.8 — Update tests in scope.** Any test that asserted on `onMouseEnter` / `onMouseLeave` handlers needs rewrites. Prefer testing visible DOM state (e.g. close button present) over testing handler wiring.
- [ ] **Task 6.9 — Manual pass at each tier.** Touch-emulation DevTools at 320, 600, 960. Every interactive element reachable via tap; keyboard focus navigates everything with visible focus rings; no feature requires hover.
- [ ] **Task 6.10 — Final grep proof.** After all tasks, running `rg -c "onMouse(Enter|Leave)" src/web/` should return a small, auditable residue (justified in commit message) or zero. Document remaining allowed exceptions in `docs/agent-guides/WEB-MOBILE.md`.
- [ ] **Task 6.11 — Lint, commit, push.**

## Validation

- Final `rg "onMouse(Enter|Leave)" src/web/` count is zero or matches the documented allowed-exceptions list.
- Keyboard-only navigation works for every interactive element.
- No `title`-as-only-label icon buttons remain at `desktop` without a visible label.
- Full touch-device pass (DevTools emulation) reveals no dead interactions.

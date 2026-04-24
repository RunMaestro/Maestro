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
- [ ] **Task 6.5 — Spot-check `SlashCommandAutocomplete`.** The component has 3 `onMouseEnter` hits driving keyboard-selected-item syncing. Confirm the fix preserves both mouse-hover and arrow-key selection.
- [ ] **Task 6.6 — Add focus-visible rings where missing.** Any interactive element touched in this phase that lacks `focus-visible:` styling — add it.
- [ ] **Task 6.7 — Tailwind migration of leftover inline styles.** While you're in each file for hover cleanup, migrate nearby inline styles to Tailwind classes — but only in the same JSX subtree. Do not refactor unrelated regions.
- [ ] **Task 6.8 — Update tests in scope.** Any test that asserted on `onMouseEnter` / `onMouseLeave` handlers needs rewrites. Prefer testing visible DOM state (e.g. close button present) over testing handler wiring.
- [ ] **Task 6.9 — Manual pass at each tier.** Touch-emulation DevTools at 320, 600, 960. Every interactive element reachable via tap; keyboard focus navigates everything with visible focus rings; no feature requires hover.
- [ ] **Task 6.10 — Final grep proof.** After all tasks, running `rg -c "onMouse(Enter|Leave)" src/web/` should return a small, auditable residue (justified in commit message) or zero. Document remaining allowed exceptions in `docs/agent-guides/WEB-MOBILE.md`.
- [ ] **Task 6.11 — Lint, commit, push.**

## Validation

- Final `rg "onMouse(Enter|Leave)" src/web/` count is zero or matches the documented allowed-exceptions list.
- Keyboard-only navigation works for every interactive element.
- No `title`-as-only-label icon buttons remain at `desktop` without a visible label.
- Full touch-device pass (DevTools emulation) reveals no dead interactions.

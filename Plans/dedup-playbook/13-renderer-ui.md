# Stage 13 - Renderer Components, Hooks, Interaction, and Theme

## Objective

Consolidate renderer behavior and presentation without changing accessibility, focus, layer ownership, timers, layout, or visual output.

## Priorities

**8, 19, 31, 36, 37, 38, 61, 62, 63, 64, 70, 78, 79, 87, 88, 89, 99, 107, 114**

## Dependencies

Stages 02, 04, and 05 complete. Stage 06 should establish settings APIs before settings UI changes.

## UI migration protocol

For every priority: render baseline, capture accessibility tree and screenshot when visual output matters, record keyboard/pointer/timer behavior, add/adjust focused tests, implement one consumer first, verify, then migrate remaining compatible consumers. Generic hooks must own setup and cleanup, not domain actions.

## Component structure

### 8 - General settings rows/headings

Replace hand-rolled compatible controls with `ToggleSettingRow` and `SettingsSectionHeading`. Preserve labels, descriptions, disabled state, IDs, layout, and analytics. Verify keyboard toggle, focus, and both themes.

### 19 - Split `AppModals`

Group modal wiring by domain while retaining one visible composition point and layer order. Extract domain components with explicit props/selectors; do not create a modal registry abstraction unless behavior requires it. Verify every modal opens/closes, focus restores, Escape affects the top layer, and no modal mounts twice.

### 31 - TabBar `ShortcutHint`

Select the richer accessible implementation, parameterize only actual differences, and preserve platform key labels. Migrate both TabBars, test macOS/Windows labels and screen-reader text, then delete local copies.

### 36 - `HelpSection`

Capture screenshots and accessibility structure for both copies. Extract only if heading hierarchy, spacing, links, and collapsibility match. Verify responsive sizes and both themes.

### 37 - TabBar primitive evaluation

Inventory shared interaction/style behavior as a cohesive unit: selection, close, drag, context menu, overflow, keyboard, and focus. Reject isolated handler factories. Extract only a stable component/hook pair that reduces code and keeps product-specific tab content explicit. Record `retain` if abstraction would be flag-heavy.

### 38 - Modal shell inventory

Classify manual shells against `ui/Modal.tsx`: compatible, special layout, non-modal overlay, or security/interaction exception. Migrate compatible shells in small batches. Verify aria-modal/name, focus trap/restore, backdrop, z-index, scrolling, Escape, and nested layers.

## Interaction hooks

### 61 - Click outside

Migrate only handlers with matching pointer phase, portal behavior, refs, enabled state, and inside exceptions. Test mouse/touch, nested portal, drag, and cleanup.

### 62 - List navigation

Compare key set, wrapping, disabled items, active descendant/focus model, Home/End, and typeahead. Parameterize proven variants; test empty/dynamic lists and IME/input exclusions.

### 63 - Escape ownership

Map the layer stack and every global/local Escape listener. Ensure only the top eligible layer handles the event, propagation rules are explicit, and focus restores. Remove duplicate listeners after real nested-modal/menu smoke.

### 64 - Inline Wizard auto-scroll

Extract a configurable hook/state machine covering near-bottom threshold, user scroll lockout, streaming updates, resize, and cleanup. Test fake scrolling/ResizeObserver and real long streaming output.

### 70 - Command-panel hook

Extract shared state/mutations for four panels while keeping commands/data domain-specific. Test query, selection, reset on close, keyboard movement, async result changes, and stale closures.

### 78 - Copy feedback

Evaluate one hook owning clipboard promise, feedback state, timeout replacement, unmount cleanup, and error state. Use fake timers. Keep differing user copy/telemetry at callsites. Adopt only if it reduces code.

### 87 - Scroll measurement

Move compatible manual measurement to `useScrollPosition`. Verify scroll container identity, throttling, initial measurement, resize/content changes, and teardown. Avoid rerender regressions.

### 88 - Pointer resize

Extract a tested mechanism for pointer capture, min/max, axis, cancellation, lost capture, window blur, touch/pen, and cleanup. Keep persistence/cursor presentation at callsites. Browser-test real drag.

### 89 - Flash timer

Give one hook/component sole ownership of scheduling, replacement, cancellation, and unmount cleanup. Test repeated flash and fake timers; verify no state update after unmount.

## Feature-local presentation

### 79 - Sparkline/date labels

Consolidate only within the feature. Preserve range, locale, empty data, timezone, scale, and SVG output. Use snapshot/table tests and visual comparison.

### 99 - Activity-graph axis labels

Extract a shared builder with explicit time range, bucket count, timezone, and formatter. Test DST, all-time, short range, empty data, and exact label positions.

### 107 - Keyboard matcher core

Extract non-US-safe modifier/key matching from duplicated shortcuts. Normalize `event.code`/`key` deliberately, preserve editable-target rules, and test US/non-US layouts, AltGr, Meta/Ctrl, repeat, and aliases. Keep action dispatch separate.

### 114 - Xterm theme variables

Replace hardcoded scrollbar colors with canonical CSS/theme variables. Preserve Firefox and WebKit behavior, hover/active states, contrast, and graceful fallback. Verify terminal in light/dark/custom themes and packaged Electron.

## Verification matrix

- Focused component/hook tests with real user events.
- Accessibility tree and keyboard-only flows.
- Fake-timer cleanup tests.
- Browser/Electron screenshots for modal, settings, TabBar, graphs, and terminal.
- Responsive sizes, light/dark/custom themes.
- React warnings, leaked listeners, and state-after-unmount checks.
- Renderer type check and relevant full suites.

## Exit criteria

All 19 priorities have evidence-backed dispositions; compatible UI behavior uses canonical primitives; exceptions remain explicit; accessibility and visual baselines are preserved; no listener/timer/pointer leak remains.

## Investigated execution cards

|   P | Current locations/behavior                                                                                                                                                                  | Chosen migration                                                                                                                         | Targeted evidence / rollback                                                                                       |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
|   8 | General Settings hand-rolls clickable `role`, `tabIndex`, Enter/Space, `ToggleSwitch`, and headings; canonical `ToggleSettingRow` and `SettingsSectionHeading.tsx` exist.                   | Migrate rendering/power/tab/update/auto-resume/storage/input/browser sections one batch at a time; keep special rows local.              | Settings component tests plus Electron keyboard/theme smoke. Revert per section.                                   |
|  19 | `src/renderer/components/AppModals/AppModals.tsx` is a mixed modal composition hotspot.                                                                                                     | Extract domain modal groups with explicit props/selectors while preserving one composition/layer order.                                  | `AppModals-selfSourced.test.tsx`, each modal suite, nested Escape/focus smoke. Revert one domain group.            |
|  31 | Two TabBars define `ShortcutHint` with the same platform-label role.                                                                                                                        | Add one TabBar-local component using richer accessible markup; migrate both.                                                             | Both TabBar tests for Windows/macOS label and screen-reader name; visual smoke.                                    |
|  36 | `CueHelpModal` and `HistoryHelpModal` repeat icon/title/body `HelpSection` markup.                                                                                                          | Extract presentation-only `HelpSection`; keep copy/actions owned by features.                                                            | Cue/History modal tests and screenshot comparison in both themes.                                                  |
|  37 | Parallel TabBars share interaction/style fragments but handlers such as `makeXHandler` would be low-value factories.                                                                        | Extract only a cohesive interaction/style primitive after selection/close/drag/context/overflow/keyboard parity; otherwise retain.       | Full TabBar suites and real drag/overflow/context/focus smoke. Roll back primitive if flags proliferate.           |
|  38 | Manual modal shells bypass `src/renderer/components/ui/Modal.tsx`; reported examples include Cue/History/Symphony/Marketplace and feature modals.                                           | Classify each by focus/backdrop/resize/layer contract; migrate exact shells from simplest to resizable/nested; leave non-modal overlays. | Per-modal tests, aria tree, focus restore, Escape, resize persistence, screenshots. Revert per modal.              |
|  61 | `SshRemoteModal`, `RepositoryDetailView`, `DocumentSelector`, `BrowserProfileMenu`, `AgentConfigPanel`, and `SessionList` have compatible click-outside handlers; `useClickOutside` exists. | Migrate only matching pointer/portal/enabled contracts, one component at a time.                                                         | Component tests for inside/outside/portal/drag/touch/unmount.                                                      |
|  62 | `FileSearchModal`, `CommandHistoryPopover`, `useTemplateAutocomplete`, and `GroupChatInput` duplicate list navigation; `useListNavigation` exists.                                          | Extend hook only for proven wrap/disabled/Home/End variants; migrate simple modal, popover, autocomplete, chat.                          | Hook/component user-event tests for empty/dynamic/IME/editable targets.                                            |
|  63 | Escape listeners are spread across modal/menu/list components despite layer-stack ownership.                                                                                                | Map handlers; route compatible surfaces through top-layer API; remove globals after nested-flow proof.                                   | Nested modal+menu Escape tests and Electron focus restoration. Revert whole ownership change if two layers close.  |
|  64 | `StreamingDocumentPreview` and `WizardConversationView` duplicate near-bottom/user-lock auto-scroll around `useAutoScrollToBottom`.                                                         | Add configurable Inline Wizard hook/state machine; migrate preview then conversation.                                                    | Fake scroll/ResizeObserver tests plus long streaming output browser smoke; rollback both consumers/helper.         |
|  70 | `BmadCommandsPanel`, `OpenSpecCommandsPanel`, `SpecKitCommandsPanel`, and `AICommandsPanel` repeat command-panel query/selection/reset mutations.                                           | Add `useCommandPanelState`; keep data loading/dispatch at panels; migrate one panel then remaining three.                                | Four panel suites for close reset, keyboard, async result changes, stale closure.                                  |
|  78 | Clipboard/copy surfaces repeat safe write, feedback state, timeout, and cleanup.                                                                                                            | Add `useCopyFeedback` only for compatible surfaces; keep telemetry/copy text local.                                                      | Fake timers, clipboard reject, repeated copy, unmount tests and user smoke.                                        |
|  79 | Usage/dashboard feature contains local sparkline and date-label helpers with same empty/range semantics.                                                                                    | Consolidate feature-locally, preserving timezone/locale/SVG scale.                                                                       | Usage Dashboard snapshots/table tests and visual comparison.                                                       |
|  87 | `useScrollLogHandlers` manually measures scroll while `useScrollPosition` exists.                                                                                                           | Make the canonical hook support the required container/content-change contract; migrate log handler.                                     | Scroll hook tests and long terminal/log browser smoke; compare rerenders.                                          |
|  88 | `useResizableModal` and `useResizablePanel` repeat pointer resize/capture mechanics.                                                                                                        | Extract `usePointerResize`; retain min/max/persistence/cursor at callers; migrate modal then panel.                                      | Pointer mouse/touch/pen/lost-capture/blur tests and real drag. Revert both callers/helper if capture regresses.    |
|  89 | Flash notification clearing and similar UI flashes own independent timers (`setFlashNotification(null)`).                                                                                   | Add one timer owner/hook for compatible flash state; migrate smallest surface first.                                                     | Fake timers for replace/cancel/unmount and no state-after-unmount warning.                                         |
|  99 | `SessionActivityGraph.tsx` and `History/ActivityGraph.tsx` duplicate `getAxisLabels`; group-chat has a related consumer.                                                                    | Extract history-local builder taking range/buckets/timezone; migrate both exact graphs, then assess group chat.                          | Graph tests for DST/all-time/short/empty/exact positions and screenshots.                                          |
| 107 | `useKeyboardShortcutHelpers.ts` repeats modifier, shifted punctuation, and 11-entry `event.code` fallback in `isShortcut`/`isTabShortcut`; `isPaneShortcut` is related.                     | Extract pure matcher core; keep action/editable-target policy in wrappers; migrate shortcut, tab, then pane if compatible.               | Existing helper tests plus non-US, AltGr, Meta/Ctrl, repeat, punctuation cases.                                    |
| 114 | `src/renderer/index.css` hardcodes xterm scrollbar colors while canonical theme variables already style other scrollbars.                                                                   | Add/use theme variables for track/thumb/hover; update xterm WebKit and Firefox rules with fallbacks.                                     | Terminal light/dark/custom theme screenshots in Electron and CSS/theme tests. Revert CSS variables/rules together. |

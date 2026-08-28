<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# UI Patterns

Shared UI patterns, component library, and design system conventions for the Maestro renderer.

---

## Modal System (LayerStack)

Maestro uses a centralized **LayerStack** to manage all modals, overlays, and search interfaces. Every dismissable UI surface registers with the stack so that Escape always closes the topmost layer first.

### Architecture

```text
LayerStackProvider          (src/renderer/contexts/LayerStackContext.tsx)
  -> useLayerStack hook     (src/renderer/hooks/ui/useLayerStack.ts)
  -> useModalLayer hook     (src/renderer/hooks/ui/useModalLayer.ts)
  -> Layer types            (src/renderer/types/layer.ts)
  -> Priority constants     (src/renderer/constants/modalPriorities.ts)
```

### Layer Types

Two discriminated-union variants defined in `src/renderer/types/layer.ts`:

| Type      | Purpose                                            | Extras                                      |
| --------- | -------------------------------------------------- | ------------------------------------------- |
| `modal`   | Full dialogs that block the UI                     | `isDirty`, `onBeforeClose`, `parentModalId` |
| `overlay` | Semi-transparent surfaces (file preview, lightbox) | `allowClickOutside`                         |

Both share `BaseLayer` fields: `id`, `priority`, `blocksLowerLayers`, `capturesFocus`, `focusTrap`, `ariaLabel`.

Focus trap modes:

- `strict` - Tab cycles within the layer (default for modals)
- `lenient` - Layer captures keyboard events but focus can leave
- `none` - No focus trapping

### Priority Ranges

Defined in `src/renderer/constants/modalPriorities.ts`:

| Range   | Purpose                  | Examples                                                           |
| ------- | ------------------------ | ------------------------------------------------------------------ |
| 1000+   | Critical / celebrations  | `QUIT_CONFIRM` (1020), `CONFIRM` (1000), `STANDING_OVATION` (1100) |
| 900-999 | High-priority mutations  | `RENAME_INSTANCE` (900), `GIST_PUBLISH` (980)                      |
| 700-899 | Standard modals          | `NEW_INSTANCE` (750), `BATCH_RUNNER` (720), `QUICK_ACTION` (700)   |
| 400-699 | Settings and info        | `SETTINGS` (450), `ABOUT` (600), `USAGE_DASHBOARD` (540)           |
| 100-399 | Overlays and previews    | `FILE_PREVIEW` (100), `GIT_DIFF` (200), `LIGHTBOX` (150)           |
| 1-99    | Autocomplete and filters | `SLASH_AUTOCOMPLETE` (50), `FILE_TREE_FILTER` (30)                 |

### Registering a Modal

Use the `useModalLayer` hook. It handles register-on-mount, unregister-on-unmount, and handler updates:

```tsx
import { useModalLayer } from '../../hooks';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

function MyModal({ onClose }: { onClose: () => void }) {
	useModalLayer(MODAL_PRIORITIES.MY_MODAL, 'My Modal', onClose);

	return <div>...</div>;
}
```

With options (dirty state, before-close confirmation):

```tsx
useModalLayer(MODAL_PRIORITIES.EDITOR, 'Editor', onClose, {
	isDirty: hasUnsavedChanges,
	onBeforeClose: async () => {
		return await confirmDiscard();
	},
	focusTrap: 'strict',
	blocksLowerLayers: true,
});
```

### Using the `<Modal>` Component

The `<Modal>` component (`src/renderer/components/ui/Modal.tsx`) wraps `useModalLayer` with standardized styling:

```tsx
import { Modal, ModalFooter } from '../../components/ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

function SettingsModal({ theme, onClose }: Props) {
	return (
		<Modal
			theme={theme}
			title="Settings"
			priority={MODAL_PRIORITIES.SETTINGS}
			onClose={onClose}
			width={500}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Save"
					confirmDisabled={!isValid}
				/>
			}
		>
			{/* modal content */}
		</Modal>
	);
}
```

`<Modal>` props of note:

- `closeOnBackdropClick` - defaults to `false`
- `showHeader` / `showCloseButton` - toggle header elements
- `customHeader` / `headerIcon` - customize the header
- `initialFocusRef` - element to auto-focus on mount
- `layerOptions` - pass-through to `useModalLayer`

`<ModalFooter>` provides a standard cancel/confirm button pair with optional `destructive` styling (red confirm button).

### Modal Sizing (max footprint)

**The Maestro Cue modal (`90vw x 90vh`) is the maximum modal size.** No modal should exceed it - not even an "expanded" or "fullscreen" state. The Cue modal (`src/renderer/components/CueModal/CueModal.tsx`) sets `width: '90vw'; height: '90vh'` on its container; treat that as the app-wide ceiling.

Guidance:

- A large, content-heavy modal (dashboards, editors, the expanded Prompt Composer) caps at `w-[90vw] h-[90vh]`.
- A compact modal that has a roomier "expanded" mode toggles between a capped default (e.g. `w-[90vw] h-[80vh] max-w-5xl`) and the `90vw x 90vh` ceiling - never `w-screen h-screen`. Staying off the screen edges keeps the modal clear of the OS title bar / traffic lights, so no per-platform inset gymnastics are needed.
- Standard form/dialog modals use the `<Modal>` component's `width` prop (a fixed pixel width) and size their height to content.

The expanded Prompt Composer (`src/renderer/components/PromptComposerModal.tsx`) is the reference implementation of the compact-vs-`90vw x 90vh` toggle.

### Resizable Modals

A modal opts into drag-to-resize by passing `resizeKey` to `<Modal>`. Do NOT hand-roll a resize handle, a `ResizeObserver`, or CSS `resize: both` - the shared path already covers persistence, minimums, and viewport clamping.

```tsx
<Modal
	theme={theme}
	title="About Maestro"
	priority={MODAL_PRIORITIES.ABOUT}
	onClose={onClose}
	width={560} // default size before any resize
	resizeKey="about" // stable, unique; enables the corner grip
	minWidth={460} // floor for this modal's layout
	minHeight={420}
>
```

How it works:

- `useResizableModal` (`src/renderer/hooks/ui/useResizableModal.ts`) owns the drag. Like `useResizablePanel` it writes to the DOM during the drag and commits React state once on mouseup. Deltas are doubled because the card is centered: growing the width by W moves the right edge by only W/2, so doubling keeps the grip under the pointer.
- Sizes persist in one `modalSizes` map in `uiStore`, keyed by `resizeKey`, written through to settings and hydrated by `loadAllSettings` on startup.
- Minimums default to `MODAL_MIN_WIDTH` (360) / `MODAL_MIN_HEIGHT` (300), never exceeding the modal's declared `width`. Pass higher values when a modal's content stops making sense below a given size - every resizable modal should have a floor that still looks right.
- Sizes are clamped to `MODAL_MAX_VIEWPORT_RATIO` (90%) of the viewport both at drag time and at read time, so a modal sized on a large display still opens sanely on a laptop.
- `ModalResizeGrip` renders the bottom-right grip; double-clicking it forgets the remembered size and returns the modal to its declared default.

`resizeKey` must be stable across renders - it is the persistence key, not a label.

**Sizing a canvas modal by the viewport.** A fixed pixel default is right for a
form or a dialog: its content has a natural width and more room buys nothing.
It is wrong for a surface the user pans around inside - a graph, a dashboard,
a map - where the useful default is "as much of the screen as a modal may
take". A default that reads as generous on a laptop is a postage stamp on a 5K
display, and the user re-drags it on every machine. Pass
`viewportModalSize({ width, height })` from `src/renderer/utils/modalSizing.ts`
as the `defaultSize` instead of a literal (Document Graph is the reference
caller). Memoize it once per mount rather than recomputing per render: the hook
already re-clamps the live size on `resize`, and a default that moves under it
fights that listener. The result still passes through `clampModalSize`, so the
shared viewport cap and the modal's own `minSize` apply on top.

### Resizable Panes Inside a Surface

`useResizablePanel` (`src/renderer/hooks/ui/useResizablePanel.ts`) is the drag
for a pane whose width the user sets: the Left Bar, the Right Bar, and the
Document Graph's preview pane all ride it. It writes to the DOM during the drag
and commits React state once on mouseup, so a drag costs one render rather than
sixty.

Who persists the width depends on where the pane lives:

- **A top-level chrome pane** (Left Bar, Right Bar) is a real setting. Pass
  `settingsKey` and back it with a `settingsStore` field, so it round-trips
  through settings like any other preference.
- **A pane inside another surface** (a preview inside a modal, a split inside a
  panel) is a view preference, not a setting. Pair the hook with
  `usePersistedPanelWidth(storageKey, { defaultWidth, minWidth, maxWidth })`
  from `src/renderer/hooks/ui/usePersistedPanelWidth.ts` - the numeric
  counterpart to `usePersistedToggle` - and **omit `settingsKey`**, or the hook
  writes the same number a second time under a key nothing reads back.

Stored bounds and the live clamp are two different questions, and conflating
them is what lets a pane swallow its own container. The stored bounds decide
what may be written to disk; the `maxWidth` handed to `useResizablePanel` folds
in the container as it is right now, so a width that was legal on a maximized
window narrows itself after the modal is resized down. See
`previewPaneSizing.ts` in `src/renderer/components/DocumentGraph/` for the
shape: constants plus one pure `previewMaxWidthForContainer()`, which also
answers the unmeasured case (a `0` container width means the `ResizeObserver`
has not reported, where clamping to the minimum would paint the remembered
width narrow and then visibly jump).

### Modals Opened From Inside the Main Panel

A modal rendered from a component that lives inside the Main Panel (file
preview renderers, terminal views, chat surfaces) MUST pass `portal` to
`<Modal>`:

```tsx
<Modal theme={theme} title="Row 1" priority={MODAL_PRIORITIES.CSV_ROW_DETAIL} portal>
```

`MainPanel.tsx` wraps the session view in `isolate` (`isolation: isolate`),
which creates a stacking context. A `fixed inset-0` backdrop rendered inside
that subtree is still full-viewport in size, but its `z-index: 9999` only ranks
it _within_ MainPanel's context. The Left Bar (`SessionList.tsx`, `relative
z-20`) and the Right Panel (later in DOM order) are siblings of that context, so
they paint on top: the center dims while both side panels stay fully lit, and
the modal looks clipped to the middle of the window.

No z-index fixes this - ranking never crosses a stacking context. Rendering into
`document.body` is the only escape, which is what `portal` does. Most modals
mount at the App root already and don't need it, which is why it is opt-in.

Because jsdom has no layout engine, a test asserting `toBeInTheDocument()`
passes whether or not the modal escaped. Assert it is **not** a descendant of
its host subtree instead:

```tsx
expect(container.querySelector('.csv-table-renderer')).not.toContainElement(modal);
expect(modal.parentElement).toBe(document.body);
```

React context flows through portals, so `useModalLayer` registration, Escape
handling, and theming are unaffected by the relocation.

### Resizable Textareas

Any textarea with a native `resize-y` grip should remember the height the user drags it to. A size someone picked by hand is a preference, so snapping back to the default on the next open (or the next app launch) is a bug, not a reset.

```tsx
const resize = useResizableTextarea({
	sizeKey: 'settings-conductor-profile', // stable, unique
	minHeight: 100, // floor for a remembered height
});

<textarea
	ref={resize.textareaRef}
	className="... resize-y"
	style={{ borderColor: theme.colors.border, minHeight: '100px', ...resize.style }}
/>;
```

How it works:

- `useResizableTextarea` (`src/renderer/hooks/ui/useResizableTextarea.ts`) observes the element and persists the dragged height, debounced. Heights live in one `textareaHeights` map in `settingsStore`, keyed by `sizeKey`, written through to settings and hydrated by `loadAllSettings` on startup.
- The native grip writes the dragged height onto the element's inline `style.height` - the same property the hook writes when restoring one. The observer just compares the current inline height against the last applied height, so a user drag is the only thing it can see (content, font size and viewport width never move an explicit height).
- Omit `defaultHeight` to leave the textarea at whatever its `rows` / CSS `min-height` already give it until the user resizes it. Pass one only when the textarea has no natural size worth keeping.
- `minHeight` / `maxHeight` bound what can be remembered; heights are also clamped to the viewport at read time, so a textarea sized on a large display still opens sanely on a laptop.
- Spread `resize.style` LAST in the `style` prop, after the caller's own `minHeight`, or the inline height gets overwritten.
- Pass `externalRef` when the component already owns a ref on the textarea (autocomplete, focus-on-open). Do NOT add a second ref or a second `ResizeObserver`.

### Auto-Growing Composers

A composer textarea that grows with its content (AI composer, both wizard composers, group chat, feedback chat) uses `useAutosizeTextarea` (`src/renderer/hooks/ui/useAutosizeTextarea.ts`). Do NOT hand-roll the two-line `height = 'auto'` / `height = scrollHeight` pair again.

```tsx
useAutosizeTextarea({ textareaRef: inputRef, value: inputValue, maxHeight: 112 });
```

Why the hand-rolled version is wrong: setting `height = 'auto'` momentarily removes the overflow, which collapses the internal scroll to the top. Once the composer is full and scrolling, every keystroke therefore scrolled the line being typed back out of sight - the text was there, but the last line was clipped until the user scrolled by hand, and the next key hid it again. `resizeTextareaToContent` (`src/renderer/utils/textareaSizing.ts`) restores `scrollTop` across the toggle, and the hook re-pins the view to the bottom when the edit happened at the end of the text (`shouldScrollTextareaToEnd`), so typing, dictation, and paste all keep the caret visible.

Run it on the committed `value`, not inside `onChange`. An `onChange`/`onInput` resize never fires for programmatic edits - voice dictation, draft restore, template insertion - so those grow the text without growing the box.

- `resetKey` forces a re-measure when the value did not change but the content did (switching AI tabs restores a different draft).
- `deferredResizeRef` is for the one caller that owns its own rAF resize on the keystroke path (`useInputAreaTextChange`); while it is true the hook skips both the resize and the scroll so the two cannot race. Everything else omits it.
- `useInputAreaAutosize` is just the AI composer's binding over this hook. Distinct from `useResizableTextarea` above, which remembers a height the USER dragged; pick by who decides the height.

### Escape Key Flow

1. `LayerStackProvider` attaches a **capture-phase** `keydown` listener on `window`.
2. On Escape, it calls `closeTopLayer()` on the stack.
3. `closeTopLayer` checks `onBeforeClose` for dirty modals, then calls the top layer's `onEscape` handler from the handler ref map.
4. The handler ref map (`handlerRefs`) is updated via `updateLayerHandler` without re-sorting the stack - this is a performance optimization.

### Querying the Stack

Components that need to know whether modals are open (for example, to suppress global shortcuts) use `LayerStackAPI`:

```tsx
const { hasOpenLayers, hasOpenModal, layerCount } = useLayerStack();

// hasOpenLayers() - any layer (modal or overlay) is registered
// hasOpenModal()  - at least one 'modal' type layer is registered
```

### Debug API

In development mode, `window.__MAESTRO_DEBUG__.layers` provides:

- `list()` - print all layers in a table
- `top()` - log the topmost layer
- `simulate.escape()` - dispatch an Escape event
- `simulate.closeAll()` - clear the entire stack

### Every Modal Needs a Graphical Exit (`<EscCloseButton>`)

**Rule:** a modal, palette, or find bar must always be dismissable with the pointer alone. Escape is not enough: remote desktop sessions swallow it, tablets driving the web interface have no key to send, and a keyboard-only exit reads as "stuck" to the user.

The `ESC` pill is that exit. Use `<EscCloseButton>` (`src/renderer/components/ui/EscCloseButton.tsx`) - do NOT hand-roll the `px-2 py-0.5 rounded text-xs font-bold` pill again. It was previously copy-pasted as an inert `<div>` (three of them with `pointer-events-none`) in nine places, so every one of those surfaces advertised an exit that did nothing on click.

```tsx
// Header pill, sitting in the search row
<EscCloseButton theme={theme} onClose={onClose} />

// Adornment pill, absolutely positioned inside a `relative` input wrapper
<EscCloseButton
	theme={theme}
	variant="adornment"
	label="Close filter (Esc)"
	onClose={handleFilterEscape}
/>
```

`onClose` must do **exactly** what pressing Escape does. When the Escape path lives in a `useModalLayer` / `registerLayer` callback, extract it into a named `useCallback` and pass the same function to both, rather than duplicating the body (see `TerminalOutput`'s `closeOutputSearch` and `QuickActionsModal`'s `handleEscape`).

Tests: query the pill by role, not by index. It is a real `<button>` now, so `getAllByRole('button')[n]` in a modal test counts it - scope list assertions to the rows themselves (e.g. `[data-action-label]`).

### Segmented Toolbars (`<SegmentedControl>`)

A horizontal row of mutually exclusive options rendered as one joined pill bar - the "Sort by: [Name][Created][Queries]" control above a grid or chart. Use `<SegmentedControl>` (`src/renderer/components/ui/SegmentedControl.tsx`), not a hand-rolled `.map()` over buttons with `borderLeft` seams.

```tsx
<SegmentedControl
	value={sortMode}
	onChange={setSortMode}
	options={[
		{ value: 'name', label: 'Name' },
		{ value: 'queries', label: 'Queries', title: 'Most queries first' },
	]}
	theme={theme}
	ariaLabel="Sort agents"
	testId="agent-overview-sort"
/>
```

It owns the active-segment coloring, the seam borders, `role="radiogroup"` + `role="radio"` semantics, arrow-key navigation between segments, and a single tab stop (`tabIndex` follows the selection, as a native radio group does). Each segment gets `data-testid="${testId}-${value}"`, so existing per-segment test ids keep working when a hand-rolled bar is migrated.

**This is not `<RadioGroup>`.** That primitive renders the same semantics as stacked, description-carrying list rows for settings panes. `SegmentedControl` is the compact toolbar form for short labels where vertical space is scarce. Pick by layout, and do not add a `variant` prop to either one to cover the other.

### Sortable Table Headers (`<SortableTh>` + `useTableSort`)

A table whose column headers sort it needs two pieces, and both live in shared code: `useTableSort()` (`src/renderer/hooks/ui/useTableSort.ts`) for the state, `<SortableTh>` (`src/renderer/components/ui/SortableTh.tsx`) for the header cell.

```tsx
const { sortKey, direction, isDescending, toggleSort } = useTableSort<TaskSortKey>('next', {
	// Text columns read best A-Z, magnitude columns biggest-first.
	defaultDirectionFor: (key) => (key === 'occurrences' ? 'desc' : 'asc'),
});

<SortableTh
	columnKey="next"
	label="Next"
	sortKey={sortKey}
	direction={direction}
	onSort={toggleSort}
	theme={theme}
	align="right"
	title="Sort by time until the next fire"
	className="pb-2 font-medium text-right"
	testId="scheduled-tasks-sort-next"
/>;
```

The hook owns the one rule every hand-rolled copy gets subtly different: clicking the **active** column flips its direction, clicking a **different** column jumps to that column's own default direction. Inheriting the previous column's direction is the bug worth avoiding - going from "Next ascending" to "Occurrences ascending" silently shows the least-used rows first, which reads as broken data rather than as a sort.

The component owns three things:

- **A real `<button>` as the click target.** A `<th role="button" onClick>` announces as a button but has no tab stop and no Enter/Space handling, so it is unreachable by keyboard. `role` grants the semantics without granting the behavior.
- **`aria-sort` on the `<th>`**, never on the inner control, and only the active column carries a direction.
- **A stable indicator slot.** The caret is always laid out and merely transparent when inactive, so switching columns doesn't reflow the header row.

Callers keep their own comparator and own padding/border classes via `className` / `style`. One nuance worth copying: rows whose sort value is genuinely unknown (a Cue interval task has no projected next fire) should be pinned last in **both** directions rather than flowing through the comparator - "unknown" is not "the largest value", and flipping the sort must not promote rows that have nothing to compare.

### Paginating an In-Memory List (`usePagination` + `<Pager>`)

Two unrelated pagination systems live in this codebase; picking the wrong one is the mistake to avoid.

- `useHistoryPagination` (`hooks/history/`) is an **async, IPC-backed windowing engine**. Use it when the data arrives page by page over IPC and the total lives in a database.
- `usePagination` (`hooks/ui/usePagination.ts`) is for a list you **already hold in memory** and simply cannot render all at once. Pure page arithmetic lives in `utils/pagination.ts` so it can be tested without a DOM.

```tsx
const pager = usePagination(sortedRows, 32, `${filterMode}:${sortMode}`);
...
{pager.isPaginated && (
	<Pager
		theme={theme} page={pager.page} totalPages={pager.totalPages}
		onPrev={pager.prevPage} onNext={pager.nextPage}
		canGoPrev={pager.canGoPrev} canGoNext={pager.canGoNext}
	/>
)}
{pager.pageItems.map(renderRow)}
```

Two rules the hook exists to enforce:

**The current page is clamped on read, not in an effect.** A list can shrink underneath an active page - narrowing the tab breakdown from "All" (1236 rows, page 30) to "Open" (18 rows) is the canonical case. Clamping in an effect renders one frame of the out-of-range page first, which flashes an empty grid; clamping on read means the out-of-range state is never visible. `page`, `pageItems`, and `range` are all derived from the clamped value.

**Pass a `resetKey`.** Build it from everything the user can change that reorders or refilters the list (sort mode, filter mode, search text). Without it, re-sorting leaves the user on page 7 of a brand-new ordering, which is an arbitrary slice of data they did not ask for.

**Put `<Pager>` in the toolbar row, not under the list.** A pager below a long grid inside a scrolling modal forces the user to scroll to the bottom, click, and then scroll back to the top to see the page they asked for. Beside the filter and sort controls, everything that changes what you see sits in one place and stays on screen. Gate it on `pager.isPaginated` so the control is absent entirely when everything fits - and choose a page size that keeps the bounded filters on one page, so the pager appears exactly when it is needed.

### Filtering a List (`<FilterInput>`)

`<FilterInput>` (`components/ui/FilterInput.tsx`) is the "narrow this list" box: search icon, borderless input, optional result count (`resultLabel`), and a clear button that only exists once there is something to clear. Reach for it whenever a pane filters a list it already holds - the Memory Viewer's name-or-content filter is the first caller.

It is **not** a find bar. A find bar walks matches inside one document and owns next/prev plus a match index (`AutoRunSearchBar`, `TerminalSearchBar`); this control has no cursor into the results, it only narrows them. Do not add match navigation to it - pick by question ("which rows do I see?" vs "take me to the next hit").

**Escape is the part that needs care.** The control clears its own query on Escape, but that only fires on an UNLAYERED surface: the layer stack listens on `window` in the capture phase, so inside any modal or registered overlay the key closes the surface before the input ever sees it. The host has to clear the filter from its own `onEscape` first:

```tsx
onEscapeRef.current = () => {
	if (filterQuery) {
		setFilterQuery('');
		return;
	}
	onClose();
};
```

Losing the whole pane while trying to reset a filter is the bug this prevents. The clear button is the always-available path either way.

### Keyboard Navigation in a `<DualPaneFileEditor>` List

The shared list pane (`components/shared/DualPaneFileEditor.tsx`) handles keys once a row has focus. Rows are real `<button>`s and the handler sits on the list container, so clicking one is enough - or pass `autoFocusList` and the surface opens with the list already focused:

- **Up / Down** walk the **visible** rows. The order comes from `visibleOrder`, which skips collapsed categories: stepping into a collapsed group would move the selection somewhere the user cannot see. The ends do not wrap, and a selection the current filter hides means the keys enter the list from whichever end they point at.
- **Backspace / Delete** raise `onDeleteItem(selectedId)`. The list only reports the intent; the consumer owns the confirmation. Both keys are ignored unless the event came from a row, so Backspace on the "+ New" button in the same container cannot delete anything.

Two focus rules the component exists to enforce:

**Selection is chased, not assumed.** `onSelect` may be async or may refuse (unsaved changes), so arrow nav records the requested id and only moves DOM focus once `selectedId` actually lands on it.

**`autoFocusList` claims focus once, and only if nothing else has it.** The list loads async, so it cannot fire on mount - it waits for the first selection, which means a fast user may already be typing in the filter box by then. Focus must stay where they put it, so the effect checks `document.activeElement` first (the same rule the layer stack uses when restoring focus) and gives up if anything outside the list holds it. Only turn it on for a surface whose primary job is walking the list; on an editor-first surface it steals the caret from the textarea.

**After a consumer-driven delete, bump `listFocusToken`.** The row that had focus was just unmounted, so focus falls to `<body>` and the next Backspace does nothing - which reads as the keyboard dying halfway through a cleanup pass. Only the consumer knows when its own async delete settled, hence the token.

### Measuring an Element's Width (`useElementWidth`)

`useElementWidth(ref, enabled?)` (`hooks/ui/useElementWidth.ts`) wraps the ResizeObserver boilerplate that was previously inline in `UsageDashboardModal`. Reach for it **only when the number has to exist in JavaScript**: an inline SVG chart needs real pixels for its viewBox, and a responsive breakpoint that switches column counts needs a value to compare. Anything expressible in CSS stays in CSS.

It returns `0` until the first measurement lands, so gate width-dependent children on `width > 0` (or supply a sensible fallback) rather than painting a zero-width chart on the first frame. It also no-ops when `ResizeObserver` is undefined, so jsdom component tests render without a polyfill.

This matters for any resizable modal that draws a chart: a hard-coded SVG width silently stops matching the frame the moment the user drags it.

### Entity Tiles in the Usage Dashboard (`<EntityTile>`)

The Usage Dashboard's card grids (the agent grid in `AgentOverviewCards`, the per-tab grid in `TabBreakdown`) all render the same tile: status dot, truncating title, badges, corner age, optional subtitle, a row of labeled stats, and a corner sparkline. That chrome lives once in `src/renderer/components/UsageDashboard/EntityTile.tsx` - border states (default / dashed / hovered / selected), the staggered `card-enter` animation, the clickable-button affordance, and the highlighted-stat accent coloring.

Adding a new dashboard grid means shaping data into `EntityTileStat[]` and passing it, not re-deriving 150 lines of tile styling. `EntityTile` is presentational: it takes formatted strings and colors and reports clicks, so callers keep their own sort/filter state and their own number formatting.

It deliberately lives under `UsageDashboard/` rather than in `renderer/widgets/`: widgets are barred from importing from `UsageDashboard/`, and this tile is an entity summary (many stats, one subject) rather than the widget library's `StatCard` (one headline metric).

### Turn Attribution Pills (`<TurnSettingPills>`)

Each assistant message in the AI transcript carries a centered footer row naming the configuration that produced it: the Claude token-source pill (`claude -p` / `TUI Wrapper`, from `getTokenSourcePill()`), then the model and effort the turn was SENT with. `src/renderer/components/ui/TurnSettingPills.tsx` renders the model/effort half - static badges that mirror the composer's interactive `ModelEffortPills` (Sparkles + accent for model, Gauge + warning for effort), because a finished turn's configuration is a fact, not a control.

The values come from `LogEntry.turnModel` / `turnEffort`, copied in `useBatchedSessionUpdates` from the tab's send-time stamp (`AITab.turnModel` / `turnEffort`, written by `codifyTurnSettings()` in `utils/providerTabSessions.ts`). Read the stamp, never the live tab or agent value: settings are codified at send, so a model change made while a turn streams applies to the next message and must not relabel the response already running. An unset value means the agent's own default applied, and that pill is omitted rather than labeled with a guess.

**A queued message freezes its settings when it is QUEUED, not when it dispatches.** Queuing is the send from the user's point of view - they picked a model, typed, hit Enter - but the turn may not spawn until several model changes later. So every path that builds a `QueuedItem` spreads `captureQueuedTurnSettings(tab, session)` into `item.turnSettings`, and both consumers read it back through `codifyQueuedTurnSettings(item, tab, session)`: `markTabRunningQueuedItem()` for the pills, and `agentStore.processQueuedItem()` for the actual `sessionCustomModel` / `sessionCustomEffort` it spawns with. The queued-item rows in the inline list and the Execution Queue browser render the same `<TurnSettingPills>`, so the user can see which pending message is on the big model before it runs.

The presence of the `turnSettings` OBJECT is the capture flag, not the presence of its fields. `undefined` model/effort inside a present object means "the agent's default was in force when I queued", which is a real choice - never write `item.turnSettings?.model ?? liveModel`, or an item queued on the default silently inherits whatever the user selected afterwards. The object is absent only on items restored from a build that predates the capture, which is the one case that falls back to live values.

Two traps when touching this row:

- `collapsedLogs` in `TerminalOutput` merges consecutive non-user entries into one rendered entry built from `[0]`. A group can lead with a system banner that carries no stamp, so the merge lifts `turnModel` / `turnEffort` from the first grouped entry that has them - the same fix `renderStyle` needed.
- `LogItem`'s memo comparator lists every field that affects rendering. A new pill field that is not in that list will not repaint when it changes.

### Queued Item Tab Labels (`resolveQueuedItemTabName`)

A `QueuedItem`'s `turnSettings` is frozen at queue time on purpose. Its `tabName` is NOT: that field is a last-known label, and the queue UI must resolve the tab's name as it is NOW.

`resolveQueuedItemTabName(session, item)` in `src/renderer/utils/executionQueue.ts` is the one resolver, and both surfaces ride it - the tab pills in `ExecutionQueueIndicator` and the tab button on each row of `ExecutionQueueBrowser`. It mirrors `resolveQueuedItemTarget`: the live tab in `session.aiTabs` first, then a closed-but-still-draining tab in `session.orphanedThinkingTabs`, and only then `item.tabName`, which by that point is the last thing we ever knew about a tab that is gone.

Reading `item.tabName` directly is what this replaced. A message queued into a brand-new tab snapshots the label `New`, and it keeps that label forever - including after auto-naming gives the tab a real title, and including next to a LATER message on the SAME tab that snapshotted the real name. The indicator groups by `tabId`, so one tab rendered under whichever name its first item happened to carry, and the browser listed two rows pointing at the same tab under two different names. The queue is exactly where the user decides what to reorder or drop, so two entries for one tab must never read as two tabs.

The producer side still writes the snapshot, via `getTabDisplayName(activeTab)` in `useInputProcessing` - one display-name rule for the fallback and for the live path, rather than a second inline `name || sessionId.split('-')[0] || 'New'` ladder that disagreed with the tab bar.

### Following Streaming Output (`useStickToBottom`)

`useStickToBottom(contentKey)` in `src/renderer/hooks/ui/useStickToBottom.ts` keeps a scrolling box pinned to its newest content while it grows, and lets go the moment the user scrolls up to read something. Returns a callback ref to put on the scrolling element; pass whatever value changes on every append as `contentKey`.

Reach for it whenever a box has BOTH a capped height and content that arrives over time - streaming command output, a live log tail. The failure it prevents is specific: the box stops growing once it hits its cap, so the outer transcript's auto-scroll has nothing left to follow, and the user is left staring at the FIRST screen of output while the live tail piles up out of sight. `ShellCommandCard`'s 480px output box is the first caller.

**Pinning is derived from geometry, never remembered.** The hook recomputes "are we at the bottom" from `scrollHeight - scrollTop - clientHeight` on every scroll event rather than tracking whether a scroll was the user's or its own. A remembered flag needs to tell those apart, which means a guard flag, which means a race the moment a scroll event does not arrive - scrolling to where you already are fires nothing. Geometry has no such ambiguity: after the hook scrolls to the bottom it IS at the bottom, so the event its own scroll produces recomputes to exactly the state it just set. Do NOT "optimize" this into a boolean the hook sets and trusts.

It uses `useLayoutEffect`, not `useEffect`: the scroll has to land in the same frame as the new content, or the box paints once at the old position and the output visibly jumps afterwards. The 50px bottom threshold matches the transcript's own in `TerminalOutput`, so a card follows its output on the same terms the conversation around it does.

Distinct from `useScrollIntoView` (brings ONE element into view inside a list, for keyboard navigation) and from `TerminalOutput`'s MutationObserver auto-scroll (owns the whole conversation pane). Pick by scope: one self-contained box, one element in a list, or the whole pane.

### Scrolling a Virtualized List to the Selection

A virtualized list follows its selection through the virtualizer's own `scrollToIndex`, from an effect keyed on the selected index. Never through a `ref` on the selected row.

```tsx
// CORRECT - one scroll per real change of selection.
useEffect(() => {
	virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
}, [selectedIndex, virtualizer]);

// WRONG - fires on EVERY render, not on every selection change.
<button ref={isSelected ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}>
```

An inline arrow function is a new identity on every render, so React detaches the old ref and attaches the new one each time, and an attach runs the callback. `@tanstack/react-virtual` re-renders (inside `flushSync`) on every scroll-offset change, so the two form a loop: a wheel tick scrolls the list, the virtualizer re-renders, the row's ref re-attaches, and `scrollIntoView` snaps the list back to the selection inside the same event. The wheel reads as broken; the component is undoing it. This is what `FileSearchModal` did, and the fix was deleting the ref, not touching the wheel handling.

`scrollToIndex` is also the API that understands the virtual window: `scrollIntoView` can only reach a row the virtualizer has actually rendered, so it silently does nothing for a selection outside the current slice.

**No `behavior: 'smooth'` on a long list.** The animation to a distant index runs long enough for the user's next wheel gesture to arrive mid-flight, and the two fight over the scroll offset.

The same identity trap applies to a non-virtualized list, minus the loop - the scroll just fires more often than the user changed anything. Use `useScrollIntoView` (`hooks/ui/useScrollIntoView.ts`) there, which keys on the value rather than on render count.

Testing it needs the virtualizer mocked: jsdom has no layout engine, so the real one measures a zero-height scroll element, yields zero items, and every assertion about row scrolling passes vacuously. `FileSearchModal.render.test.tsx` mocks `useVirtualizer` to emit a fixed window of rows, stubs `Element.prototype.scrollIntoView` (jsdom does not implement it), and asserts it is never called. Lead with a test that the rows exist, or the suite proves nothing.

### Rendering Raw Terminal Output (`useAnsiConverter`)

`useAnsiConverter(theme)` in `src/renderer/hooks/ui/useAnsiConverter.ts` returns the theme-aware `ansi-to-html` converter every raw-output surface shares; `createAnsiConverter(theme)` is the non-React form. Feed its result to `getCachedAnsiHtml(text, theme.id, converter)` from `utils/textProcessing`, which converts, sanitizes with DOMPurify, and caches per theme. Callers today: `TerminalOutput` (transcript + terminal pane), `ShellCommandCard` (command mode), `GitCommandRunnerModal` (the Pull / Push console).

The 16 ANSI slots map onto the ACTIVE theme, not the xterm palette, with a semantic fallback (`error` / `success` / `warning` / `accent`) for any slot a theme does not declare. Do NOT hand-roll another `new Convert({...})`: a second palette drifts the first time a theme adds a color, and the two surfaces then disagree about what "bright green" means.

Two things have to be true for color to reach the screen, and the renderer only owns one of them. **Nothing Maestro spawns is a TTY**, so the producer suppresses color by default: git needs `-c color.ui=always` and anything its hooks run (a test suite, a linter) needs `FORCE_COLOR=1` / `CLICOLOR_FORCE=1` in the spawn env. A surface that renders ANSI perfectly still shows a wall of gray if its spawn site forgot that half.

**Collapse carriage returns BEFORE converting.** `processCarriageReturns()` turns `Writing objects: 42%\r...100%` back into the single line a terminal would have shown; converting first emits a screen of dead progress rows instead. And any regex run against output that may now carry color (the "no upstream branch" probe, for one) must go through `stripAnsiCodes()` first, or a code landing mid-phrase hides the match.

### Text Selection in Modals

**Rule:** any modal (or modal subtree) whose primary purpose is _clicking_ - buttons, tabs, list rows, cards, graph nodes, filter chips, toggles, dropdowns - must have `select-none` on its root container. The dashboard-style modals (Cue, Usage Dashboard, Symphony, Playbook Exchange, Settings, Director's Notes list) are all click-driven; native browser drag-to-select highlighting fires accidentally during normal interactions (clicking a tab, dragging a graph node, double-clicking a card) and looks broken.

```tsx
// Click-driven modal: kill text selection at the root
<div className="relative rounded-xl shadow-2xl flex flex-col select-none">...</div>
```

`select-none` cascades through descendants but Chromium preserves native selection behavior inside `<input>` and `<textarea>`, so search fields and form controls keep working without intervention.

**Carve out content subtrees with `select-text`** when the modal contains regions where copying matters: prose detail views, code/YAML editors, log entry bodies, error messages, file paths, AI chat output. Apply `select-text` directly on the root of that subtree - it overrides the ancestor's `select-none`.

```tsx
// Detail view nested inside a select-none parent: opt back in
<div className="rounded-lg border shadow-2xl flex flex-col select-text">...</div>
```

**Skip modals whose primary purpose is reading or editing text:** `CueYamlEditor`, `CueHelpModal`, the wizard chat shell's message bubbles, Director's Notes detail popup, the System Log Viewer (intentionally left selectable), confirmation dialogs with error text. If the user's main interaction is reading or copying, leave selection alone.

**When adding a new modal,** decide first whether it's click-driven or content-driven. If click-driven, add `select-none` to the root in the same commit as the modal itself - retrofitting it later requires hunting down every nested detail view to add `select-text` overrides.

---

## Theme System

### Architecture

```text
src/shared/theme-types.ts   - Type definitions (ThemeId, ThemeColors, Theme)
src/shared/themes.ts        - Canonical theme objects (THEMES record)
src/renderer/constants/themes.ts - Re-exports for renderer imports
```

### `src/shared/themes.ts` Is Public API

The RunMaestro.ai website generates its theme picker from this file. It checks
out RunMaestro/Maestro in CI (and on a daily cron) and fails its build when its
generated palette drifts from ours. Renaming the file, moving the `THEMES`
export, or changing its shape turns that repo red with no signal here, so treat
the export surface as public and change it deliberately.

The website layers on one extra token, `accentSecondary`, that has no
counterpart in `ThemeColors`. It is deliberately website-only - do NOT add it
here to "fix" the mismatch.

### Theme Structure

Each theme has:

```typescript
interface Theme {
	id: ThemeId;
	name: string;
	mode: ThemeMode; // 'light' | 'dark' | 'vibe'
	colors: ThemeColors;
}
```

`ThemeColors` fields (13 color slots):

| Color              | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `bgMain`           | Main content area background                |
| `bgSidebar`        | Left/right sidebar background               |
| `bgActivity`       | Interactive/hover element backgrounds       |
| `border`           | Dividers and outlines                       |
| `textMain`         | Primary text                                |
| `textDim`          | Secondary/muted text                        |
| `accent`           | Highlights and interactive elements         |
| `accentDim`        | Dimmed accent (typically with alpha)        |
| `accentText`       | Text in accent contexts                     |
| `accentForeground` | Text ON accent backgrounds (contrast color) |
| `success`          | Green states                                |
| `warning`          | Yellow/orange states                        |
| `error`            | Red states                                  |

`ThemeColors` also has optional ANSI 16-color terminal fields (`ansiBlack`, `ansiRed`, `ansiGreen`, `ansiYellow`, `ansiBlue`, `ansiMagenta`, `ansiCyan`, `ansiWhite`, and their `ansiBright*` variants). When not provided, `XTerminal` uses theme-appropriate defaults.

### Available Themes

Three modes with built-in themes:

**Dark**: dracula, monokai, nord, tokyo-night, catppuccin-mocha, gruvbox-dark, solarized-dark

**Light**: github-light, solarized-light, one-light, gruvbox-light, catppuccin-latte, ayu-light

**Vibe**: pedurple, maestros-choice, dre-synth, inquest

Plus `custom` - user-defined via Custom Theme Builder.

### Using Themes in Components

All themed components receive a `theme: Theme` prop. Apply colors via inline styles:

```tsx
<div
	style={{
		backgroundColor: theme.colors.bgSidebar,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	}}
>
	<span style={{ color: theme.colors.textDim }}>Secondary text</span>
</div>
```

### Setting the Active Theme

Via `useSettings` hook:

```tsx
const { activeThemeId, setActiveThemeId } = useSettings();
setActiveThemeId('tokyo-night');
```

Custom theme colors are managed through `customThemeColors` / `setCustomThemeColors` / `customThemeBaseId`.

---

## Keyboard Shortcuts

### Architecture

```text
src/renderer/constants/shortcuts.ts                 - Shortcut definitions
src/renderer/hooks/keyboard/useMainKeyboardHandler.ts - Global keydown handler
src/renderer/hooks/keyboard/useKeyboardShortcutHelpers.ts - Shortcut matching
src/renderer/components/ShortcutEditor.tsx           - User customization UI
src/renderer/components/ShortcutsHelpModal.tsx       - Help overlay (Cmd+/)
```

### Shortcut Categories

Three categories defined in `src/renderer/constants/shortcuts.ts`:

**DEFAULT_SHORTCUTS** - Editable by the user:

- Navigation: `Cmd+[`/`]` (cycle agents), `Cmd+Shift+,`/`.` (nav back/forward)
- Panels: `Alt+Cmd+ArrowLeft/Right` (toggle sidebars)
- Actions: `Cmd+K` (quick actions), `Cmd+,` (settings), `Cmd+N` (new agent)
- Views: `Cmd+Shift+D` (git diff), `Cmd+Shift+G` (git log), `Cmd+Shift+E` (auto run expanded)
- Focus: `Cmd+.` (toggle input/output), `Cmd+Shift+A` (focus left panel)

**FIXED_SHORTCUTS** - Displayed in help but not configurable:

- `Alt+Cmd+1-0` (jump to agent 1-10)
- `Cmd+F` (context-sensitive filter/search)
- `Cmd+ArrowLeft/Right` (file preview navigation)
- `Cmd+=`/`Cmd+-` (font size)

**TAB_SHORTCUTS** - AI mode tab management:

- `Cmd+T` (new tab), `Cmd+W` (close tab), `Cmd+1-9` (go to tab N)
- `Alt+Cmd+T` (tab switcher), `Cmd+Shift+T` (reopen closed tab)
- `Cmd+R` (toggle read-only), `Cmd+S` (toggle save to history)

### Keyboard Handler Pattern

The main handler in `useMainKeyboardHandler` uses a **ref pattern** for performance. Instead of listing 50+ state values as `useEffect` dependencies (causing listener churn), a single ref holds all context:

```tsx
// In the hook:
const keyboardHandlerRef = useRef<KeyboardHandlerContext | null>(null);

useEffect(() => {
	const handleKeyDown = (e: KeyboardEvent) => {
		const ctx = keyboardHandlerRef.current;
		if (!ctx) return;
		// use ctx.isShortcut, ctx.sessions, etc.
	};
	window.addEventListener('keydown', handleKeyDown);
	return () => window.removeEventListener('keydown', handleKeyDown);
}, []); // empty deps - handler reads from ref

// In App.tsx render body:
keyboardHandlerRef.current = { isShortcut, sessions, activeSession, ... };
```

### Shortcut Customization

Users can rebind `DEFAULT_SHORTCUTS` and `TAB_SHORTCUTS` via the ShortcutEditor in Settings. Custom bindings are persisted through `useSettings`:

```tsx
const { shortcuts, setShortcuts, tabShortcuts, setTabShortcuts } = useSettings();
```

### Surface-Local Chords (`useCommandKeyShortcut`)

`useCommandKeyShortcut(key, handler, enabled)` in `src/renderer/hooks/keyboard/useCommandKeyShortcut.ts` is the primitive for a bare Cmd/Ctrl+`<key>` chord that ONE visible surface claims for as long as it is up: Cmd+S in an editor pane (`useSaveShortcut` is a preset over it), Cmd+R on the Usage Dashboard's Anthropic Usage / OpenAI Usage panels (`useQuotaRefresh`'s `refreshHotkey` option). It listens in the capture phase with `preventDefault`, so it wins against a focused textarea and against the browser's own default for the chord, and it requires the modifier ALONE - a Shift- or Alt-qualified chord falls through to whatever else owns it.

Do NOT reach for it to add a global shortcut. Those belong in `constants/shortcuts.ts` and must be matched through `eventMatchesShortcutKeys` so the user can rebind them. And do NOT let a component claim a chord just because it is mounted: `refreshHotkey` defaults to false and the dashboard opts in only on the tab that renders the panel, because two mounted panels both answering Cmd+R would refresh whichever one registered last. When a surface advertises its chord in a tooltip, gate the hint on the same flag that claims it, and build the label with `formatShortcutKeys()` so it does not read `⌘R` on Windows.

### Keyboard Mastery Gamification

Shortcut usage is tracked for a gamification system (`keyboardMasteryStats`). The `recordShortcutUsage` function in settings increments counters and can trigger level-up celebrations.

---

## Notification System (Toast)

Toasts use the **same five-color design language** as Center Flash (`green | yellow | orange | red | theme`) so the two systems feel unified. The difference is durability: toasts queue, sit in the corner, and stay until the user (or a timer) dismisses them; Center Flashes are exclusive, momentary, and center-screen.

### Architecture

```text
src/renderer/stores/notificationStore.ts - Zustand store + notifyToast()
src/renderer/components/Toast.tsx        - ToastContainer + ToastItem
src/cli/commands/notify-toast.ts         - `maestro-cli notify toast` command (external trigger)
```

### Firing a Toast (in-app)

Use `notifyToast()` from anywhere (React or non-React code):

```typescript
import { notifyToast } from '../stores/notificationStore';

notifyToast({
	color: 'theme', // 'green' | 'yellow' | 'orange' | 'red' | 'theme' (default)
	title: 'Task Complete',
	message: 'Auto Run finished phase-01.md',
	// Optional fields:
	dismissible: false, // true = sticky, no auto-dismiss, click X to close
	duration: 20000, // ms; ignored when dismissible:true
	group: 'Backend',
	project: 'My Agent',
	taskDuration: 45000,
	tabName: 'main',
	sessionId: 'abc-123', // enables click-to-navigate
	tabId: 'tab-1',
	actionUrl: 'https://github.com/pr/1',
	actionLabel: 'View PR',
});
```

`notifyToast` handles:

1. ID generation and timestamp
2. Color resolution (color > legacy type > 'theme')
3. Duration calculation (config seconds → ms; sticky when `dismissible: true`)
4. Adding to visible queue (unless toasts disabled with `defaultDuration: -1`)
5. Logging via `window.maestro.logger.toast`
6. Audio feedback via `window.maestro.notification.speak` (if enabled)
7. OS desktop notification via `window.maestro.notification.show` (if enabled)
8. Auto-dismiss timer (skipped for dismissible toasts)

### Firing a Toast (external - `maestro-cli`)

```bash
# Default - themed, auto-dismisses on the app's default schedule.
maestro-cli notify toast "Build" "Build succeeded on main"

# Pick a color and a custom duration.
maestro-cli notify toast "Tests" "All green" --color green --timeout 10
maestro-cli notify toast "Quota" "Approaching limit" --color orange --timeout 30

# Sticky - user must click to dismiss. Cannot combine with --timeout.
maestro-cli notify toast "Action required" "Approve the PR before EOD" \
    --color red --dismissible
```

`--dismissible` is the **only** way external scripts can leave a toast on screen indefinitely. `--timeout 0` is rejected - use `--dismissible` instead. Numeric durations are capped at **60 seconds** (toasts are corner-only and less obtrusive than Center Flash, so the cap is more generous than 5 s).

### Toast vs Center Flash: when each fits

| Scenario                                                        | Pick this                            |
| --------------------------------------------------------------- | ------------------------------------ |
| User-initiated micro-confirmation ("Copied", "Saved")           | Center Flash                         |
| Async result with context (PR posted, export complete)          | Toast                                |
| Critical message the user **must** acknowledge                  | Toast `dismissible: true`            |
| Quick mode-toggle indicator                                     | Center Flash                         |
| Click-to-navigate to a session/tab                              | Toast (Center Flash isn't clickable) |
| Long-form message the user might want to re-read after a moment | Toast                                |

### Color palette (shared with Center Flash)

| Color    | Source                          | Toast use cases                                          |
| -------- | ------------------------------- | -------------------------------------------------------- |
| `theme`  | `theme.colors.accent`           | **Default.** Generic notifications with no semantic      |
| `green`  | `theme.colors.success`          | Success / completion ("Build succeeded", "Tests pass")   |
| `yellow` | `theme.colors.warning`          | Soft heads-up ("Approaching context window limit")       |
| `orange` | Fixed `#f97316` (no theme slot) | Emphatic warning ("Quota at 90%")                        |
| `red`    | `theme.colors.error`            | Failure / blocking issue ("Sync failed", "Auth expired") |

Same icons as Center Flash: green→Check, yellow→Info, orange→AlertTriangle, red→AlertCircle, theme→Sparkles. **Do not** add a sixth color - keep the design language consistent across both systems.

### Dismissible toasts

Set `dismissible: true` (or pass `--dismissible` from the CLI) when the toast is something the user **must** see - a critical error, a required action, a security alert, etc. Behavior:

- No auto-dismiss timer is set.
- The progress bar is hidden.
- The close button is rendered with the toast's accent color (filled background + ring) instead of the muted `textDim` it gets for auto-dismissing toasts. This signals "you need to click this."
- `aria-label` becomes "Dismiss notification" for screen readers.
- `dismissible` is mutually exclusive with `duration` / `--timeout` (the CLI rejects the combination; in-app, `dismissible: true` overrides any `duration` value).

Use sparingly - every dismissible toast is a tiny piece of homework for the user.

### Toast Configuration

Managed through the notification store:

```typescript
const store = useNotificationStore();

store.setDefaultDuration(20); // seconds; 0 = never dismiss; -1 = disable toasts
store.setAudioFeedback(true, 'say'); // enable TTS with command
store.setOsNotifications(true); // enable OS notifications
```

### Non-React Access

```typescript
import { getNotificationState, getNotificationActions } from '../stores/notificationStore';

const state = getNotificationState();
const actions = getNotificationActions();
actions.clearToasts();
```

### ToastContainer Component

Rendered as a portal to `document.body`, positioned fixed at bottom-right. Each `ToastItem` shows:

- Color-coded icon (resolved from `toast.color` - see palette above)
- Optional group badge, project name, tab name
- Title and message
- Optional action link
- Optional task duration
- Progress bar for auto-dismiss countdown (hidden for `dismissible` toasts)
- Slide-in/out animations
- Close button - emphasized (color-tinted) when `dismissible: true`

### Back-compat: legacy `type` API (in-app only)

The original API used `type: 'success' | 'info' | 'warning' | 'error'`. It is still accepted **in-app** via `notifyToast({ type })` for back-compat, but **deprecated** - new code should use `color`. The CLI flag `--type` was removed. Mapping:

| Legacy type | Maps to color |
| ----------- | ------------- |
| `success`   | `green`       |
| `info`      | `theme`       |
| `warning`   | `yellow`      |
| `error`     | `red`         |

Existing in-app callers using `type:` continue to work without changes.

---

## Above-Modal Layering (`Z_LAYERS`)

Ordinary modals use plain Tailwind classes: `z-[9999]` for the backdrop, `z-[10000]`/`z-[10001]` for menus and tooltips anchored inside one. Those numbers only ever compete with each other, so they stay inline.

The handful of overlays that deliberately outrank a modal read their value from `Z_LAYERS` in `src/renderer/constants/zLayers.ts`. Their relative order is a product decision, so it lives in one file instead of being rediscovered as a magic number per component:

| Layer                    | Surface                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `Z_LAYERS.CONFETTI`      | Celebration particles - decorative, sits under real UI          |
| `Z_LAYERS.TOAST`         | `ToastContainer` - visible over modals so results aren't missed |
| `Z_LAYERS.QUICK_ACTIONS` | Command palette - owns the screen, including over toasts        |
| `Z_LAYERS.CENTER_FLASH`  | Momentary ack - always the top-most pixel                       |

Do NOT add a new hard-coded five-digit z-index. If a surface needs to sit above a modal, give it an entry here so the ordering stays reviewable. Note that a z-index only ranks within its stacking context: a portal to `document.body` (toasts, center flash) always compares against the root, while an inline overlay compares against its nearest ancestor that establishes a context.

---

## Center Flash System (rapid temporary notifications)

**Center Flash** is the canonical mechanism for momentary, center-screen acknowledgements of user-initiated actions. It is intentionally distinct from the Toast system - they are **not** interchangeable. Use the decision table below; do not hand-roll a new flash component.

The Center Flash visual is **themed** - every Maestro theme produces a visually distinct flash by default. The card uses the active theme's `bgSidebar` with an accent-tinted overlay; the icon, border, and glow take the resolved color (default: `theme.colors.accent`).

### Decision: Center Flash vs Toast

| You want to...                                                                 | Use                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Confirm a _user-initiated_ action they just took ("Copied", "Saved", "Pinned") | **Center Flash** (default `theme` color)         |
| Surface an _async_ result tied to context (PR posted, export complete, etc.)   | Toast                                            |
| Report an error or failure                                                     | Toast (persistent, dismissable, has icon + body) |
| Show a brief mode-switch indicator ("Bionify: ON")                             | Center Flash (`theme` color)                     |
| Warn the user about something they should read ("Commands disabled")           | Center Flash (`yellow` or `orange` color)        |
| Anything that the user might want to click, navigate from, or dismiss manually | Toast                                            |

**Litmus test:** if the message would still be useful 10 seconds from now, it is a Toast. If the user only needs to see "yep, that happened" before getting on with their work, it is a Center Flash.

### Architecture

```text
src/renderer/stores/centerFlashStore.ts  - Zustand store + notifyCenterFlash() / dismissCenterFlash()
src/renderer/components/CenterFlash/     - <CenterFlash /> component (mounted once in App.tsx via portal)
src/renderer/utils/flashCopiedToClipboard.ts - clipboard-ack helper
src/cli/commands/notify-flash.ts         - `maestro-cli notify flash` command (external trigger)
```

Center Flash is **exclusive** - only one is visible at a time. A new flash replaces the previous one (no queue). The component is mounted once in `App.tsx` next to `<ToastContainer />`; do not mount it locally inside features.

### Firing a flash (in-app)

```typescript
import { notifyCenterFlash } from '../stores/centerFlashStore';

notifyCenterFlash({
	message: 'File Saved', // required, primary line
	detail: '/path/to/file.md', // optional second line, mono font, truncates with title attr
	color: 'theme', // default; matches the active theme. See "Color palette" below.
	duration: 1500, // optional ms; default 1500; 0 = no auto-dismiss
});
```

Convenience helper for the most common case (clipboard acks - always defaults to `color: 'theme'`):

```typescript
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';

flashCopiedToClipboard(value); // "Copied to Clipboard" + value as detail
flashCopiedToClipboard(value, 'Session ID Copied'); // custom title
```

**Always** prefer `flashCopiedToClipboard` for clipboard-success acks so wording, color, and duration stay consistent across the app.

### Firing a flash (external - `maestro-cli`)

```bash
# Default - themed, matches the active Maestro theme. Auto-dismisses after 1.5 s.
maestro-cli notify flash "Build complete"

# Pick an explicit color. One of: green, yellow, orange, red, theme.
maestro-cli notify flash "Tests passed" --color green
maestro-cli notify flash "Production deploy starting" --color orange --detail "v1.42.0"

# Control how long it stays. --timeout is in seconds (max 5).
maestro-cli notify flash "CI failed on main" --color red --timeout 5
```

External integrations should pass `--color` (one of the 5 canonical values) so the flash visibly matches their intent without depending on the user's theme.

**Duration cap:** CLI-triggered flashes are capped at **5 seconds**. The cap is enforced both client-side (CLI rejects values above the limit before sending) and at the IPC boundary in the main process (rejects oversized payloads from any external client). The cap exists so external scripts can't stick a permanent overlay on the user. Internal in-app callers using `notifyCenterFlash()` directly are not capped.

### Color palette (the design language)

These five colors are the **only** colors the Center Flash will ever render. They are deliberately limited so the visual language stays consistent and instantly recognizable across the app and across CLI integrations.

| Color    | Source                          | Icon            | Use for                                                                                                  |
| -------- | ------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `theme`  | `theme.colors.accent`           | `Sparkles`      | **Default.** Themed acknowledgement with no semantic - clipboard acks, mode toggles, quiet confirmations |
| `green`  | `theme.colors.success`          | `Check`         | Explicit success semantic when the user benefits from "yes it worked" coloring (CLI status, test passes) |
| `yellow` | `theme.colors.warning`          | `Info`          | Soft heads-up, not a failure ("Commands disabled", "No unread tabs")                                     |
| `orange` | Fixed `#f97316` (no theme slot) | `AlertTriangle` | More emphatic warning than yellow ("Production deploy starting", "Quota at 90%")                         |
| `red`    | `theme.colors.error`            | `AlertCircle`   | Failure / blocking outcome from a CLI or external trigger (in-app failures usually go to Toast instead)  |

**Why these five?** They cover the full traffic-light range (green → yellow → orange → red) plus a neutral themed default. Adding a sixth color would dilute their meaning. If a use case does not fit, it is probably a Toast, an inline banner, or a modal.

### Visual treatment (do not override)

The component implements one consistent treatment that adapts to color and theme. Do not attempt to restyle it:

- **Themed frosted glass card.** Background = `theme.colors.bgSidebar` + a 135° linear gradient overlay tinted with the resolved color (slightly stronger for `theme` so the theme accent reads clearly). `backdrop-filter: blur(16px) saturate(160%)`.
- **Color-tinted accents.** Icon color, icon's tinted circle, card border, and outer glow all use the resolved color. Each Maestro theme therefore produces a visually distinct flash for the same color value.
- **Color icons** (lucide): see Color palette table. Icon sits in a 36 px tinted circle (`color * 26%` bg, `color * 33%` inner ring).
- **Two-line layout when `detail` is provided.** Semibold title (`textMain`) on top, mono `textDim` detail below (truncated, full value on hover via `title=`).
- **Bottom progress bar** animates from full width to zero over `duration` using the resolved color at 85% opacity.
- **Entrance:** 180 ms scale (0.94 → 1) + fade. **Exit:** 160 ms reverse. No bounce, no spring, no drop-and-fade.
- **Z-index:** `100001` (sits above toasts, below modal-stack overlays). `pointer-events: none` (never blocks input).
- **Theme tokens used:** `bgSidebar`, `textMain`, `textDim`, `border`, plus the resolved color (one of `success`, `warning`, `accent`, `error`, or the fixed orange). No new color tokens needed for flash usage.
- **A11y:** `role="status"`, `aria-live="polite"`, `aria-atomic="true"`. Do not add a close button - flashes are not interactive.

### Duration guidance

- **Default 1500 ms** is correct for almost everything. Do not pass `duration` unless you have a specific reason.
- Use a longer duration (`2500`-`3000`) only for `yellow`/`orange`/`red` flashes with longer messages the user must read.
- Use `duration: 0` (no auto-dismiss) only for the rarest cases - it requires you to call `dismissCenterFlash()` explicitly later, and Center Flash is exclusive, so a non-dismissed flash blocks every subsequent one. **Note:** `0` is rejected for externally-triggered flashes (CLI / web). External callers are also capped at 5000 ms.

### Anti-patterns (do not do these)

- ❌ **Do not** create a new center-screen overlay component. Use `notifyCenterFlash`.
- ❌ **Do not** roll your own `useState` + `setTimeout` for clipboard acks. Use `flashCopiedToClipboard`.
- ❌ **Do not** use `notifyToast` for clipboard-success acks. Use `flashCopiedToClipboard`.
- ❌ **Do not** add a sixth color or override the visual treatment. The five-color palette is the design language - extending it would defeat the purpose.
- ❌ **Do not** add `flashNotification` / `successFlashNotification` state to a store. The legacy `setFlashNotification` and `setSuccessFlashNotification` setters in `uiStore` are compatibility shims that delegate to `notifyCenterFlash`; do not extend them - call `notifyCenterFlash` directly in new code.
- ❌ **Do not** stack flashes (queue them). The system is intentionally exclusive; the latest flash wins.

### Back-compat: legacy `variant` API (in-app only)

The original API used `variant: 'success' | 'info' | 'warning' | 'error'`. It is still accepted **in-app** via `notifyCenterFlash({ variant })` for back-compat, but **deprecated** - new code should use `color`. The CLI flag `--variant` was removed. The mapping is fixed:

| Legacy variant | Maps to color |
| -------------- | ------------- |
| `success`      | `green`       |
| `info`         | `theme`       |
| `warning`      | `yellow`      |
| `error`        | `red`         |

Pre-existing call sites using `setFlashNotification` / `setSuccessFlashNotification` (via `uiStore` or via `showFlashNotification` / `showSuccessFlash` in `useAgentExecution`) continue to work - they fire `notifyCenterFlash` with `color: 'yellow'` and `color: 'theme'` respectively under the hood.

---

## Shared Components

### `<Modal>` (`src/renderer/components/ui/Modal.tsx`)

Full-featured modal wrapper. See Modal System section above.

### `<ModalFooter>` (`src/renderer/components/ui/Modal.tsx`)

Standard cancel/confirm button layout:

```tsx
<ModalFooter
	theme={theme}
	onCancel={handleClose}
	onConfirm={handleSubmit}
	confirmLabel="Delete"
	destructive={true} // red confirm button
	confirmDisabled={!canDelete}
	showCancel={true}
/>
```

### `<CornerDot>` (`src/renderer/components/ui/CornerDot.tsx`)

The small pip pinned to the corner of something else: the red unread dot over a
status dot, the accent dot over the Bell filter, the pulsing dot over the Group
Chats count badge. Render it inside a `relative` parent. Do NOT hand-roll
another `absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full` - there were
four copies and they had already drifted on size and offset.

```tsx
<div className="relative">
	<StatusDot />
	{hasUnread && <CornerDot color={theme.colors.error} title="Unread messages" />}
</div>
```

- `size` - `'sm'` (6px) over a status dot or small icon, `'md'` (8px) to read against a filled badge.
- `placement` - `'top-right'` (default) or `'right'` for parents too short to have a usable corner.
- `pulse` - live activity. Steady means "waiting for you".
- `ringColor` - pass the surface color (e.g. `theme.colors.bgSidebar`) when the dot sits on a filled parent.
- `title` - gives both a hover tooltip and an accessible name. Without one the dot is `aria-hidden`,
  since it usually just repeats what its parent already says. The dot is deliberately NOT
  `pointer-events-none` (that kills the tooltip); clicks bubble to the parent.

### `<FontScaleControl>` (`src/renderer/components/ui/FontScaleControl.tsx`)

Decrease / reset / increase font zoom for a reading pane. Pair it with
`useFontScale(storageKey)` (`src/renderer/hooks/ui/useFontScale.ts`), which owns
the value, the clamping (0.7 - 2.0, rounded to two decimals so no
`calc(0.875rem * 1.0000000000000002)` reaches the DOM) and the localStorage
persistence. Do NOT hand-roll another pair of `AArrowUp` / `AArrowDown` buttons.

```tsx
const fontScale = useFontScale('filePreview.fontScale');
<FontScaleControl
	theme={theme}
	control={fontScale}
	variant="floating"
	collapsible
	target="preview"
/>;
```

- `variant="inline"` - bordered squares for a toolbar or stats bar (Director's Notes).
- `variant="floating"` - frosted pill for overlaying a scrolling pane (file preview,
  pinned top-right as the mirror of the Table of Contents button at bottom-right).
- `collapsible` (floating only) - rests as a circle the size of that Table of Contents
  button and expands to the full pill on hover or keyboard focus. The buttons are
  CLIPPED, not unmounted, so tabbing into them opens the pill instead of skipping a
  control the user cannot see. The resting circle tints itself with the theme accent
  while the scale is not 100%, so the collapsed state still says the pane is zoomed.
- The percentage in the middle appears only once zoomed and doubles as the reset.
- The file preview also binds bare `-` / `+` (and `=` / `_`) to the two steps and `0`
  to the reset, guarded on `canScaleFontForView()` and on `isTextInputTarget(e.target)`
  so the find bar and the CM6 editor keep their keys.

**Only render it where the zoom moves type.** A control that changes nothing reads
as broken: Director's Notes hides it in Rich Mode (fixed-size widget chrome), and
the file preview gates it on `canScaleFontForView()` in `filePreviewUtils.ts`
(images, binary card, rendered HTML iframe, Mermaid, CSV / JSONL tables opt out).
Applying the scale is per-surface: prose reads `--fp-font-scale` from the scroll
container, the CM6 panes take a `fontScale` prop that rides in the theme, and the
Fast text tier must scale its fixed virtualizer page height by the same number or
the pages overlap.

### `<FormInput>` (`src/renderer/components/ui/FormInput.tsx`)

Themed form input with label, validation, and Enter-to-submit:

```tsx
<FormInput
	theme={theme}
	label="Agent Name"
	value={name}
	onChange={setName}
	onSubmit={handleSave}
	placeholder="Enter name..."
	error={validationError}
	helperText="Used in the Left Bar"
	monospace={false}
	autoFocus={true}
	selectOnFocus={true}
	addon={<button>Browse</button>}
/>
```

Key features:

- Ref forwarding for focus management
- Built-in Enter key handling with `submitEnabled` guard
- Error state changes border color to `theme.colors.error`
- Auto-generated `id` for label association (accessibility)

### `<ToggleSwitch>` (`src/renderer/components/ui/ToggleSwitch.tsx`)

The themed pill toggle. Use it instead of hand-rolling the
`relative w-10 h-5 rounded-full` + `translate-x-5` button - that markup was
copy-pasted across the bundled command panels and drifted (some copies lost
`title`, some lost `aria-checked`):

```tsx
<ToggleSwitch
	checked={enabled}
	onChange={onEnabledChange}
	theme={theme}
	ariaLabel="Show Spec Kit commands in slash command autocomplete"
	title={enabled ? 'Hide from slash command autocomplete' : 'Show in slash command autocomplete'}
/>
```

Renders `role="switch"` with `aria-checked`, so tests select it with
`getByRole('switch', { name: ... })`. For a full labeled settings row with icon,
section label, and description, use `<SettingCheckbox>` below instead.

### `<CollapsedCommandsNotice>` (`src/renderer/components/ui/CollapsedCommandsNotice.tsx`)

Placeholder shown in place of a disabled command section's list (Spec Kit,
OpenSpec, BMAD). Turning a section off collapses its commands out of view, but
they stay reachable for editing behind "Show anyway":

```tsx
{
	!enabled && commands.length > 0 && (
		<CollapsedCommandsNotice
			theme={theme}
			count={commands.length}
			expanded={revealWhileDisabled}
			onToggle={() => setRevealWhileDisabled((prev) => !prev)}
			sectionName="Spec Kit"
		/>
	);
}
```

Panels pair it with a `revealWhileDisabled` state that resets in a
`useEffect` on `enabled`, so re-disabling a section always re-collapses the list.

### `<ErrorBoundary>` (`src/renderer/components/ErrorBoundary.tsx`)

React error boundary that catches render errors, reports to Sentry, and shows a recovery UI:

```tsx
<ErrorBoundary fallbackComponent={<CustomError />} onReset={() => resetState()}>
	<RiskyComponent />
</ErrorBoundary>
```

Default fallback shows error details, component stack trace, and "Try Again" / "Reload App" buttons. Reports to Sentry via `Sentry.captureException`.

### `<Markdown>` (`src/renderer/components/Markdown/`)

The single, unified react-markdown renderer for the desktop app. Pick a `preset`
instead of wiring `react-markdown` by hand:

```tsx
import { Markdown } from '../Markdown';

<Markdown preset="document" theme={theme} content={md} onExternalLinkClick={openUrl} />;
```

Presets:

- **`chat`** - richest surface (AI Terminal, Group Chat, History, Feedback,
  Director's Notes, Document Graph). Shiki code fences with copy button + language
  picker, file links via `remarkFileLinks`, right-click link/file/image context
  menus (images and diagrams get their Copy/Save menu app-wide from
  `ImageContextMenuHost`, not from this preset), IPC-loaded local images, chat line
  breaks + KaTeX math, Bionify, raw-HTML + DOMPurify. `MarkdownRenderer` is a thin
  wrapper around `<Markdown preset="chat">`.
- **`document`** - file/doc preview. Prism highlighting, search highlight, anchor
  (`#`) links, pluggable `imageRenderer`, `customLanguageRenderers` (mermaid),
  `extraRemark/RehypePlugins`. Renders bare so callers keep their own scoped prose
  container. Pass `frontmatter={false}` for GFM-only surfaces.
  Also draws Auto Run marker pills (`autorunMarkers`, on for this preset only) -
  see [Auto Run Marker Pills](#auto-run-marker-pills) below.
- **`wizard-bubble`** / **`release-notes`** - minimal, tightly-styled presets.

Shared internals (do NOT re-implement): plugin selection lives in
`Markdown/plugins.ts` (`buildMarkdownPlugins`), text preprocessing in
`Markdown/preprocess.ts` (`preprocessMarkdown`, `fixMarkdownLinkSpaces`), and the
leaf renderers in `Markdown/components/*` (`MarkdownLink`, `InlineCode`,
`HexSwatch`, `ShikiCodeBlock`, `PrismCodeBlock`, `LocalImage`). The document
component map is `createMarkdownComponents()` in `utils/markdownConfig.ts`, which
`<Markdown preset="document">` uses internally. A few advanced surfaces (AutoRun's
keystroke-memoized preview, FilePreview's tier selection + from-tree image
resolution, the Wizard DocumentEditor) consume `createMarkdownComponents()`
directly rather than the shell, but share the same leaf implementation.

#### Auto Run marker pills

`MAESTRO:HITL`, `maestro:halt`, and `MAESTRO:MODEL` are HTML comments, so they
render as NOTHING - and two of them silently block the next run (a live gate
pauses it, a halt makes Auto Run refuse to start). That presents to the user as
"I pressed Run and nothing happened", with the cause in text no surface draws.
`remarkMaestroMarkers` (`components/Markdown/remarkMaestroMarkers.ts`) rewrites
each marker node into a tagged element that `createMarkdownComponents()` renders
as `<MarkerPill>`.

Two things to know before touching it:

- **It is opt-in per surface, and deliberately off for chat.** `<Markdown>` sets
  `autorunMarkers` from `preset === 'document'`. A chat message that explains the
  syntax is DESCRIBING a marker, not configuring one, so a pill there would
  assert a setting that does not exist. Chat also builds its own component map,
  which is the second half of that guarantee.
- **The three surfaces that consume `createMarkdownComponents()` directly must
  add the plugin themselves** - `FilePreview`, AutoRun's `useAutoRunMarkdown`,
  and the Wizard `DocumentEditor` all do, because they assemble their own remark
  list rather than going through the shell. Miss it on a new direct consumer and
  the markers silently go back to rendering as nothing on that surface only.

The pill shows STATUS (`live` / `spent` / `invalid`), not presence: a gate above
an unchecked task and one above a checked task differ by a character in the
source, and only the first stops the run. Status resolution lives in
`scanMaestroMarkers()` (`src/shared/autorunMarkers.ts`) alongside the engines'
own `findPendingHitlGate()` / `detectHaltMarker()`, so the pill and the engine
cannot disagree about what is live.

#### Clickable task checkboxes

react-markdown renders every GFM checkbox `disabled`, so a rendered preview is
read-only by default even though the prose styles give the box a pointer cursor.
Three pieces make one clickable, and they are shared - do NOT rebuild any of
them per surface:

- `rehypeSourceLine` (`components/Markdown/rehypeSourceLine.ts`) in the caller's
  rehype plugins. It stamps each box with the 1-based line its `- [ ]` marker
  lives on. The box itself is synthesized during mdast -> hast and carries no
  position, so it inherits its list item's line.
- `onTaskToggle: (line) => Promise<boolean>` passed to
  `createMarkdownComponents()`. It swaps in `<TaskCheckbox>`
  (`components/Markdown/components/TaskCheckbox.tsx`), which owns the optimistic
  flip; resolve `false` and the box reverts. Omit the option and the read-only
  behavior is unchanged.
- `toggleTaskCheckboxAtLine()` (`utils/markdownTasks.ts`) to rewrite the source.
  It preserves indentation, bullet style, and CRLF endings, and returns `null`
  for a line with no task marker so a stale render cannot corrupt the file.

Do NOT count checkboxes in the DOM and map them onto the Nth task line: that
drifts the moment a `- [ ]` appears inside a code fence. The file preview and
the Auto Run panel both ride this path; Auto Run drops the callback while a
document is locked by a running Auto Run, matching its disabled editor.

**The toggle handler MUST have a stable identity.** `createMarkdownComponents()`
returns a map of freshly-created component functions, so anything that rebuilds
that map hands React a NEW component TYPE for every element and it unmounts and
remounts the whole rendered document - throwing away the reader's scroll
position, restarting images, and re-running Mermaid. A toggle handler naturally
closes over the document content, so an ordinary `useCallback` is reborn on
every edit and does exactly that. Wrap it in `useStableCallback()`
(`hooks/utils/useStableCallback.ts`) and keep the component memo's dependencies
off the content (depend on `file.path`, not `file`). `useAutoRunMarkdown` does
the wrapping internally, so its callers cannot get this wrong.

#### Preview/edit scroll sync rides the same `data-source-line` tags

`rehypeSourceLine` stamps EVERY block, not just task checkboxes, and the second
consumer is `lineSync.ts` (`components/FilePreview/lineSync.ts`):
`domGetTopLineByAttr()` reads the tags to find the source line at the fold so
the preview -> edit toggle lands where the reader was, and
`domScrollToLineByAttr()` walks them back the other way.

**A component override in `createMarkdownComponents()` must forward its props.**
`p`, `li`, and `blockquote` were written as
`React.createElement('p', null, children)`, which silently eats
`data-source-line` along with everything else. Headings forwarded theirs, so the
tags did not disappear - they thinned out to HEADINGS ONLY, and the walk could
no longer tell "the top of the document" from "the first heading". Destructure
`node` out (it is react-markdown's mdast node and React warns if it reaches the
DOM) and spread the rest.

**"Above the first tagged block" is line 1, not the first block's line.** The
container's own leading padding puts even block one below the fold at
`scrollTop` 0, so a `blocks[0]` fallback answers with the first block for a
document scrolled to the very top. `domScrollToLineByAttr()` is the mirror
image: for a line at or above the first block it writes a hard
`scrollTop = 0` rather than aligning block one with the scroller edge, which
would scroll that same padding away and land a few pixels short.

#### Alert callouts

`[!NOTE]`-style callouts need a plugin AND a blockquote renderer. `remarkAlert`
(`components/Markdown/remarkAlert.ts`) tags the blockquote with
`markdown-alert-<type>`; `alertTypeFromClassName()` reads it back and the
blockquote delegates to `<AlertCallout>`. `<Markdown>` wires both automatically
(`alerts: true`); surfaces that assemble their own remark stack must push
`remarkAlert` right after GFM and before `remark-breaks`, or the marker stays
literal text. Labels, accents, and icon geometry live in
`components/Markdown/alertMeta.ts` so the React callout and the File Preview
Fast tier (which emits HTML strings via `markdownFast/alertTagger.ts`) cannot
drift.

Separate engines, intentionally not part of `<Markdown>`: `MarkdownPreviewFast`
(markdown-it, virtualized for 64KB+ files) and `MobileMarkdownRenderer` (web
bundle, no IPC).

### `<SettingCheckbox>` (`src/renderer/components/SettingCheckbox.tsx`)

Toggle switch with icon, section label, title, and description:

```tsx
<SettingCheckbox
	icon={Bell}
	sectionLabel="Notifications"
	title="OS Notifications"
	description="Show desktop notifications when tasks complete"
	checked={osNotificationsEnabled}
	onChange={setOsNotificationsEnabled}
	theme={theme}
/>
```

### `<ToastContainer>` (`src/renderer/components/Toast.tsx`)

Portal-rendered toast notification stack. Rendered in `App.tsx`:

```tsx
<ToastContainer theme={theme} onSessionClick={handleSessionClick} />
```

### `<EnvVarList>` (`src/renderer/components/ui/EnvVarList.tsx`)

Read-only view of an agent's **effective** environment: the merged result of all
three layers, each row badged with the layer whose value won.

```tsx
<EnvVarList
	theme={theme}
	vars={resolveAgentEnvironment({ global, agent, session })}
	emptyMessage={`No environment variables are set for ${session.name}.`}
	testId="reauth-env"
/>
```

Feed it from `resolveAgentEnvironment()` in `src/shared/agentEnvironment.ts` (see
[SHARED-UTILS.md](SHARED-UTILS.md)) rather than merging the layers at the call
site, or the panel drifts from what the spawner actually built.

**Not the same component as `Settings/EnvVarsEditor`**, which edits ONE layer.
Pick by question: "change a value" is the editor, "which profile am I running
as?" is this. Do not add an edit mode to this one to cover both.

Credential-shaped keys are masked behind a per-row reveal, decided by
`isSecretEnvKey()`. This is deliberately loose - the surfaces that show an
environment are diagnostic ones people open while screen-sharing for help, so a
false positive costs one click and a false negative leaks a live key.

---

## Line Numbers on a `<textarea>` (`TextareaLineNumbers`)

`src/renderer/components/ui/TextareaLineNumbers.tsx` is the one gutter. A
textarea has none of its own, so the numbers live in an overlay, and the naive
"one `<div>` per line" version gets two things wrong that this component owns:

- **Scroll.** The textarea scrolls its own content, so the gutter is translated
  by the same `scrollTop`. It is written straight to the DOM in a `scroll`
  listener rather than through state, so a fast scroll cannot lag a frame behind
  the text it labels.
- **Soft wrap.** A prose line that wraps onto three visual rows is three rows
  tall in the textarea but one entry in the gutter. Each logical line is measured
  against a hidden mirror that copies the textarea's font, wrap width, and
  wrapping rules, so number N always sits on the first visual row of line N.

Render it inside a `position: relative` wrapper that also holds the textarea, and
push the text clear of the digits with `lineNumberGutterMetrics(value)`:

```tsx
const metrics = lineNumberGutterMetrics(value);
<div className="relative w-full h-full">
	<TextareaLineNumbers textareaRef={ref} value={value} theme={theme} />
	<textarea ref={ref} value={value} style={{ paddingLeft: metrics.textPaddingLeft }} />
</div>;
```

The metrics are in `ch` units and reserve a minimum of two digits, so the editor
does not reflow the first time the document reaches line 10, and the gutter
scales with the monospace font instead of a hard-coded pixel guess. Both callers
ride it: the Cue YAML editor and the Auto Run expanded modal (`showLineNumbers`,
which the docked Auto Run panel leaves off because it has no room for a gutter).

Do NOT hand-roll another `value.split('\n').map((_, i) => <div>{i + 1}</div>)`
gutter. That is what the YAML editor had, and it drifted out of alignment the
moment the file was taller than the box or any line wrapped.

jsdom has no layout engine and no `ResizeObserver`, so under test the gutter
renders with natural row heights rather than measured ones. That is deliberate,
not a polyfill gap - assert on the numbers and the transform, not on pixel
heights.

---

## Collapsible Advisories (`AutoRunNoticeBanner`, `usePersistedToggle`)

A banner that recurs on every qualifying document is an advisory, not an event:
the author reads it once, then wants the space back. `AutoRunNoticeBanner`
takes an optional `collapseKey`, which turns its heading into a disclosure
button (chevron + title, `aria-expanded`/`aria-controls`) and folds the body and
actions away. The Auto Run human-step warning uses it; the paused-run error
banner deliberately does not, because that one describes a one-off event the
user must act on.

`usePersistedToggle(storageKey, defaultValue)` in
`src/renderer/hooks/ui/usePersistedToggle.ts` is the state behind it: one
boolean in localStorage, storage failures degrade to in-memory only. Reach for
it for any view preference a user sets by clicking that must survive the
surface unmounting (a Right Bar tab switch, a re-render from new data) but is
not worth a Settings row. Do NOT hand-roll another
`useState(() => localStorage.getItem(...) === 'true')` pair - the collapse would
reset every time the panel re-rendered, which reads as the banner refusing to
stay closed.

---

## Right-Click Image Menu (`ImageContextMenuHost`)

Every image anywhere in the app - raster `<img>`, agent-authored inline `<svg>`, Mermaid charts, thumbnails, the lightbox - gets the same three actions on right-click: **Copy Image**, **Save to Project...**, and **Save As...**.

**Surfaces wire up nothing.** `<ImageContextMenuHost>` is mounted once in `App.tsx` and owns a single delegated `contextmenu` listener on the document that resolves the image from the click target. Do NOT add an `onContextMenu` to a new image surface, do not call a hook, and do not add a per-surface copy/save button pair. There is no per-surface wiring to forget, which is the entire point: the menu used to hang off individual components, so every new image surface silently shipped without it.

- `resolveImageFromEvent(e)` (exported from `ImageContextMenuHost.tsx`) decides what counts. It skips three things: anything inside a `[data-no-image-menu]` subtree, lucide icons (which are `<svg>` but carry the `lucide` class), and anything under 32px rendered (favicons, inline badges).
- **Opting a surface out:** put `data-no-image-menu` on its container. Use this only when the surface owns its own right-click behavior (e.g. `AnnotatorCanvas`). A menu that already handled the click and called `preventDefault()` is skipped automatically via `defaultPrevented` - that is how `LinkContextMenu` / `FileContextMenu` coexist with this one.
- `utils/imageExport.ts` does the work: `copyImageElementToClipboard()` returns `'image' | 'text' | 'failed'` so the UI can admit when only markup or a URL reached the clipboard rather than claiming a paste-able image. `saveImageToProject()` writes into the project's `DIAGRAMS_DIR` (`.maestro/diagrams/`) and works over SSH; `saveImageElementToDisk()` is the native-dialog path. Binary writes go through `fs.writeImageFile` (`fs.writeFile` is UTF-8 and would corrupt the bytes).
- `ImageDestinationModal` is the "Save to Project..." destination picker (folder, file name, SVG/PNG format, live path preview). Not to be confused with `FilePreview/ImageSaveModal`, which is the annotator's overwrite-vs-save-as prompt.

`serializeSvg()` stamps the measured size onto the clone when the source has none. Mermaid sizes charts with CSS (`width="100%"`), and without this the rasterized copy comes out cropped at the browser's 300x150 default.

---

## Menu / Popover Sizing - Use rem, Not px

The user's font-size setting (`useSettings.ts` writes `document.documentElement.style.fontSize`) scales **everything sized in `rem`** (including Tailwind's `text-xs`/`text-sm` etc.) but **not values in `px`**. If a context menu, dropdown, or tab overlay menu uses `minWidth: '160px'`, the text grows with the user's font setting but the container does not - so labels like "Create New Group" wrap onto two lines at larger sizes.

**Two-part rule:**

1. **Express dimensions in rem.** For any popover / menu / overlay that contains text content, write `minWidth`, `maxWidth`, and `maxHeight` in **rem** (or `em`), not `px`. Conversion: `Npx → (N/16)rem` (160px → 10rem, 200px → 12.5rem, 220px → 13.75rem, 280px → 17.5rem, 320px → 20rem).
2. **Add `whitespace-nowrap` to the menu container.** `minWidth` only sets a lower bound - the container won't actually grow past it unless its content forces it to. By default, long text labels (e.g., "Create New Group") will wrap onto multiple lines instead of pushing the container wider. Putting `whitespace-nowrap` on the menu's outermost container makes labels stay on one line and the container expand to fit them.

The two rules work together: rem keeps the minimum sized correctly across font scales, and `whitespace-nowrap` lets the container grow when individual labels need more room than the minimum allows. Skip rule 2 only when the popover has a `maxWidth` that is intentionally truncating long content (e.g., `BrowserTabItem` clamps URL display with `truncate`).

Existing canonical sites already follow this - see `SessionContextMenu.tsx`, `NodeContextMenu.tsx` (`DocumentGraph/`), `PipelineContextMenu.tsx` (`CuePipelineEditor/`), `FileContextMenu.tsx`, `LinkContextMenu.tsx`, `TerminalSelectionContextMenu.tsx`, `TabBar/AITabOverlayMenu.tsx`, `TabBar/FileTab.tsx`, `TabBar/TerminalTabItem.tsx`, `TabBar/BrowserTabItem.tsx`, `TemplateAutocompleteDropdown.tsx`. When adding a new menu/popover, match this convention so it grows with the user's font size.

This rule applies to **content containers** sized to wrap text. It does NOT apply to layout primitives where px is intentional (icon dimensions, fixed-pixel borders, scrollbar widths, viewport-relative positioning).

---

## Left Bar Header Width Gates

The Left Bar header is a single row that neither wraps nor scrolls, and the user can drag the sidebar down to 256px. Every control added to it (the badge pill, the now-playing pill, the LIVE toggle) takes room from a fixed budget, so the row needs a declared yield order rather than whatever CSS happens to shrink first.

**The MAESTRO wordmark is drawn in full or not at all.** It used to carry `truncate`, which rendered the brand as "MAE..." on a narrow sidebar. A clipped brand reads as a rendering bug, not as a deliberate space saving, so `SessionList` gates it on a width instead:

```ts
const showWordmark =
	leftSidebarWidthState >=
	WORDMARK_MIN_WIDTH + livePillReserve + headerBadgeWidth + nowPlayingReserve;
```

The wand button stays at every width, so the header never loses its identity or its switch-agent affordance.

**The now-playing pill is the row's shrink target of last resort.** Something has to yield, and the filename inside that pill is the only thing in the row that can be clipped without looking broken. It is therefore `min-w-0` rather than `shrink-0` (a flex item defaults to `min-width: auto` and refuses to go below its content, so both the pill and the button inside it need `min-w-0`), while both transport buttons, both icons, and the divider stay `shrink-0` - they are the entire transport a minimized player has.

Two rules for adding a control here:

- **Reserve for the form the control is actually in, not its widest form.** The now-playing pill sheds its filename below `NOW_PLAYING_LABEL_MIN_WIDTH`, so `NOW_PLAYING_COMPACT_RESERVE` and `NOW_PLAYING_LABEL_RESERVE` are separate numbers. Reserving the wide figure at every width hides the wordmark to make room for a pill that is no longer that wide.
- **Ask the store whether the control is on screen, once.** `selectNowPlayingVisible` in `mediaPlaybackStore` answers that for the pill, and both the pill and the header's reserve read it. Two copies of "is it visible" is how a width reserve ends up describing a header nobody is looking at.

Testing this drives `leftSidebarWidth` in `useSettingsStore` directly, the same way the LIVE-pill tests do; jsdom measures nothing, so a real-layout test is not available. Assert the wordmark's ABSENCE at narrow widths, not that `truncate` is gone - the latter passes on a wordmark that still renders clipped.

---

## Tab System

Each agent supports multiple AI tabs within its workspace. Tab management hooks live in `src/renderer/hooks/tabs/`.

### Tab Shortcuts

Defined in `TAB_SHORTCUTS` constant. Key bindings:

- `Cmd+T` - New tab
- `Cmd+W` - Close tab
- `Cmd+1-9` - Jump to tab N
- `Cmd+0` - Jump to last tab
- `Cmd+Shift+[`/`]` - Previous/next tab
- `Alt+Cmd+T` - Tab switcher modal
- `Cmd+Shift+T` - Reopen closed tab
- `Cmd+Shift+R` - Rename tab
- `Cmd+R` - Toggle read-only mode
- `Cmd+S` - Toggle save to history

### Tab State

Each tab has an `AITab` type with:

- `id`, `name`, `agentSessionId`
- `starred`, `readOnlyMode`, `saveToHistory`
- `inputValue`, `logs`, `usageStats`
- `wizardState` (for inline wizard sessions)
- `thinkingStartTime`, `showThinking`

### Tab Handlers

`useTabHandlers` (`src/renderer/hooks/tabs/useTabHandlers.ts`) returns a large `TabHandlersReturn` object covering both AI/terminal tabs and file-preview tabs. The main handlers are:

**AI/terminal tab handlers:**

- `handleNewTab()` - create a new AI tab
- `handleTabSelect(tabId)` - switch active tab
- `handleTabClose(tabId)` - close a tab
- `handleCloseAllTabs()` - close every AI tab
- `handleCloseOtherTabs()` - close all except active
- `handleCloseTabsLeft()` / `handleCloseTabsRight()` - close tabs on one side of active
- `handleCloseCurrentTab()` - returns `CloseCurrentTabResult` indicating which tab type was closed
- `handleTabReorder(fromIndex, toIndex)` - reorder AI tabs
- `handleUnifiedTabReorder(fromIndex, toIndex)` - reorder the unified tab bar (mixes AI, file, browser, terminal)
- `handleRequestTabRename(tabId)` - open rename modal
- `handleTabStar(tabId, starred)` - pin/unpin
- `handleTabMarkUnread(tabId)` - mark unread
- `handleToggleTabReadOnlyMode()` / `handleToggleTabSaveToHistory()` / `handleToggleTabShowThinking()` - per-tab toggles

**File-preview tab handlers:**

- `handleOpenFileTab(params)` - open a file preview
- `handleSelectFileTab(tabId)` / `handleCloseFileTab(tabId)` - file tab lifecycle
- `handleFileTabEditModeChange(tabId, editMode)` / `handleFileTabEditContentChange(tabId, content)` - edit mode state
- `handleFileTabScrollPositionChange(tabId, scrollTop)` / `handleFileTabSearchQueryChange(tabId, query)` - per-tab scroll/search state
- `handleReloadFileTab(tabId)` - reload file from disk
- `handleFileTabNavigateBack()` / `handleFileTabNavigateForward()` - per-file-tab navigation history

The hook also returns selectors: `activeTab`, `unifiedTabs`, `activeFileTab`, `activeBrowserTab`, and the file-tab history state (`fileTabBackHistory`, `fileTabForwardHistory`, `fileTabCanGoBack`, `fileTabCanGoForward`).

---

## Encore Features

Encore features are optional features disabled by default, gated behind the `EncoreFeatureFlags` interface:

```typescript
interface EncoreFeatureFlags {
	directorNotes: boolean;
	usageStats: boolean;
	symphony: boolean;
	maestroCue: boolean;
}
```

### Adding a New Encore Feature

1. Add the flag to `EncoreFeatureFlags` in `src/renderer/types/index.ts`
2. Add default value in `useSettings.ts` state
3. Add toggle UI in `SettingsModal.tsx` (Encore Features section)
4. Gate the feature in `App.tsx` and keyboard handler:

```tsx
const { encoreFeatures } = useSettings();

// In component render:
{encoreFeatures.symphony && <SymphonyModal ... />}

// In keyboard handler:
if (ctx.encoreFeatures.symphony && ctx.isShortcut('openSymphony', e)) {
	ctx.setSymphonyModalOpen(true);
}
```

---

## Settings Pattern

### Architecture

```text
src/renderer/hooks/settings/useSettings.ts   - Hook adapter over Zustand store
src/renderer/stores/settingsStore.ts         - Zustand store (source of truth)
src/main/index.ts                            - IPC handlers for persistence
```

### How Settings Work

1. `useSettings()` returns a `UseSettingsReturn` object with getter/setter pairs for every setting.
2. Setters call `window.maestro.settings.set(key, value)` to persist to Electron Store.
3. On mount, `loadAllSettings()` reads all settings via `window.maestro.settings.getAll()`.
4. On system resume from sleep, settings are reloaded automatically.

### Adding a New Setting

1. Add the field and setter to `UseSettingsReturn` in `src/renderer/hooks/settings/useSettings.ts`
2. Add state and action to `settingsStore.ts`
3. Add IPC handler in `src/main/index.ts` for `settings.get` / `settings.set`
4. Add UI control in the appropriate Settings tab

### Setting Categories

The `UseSettingsReturn` interface groups settings by domain:

- **Conductor Profile** - user's "about me" for AI context
- **LLM** - provider, model slug, API key
- **Shell** - default shell, custom path, args, env vars
- **Font** - family, size (applied to document root for rem scaling)
- **UI** - theme, sidebar widths, enter-to-send, markdown mode, auto-scroll
- **Notifications** - OS notifications, audio feedback, toast duration
- **Updates** - check on startup, beta channel
- **Shortcuts** - editable and tab shortcut maps
- **Custom AI Commands** - user-defined slash commands
- **Stats** - auto-run stats, usage stats, keyboard mastery
- **Onboarding** - tour/wizard completion state
- **Context Management** - auto-grooming settings
- **Encore Features** - optional feature flags
- **Accessibility** - colorblind mode
- **Power Management** - prevent sleep during runs

---

## State Management (Zustand Stores)

Maestro uses Zustand stores as the primary state management solution. Located in `src/renderer/stores/`:

| Store               | Purpose                                |
| ------------------- | -------------------------------------- |
| `settingsStore`     | All user preferences and configuration |
| `sessionStore`      | Agent sessions and active session      |
| `tabStore`          | Tab state per session                  |
| `agentStore`        | Agent detection and capabilities       |
| `batchStore`        | Auto Run batch processing state        |
| `groupChatStore`    | Group chat sessions                    |
| `fileExplorerStore` | File tree state                        |
| `modalStore`        | Modal open/close flags                 |
| `notificationStore` | Toast queue and config                 |
| `operationStore`    | Long-running operation tracking        |
| `uiStore`           | Transient UI state (focus, sidebar)    |

### Store Access Patterns

**Inside React:**

```tsx
const sessions = useSessionStore((s) => s.sessions);
const addSession = useSessionStore((s) => s.addSession);
```

**Outside React (services, orchestrators):**

```typescript
const state = useSessionStore.getState();
state.addSession(newSession);
```

### Store Reset in Tests

Zustand stores are singletons. Reset between tests:

```typescript
beforeEach(() => {
	useSettingsStore.setState({
		/* initial state */
	});
});
```

### The Record View for a Table Row (`<RecordDetailModal>`)

`<RecordDetailModal>` in `src/renderer/components/ui/RecordDetailModal.tsx` flips one row of a table into a field/value list: one field per line, values wrapped with their newlines intact, a field filter, prev/next row navigation, and a per-value copy button.

Every tabular preview uses it. `CsvRowDetailModal` is a thin adapter that maps a positional CSV row onto the field list; the parquet viewer maps typed cells through `formatCellExact`. Do NOT hand-roll a second one - the keyboard model here is subtle and easy to get subtly wrong.

Callers supply their own `priority` (a `MODAL_PRIORITIES` entry), `resizeKey` (so each surface remembers its own dragged size), and `testIdPrefix` (so a test can target the surface it opened rather than "whichever record modal is up"). The `fields` prop is the only shape all callers agree on: a CSV row is positional strings and a parquet row is typed values, so the mapping belongs in the caller, not in a union type here.

**Focus starts on the field list, not the filter input.** Left/Right step between rows and Up/Down scroll, and none of that works while a text input owns the caret - `/` is what moves focus to the filter. Escape is deliberately NOT handled locally: the layer stack takes it at capture on `window`, so "Escape clears the filter first" is not implementable here and Escape closing the modal is the app-wide contract anyway.

### The Parquet Viewer (`src/renderer/components/ParquetViewer/`)

The file preview for `.parquet`. Unlike every other preview it is a **client of a query engine**, not a renderer over file content: the file stays open in the main process and only the displayed window of rows crosses IPC. See [Parquet Preview](#parquet-preview-srcmainparquet) in AGENT-INFRA for the engine side.

Three rules for editing it:

- **Never filter or sort locally.** Both round-trip to the engine. Filtering the loaded page would only ever search the first few hundred rows, which on a 100M-row file is a search box that lies.
- **`matchedRows` is a lower bound until `complete` is true.** Render it as `1,204+`, never as an exact total. A filtered scan stops as soon as it has filled the requested window; a background pass with `countAll: true` converges the number, and that pass is also what warms the scan for the next page.
- **Hiding a column changes the projection.** It is a real optimization (the engine stops decoding that column), not a CSS toggle, which is why it invalidates the loaded window.

The grid virtualizes with `@tanstack/react-virtual`. **Its "load the next page" effect must not fire for an unmeasured grid**: with no layout, the virtualizer renders a default window and the last rendered index looks like the end of the data, so the viewer pages the entire match set into memory without the user ever scrolling. `ParquetGrid` guards on `scrollRef.current?.clientHeight` and treats "no rendered rows" as `-1` rather than `0` for exactly this reason. jsdom has no layout engine, so this is the failure mode a render test will catch and a manual pass never will.

Column widths are explicit state seeded from each column's type, not measured. Measuring needs cells, cells arrive one page at a time, and a width that jumps when page two lands is worse than one that is merely approximate.

---

## Key Files Reference

| Pattern           | Primary Files                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Layer stack       | `src/renderer/hooks/ui/useLayerStack.ts`, `src/renderer/contexts/LayerStackContext.tsx`                     |
| Modal layer       | `src/renderer/hooks/ui/useModalLayer.ts`                                                                    |
| Modal component   | `src/renderer/components/ui/Modal.tsx`                                                                      |
| Modal priorities  | `src/renderer/constants/modalPriorities.ts`                                                                 |
| Layer types       | `src/renderer/types/layer.ts`                                                                               |
| Theme definitions | `src/shared/themes.ts`, `src/shared/theme-types.ts`                                                         |
| Shortcuts         | `src/renderer/constants/shortcuts.ts`                                                                       |
| Keyboard handler  | `src/renderer/hooks/keyboard/useMainKeyboardHandler.ts`                                                     |
| Notifications     | `src/renderer/stores/notificationStore.ts`, `src/renderer/components/Toast.tsx`                             |
| Form components   | `src/renderer/components/ui/FormInput.tsx`, `src/renderer/components/ui/Modal.tsx`                          |
| Error boundary    | `src/renderer/components/ErrorBoundary.tsx`                                                                 |
| Markdown renderer | `src/renderer/components/Markdown/` (`<Markdown preset=...>`; `MarkdownRenderer.tsx` wraps the chat preset) |
| Settings hook     | `src/renderer/hooks/settings/useSettings.ts`                                                                |
| Settings store    | `src/renderer/stores/settingsStore.ts`                                                                      |
| Record view       | `src/renderer/components/ui/RecordDetailModal.tsx`                                                          |
| Parquet viewer    | `src/renderer/components/ParquetViewer/`                                                                    |

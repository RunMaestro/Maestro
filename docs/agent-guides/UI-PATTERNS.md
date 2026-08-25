<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# UI Patterns

Shared UI patterns, component library, and design system conventions for the Maestro renderer.

---

## Every Surface Needs Three Ways In and Two Ways Out

A dashboard, modal, or panel the user is meant to open is not finished until all
of these exist. This is not a style preference: a surface with one entry point is
a surface most users never find, and one with no visible exit strands anyone on a
tablet or a remote desktop. Ship them together, in the same change.

**Three ways in:**

| Way                 | Where it goes                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hotkey**          | `DEFAULT_SHORTCUTS` in `src/renderer/constants/shortcuts.ts`, handled in `useMainKeyboardHandler`                                                                                                                                   |
| **Command palette** | A `build*Commands()` module under `src/renderer/components/QuickActionsModal/commands/`, wired in `QuickActionsModal.tsx`                                                                                                           |
| **Menu**            | `HamburgerMenuContent.tsx` for a destination the user navigates to. Skip this one for an in-the-moment toggle (show/hide something already on screen), which belongs on a key and in the palette but not in a menu of places to go. |

Register the surface in `UI_SURFACES` (`src/shared/uiSurfaces.ts`) at the same
time. One entry gives you `maestro-cli open <surface>`, the `open_modal` bridge
validation, and the discovery hint that teaches the user the hotkey - and it is
the list a reviewer checks against.

**Two ways out:** Escape (free via `useModalLayer` / the shared `Modal`) **and** a
visible control - `<EscCloseButton>` or the `Modal` header's X. Never Escape alone.

**And it should be resizable.** Any surface bigger than a confirm dialog takes a
`resizeKey` so `useResizableModal` remembers the size the user dragged it to. A
fixed-size dashboard is wrong on somebody's display.

**Closing must park, never destroy.** If the content owns live state (an iframe,
a media element, a running view), keep it mounted and pass `hidden` to `Modal`
instead of unmounting it - see `ConcertoStageModal`. Reopening must return the
user to exactly what they left.

### Docked or floating (`Modal`'s `floating` prop)

A surface the user watches while they keep working - rather than one that owns
their attention - can offer a pop-out. Pass `floating={{ position, onMovePointerDown }}`
and the same `Modal` renders as a free-positioned, non-blocking window: no
backdrop, a click-through layer, a passive layer registration (Escape still
closes it, but it neither traps focus nor blanks the app's shortcuts), a header
that doubles as the drag handle, and resize handles on the bottom/right only
(a top-left-pinned frame cannot honor a north or west drag without also moving).

Drive the drag with `usePointerDrag` and `ignoreButtons: true` so the header's own
buttons still click, clamp with `clampModalPosition()` from `utils/modalSizing.ts`
so the title bar can never be dragged off screen, and persist on `onEnd` rather
than per pointer-move.

**Do NOT branch between a `<Modal>` and a hand-rolled floating `<div>`.** They
must be the same element with different props, or React unmounts the subtree on
every toggle - which restarts whatever the pop-out existed to keep running.

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

### Naming the Subject in a Modal Header (`subtitle`)

A modal opened from a **right-click menu** frequently acts on something other than the highlighted agent. `git push` as a header names the operation but not the target, so a user who right-clicked an arbitrary Left Bar row has no way to tell which agent is about to push.

Pass `<Modal subtitle={...}>` for the subject: which agent, which repo, which file. It renders dimmed after the title (`git push · Sonoma-Fix`) and is skipped entirely when empty, so a modal with nothing to name looks exactly as it did before. `GitCommandRunnerModal.tsx` is the reference use.

**Do not concatenate the subject into `title`.** `title` is the `aria-label` and the modal-layer label, and it seeds the fallback resize key via `getDefaultResizeKey()` - a per-agent title mints a different persisted window size for every agent, so the modal would forget its size each time you targeted a different one. That is also why any test asserting on the bare title keeps passing after a `subtitle` is added.

Most openers already carry what they need: `useGitAgentActions.ts` has been putting `sessionId` in the `gitCommandRunner` payload since it was written, the modal just ignored it. Check the payload before plumbing a new prop.

**Two shapes `subtitle` cannot reach**, both of which own their header instead of letting `<Modal>` draw it:

- A modal passing `customHeader` - that replaces `<Modal>`'s header wholesale, so the prop silently never renders (`BranchSwitcherModal`).
- A bespoke shell with its own `<h2>` and no `<Modal>` at all (`CreatePRModal`, `CreateWorktreeModal`, `WorktreeConfigModal`, `GitLogViewer`, `GitDiffViewer`).

Both render `<ModalSubtitle theme={theme} subtitle={name} />` directly, exported from `ui/Modal.tsx`. `<Modal>` renders the same component from its own `subtitle` prop, so every surface shares one dim, one separator, and one `data-testid="modal-subtitle"`. Do NOT hand-roll the dimmed span. When you add the name to a bespoke header, give the heading `shrink-0` and the wrapper `min-w-0`, or the name pushes the close button instead of ellipsising.

**Check for a second header.** `GitDiffViewer` draws a separate one in its empty-diff branch, which needs the name more than the populated one does - "No changes to display" is exactly the message a user misreads as belonging to the agent they meant to right-click.

**Do not force-activate the agent to make a modal find it.** `Configure Worktrees` used to call `setActiveSessionId()` before opening so the modal's `activeSession` read would land on the right agent. That silently moved the user's selection and retargeted every other surface bound to the active agent. Put the target in the modal payload instead, and give the modal AND its callbacks one shared resolver (pinned agent, else active) so the dialog and its Save button cannot target different agents - see `resolveWorktreeConfigTarget()` in `useWorktreeHandlers.ts`.

### Resizable Modals

Dialog-style modals can offer persisted, center-anchored drag-to-resize via `useResizableModal()` (`src/renderer/hooks/ui/useResizableModal.ts`), backed by pure sizing/clamping helpers in `src/renderer/utils/modalSizing.ts` and the handle UI in `src/renderer/components/ui/ResizeHandles.tsx`. Sizes persist in the `modalSizes` setting (`src/renderer/stores/settingsStore.ts`: `setModalSize`/`resetModalSize`/`resetModalSizes`), clamped to a `320x240` minimum and the `90vw x 90vh` app-wide ceiling described above, with per-modal `minSize`/`maxSize` overrides for dense tools or width-capped reading surfaces (e.g. Director's Notes caps `maxSize.width` at `1050`).

**Resetting a size.** Double-clicking any resize handle forgets that one modal's remembered size and snaps it back to its declared `defaultSize`. Pass the hook's `onResetSize`/`canReset` through to `ResizeHandles` to enable it - `<Modal>` already does, and every bespoke shell that renders `ResizeHandles` directly should too, so the gesture is uniform. `canReset` only gates the tooltip wording (the handles are invisible until hover, so the native `title` is the gesture's only discoverability), and `resetModalSize` skips the settings write when nothing was stored, so an idle double-click is free. Settings -> Display -> Modal Layout still offers the reset-every-modal escape hatch (`resetModalSizes`).

The shared `<Modal>` component wires this up automatically via `resizable`/`resizeKey`/`defaultSize`/`minSize`/`maxSize` props, but **resizing only activates when the caller passes an explicit, stable `resizeKey`.** Omitting it (the default for most `<Modal>` callers - simple confirms, help dialogs) falls back to the legacy fixed `width`/`maxHeight`/`scaleWidthWithFont` sizing instead of a title-derived key: a title/priority-derived fallback isn't stable across unrelated dialogs (every default-titled `ConfirmModal` would otherwise collide on one persisted size). Bespoke modal shells that don't use `<Modal>` (e.g. `QuitConfirmModal.tsx`) should stay off `useResizableModal` entirely if they're simple, non-resizable confirms.

When two toggleable states of the same modal need independent footprints (e.g. Prompt Composer's compact vs. fullscreen), use two distinct `resizeKey`s (`prompt-composer-compact` / `prompt-composer-fullscreen`) rather than one shared key with a mode-dependent `defaultSize` - `defaultSize` is only consulted before the first saved size exists, so a single key would let one mode's manual resize silently pin the other mode's size too.

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

### Modals Launched From Inside Settings (`launchFromSettings`)

The Settings modal renders at `z-[9999]`, above every other modal surface. A
control inside Settings that opens a SEPARATE top-level modal (Extensions ->
"Open Pianola", a plugin's contributed `modal` panel) therefore opens it
_behind_ Settings: the click appears to do nothing until the user closes
Settings and finds the modal waiting underneath.

Route those launchers through `launchFromSettings()` in
`src/renderer/utils/launchFromSettings.ts`:

```tsx
onClick={() => launchFromSettings(() => getModalActions().setPianolaModalOpen(true))}
```

It closes Settings and then runs the launcher, in that order. Keeping the order
in one helper matters: a launcher that itself deep-links back into Settings (a
different tab, say) has to win over the close.

Use it only for launchers that open a separate top-level modal. Inline settings
controls, confirmations, and pickers that are meant to stack ON TOP of Settings
must not use it.

Because jsdom has no layout engine, a test cannot observe the occlusion. Assert
the store state instead: `isOpen('settings')` is `false` and the launched modal
is open.

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

### Dismissal Affordance in Search Headers (`EscCloseHint`)

Modals with a search header (Tab Switcher, Quick Actions, Agent Sessions) show a keycap-style "ESC" hint next to the input. Do NOT hand-roll that badge - use `<EscCloseHint theme={theme} onClose={...} />` from `src/renderer/components/ui/EscCloseHint.tsx`. On fine pointers it renders the passive ESC hint; on coarse pointers (touch, where no Escape key exists) it renders a real X button wired to `onClose`, so the modal stays closable on phones/tablets.

### Fixed-Position UI Inside the Mobile Drawers (portal or it's trapped)

On narrow viewports the Left Bar and Right Bar float as CSS-transformed drawers (`index.css`, `[data-panel='left'|'right']`). A transformed ancestor becomes the containing block for `position: fixed`, so any full-screen overlay rendered inside them (modals, sheets) gets trapped to the ~320px drawer box instead of covering the viewport. Render such overlays through `createPortal(..., document.body)` - see `HistoryDetailModal.tsx` and `SessionList/HamburgerDropdown.tsx` (which also swaps the anchored dropdown for a full-screen sheet at the xs breakpoint). If the overlay must survive outside-click closers keyed on a container ref, mark it (e.g. `data-hamburger-sheet`) and have the closer ignore clicks inside the marker.

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

### Measuring an Element's Width (`useElementWidth`)

`useElementWidth(ref, enabled?)` (`hooks/ui/useElementWidth.ts`) wraps the ResizeObserver boilerplate that was previously inline in `UsageDashboardModal`. Reach for it **only when the number has to exist in JavaScript**: an inline SVG chart needs real pixels for its viewBox, and a responsive breakpoint that switches column counts needs a value to compare. Anything expressible in CSS stays in CSS.

It returns `0` until the first measurement lands, so gate width-dependent children on `width > 0` (or supply a sensible fallback) rather than painting a zero-width chart on the first frame. It also no-ops when `ResizeObserver` is undefined, so jsdom component tests render without a polyfill.

This matters for any resizable modal that draws a chart: a hard-coded SVG width silently stops matching the frame the moment the user drags it.

### Horizontally Scrolling Strips (`useHorizontalScroll`)

`useHorizontalScroll(ref, resetKey?)` (`hooks/ui/useHorizontalScroll.ts`) returns `{ canScrollLeft, canScrollRight, scrollByPage, scrollIntoView }` for a row that overflows sideways. Reach for it whenever a set that keeps growing has to stay one row tall: the New Agent Wizard's provider strip is the first consumer, because a wrapping grid pushed the Continue button below the fold once the provider count passed eight.

Two things a bare `overflow-x-auto` gets wrong, and this hook fixes:

- **Silence at the edge.** Nothing tells the user more content exists past the right edge. Use the flags to render an honest affordance - a gradient fade plus an arrow button. Do not render the arrows unconditionally: an arrow that cannot move is worse than no arrow.
- **A swallowed wheel gesture.** A strip has no vertical overflow of its own, so a mouse wheel or trackpad flick over it scrolls an ancestor or does nothing. The hook maps VERTICAL deltas onto the horizontal axis.

Three rules the wheel handler follows, each of them a bug someone felt before it was written:

- **A gesture that is already horizontal is handed back to the browser.** A trackpad two-finger swipe or a tilt wheel already targets this strip's axis, and the native path carries the platform's own momentum and interruption behaviour. Taking it over replaces a fling with a stepped, dead-feeling drag, so the handler returns without calling `preventDefault()` whenever `|deltaX| > |deltaY|`.
- **Wheel deltas are not always pixels.** `deltaMode` says whether the number counts pixels (0), lines (1), or pages (2). Using the raw value makes a line-reporting mouse crawl three pixels per notch, so scale it before it becomes a scroll offset.
- **The gesture is only claimed when it actually moves the strip.** At an end stop, a further scroll in that direction belongs to the surrounding page; swallowing it there traps the pointer over a strip that no longer responds while the page behind it refuses to scroll.

**Do NOT put `scroll-smooth` on the strip element.** That class applies to EVERY programmatic scroll, including the browser's own scroll-into-view when arrow-key focus lands on an off-screen tile and the per-tick write a wheel gesture makes - each one becomes a fresh ~300ms eased animation started from wherever the previous one had reached, so a flick queues dozens of them and the strip drifts along behind the gesture instead of tracking it. The hook scrolls with an explicit `behavior`: `'instant'` for wheel ticks, `'smooth'` for `scrollByPage`, so the arrow buttons stay eased without the strip opting in globally. Both go through one helper that falls back to a `scrollLeft` write, because jsdom implements `scrollLeft` but not `scrollTo`.

Scroll events also fire far faster than the screen repaints, and measuring reads `scrollWidth`/`clientWidth`, so the hook coalesces measurement to one `requestAnimationFrame` per frame rather than forcing a synchronous layout for every event in a flick.

Keep the arrow buttons out of the tab order (`tabIndex={-1}`) when the strip's items are already reachable with the arrow keys - otherwise they become dead ends in the middle of the keyboard path.

**Do not lean on the browser's own scroll-into-view to keep the focus ring visible.** It gets two things wrong on a strip like this. It scrolls the item flush against the edge, where the gradient fade and the arrow button float over the strip's own ends, so the item it just revealed sits underneath one and still reads as off-screen. And a DISABLED item never takes DOM focus at all - the focus ring still moves onto it, so arrowing across an uninstalled provider looks like the strip froze. Focus with `focus({ preventScroll: true })` and drive the strip yourself:

```tsx
const { scrollIntoView } = useHorizontalScroll(stripRef, tiles.length);

// Tracks the ring's INDEX, not DOM focus, so a disabled tile still moves the strip.
useEffect(() => {
	// Read the ref inside the effect: ref callbacks run at commit, so a render-time
	// read on the first mount captures null with no re-render to correct it.
	scrollIntoView(tileRefs.current?.[focusedIndex], STRIP_EDGE_PADDING_PX);
}, [focusedIndex, scrollIntoView, tileRefs, tiles]);
```

`scrollIntoView(child, edgePaddingPx?)` scrolls the minimum that reveals the child, and only for the edge it is actually past. Pass the width of whatever floats over the strip's ends as `edgePaddingPx` - share one constant with the fade's own `width` so the two cannot drift. It measures from `getBoundingClientRect()` rather than `offsetLeft`, which is relative to the nearest positioned ancestor (the wrapper, not the strip) and would silently drift by the wrapper's padding. An item wider than the viewport overflows both edges at once; the left edge wins, since a visible leading edge beats a visible trailing one.

It no-ops without `ResizeObserver`, so jsdom component tests render without a polyfill (and both flags read `false`, since jsdom reports zero for every measurement).

### Entity Tiles in the Usage Dashboard (`<EntityTile>`)

The Usage Dashboard's card grid (the agent grid in `AgentOverviewCards`) renders one tile shape: status dot, truncating title, badges, corner age, optional subtitle, a row of labeled stats, and a corner sparkline. That chrome lives once in `src/renderer/components/UsageDashboard/EntityTile.tsx` - border states (default / dashed / hovered / selected), the staggered `card-enter` animation, the clickable-button affordance, and the highlighted-stat accent coloring.

Adding a new dashboard grid means shaping data into `EntityTileStat[]` and passing it, not re-deriving 150 lines of tile styling. `EntityTile` is presentational: it takes formatted strings and colors and reports clicks, so callers keep their own sort/filter state and their own number formatting.

**A tile grid is not the default for every dashboard collection.** `TabBreakdown` (the per-tab list inside the agent detail modal) used to render tiles and now renders a `<SortableTh>` table: a tab row carries a name and four small numbers, which is little enough that rows scan faster than cards, and it keeps the view visually distinct from the agent tiles the reader just clicked through to reach it. Pick tiles when a row's worth of data needs the space; pick a table when it does not.

It deliberately lives under `UsageDashboard/` rather than in `renderer/widgets/`: widgets are barred from importing from `UsageDashboard/`, and this tile is an entity summary (many stats, one subject) rather than the widget library's `StatCard` (one headline metric).

### Turn Attribution Pills (`<TurnSettingPills>`)

Each assistant message in the AI transcript carries a centered footer row naming the configuration that produced it: the Claude token-source pill (`claude -p` / `TUI Wrapper`, from `getTokenSourcePill()`), then the model and effort the turn was SENT with. `src/renderer/components/ui/TurnSettingPills.tsx` renders the model/effort half - static badges that mirror the composer's interactive `ModelEffortPills` (Sparkles + accent for model, Gauge + warning for effort), because a finished turn's configuration is a fact, not a control.

The values come from `LogEntry.turnModel` / `turnEffort`, copied in `useBatchedSessionUpdates` from the tab's send-time stamp (`AITab.turnModel` / `turnEffort`, written by `codifyTurnSettings()` in `utils/providerTabSessions.ts`). Read the stamp, never the live tab or agent value: settings are codified at send, so a model change made while a turn streams applies to the next message and must not relabel the response already running. An unset value means the agent's own default applied, and that pill is omitted rather than labeled with a guess.

Two traps when touching this row:

- `collapsedLogs` in `TerminalOutput` merges consecutive non-user entries into one rendered entry built from `[0]`. A group can lead with a system banner that carries no stamp, so the merge lifts `turnModel` / `turnEffort` from the first grouped entry that has them - the same fix `renderStyle` needed.
- `LogItem`'s memo comparator lists every field that affects rendering. A new pill field that is not in that list will not repaint when it changes.

### Keycaps (`<Keycap>` / `<KeycapHint>`)

`src/renderer/components/ui/Keycap.tsx` draws a keyboard key as a physical key - a face, a border, and a lip along the bottom edge - rather than as a glyph in a dim caption. `Keycap` is the cap alone; `KeycapHint` is one or more caps beside the action they perform (`[↑][↓] Model`).

Two props are the reason it exists rather than another hand-rolled `<kbd>`:

- **`pressed`** collapses the lip and sinks the cap by exactly the lip's height, so a surface that already listens for the key can echo the real keypress on screen. Drive it from a short timer, not from `keyup`: a held key repeats without ever sending `keyup`, so a cap released on `keyup` stays stuck down.
- **`onClick`** turns the hint into the control. A surface showing `↵ Apply` and `esc Cancel` needs no separate button row, and the pointer-only user (remote desktop, tablet) clicks the same key the keyboard user presses - which is how it satisfies [Every Modal Needs a Graphical Exit](#every-modal-needs-a-graphical-exit-escclosebutton).

The hover wash is drawn from `theme.colors.border`, not a fixed white overlay, so it stays visible on light themes. Glyph choice is the caller's: pass `'↑'`, `'↵'`, `'esc'`, or `formatShortcutKeys()` output.

### The Two-Axis Console (`ModelEffortModal`)

`src/renderer/components/ModelEffortModal.tsx` is the reference for a surface where **the shape of the control is the explanation of the control**. Both axes are live at once - Up/Down walks the model, Left/Right walks the effort - so it is deliberately NOT a `<Modal>`: dialog chrome would add a focus ring and invite tabbing between panes, which is the interaction the design is trying to remove. It portals a blurred scrim and floats the composition on it, registering with `useModalLayer` for Escape and priority.

Ideas worth reusing:

- **A wheel, not a list.** Rows are absolutely positioned by `transform` and keyed by model id, so a row that survives a step animates to its new slot instead of being repainted in place. The wrap radius is capped at `floor((count - 1) / 2)`, which is what lets a short catalog wrap without the same model appearing in two slots at once.
- **The end-fade and the depth falloff are one decision.** A `maskImage` fades the wheel's ends; the outermost `WHEEL_DEPTH` entry has to survive that fade with something still legible. Deepening the wheel past what the mask lets through buys dead air, not rows - that is why the radius is 2.
- **Ordered scales get a level meter; unordered sets do not.** Effort bars ramp with the level and fill up to the selection, so the scale reads without reading a word. Model has no order, so it gets none. The `(default)` stop sits off the scale behind a hairline and carries no bar - which is also why the row aligns `items-start` with a fixed-height bar slot, rather than `items-end` on a baseline the default stop does not have.
- **Type-to-jump beats a scrollbar.** A printable key jumps the wheel to the matching model; repeating a letter walks every model starting with it. Gate it on `isTypeaheadKey` (no `metaKey` / `ctrlKey` / `altKey`) - swallowing modified keys would stop `Cmd+W` reaching the window and trap the user inside the surface.

**No legend, but still a graphical exit.** The surface shows no shortcut caption: the axes are self-describing, and the caption was the only thing on screen that had to be read rather than seen. [Every Modal Needs a Graphical Exit](#every-modal-needs-a-graphical-exit-escclosebutton) is still satisfied without a button row - clicking the scrim cancels and double-clicking a row applies, both routed through the same handlers Escape and Enter use, so pointer and keyboard cannot drift.

Anything with an inline `transition` must carry a class the reduced-motion block can name (`.maestro-wheel-row`, `.maestro-effort-stop`, `.maestro-keycap`); the blanket `.transition-*` reset in `index.css` only matches Tailwind's utility classes.

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

### Arrow Navigation Over a List or Grid (`useListNavigation`)

`useListNavigation()` in `src/renderer/hooks/keyboard/useListNavigation.ts` owns
arrow/vim/page/Enter navigation for every list-shaped surface (command palette,
tab switcher, git log, history). Do NOT hand-roll another
`selectedIndex` + keydown switch.

Pass `columns` to navigate a 2-D **grid** instead: left/right step one tile,
up/down jump a full row. Omitting it is exactly the old list behavior, where
left/right stay inert because other things own those keys (text carets, tree
expand/collapse).

Grid mode keys on the option's **presence**, not on `columns > 1`. A grid that
has reflowed down to a single column still answers all four arrows - there,
left/right simply mean previous/next. Gating the horizontal arrows on the
measured value makes them die exactly when the window gets narrow, which reads
as broken rather than as a narrow grid.

For a responsive grid, feed it the MEASURED column count from
`useGridColumnCount(el, itemCount)` (`src/renderer/hooks/ui/useGridColumnCount.ts`),
which reads the resolved `grid-template-columns` and re-measures on reflow. A
hard-coded row width silently walks to the wrong tile the moment an `auto-fill`
grid drops to two columns.

It takes the ELEMENT, not a ref object, and the caller holds that element in
**state** via a callback ref:

```tsx
const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
const columns = useGridColumnCount(gridEl, items.length);
const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
	listLength: items.length,
	columns,
	onSelect: (i) => open(items[i]),
});
// ...
<Grid onGridElement={setGridEl} ... />
```

A ref's `.current` changing is invisible to React, so a version keyed on a ref
object keeps observing a grid that has since unmounted. That is not theoretical:
removing an observed element from the document resizes it to 0 and fires its
ResizeObserver, a detached node resolves `grid-template-columns` to the empty
string, and the count collapses to 1. Symptom: arrow navigation works, the user
opens a detail pane, comes back, and up/down have quietly degraded to
single-item steps for the rest of the visit. The hook also refuses to measure a
detached node for the same reason.

Wire the result up as a **roving tabindex**: the active item gets `tabIndex={0}`
and every other item `tabIndex={-1}`, with `onKeyDown` on the container. Tab then
crosses the whole grid in one press while the arrows walk it, which is the
standard composite-widget contract. Keep the items native `<button>`s so Space
activates them; Enter is handled by the hook, whose `preventDefault` suppresses
the button's own activation so the item opens exactly once.

Two things the Extensions grid (`Settings/Extensions/`) gets right and a new
grid should copy:

- **Take focus on mount.** A grid the user navigated to is the thing they came
  to use, so claim focus rather than making them click or Tab into it first.
  Consume that with a ref so it happens once per mount; re-focusing on every
  index change yanks the caret back from wherever the user moved it.
- **Own the active index ABOVE the grid** when the grid unmounts for a detail
  view, and let the remount restore focus. Otherwise Escape drops the user on
  the first tile and they lose their place.
- **Move DOM focus only when focus is already inside the grid.** An effect that
  focuses on every index change steals the caret out of the search box the
  moment filtering changes the list.

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

### `<ShortcutHint>` (`src/renderer/components/TabBar/ShortcutHint.tsx`)

The keys badge at the right edge of a tab overlay-menu row:

```tsx
{
	tabShortcuts.moveTabToStart && (
		<ShortcutHint keys={tabShortcuts.moveTabToStart.keys} theme={theme} />
	);
}
```

Used by every tab item's overlay menu (`AITabOverlayMenu`, `FileTab`, `TerminalTabItem`, `BrowserTabItem`, `GroupTabChip`). It was previously re-declared inline, byte-identical, in four of those components - do NOT add a fifth copy. Positions itself with `ml-auto`, so it only lays out correctly inside a flex row item. Key glyphs come from `formatShortcutKeys`, which is platform-correct; never hard-code `⌘` / `Ctrl` in menu copy.

### `<AdditionalDirectoriesSection>` (`src/renderer/components/shared/AdditionalDirectoriesSection.tsx`)

The row editor for an agent's extra directory grants (path + independent R / W square toggles + remove). Shared by NewInstanceModal, EditAgentModal, and the Wizard's DirectorySelectionScreen so all three emit the same `AdditionalDirectory[]`.

```tsx
<AdditionalDirectoriesSection
	theme={theme}
	directories={additionalDirectories}
	onChange={setAdditionalDirectories}
	disableBrowse={isSshEnabled} // local folder picker can't see the remote host
/>
```

Always run the value through `normalizeAdditionalDirectories(dirs, homeDir)` (`src/shared/additionalDirectories.ts`) before persisting it on the session - the component keeps raw rows so the user can type and toggle freely. Grants are prompt-level only; see SHARED-UTILS.md → Additional Directories.

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

### `<MiniBadge>` (`src/renderer/components/ui/MiniBadge.tsx`)

The tiny uppercase text chip that tags an item's state: "WT" beside a worktree
agent, "Active" / "Snoozed" beside a tab. It is the generic text counterpart to
`<CountBadge>`, which says a number and nothing else, and to the domain pills
beside it (`WorktreePill`, `GitRunningBadge`) that say one fixed word in their
own colors. Do NOT hand-roll another `text-[9px] px-1 rounded uppercase` span -
the Usage Dashboard's tiles carried one copy and the per-tab list needed the
identical chip, which is exactly where two copies start drifting on padding and
weight.

```tsx
<MiniBadge label="Snoozed" theme={theme} color={theme.colors.warning} testId="tab-snoozed" />
```

- `color` defaults to the theme accent and tints both the text and its translucent fill.
- The label is its own accessible name, so pass a real word rather than an abbreviation
  the reader has to decode - unless the abbreviation is the established UI term, in which
  case pass `title` with the long form.

### `<ProviderAvailabilityBar>` (`src/renderer/components/ui/ProviderAvailabilityBar.tsx`)

"4 providers available locally of 11 supported", plus the toggle that brings the
other 7 back. Most of the providers Maestro supports are not installed on any
given machine, so listing all of them buries the two or three a user can pick
behind a wall of dimmed rows. Both provider pickers - the wizard's tile strip
and the New Agent modal's list - hide the rest by default and show this one bar,
so the count and the toggle cannot disagree about what is being filtered.

The filtering rules themselves live in `src/renderer/utils/providerAvailability.ts`
(`filterToAvailableProviders`, `providerLocationLabel`) rather than in either
picker. Three rules, each of them a dead end if broken:

- **The count always describes ALL supported providers, never the filtered list.**
  A count that shrank along with the rows would report "4 of 4" and answer nothing.
- **Filtering down to nothing falls back to the full list.** An empty picker has no
  row to reach per-provider settings through, so a user whose binary sits in a
  non-standard place would have no way to point Maestro at it and no way to proceed.
- **The selected provider survives the filter regardless.** Duplicating an agent whose
  provider is missing from this machine would otherwise hide the very row that shows
  what is selected, and the picker would look like it has no selection.

`variant="compact"` drops to the counts alone for a bar that rides a section
heading (the New Agent modal); `full` is the standalone row (the wizard). The
location phrase comes from `providerLocationLabel(remoteHost)` - both pickers can
point at an SSH remote, and "locally" is a claim about the wrong machine whenever
one is selected.

Two things a container has to respect. If the surface runs one keydown handler
across the whole screen (the wizard does, to drive the strip), exempt the bar's
subtree with `PROVIDER_BAR_NAV_EXEMPT_ATTR` or the toggle loses its own Tab and
arrow keys the moment it takes focus. And when the filter flips, **carry the
focus ring by PROVIDER, not by index** - the list renumbers, so keeping the raw
index slides the ring onto whichever unrelated provider inherited that slot.

### `<FontScaleControl>` (`src/renderer/components/ui/FontScaleControl.tsx`)

Decrease / reset / increase font zoom for a reading pane. Pair it with
`useFontScale(storageKey)` (`src/renderer/hooks/ui/useFontScale.ts`), which owns
the value, the clamping (0.7 - 2.0, rounded to two decimals so no
`calc(0.875rem * 1.0000000000000002)` reaches the DOM) and the localStorage
persistence. Do NOT hand-roll another pair of `AArrowUp` / `AArrowDown` buttons.

```tsx
const fontScale = useFontScale('filePreview.fontScale');
<FontScaleControl theme={theme} control={fontScale} variant="floating" target="preview" />;
```

- `variant="inline"` - bordered squares for a toolbar or stats bar (Director's Notes).
- `variant="floating"` - frosted pill for overlaying a scrolling pane (file preview,
  pinned top-right as the mirror of the Table of Contents button at bottom-right).
- The percentage in the middle appears only once zoomed and doubles as the reset.

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

### Output Widget Library (`src/renderer/components/widgets/`)

Shared, theme-aware, **presentational-only** display widgets. Every widget is
memoized, takes its data via props (no IPC, no store reads), and is independent
of any Encore flag - so it can be composed onto any surface. Import from the
barrel (`components/widgets`), not from `output/` directly. Reuse these before
hand-rolling stat cards, bar charts, donuts, or activity timelines.

| Widget              | Use for                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `StatCard`          | Headline metric: large value, label, optional `Sparkline` + icon     |
| `StatCardGrid`      | Responsive auto-fit grid of `StatCard`s from a `StatCardDatum[]`     |
| `SectionCard`       | Titled content card (icon + accent + action slot) framing a block    |
| `ActivityTimeline`  | Compact stacked AUTO/USER/CUE bar timeline from `TimelineBucket[]`   |
| `TypeBreakdown`     | Donut breakdown of `DonutSlice[]` with center total + legend %       |
| `AgentActivityBars` | Horizontal bars from `BarDatum[]`: sorted desc, top-N + overflow row |

Shared prop types live in `widgets/types.ts` (`WidgetProps` carries `theme`;
plus `StatCardDatum`, `BarDatum`, `TimelineBucket`, `DonutSlice`). Colors follow
the unified-history language (AUTO = `theme.colors.warning`, USER =
`theme.colors.accent`, CUE = `CUE_COLOR`); pass a `colors` override for
colorblind palettes. `StatCard`/`TypeBreakdown` reuse `Sparkline` and
`formatNumber` rather than re-implementing SVG paths or number formatting.

First consumer: Director's Notes Rich Mode (`DirectorNotes/RichOverview.tsx`),
which composes the widgets from deterministic IPC data (`getGraphData` /
`getUnifiedHistory`) and wraps each chart in `ChartErrorBoundary`.

Full reference (all output + input widget props, the input-family contract, the
presentational-only/Encore-flag-independent rules, and the Widget Gallery dev
command): [WIDGET-LIBRARY.md](WIDGET-LIBRARY.md). Reuse a widget from there
before hand-rolling a stat card, chart, sparkline, or input control.

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

## Responsive Headers - Container Queries, Not JS Width

Header rows that sit inside a resizable panel (main panel header, left-sidebar section headers) must degrade **on a single line** as the panel narrows: progressively hide the least useful elements rather than wrapping onto a second row. Wrapping is always a bug here - it shifts every row below it and looks broken.

Do this with **CSS container queries**, not JavaScript width detection. A JS approach needs a `ResizeObserver`, re-renders on every drag frame, and lags a pointer-driven resize; the CSS is declarative, runs at layout time, and cannot desync.

### The pattern

Three pieces, all required:

1. **Establish the context** on the header element:
   ```css
   .my-header-container {
   	container-type: inline-size;
   	container-name: myheader;
   }
   ```
2. **Guarantee no-wrap structurally** in the JSX: `whitespace-nowrap` (plus `truncate` for the title) on the label group, and `shrink-0` on the icons and the right-hand control cluster. This holds the single line even where container queries don't apply - the queries only decide _when_ each item drops, never _whether_ the row wraps.
3. **Give each droppable element a hook class** and hide it at a threshold, dropping the least informative item first:
   ```css
   @container myheader (max-width: 340px) {
   	.my-count-badge {
   		display: none;
   	}
   }
   ```

### Rules

- **Drop counts and labels; keep buttons.** Put the hook class on the count `<span>` inside a button, never on the button itself - an affordance that vanishes is unreachable, a number that vanishes costs nothing. Collapse a labelled button to its icon/glyph instead of removing it.
- **Preserve the accessible name.** When a label is `display: none`, the accessible name must still come from a `title` (or `aria-label`) on the button, or the collapsed control becomes unidentifiable to screen readers.
- **All thresholds must clear the panel's minimum width.** The left sidebar clamps to `minWidth: 280` (`useResizablePanel` in `SessionList.tsx`); everything droppable must have dropped by then or the header wraps at the drag floor.
- **Adding a control to one of these headers means adding a drop rule for it.** This is the most likely way to regress the layout - a new button widens the row with no threshold to shed it.

### Canonical implementations

| Surface                     | Container  | Hook classes                                                 | CSS                              |
| --------------------------- | ---------- | ------------------------------------------------------------ | -------------------------------- |
| Main panel header           | `header`   | `.header-session-name`, `.header-cost-widget`, ...           | `index.css` "Header Bar"         |
| Group Chats sidebar section | `gcheader` | `.gc-count-badge`, `.gc-archived-count`, `.gc-newchat-label` | `index.css` "Group Chats Header" |

### Testing

jsdom has **no layout engine and never evaluates container queries**, so no unit test can assert "the label is hidden at 275px". Test the _contract_ instead, in two layers:

- **Render test** (`GroupChatList.test.tsx` -> "single-line header contract"): the container class is present, the anti-wrap utilities survive, each droppable element carries its hook class, and the collapsed button keeps its accessible name and click handler.
- **Cross-file test** (`groupChatHeaderResponsive.regression.test.ts`): the JSX hook classes and the `@container` rules still agree in both directions (a rename on either side fails), the drop order is preserved, and no threshold falls below the sidebar minimum.

That pairing is what makes the silent failure mode loud - the class names are the only thing tying the two files together, and nothing else in the build would catch drift.

---

## Touch Gestures (`useLongPress`)

The desktop renderer also runs on phones (web-desktop build), where several interactions are right-click-only or hover-only and thus unreachable. `useLongPress` (`src/renderer/hooks/utils/useLongPress.ts`) is the canonical way to expose a right-click affordance (context menu, tab action overlay) to touch users. Do NOT hand-roll a `setTimeout` + `touchmove` gesture; reuse this hook.

It differentiates tap, scroll, and long-press:

- A ~500ms press without moving past a 10px threshold fires `onLongPress(rect)` with the element's bounding rect (so callers can anchor a menu at the touch position) and a `success` haptic.
- A `touchmove` past the threshold cancels the long-press (scroll-aware): the menu does NOT pop while the user is scrolling a list.
- A short press fires the optional `onTap` with a `tap` haptic.
- `handleContextMenu` triggers the same `onLongPress` immediately on desktop right-click, so mouse behavior is preserved when you wire both.

```tsx
const { elementRef, handlers, handleContextMenu } = useLongPress({
	onLongPress: (rect) => openMenuAt(rect.left, rect.bottom),
});

<div
	ref={elementRef as React.RefObject<HTMLDivElement>}
	{...handlers}
	onContextMenu={handleContextMenu} // keep existing right-click behavior
/>;
```

Gate any touch-only wiring behind `isCoarsePointer()` from `src/renderer/utils/touch.ts` when you must not change mouse/keyboard behavior.

---

## Virtual Keyboard Offset (`useKeyboardVisibility`)

On phones the on-screen keyboard covers the bottom of the layout viewport, hiding the AI input and send controls. `useKeyboardVisibility` (`src/renderer/hooks/utils/useKeyboardVisibility.ts`) is the canonical detector - do NOT re-derive `window.visualViewport` math or listen for `focusin`/`resize` yourself. It is pure Visual Viewport API with zero app coupling, so it is a no-op on the Electron desktop app and anywhere the API is unavailable (both return `{ keyboardOffset: 0, isKeyboardVisible: false }`).

- Compares `window.innerHeight` to `visualViewport.height` (minus `offsetTop`); a shrink past a 50px threshold reads as a keyboard and reports the eaten pixel height as `keyboardOffset`.
- Recomputes on the viewport's `resize` (and, while the keyboard is up, `scroll`) events; cleans up its listeners on unmount.

The app shell in `App.tsx` publishes the offset as a CSS custom property, and `.maestro-app-shell` consumes it as bottom padding (scoped to `html[data-runtime='web-desktop']`, so the native app is untouched):

```tsx
const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();
const keyboardShellOffset = isWebDesktop() && isKeyboardVisible ? keyboardOffset : 0;

<div className="maestro-app-shell" style={{ '--keyboard-offset': `${keyboardShellOffset}px` } as React.CSSProperties}>
```

```css
html[data-runtime='web-desktop'] .maestro-app-shell {
	padding-bottom: calc(env(safe-area-inset-bottom) + var(--keyboard-offset, 0px));
}
```

Because the shell is `box-sizing: border-box` at `height: 100dvh`, the added bottom padding shrinks the content box and the flex column re-lays with the input sitting just above the keyboard. Gate the applied offset behind `isWebDesktop()` (from `src/renderer/utils/runtimeContext.ts`) so it stays a no-op on the Electron desktop app.

---

## Voice Input (`useVoiceInput`)

`useVoiceInput` (`src/renderer/hooks/utils/useVoiceInput.ts`) is the canonical speech-to-text hook for the AI input on touch devices. Do NOT re-instantiate `SpeechRecognition` or hand-roll vendor-prefix detection - it wraps the Web Speech API (with the `webkitSpeechRecognition` fallback), carries its own typings, and reuses `triggerHaptic`/`HAPTIC_PATTERNS` from `src/renderer/utils/touch.ts`.

- Call it where the live draft lives (`InputArea`), passing `currentValue` (the draft), `onTranscriptionChange` (the draft setter), and an optional `focusRef` (the textarea, refocused when dictation ends). Streaming interim results call `onTranscriptionChange` so the draft updates live; the final transcript is appended to the value captured when listening began.
- `voiceSupported` (support detection), `isListening`, and `toggleVoiceInput` drive the UI. `toggleVoiceInput`'s identity changes with the draft, so wrap it in a ref-backed stable callback before handing it to a memoized child (e.g. `ToolbarControls`) - otherwise the child re-renders on every keystroke.

The mic toggle lives in `ToolbarControls` and renders only when `voiceSupported && isCoarsePointer()` (touch), so desktop mouse/keyboard users never see it. It sits in the always-visible left action group (not the collapsing overflow toggle group), because a voice affordance buried behind the `...` menu on the phones it targets defeats the purpose.

```tsx
const voice = useVoiceInput({
	currentValue: inputValue,
	onTranscriptionChange: setInputValue,
	focusRef: inputRef,
	disabled: isTerminalMode,
});
const voiceToggleRef = useRef(voice.toggleVoiceInput);
voiceToggleRef.current = voice.toggleVoiceInput;
const handleToggleVoiceInput = useCallback(() => voiceToggleRef.current(), []);
```

---

## Swipe Gestures (`useSwipeGestures`)

`useSwipeGestures` (`src/renderer/hooks/utils/useSwipeGestures.ts`) is the canonical multi-directional swipe detector (distance/velocity thresholds, direction locking, optional offset tracking). It returns touch handlers to spread on a target element. Do NOT hand-roll `touchstart`/`touchmove` math - reuse this hook.

Key caveat: `handleTouchMove` calls `e.preventDefault()` once it locks to a horizontal swipe, so it suppresses native horizontal scroll on whatever element it's attached to. Attach it only to elements where that's intended - screen-edge drawer zones or a modal backdrop - never a scrollable content region (terminal, tab bar, tables).

App.tsx uses it for edge-swipe drawers on phones, gated on `isNarrowViewport && isWebDesktop() && isCoarsePointer()`:

- Two thin (24px) fixed edge strips (`.maestro-edge-swipe-zone`, `touch-action: pan-y`) host the openers - a rightward swipe from the left edge opens the Left Bar (`setLeftSidebarOpen(true)`), a leftward swipe from the right edge opens the Right Panel. Because gestures can only START in the edge strips, center-content horizontal scrolling is never intercepted.
- The mobile backdrop (only present while a drawer is open) hosts the closer - swipe left to close the left drawer, swipe right to close the right.

---

## Exporting Rendered SVG Diagrams (Copy / Save)

Any surface that renders a diagram the user might want to keep should offer the shared right-click menu. Do NOT hand-roll a copy/save affordance.

- **Menu:** `<SvgContextMenu menu={svgMenu} theme={theme} onDismiss={dismissSvgMenu} />` (`src/renderer/components/SvgContextMenu.tsx`) - "Copy Image" (rasterized PNG) and "Save Image (SVG)".
- **State:** `useSvgContextMenu()` (`src/renderer/hooks/ui/useSvgContextMenu.ts`) returns `{ svgMenu, dismissSvgMenu, openSvgMenu, openSvgMenuFromContainer }`.
- **Export logic:** `serializeSvg()`, `svgToPngDataUrl()`, `copySvgToClipboard()`, `downloadSvg()` in `src/renderer/utils/svgExport.ts`.

Which opener to use depends on how the SVG got into the DOM:

| SVG source                                                     | Opener                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| React-rendered `<svg>` (agent-authored inline SVG in markdown) | `openSvgMenu(e.currentTarget, e.clientX, e.clientY)` from the element's own `onContextMenu` |
| Imperatively injected `<svg>` (Mermaid appends into a div)     | `openSvgMenuFromContainer` on the container's `onContextMenu`                               |

The second case is the one that gets missed: an SVG appended with `appendChild` never passes through React's element tree, so a component map override (like the chat markdown `svg:` renderer) will never see it. Hang the handler off the container instead.

`copySvgToClipboard()` returns `'image' | 'markup' | 'failed'` - flash accordingly. A blanket "Copied to Clipboard" is wrong when rasterization fell back to copying markup as text, and silence is wrong when it failed outright.

---

## Table of Contents (`components/Toc`)

Any long scrollable surface that wants a jump list uses the shared TOC. Do NOT re-implement the floating button, the panel, or its keyboard handling: users have muscle memory from File Preview, and a second copy drifts from it.

| Piece               | Location                            | Responsibility                                                                      |
| ------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `<TocOverlay>`      | `components/Toc/TocOverlay.tsx`     | The button + panel, entry rendering, Arrow/Home/End navigation, focus-first-on-open |
| `useTocOverlay()`   | `hooks/ui/useTocOverlay.ts`         | Open state, toggle hotkey, Escape, click-outside, focus restore on close            |
| `computeTocWidth()` | `components/Toc/tocWidth.ts`        | Panel width from the longest entry (clamped 200-500px)                              |
| `extractHeadings()` | `components/Toc/extractHeadings.ts` | Markdown headings -> `TocEntry[]`, code-fence aware, `github-slugger` slugs         |

Consumers: `FilePreviewToc` (markdown files) and `AIOverviewTab` (Director's Notes, both reading modes).

Two things a host must get right:

- **Anchors have to exist.** The default scroll path is `containerRef.querySelector('#slug')`. For rendered markdown that means passing `rehype-slug` so headings carry ids matching `extractHeadings`' slugs. For non-heading targets (Director's Notes' `SectionCard`s, the virtualized Fast tier) either put a matching `id` on the target or pass `onSelectEntry` and handle the scroll yourself.
- **The keydown must reach the hook.** `handleKeyDown` fires from the element that has DOM focus, and keys bubble UP. If an ancestor owns focus, the hook never sees the hotkey. Focus the scroll region itself - in Director's Notes the tab exposes a `TabFocusHandle` whose `focus()` targets the content region for exactly this reason.

Escape ordering is the host's call. On a layer-stack modal, delegate to `closeIfOpen()` first and only close the modal when it returns false, so Escape dismisses the panel before the modal.

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
- `handleUnifiedTabReorder(fromIndex, toIndex)` - reorder the unified tab bar (mixes AI, file, browser, terminal, and tiled-group chips). A tiled group is ONE unified tab and drags/reorders as a single unit like any other chip; its panes are referenced by the group's layout tree, not by `unifiedTabOrder`, so moving the chip never disturbs the tiling.
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

### New pane / new tab focus - move the caret, not just the ring

A tab group's `focusedPaneId` drives the focus RING and input routing. It does **not**
move DOM focus, so a keyboard pane switch alone leaves the caret in the previous
pane and the user's next keystroke goes to the wrong place. The same is true of a
plain new tab: activating it does not put a caret anywhere.

Every path that wants the caret publishes a one-shot `focusRequest` on `uiStore`,
addressed **either** by tiled pane leaf id (`requestPaneFocus`) **or** by tab ref
(`requestTabFocus`) - one slot, so there is a single focus owner and a single
cancel chain, and a later request always supersedes an earlier one:

- `useTilingShortcuts` - `focusPane`, `cyclePane`, `splitFocusedPane`, and
  `closeFocusedPane` when the group survives.
- `tileNewTabAction` - the tile-below family.
- `useFilePreviewTabHandlers.handleNewFileTab` / `useBrowserTabHandlers.handleNewBrowserTab` -
  a blank file opens with the caret in the editor, a new browser tab with the caret
  in the address bar.

`MainPanelContent` consumes it (clearing immediately so a stale request can't
re-steal focus on a later remount) and routes by tab kind through
`focusPaneInputWhenReady` in `utils/paneFocus.ts`. It also resets `activeFocus` to
`'main'`, because the pane shortcuts are not gated on it and can fire while the
Left/Right Bar owns it.

Three things to preserve when touching this:

- **The retry belongs to a ref, not to the effect's cleanup.** Consuming the request
  nulls the store field the effect subscribes to, so the consume re-renders the
  component. Returning the canceller from the effect made it tear its own retry down
  a few ms in - always before the first 50ms attempt - and NO pane ever took focus.
  A superseded request still cancels the one before it, which is all the cleanup was
  for. The regression test is `still focuses after the re-render its own consume
causes`; its mocked `clearFocusRequest` really nulls the value, because a bare
  `vi.fn()` never triggers the re-render that breaks it.
- **Use `focusTerminal(tabId)`, never `focusActiveTerminal()`.** A tiled terminal pane
  does not set `activeTerminalTabId` (`focusPaneInSession` only syncs `activeTabId`,
  and only for AI panes), so the "active" variant lands on the wrong terminal or none.
- **Keep it a request, not an effect keyed on `focusedPaneId`.** A mouse press anywhere
  in a pane also moves `focusedPaneId`, so a derived effect would yank the caret into
  the AI input mid-drag and break text selection in the conversation. Keeping it
  explicit ties the focus steal to user intent.

### Creating a tab straight into a tile - `tileNewTab`

`tileNewTab(session, kind, defaults, zone?)` in `src/renderer/hooks/tabs/tileNewTab.ts`
creates an AI / file / terminal / browser tab and drops it into a pane beside whatever
is on screen, in one session update. It is what the command palette's **Tile New ...
Below** family calls (`commands/tileCommands.ts`), and it is the entry point for any
future surface that wants "split the view and put a new X here" without a drag.

It reuses the drag path's primitives rather than re-deriving layout: a live group is
extended with `tileTabIntoGroup` on its FOCUSED pane (not the whole grid), and an
untiled view is paired via `createGroupFromDrop`. `canTileNewTab(session)` reports
whether there is anything on screen to tile against, so a caller can hide the
affordance instead of offering a no-op.

The one rule to preserve: **the new tab must be minted non-activating.** Every ordinary
new-tab path (`createTab`, `addTerminalTab`, `handleNewBrowserTab`, `handleNewFileTab`)
clears `activeGroupId` and claims the panel, because a standalone tab has to or the
group would keep winning render precedence. Here that is backwards - it would tear
down the group being built - so `createTab`/`addTerminalTab` are called with
`activate: false` and the file/browser tabs are appended without touching any
`active*TabId`. The tiling call at the end is what sets focus and activates the group.

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

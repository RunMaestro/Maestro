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

**A modal body must never focus its own input.** `<Modal>` always claims focus on mount, inside a `requestAnimationFrame`: it focuses `initialFocusRef` when one is passed and its own overlay container when one is not. That frame lands AFTER the body's own effects, so a child that calls `inputRef.current.focus()` itself is silently handed back to a `div` one frame later and the surface swallows every keystroke - the failure looks like a dead text box, not a focus bug. Pass `initialFocusRef` and let Modal do it. A body effect stays correct for things focus does not undo, such as putting the caret at the end of a textarea (`QueuedItemEditModal`).

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

```tsx
<Modal
	theme={theme}
	title="About Maestro"
	priority={MODAL_PRIORITIES.ABOUT}
	onClose={onClose}
	resizeKey="about" // stable, unique; enables the resize handles
	defaultSize={{ width: 560, height: 480 }} // size before any resize
	minSize={{ width: 460, height: 420 }} // floor for this modal's layout
>
```

**Resetting a size.** Double-clicking any resize handle forgets that one modal's remembered size and snaps it back to its declared `defaultSize`. Pass the hook's `onResetSize`/`canReset` through to `ResizeHandles` to enable it - `<Modal>` already does, and every bespoke shell that renders `ResizeHandles` directly should too, so the gesture is uniform. `canReset` only gates the tooltip wording (the handles are invisible until hover, so the native `title` is the gesture's only discoverability), and `resetModalSize` skips the settings write when nothing was stored, so an idle double-click is free. Settings -> Display -> Modal Layout still offers the reset-every-modal escape hatch (`resetModalSizes`).

The shared `<Modal>` component wires this up automatically via `resizable`/`resizeKey`/`defaultSize`/`minSize`/`maxSize` props, but **resizing only activates when the caller passes an explicit, stable `resizeKey`.** Omitting it (the default for most `<Modal>` callers - simple confirms, help dialogs) falls back to the legacy fixed `width`/`maxHeight`/`scaleWidthWithFont` sizing instead of a title-derived key: a title/priority-derived fallback isn't stable across unrelated dialogs (every default-titled `ConfirmModal` would otherwise collide on one persisted size). Bespoke modal shells that don't use `<Modal>` (e.g. `QuitConfirmModal.tsx`) should stay off `useResizableModal` entirely if they're simple, non-resizable confirms.

- `useResizableModal` (`src/renderer/hooks/ui/useResizableModal.ts`) owns the drag. Like `useResizablePanel` it writes to the DOM during the drag and commits React state once on mouseup. Deltas are doubled because the card is centered: growing the width by W moves the right edge by only W/2, so doubling keeps the grip under the pointer.
- Sizes persist in one `modalSizes` map in `uiStore`, keyed by `resizeKey`, written through to settings and hydrated by `loadAllSettings` on startup.
- `defaultSize` is the size before any drag: its width falls back to the `width` prop and its height to 320, so a modal that opts in without declaring one opens far shorter than its old `maxHeight` let it grow. Declare both.
- Minimums default to `DEFAULT_MODAL_MIN_SIZE` (320 x 240) in `src/renderer/utils/modalSizing.ts`. Pass a higher `minSize` when a modal's content stops making sense below a given size - every resizable modal should have a floor that still looks right.
- Sizes are clamped to `MODAL_MAX_VIEWPORT_RATIO` (90%) of the viewport both at drag time and at read time, so a modal sized on a large display still opens sanely on a laptop.
- `ResizeHandles` renders all eight edges and corners; double-clicking any of them forgets the remembered size and returns the modal to its declared default.
- The frame is a flex column with a fixed header and footer, so **the body must be told to fill it**: a scroll container still carrying `max-h-[400px]` (or any fixed height) leaves dead space below the list no matter how far the user drags. Pass `contentClassName="p-6 flex-1 min-h-0 flex flex-col"` and give the scrolling child `flex-1 min-h-0 overflow-y-auto` instead of a height cap. `ShortcutsHelpModal` is the reference caller.

`resizeKey` must be stable across renders - it is the persistence key, not a label.

When two toggleable states of the same modal need independent footprints (e.g. Prompt Composer's compact vs. fullscreen), use two distinct `resizeKey`s (`prompt-composer-compact` / `prompt-composer-fullscreen`) rather than one shared key with a mode-dependent `defaultSize` - `defaultSize` is only consulted before the first saved size exists, so a single key would let one mode's manual resize silently pin the other mode's size too.

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

### Escape as a Ladder, Not a Close Button

A surface with its own transient state - a focused search box, a query, a selected row - should climb OUT of that state one rung per Escape rather than closing on the first press. `DocumentGraphView` is the reference: caret in the search box hands focus back to the graph **with the query intact**, the next press clears the query, and only then does it close. Rung one is what makes "search, then arrow to a hit" work - the highlighted nodes have to survive the key that gets you out of the text box.

**The ladder MUST live in the layer's `onEscape`, never in the input's `onKeyDown`.** `LayerStackProvider` listens at CAPTURE on `window` (step 1 above), so a handler on the input runs after the stack has already closed the surface, and its `stopPropagation` cannot un-run a listener that has already fired. An `onKeyDown` ladder is dead code that looks correct in review: every Escape goes straight to close. Same rule the `<FilterInput>` and `MemoryViewer` notes below state from the consumer's side.

Two mechanical points when the ladder needs render-scope values (the live query, the node list, a `handleNodeSelect`):

- Register a STABLE wrapper with the layer and assign the body to a ref during render (`escapeLadderRef.current = () => {...}`). A `useCallback` that closes over the search query re-registers the layer on every keystroke.
- Read focus from `document.activeElement === searchInputRef.current` rather than tracking a `isSearchFocused` boolean. The key never reaches the input, so nothing is guaranteed to have updated that flag.

A higher-priority overlay registered by the same surface (the graph's legend drawer) is an implicit rung above all of this - the stack closes the top layer first, so it needs no branch in the ladder.

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

### Arrow-Key Navigation Inside a Modal Belongs on the Element, Not `window`

A `useEventListener('keydown', ...)` on `window` never sees a key pressed inside a `<Modal>`: the overlay stops keydown before it reaches the window, and whatever held focus when the surface opened (a composer textarea, a tab strip) can swallow the key first. Put the handler on the scrolling container or the card itself with `onKeyDown`, give it `tabIndex={-1}` plus `outline-none`, and make sure something focuses it - `initialFocusRef` for a `<Modal>`, a mount effect for a card. `ExecutionQueueBrowser` handles rows on its card and menu items on the action list for exactly this reason.

Two rules go with it. **Let a focused control keep its own keys**: bail out when the event target is inside an `input`, `textarea`, or `[contenteditable]`, and leave `Enter` to a focused `<button>`, or the list steals the key from the control the user is actually on. And **take focus back when a child surface closes** (`useFocusOnClose`), because the focused element was just unmounted, focus falls to `<body>`, and the next arrow key silently does nothing - which reads as the keyboard dying halfway through.

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

**The box does not collapse, and a crowded row is not the reason to make it.** A `collapsible` variant that shrank to its magnifier until focused was tried and removed: hiding the primary control of a pane to buy horizontal space trades a layout problem for a discoverability one, and the neighbour it had to hide to fit (the Memory Viewer's unlinked chip) was a control too. When a toolbar cannot fit on one line, move what is NOT a control off that line instead - the Memory Viewer sends its corpus stats to a footer, which leaves the whole row for things the user can actually press.

### A Surface That Reads and Edits Markdown

Any pane whose content is a markdown document rides the **File Preview stack**, not a bare `<textarea>`:

- **Reading** - `<Markdown preset="document">` inside a scroll container, with `<style>{generateProseStyles({ theme, scopeSelector })}</style>` so the document typography is scoped to that pane instead of leaking heading and table rules onto the chrome around it.
- **Editing** - `<MarkdownEditor>` from `components/FilePreview/markdownEditor`, which brings CodeMirror syntax colouring, the wrap-aware line-number gutter, and an imperative handle (`focus`, `scrollToLine`, `setSearchMatches`, scroll-percent sync).
- **Switching** - `Cmd/Ctrl+E`, read from the user's LIVE `toggleMarkdownMode` binding via `eventMatchesShortcutKeys`, never from a literal `e`. One chord flips a file preview and a memory alike; two spellings of one idea is how a keyboard stops being predictable.

**Open in Preview.** A markdown pane is opened to read far more often than to write, so the rendered document is the default state and editing is one keystroke away rather than the state the user has to leave.

Four details that are easy to miss:

- **A modal layer must bind the chord itself.** A pane registered through `useModalLayer` blocks lower layers, so the app-level `toggleMarkdownMode` handler never runs while it is up.
- **Hand the caret over on the switch.** Entering Edit must focus the editor (`requestAnimationFrame(() => editorRef.current?.focus())`); without it a writable surface appears while every keystroke still goes wherever focus already was, which reads as the editor being broken. Leaving Edit hands focus back to the list.
- **Key the editor on the filename.** Undo history belongs to one document. Carried across a file switch, an undo pastes the previous file's text into this one.
- **Put the border on a wrapper.** CM6 measures its viewport against its own host element, so a border on that host is counted twice once the content scrolls.

**Highlights are pushed, not passed.** CM6 owns its document, so re-rendering the component will not move a decoration and rebuilding the view throws away the undo history and the caret. Push matches through `setSearchMatches(ranges, index)` from an effect, building the ranges with `searchMatchRanges(text, query)` from `utils/highlightMatches` - it runs the same `splitOnMatches()` the rendered preview highlights with, so the two modes cannot disagree about what counts as a hit. Pass `-1` for the active index when the query is a FILTER rather than a find bar: there is no cursor into the results, so every hit gets the same wash.

**A read-only pane needs both halves of the switch.** `<MarkdownEditor readOnly>` pushes `EditorState.readOnly` (refuses edits) AND `EditorView.editable.of(false)` (drops the caret and the `contenteditable` attribute). Setting only the first leaves a pane that still looks like a text box and silently swallows typing. Reach for it whenever the document is a reference rather than a draft - the Maestro Prompts tab renders the bundled default that way.

**A host-owned popup claims keys by returning `true` from `onKeyDown`.** That handler is installed at `Prec.highest`, so it sees the key before CodeMirror's own keymap; returning anything else leaves the key to the editor. Without the precedence the arrow keys would have already moved the caret by the time a popup was offered them, which is what makes a `{{`-autocomplete over CM6 possible at all (see `useEditorTemplateAutocomplete`). Returning nothing is the safe default and matches the pre-existing behaviour.

`MemoryViewer` is the reference implementation. Settings -> Maestro Prompts (`MaestroPromptsTab`) is the second rider and shows the variations: it opens on `edit` rather than `preview` (a prompt is opened here to be changed), and its Preview resolves `{{TEMPLATE}}` variables against the active agent first, because what matters about a prompt is what the agent finally receives.

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

### Horizontally Scrolling Strips (`useHorizontalScroll`)

`useHorizontalScroll(ref, resetKey?)` (`hooks/ui/useHorizontalScroll.ts`) returns `{ canScrollLeft, canScrollRight, scrollByPage, scrollIntoView }` for a row that overflows sideways. Reach for it whenever a set that keeps growing has to stay one row tall: the New Agent Wizard's provider strip is the first consumer, because a wrapping grid pushed the Continue button below the fold once the provider count passed eight.

**A strip is for the sets that do not fit, not for every set.** The same wizard drops back to a centered wrapping block whenever the tiles fit in two rows - see [Two Shapes for One Tile Set](#two-shapes-for-one-tile-set-agentgridlayout) below. Four tiles pinned to the left edge of a wide scrolling row read as a layout that forgot to reflow, and the affordances the hook exists to provide (fades, arrows) have nothing to point at.

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

### Two Shapes for One Tile Set (`agentGridLayout`)

The New Agent Wizard draws the same provider tiles two ways, and which one it
picks is derived from the count rather than authored:
`resolveAgentGridLayout(tileCount, containerWidth)` in
`components/Wizard/screens/AgentSelectionScreen/utils/agentGridLayout.ts`.

- **More tiles than fit in two rows -> the scrolling strip.** A third row pushes
  the Continue button below the fold, which is the whole reason the strip exists.
- **Two rows or fewer -> a centered wrapping block.** This is the everyday case
  once the user filters to the providers they actually have. A handful of tiles
  pinned to the left edge of a wide scrolling row reads as a layout that forgot
  to reflow.

Two rules that are easy to get wrong:

- **Balance the rows, do not fill them.** Five tiles across a four-wide row draws
  4 + 1, which looks like a mistake; `ceil(n / 2)` columns draws 3 + 2, which
  reads as an arrangement. The block then caps its own `maxWidth` at that many
  tiles, which is what forces the break - `flex-wrap` alone would fill the row.
- **Measure the OUTER wrapper, never the block itself.** The block's width is an
  output of the layout, so measuring it feeds the cap back in and it shrinks a
  step on every pass. `useElementWidth` on the full-width parent is the input.

The column count is also what up/down arrow movement steps by, so the component
reports it upward (`onColumnsChange`) rather than letting the keyboard handler
assume a shape. A handler moving by an assumed row width jumps the focus ring to
a tile that is not above or below the one the user is on, and the same width cap
that keeps the block from spreading wider than the strip is what keeps the two
in agreement. Fall back to a fixed column count until the first measurement
lands, since `useElementWidth` reports 0 on the first frame and in jsdom.

### Entity Tiles in the Usage Dashboard (`<EntityTile>`)

The Usage Dashboard's card grid (the agent grid in `AgentOverviewCards`) renders one tile shape: status dot, truncating title, badges, corner age, optional subtitle, a row of labeled stats, and a corner sparkline. That chrome lives once in `src/renderer/components/UsageDashboard/EntityTile.tsx` - border states (default / dashed / hovered / selected), the staggered `card-enter` animation, the clickable-button affordance, and the highlighted-stat accent coloring.

Adding a new dashboard grid means shaping data into `EntityTileStat[]` and passing it, not re-deriving 150 lines of tile styling. `EntityTile` is presentational: it takes formatted strings and colors and reports clicks, so callers keep their own sort/filter state and their own number formatting.

**A tile grid is not the default for every dashboard collection.** `TabBreakdown` (the per-tab list inside the agent detail modal) used to render tiles and now renders a `<SortableTh>` table: a tab row carries a name and four small numbers, which is little enough that rows scan faster than cards, and it keeps the view visually distinct from the agent tiles the reader just clicked through to reach it. Pick tiles when a row's worth of data needs the space; pick a table when it does not.

It deliberately lives under `UsageDashboard/` rather than in `renderer/widgets/`: widgets are barred from importing from `UsageDashboard/`, and this tile is an entity summary (many stats, one subject) rather than the widget library's `StatCard` (one headline metric).

### Turn Attribution Pills (`<TurnSettingPills>`)

Each assistant message in the AI transcript carries a centered footer row naming the configuration that produced it: the Claude token-source pill (`claude -p` / `TUI Wrapper`, from `getTokenSourcePill()`), then the model and effort the turn was SENT with. `src/renderer/components/ui/TurnSettingPills.tsx` renders the model/effort half - static badges that mirror the composer's interactive `ModelEffortPills` (Sparkles + accent for model, Gauge + warning for effort), because a finished turn's configuration is a fact, not a control.

The values come from `LogEntry.turnModel` / `turnEffort`, copied in `useBatchedSessionUpdates` from the tab's send-time stamp (`AITab.turnModel` / `turnEffort`, written by `codifyTurnSettings()` in `utils/providerTabSessions.ts`). Read the stamp, never the live tab or agent value: settings are codified at send, so a model change made while a turn streams applies to the next message and must not relabel the response already running. An unset value means the agent's own default applied, and that pill is omitted rather than labeled with a guess.

**A queued message freezes its settings when it is QUEUED, not when it dispatches.** Queuing is the send from the user's point of view - they picked a model, typed, hit Enter - but the turn may not spawn until several model changes later. So every path that builds a `QueuedItem` spreads `captureQueuedTurnSettings(tab, session)` into `item.turnSettings`, and both consumers read it back through `codifyQueuedTurnSettings(item, tab, session)`: `markTabRunningQueuedItem()` for the pills, and `agentStore.processQueuedItem()` for the actual `sessionCustomModel` / `sessionCustomEffort` it spawns with. The queued-item rows in the inline list and the Execution Queue browser render the same `<TurnSettingPills>`, so the user can see which pending message is on the big model before it runs.

The presence of the `turnSettings` OBJECT is the capture flag, not the presence of its fields. `undefined` model/effort inside a present object means "the agent's default was in force when I queued", which is a real choice - never write `item.turnSettings?.model ?? liveModel`, or an item queued on the default silently inherits whatever the user selected afterwards. The object is absent only on items restored from a build that predates the capture, which is the one case that falls back to live values.

**The token-source half is opt-in.** The `showProviderModePill` display setting (Settings -> Display -> Provider Mode Pill, default OFF) suppresses the `claude -p` / `TUI Wrapper` pill everywhere it appears: the chat footer (`TerminalOutput`), the History list row (`HistoryEntryItem`), and the history detail view (`HistoryDetailModal`). The model and effort pills are NOT gated by it - they are separate facts about the turn. All three surfaces read the store field directly rather than threading a prop, so a new surface that renders `getTokenSourcePill()` has to remember the gate itself.

Two traps when touching this row:

- `collapsedLogs` in `TerminalOutput` merges consecutive non-user entries into one rendered entry built from `[0]`. A group can lead with a system banner that carries no stamp, so the merge lifts `turnModel` / `turnEffort` from the first grouped entry that has them - the same fix `renderStyle` needed.
- `LogItem`'s memo comparator lists every field that affects rendering. A new pill field that is not in that list will not repaint when it changes. `showProviderModePill` is passed down as a primitive prop (not read from the store inside `LogItem`) for exactly this reason, and it is listed in the comparator.

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
- **A scale only reads as a scale on one line.** A provider with seven stops is wider than the wheel's column, so the effort row sizes to its content (`w-max`) and breaks out of that column rather than folding `max` and `ultra` onto a second row; `max-w-[92vw]` is what brings wrapping back on a window too narrow to hold the line at all. Sizing to content is also why the space either side of the pills is still scrim - a `w-full` row swallows the mousedown across the whole column, so clicking beside the pills stopped closing the modal.
- **Type-to-jump beats a scrollbar.** A printable key jumps the wheel to the matching model; repeating a letter walks every model starting with it. Gate it on `isTypeaheadKey` (no `metaKey` / `ctrlKey` / `altKey`) - swallowing modified keys would stop `Cmd+W` reaching the window and trap the user inside the surface.

**No legend, but still a graphical exit.** The surface shows no shortcut caption: the axes are self-describing, and the caption was the only thing on screen that had to be read rather than seen. [Every Modal Needs a Graphical Exit](#every-modal-needs-a-graphical-exit-escclosebutton) is still satisfied without a button row - clicking the scrim cancels and double-clicking a row applies, both routed through the same handlers Escape and Enter use, so pointer and keyboard cannot drift.

Anything with an inline `transition` must carry a class the reduced-motion block can name (`.maestro-wheel-row`, `.maestro-effort-stop`, `.maestro-keycap`); the blanket `.transition-*` reset in `index.css` only matches Tailwind's utility classes.

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

### Restoring a Transcript's Scroll Position

An AI tab is left in one of TWO states, and they restore differently. `TerminalOutput` takes both `initialScrollTop` (the tab's saved `scrollTop`) and `initialIsAtBottom` (the tab's saved `isAtBottom`) and hands them to `useTerminalOutputScroll()`, and it needs both.

**Following the tail** (`isAtBottom` true, or unset). The saved `scrollTop` is only a snapshot of where the bottom HAPPENED TO BE at save time, and the transcript keeps growing while the tab is off screen. Restoring that number verbatim drops the user however far the agent wrote while they were away, and because the stale offset is then far above the new bottom, the restore ALSO pauses auto-scroll - so the transcript will not even follow the output that stranded them. Clicking a toast to read a finished reply landed thousands of pixels above it, with the tail switched off. Such a tab restores to the BOTTOM and ignores the saved number.

**Parked mid-history** (`isAtBottom` false). The offset is exactly right and must be honored: new entries are appended BELOW, so what the user was reading has not moved. This restore pauses auto-scroll on purpose, or the MutationObserver yanks the view straight back down.

`undefined` counts as at-bottom, which is the same default the unread gate in `useAgentDataListener` uses (`targetTab.isAtBottom !== false`). Keep the two spellings identical - a tab that is "at the bottom" for unread purposes and "parked" for scroll purposes is the bug above wearing a different hat.

**Neither target is reached in one frame.** A single `requestAnimationFrame` proves the DOM is MOUNTED, not that its height has settled: images are still decoding, fonts still swapping, code blocks still re-highlighting. `scrollHeight` is short on that first frame and `maxScroll` with it, so the restore clamps to less than it was asked for and the tab opens above where the user left it. The restore therefore re-attempts across frames, and the two states latch differently:

- A fixed offset latches as soon as the content is tall enough to hold it, so the restore re-applies under a `ResizeObserver` on the container until it lands, with `SCROLL_RESTORE_SETTLE_MS` as a hard stop.
- The bottom cannot be latched that way at all, because `maxScroll` MOVES with every late image. "Landed on the bottom" is true on the first frame and wrong on the next, so a tail-following tab does not run the offset restore: the mount-time bottom jump plus the follow-the-tail `MutationObserver`/`ResizeObserver` keep it pinned to the live bottom as the content grows.

A genuine user scroll during the settle abandons the restore (`wheel` / `touchstart` on the container tear the retry down); their input wins, because a restore that keeps yanking the view is worse than landing slightly high. An in-flight cross-tab search jump wins for the same reason (`jumpInFlightRef`).

Do not "simplify" this back to a single saved offset. A pixel offset cannot express "wherever the newest message is", and that is the state most tabs are actually left in.

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

**Smooth or instant is decided by how the user moves through the list**, not by taste. `useScrollIntoView(isOpen, selectedIndex, itemCount, behavior)` defaults to `'smooth'`, which is right for a short dropdown stepped one item at a time (the slash-command, tab-completion, and @-mention popovers in `InputArea`). Pass `'auto'` for a list the user HOLDS an arrow key on: key repeat fires faster than a smooth scroll animates, so each repeat cancels the animation in flight and the list lurches and stalls instead of stepping. An instant scroll per keypress is what reads as smooth under key repeat. `GroupChatHistoryPanel` is the first `'auto'` caller, and it pairs the hook with `scroll-p-2` on the scroll container so `block: 'nearest'` leaves a sliver of the next entry visible at the edges - without the padding the selection pins flat against the boundary and a held arrow looks like the list stopped moving.

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

### Surface-Local Chords (`useCommandKeyShortcut`)

`useCommandKeyShortcut(key, handler, enabled)` in `src/renderer/hooks/keyboard/useCommandKeyShortcut.ts` is the primitive for a bare Cmd/Ctrl+`<key>` chord that ONE visible surface claims for as long as it is up: Cmd+S in an editor pane (`useSaveShortcut` is a preset over it), Cmd+R on the Usage Dashboard's Anthropic Usage / OpenAI Usage panels (`useQuotaRefresh`'s `refreshHotkey` option). It listens in the capture phase with `preventDefault`, so it wins against a focused textarea and against the browser's own default for the chord, and it requires the modifier ALONE - a Shift- or Alt-qualified chord falls through to whatever else owns it.

Do NOT reach for it to add a global shortcut. Those belong in `constants/shortcuts.ts` and must be matched through `eventMatchesShortcutKeys` so the user can rebind them. And do NOT let a component claim a chord just because it is mounted: `refreshHotkey` defaults to false and the dashboard opts in only on the tab that renders the panel, because two mounted panels both answering Cmd+R would refresh whichever one registered last. When a surface advertises its chord in a tooltip, gate the hint on the same flag that claims it, and build the label with `formatShortcutKeys()` so it does not read `⌘R` on Windows.

### A Shortcut and Its Palette Entry Must Name Each Other

Every user-reachable action wants both a chord and a command-palette entry, and the palette entry is where a user LEARNS the chord. Two silent failures live at that seam, and `src/__tests__/renderer/components/QuickActionsModal/paletteShortcutCoverage.test.ts` locks both down:

- **A dead lookup.** `shortcuts` and `tabShortcuts` are `Record<string, Shortcut>`, so `shortcuts.maestroCue` type-checks perfectly, evaluates to `undefined`, and renders an entry with no chord beside it. The real id was `openCue`; three more (`mergeSession`, `sendToAgent`, `summarizeAndContinue`) named shortcuts that never existed. Nothing in `tsc` or a render test catches this - the entry looks fine, it is simply missing the one thing that teaches the keyboard.
- **A missing entry.** A shortcut with no palette command is reachable only by someone who already knows the chord, which is the opposite of what the palette is for.

The test greps the whole `QuickActionsModal/` tree for `shortcuts.<id>`, `tabShortcuts?.<id>`, and `FIXED_SHORTCUTS.<id>`, checks each id against the real maps, and then asserts the reverse: every id in `DEFAULT_SHORTCUTS` / `TAB_SHORTCUTS` is either wired to an entry or listed in `NO_PALETTE_ENTRY_BY_DESIGN` (the palette takes focus, so `quickAction` and `agentSwitcher` cannot be invoked from inside it) or `MISSING_PALETTE_ENTRY` (a real gap, each one waiting on a callback threaded to the palette). It is an exact ledger, not an allow-anything set: **adding a shortcut fails this test until you either wire its entry or record it as a gap with a reason.** Remove an id from `MISSING_PALETTE_ENTRY` in the same change that adds its entry.

A palette entry may also name a chord it does not own: `FIXED_SHORTCUTS.filterSessions` and friends are all Cmd+F scoped by focus, and naming the chord on the `Filter...` entries is how a user learns the palette is not the only way in.

### Keyboard Mastery Gamification

Shortcut usage is tracked for a gamification system (`keyboardMasteryStats`). The `recordShortcutUsage` function in settings increments counters and can trigger level-up celebrations.

The percentage is `countUsedBoundShortcuts(bound, used) / bound.length`, where `bound` comes from `collectBoundShortcuts()` in `src/renderer/constants/keyboardMastery.ts`. Every surface that shows a mastery figure (the help modal's bar, the Usage Dashboard ring and its Unused Shortcuts list, the leaderboard payload, the store's level-up check) runs its maps through that one helper, so they cannot disagree about the total. Unbound shortcuts are excluded from BOTH ends: they still appear in the help modal's list marked `Unassigned` (the user should know the action exists and can bind it), but they carry no progress circle, never appear as "unused", and never sit in the denominator. See [RENDERER-SERVICES.md -> keyboardMastery.ts](RENDERER-SERVICES.md#keyboardmasteryts-87-lines).

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

"4 providers available locally of 11 supported", plus the toggle that switches
between the two lists. Most of the providers Maestro supports are not installed
on any given machine, so listing all of them buries the two or three a user can
pick behind a wall of dimmed rows. Both provider pickers - the wizard's tile
strip and the New Agent modal's list - show this one bar, so the count and the
toggle cannot disagree about what is being filtered.

**Which way the toggle starts is per-picker, and deliberately not the same.**
The New Agent modal opens FILTERED, because it is the everyday path and its user
already knows what they have installed. The wizard opens on ALL supported
providers, because it is a first-run screen: someone whose provider is installed
but undetected (a custom path, an SSH host detection could not probe) would
otherwise open the wizard, not see it, and conclude Maestro does not support it.
The filtering RULES below are shared regardless, so the two can only differ in
where they start, never in what "available" means.

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
  The Auto Run panel uses the same treatment over its document, so zooming reads
  identically whether a document is open in a file tab or in the Right Bar. Pin it
  with a `sticky top-* z-20 h-0` row rather than `absolute`: sticky needs no
  positioned ancestor and the zero height keeps the pill from displacing content.
- `size` - `'md'` (default) or `'sm'`, which drops the buttons from `w-7 h-7` to
  `w-6 h-6` and the icons from `w-4` to `w-3.5`. Use `'sm'` where the surface is
  narrow (the Auto Run panel in the Right Bar) or in a dense `text-xs` button row,
  where the default squares stand a couple of pixels taller than the row and read
  heavier than the buttons beside them.
- **A pane with a read mode and an edit mode gets two scales, not one.** Auto Run
  keeps `autoRun.previewFontScale` and `autoRun.editFontScale` and passes whichever
  matches the current mode; reading rendered prose and editing Markdown source are
  comfortable at different sizes, and one shared value makes each mode fight the
  other. Both hooks stay mounted, so switching back restores the size that mode was
  left at. When the scale drives a `<textarea>`, scale the `lineHeight` with it
  (Auto Run uses a unitless `1.45`) - a fixed `20px` row crams taller glyphs once
  zoomed - and pass the scale as `remeasureKey` to `<TextareaLineNumbers>`.
- `collapsible` (floating only) - rests as a circle the size of that Table of Contents
  button and expands to the full pill on hover or keyboard focus. The buttons are
  CLIPPED, not unmounted, so tabbing into them opens the pill instead of skipping a
  control the user cannot see. The resting circle tints itself with the theme accent
  while the scale is not 100%, so the collapsed state still says the pane is zoomed.
- The percentage in the middle appears only once zoomed and doubles as the reset.
- The file preview also binds bare `-` / `+` (and `=` / `_`) to the two steps and `0`
  to the reset, guarded on `canScaleFontForView()` and on `isTextInputTarget(e.target)`
  so the find bar and the CM6 editor keep their keys. Any OTHER surface wanting those
  keys uses `useScaleShortcuts()` (below) rather than a second copy of the branch; the
  file preview keeps its inline version because it sits inside one guarded key chain
  whose ordering decides which branch answers a key.

### `useScaleShortcuts()` (`src/renderer/hooks/ui/useScaleShortcuts.ts`)

Bare `+` / `-` / `0` zoom for any surface driven by `useScalePreference`. Pass the
control and an `enabled` flag:

```tsx
const thumbnailScale = useScalePreference('stagedImages.thumbnailScale', RANGE);
const isTopLayer = useIsTopLayer(MODAL_PRIORITIES.STAGED_IMAGES_ORGANIZER);
useScaleShortcuts(thumbnailScale, { enabled: isTopLayer });
```

- **Modifier-free on purpose.** An event carrying Cmd / Ctrl / Alt is left alone,
  because `Cmd+=` / `Cmd+-` is the application's own font zoom and must keep working
  while a zoomable surface is open.
- `=` and `_` are the unshifted and shifted twins of `+` and `-`, so the user never
  has to think about Shift; `0` is the reset.
- It listens on `window` in the capture phase, not on the surface's node: focus falls
  to the body when a nested overlay closes, and `stopPropagation` keeps a bare `0` or
  `-` out of the global shortcut handler. `isTextInputTarget(e.target)` keeps a filter
  box typing normally.
- **Gate it with `useIsTopLayer(priority)`** (`src/renderer/hooks/ui/useIsTopLayer.ts`),
  or a surface underneath an open overlay answers the same keypress. That hook is also
  the shared answer to "am I the top layer?" - `AutoRunExpandedModal` uses it to reclaim
  focus.
- Name the keys in the `ScaleControl` tooltips with `shortcutHint`. A shortcut the
  button never mentions is one nobody finds.

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

**Pass `remeasureKey` when the textarea's typography can change without its box
changing.** The component re-measures on its own `ResizeObserver`, and a font-size
change leaves the border box exactly the same size, so nothing fires and the
numbers keep the row heights of the OLD font until the next keystroke. Auto Run
passes its edit-mode font scale; any surface with a font zoom over a numbered
textarea needs the same.

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

`usePersistedChoice(storageKey, options, defaultValue)` in
`src/renderer/hooks/ui/usePersistedChoice.ts` is the enum counterpart, for a
preference whose answer is one of three words rather than yes/no (the Extensions
grid's A-Z / Newest sort). It validates the stored string against the option
list on read, so a mode left behind by an older build falls back to the default
instead of stranding the surface in a state its control can no longer express.
Both hooks reach Storage through `safeLocalStorage()`
(`src/renderer/utils/safeLocalStorage.ts`), which is also what
`useScalePreference` uses - do NOT write a fourth private `storage()` guard.

---

## Right-Click Image Menu (`ImageContextMenuHost`)

Every image anywhere in the app - raster `<img>`, agent-authored inline `<svg>`, Mermaid charts, thumbnails, the lightbox - gets the same three actions on right-click: **Copy Image**, **Save to Project...**, and **Save As...**.

**Surfaces wire up nothing.** `<ImageContextMenuHost>` is mounted once in `App.tsx` and owns a single delegated `contextmenu` listener on the document that resolves the image from the click target. Do NOT add an `onContextMenu` to a new image surface, do not call a hook, and do not add a per-surface copy/save button pair. There is no per-surface wiring to forget, which is the entire point: the menu used to hang off individual components, so every new image surface silently shipped without it.

- `resolveImageFromEvent(e)` (exported from `ImageContextMenuHost.tsx`) decides what counts. It skips three things: anything inside a `[data-no-image-menu]` subtree, lucide icons (which are `<svg>` but carry the `lucide` class), and anything under 32px rendered (favicons, inline badges).
- **Opting a surface out:** put `data-no-image-menu` on its container. Use this only when the surface owns its own right-click behavior (e.g. `AnnotatorCanvas`). A menu that already handled the click and called `preventDefault()` is skipped automatically via `defaultPrevented` - that is how `LinkContextMenu` / `FileContextMenu` coexist with this one.
- `utils/imageExport.ts` does the work: `copyImageElementToClipboard()` returns `'image' | 'text' | 'failed'` so the UI can admit when only markup or a URL reached the clipboard rather than claiming a paste-able image. `saveImageToProject()` writes into the project's `DIAGRAMS_DIR` (`.maestro/diagrams/`), works over SSH, and calls `requestFileTreeRefresh(target.sessionId)` after a successful write so the new file shows up in the Files panel instead of waiting for its timed refresh (the toast offers to open it, so a stale tree reads as the save having failed). That refresh lives inside `saveImageToProject` rather than in the menu host for the same reason the menu itself is delegated: a future save surface gets it with no wiring. `saveImageElementToDisk()` is the native-dialog path and writes wherever the user points it, which is usually outside any workspace, so it does not refresh. Binary writes go through `fs.writeImageFile` (`fs.writeFile` is UTF-8 and would corrupt the bytes).
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

## Right-Click Image Menu (`ImageContextMenuHost`)

Every image anywhere in the app - raster `<img>`, agent-authored inline `<svg>`, Mermaid charts, thumbnails, the lightbox - gets the same three actions on right-click: **Copy Image**, **Save to Project...**, and **Save As...**.

**Surfaces wire up nothing.** `<ImageContextMenuHost>` is mounted once in `App.tsx` and owns a single delegated `contextmenu` listener on the document that resolves the image from the click target. Do NOT add an `onContextMenu` to a new image surface, do not call a hook, and do not add a per-surface copy/save button pair. There is no per-surface wiring to forget, which is the entire point: the menu used to hang off individual components, so every new image surface silently shipped without it.

- `resolveImageFromEvent(e)` (exported from `ImageContextMenuHost.tsx`) decides what counts. It skips three things: anything inside a `[data-no-image-menu]` subtree, lucide icons (which are `<svg>` but carry the `lucide` class), and anything under 32px rendered (favicons, inline badges).
- **Opting a surface out:** put `data-no-image-menu` on its container. Use this only when the surface owns its own right-click behavior (e.g. `AnnotatorCanvas`). A menu that already handled the click and called `preventDefault()` is skipped automatically via `defaultPrevented` - that is how `LinkContextMenu` / `FileContextMenu` coexist with this one.
- `utils/imageExport.ts` does the work: `copyImageElementToClipboard()` returns `'image' | 'text' | 'failed'` so the UI can admit when only markup or a URL reached the clipboard rather than claiming a paste-able image. `saveImageToProject()` writes into the project's `DIAGRAMS_DIR` (`.maestro/diagrams/`) and works over SSH; `saveImageElementToDisk()` is the native-dialog path. Binary writes go through `fs.writeImageFile` (`fs.writeFile` is UTF-8 and would corrupt the bytes).
- `ImageDestinationModal` is the "Save to Project..." destination picker (folder, file name, SVG/PNG format, live path preview). Not to be confused with `FilePreview/ImageSaveModal`, which is the annotator's overwrite-vs-save-as prompt.

`serializeSvg()` stamps the measured size onto the clone when the source has none. Mermaid sizes charts with CSS (`width="100%"`), and without this the rasterized copy comes out cropped at the browser's 300x150 default.

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

## Left Bar Header Width Gates

The Left Bar header is a single row that neither wraps nor scrolls, and the user can drag the sidebar down to 256px. Every control added to it (the badge pill, the now-playing pill, the LIVE toggle) takes room from a fixed budget, so the row needs a declared yield order rather than whatever CSS happens to shrink first.

**The row is three zones: identity, indicators, menu.** The wand and the wordmark sit in a `shrink-0` zone on the left, the hamburger in a `shrink-0` zone on the right, and every status control goes in the `flex-1 justify-center min-w-0` band between them (`data-testid="sidebar-header-indicators"`). `flex-1` is what centers the band: it takes whatever the two fixed zones leave and centers its contents in that, so the indicators read as their own group rather than as a tail on the wordmark. A new status control belongs in the band, not beside the wordmark.

**The MAESTRO wordmark is drawn in full or not at all.** It used to carry `truncate`, which rendered the brand as "MAE..." on a narrow sidebar. A clipped brand reads as a rendering bug, not as a deliberate space saving, so `SessionList` gates it on a width instead:

```ts
const showWordmark =
	leftSidebarWidthState >=
	WORDMARK_MIN_WIDTH + livePillReserve + headerBadgeWidth + nowPlayingReserve;
```

The wand button stays at every width, so the header never loses its identity or its switch-agent affordance.

**The now-playing pill is the row's shrink target of last resort.** Something has to yield, and the filename inside that pill is the only thing in the row that can be clipped without looking broken. It is therefore `min-w-0` rather than `shrink-0` (a flex item defaults to `min-width: auto` and refuses to go below its content, so both the pill and the button inside it need `min-w-0`), while both transport buttons, both icons, and the divider stay `shrink-0` - they are the entire transport a minimized player has.

**The wordmark yields ahead of the indicators, so it stops charging them once it is gone.** The LIVE toggle's label threshold adds the badge's reserve only while `showWordmark` is true:

```ts
const showLiveLabel =
	leftSidebarWidthState >= LIVE_LABEL_MIN_WIDTH + (showWordmark ? headerBadgeWidth : 0);
```

Charging for the badge either way is what left a 256px sidebar showing a bare radio dot while the ~110px the wordmark had just vacated sat empty. Above the wordmark threshold the sidebar is already wide enough for both, so the term is only ever a no-op there.

Three rules for adding a control here:

- **Reserve for the form the control is actually in, not its widest form.** The now-playing pill sheds its filename below `NOW_PLAYING_LABEL_MIN_WIDTH`, so `NOW_PLAYING_COMPACT_RESERVE` and `NOW_PLAYING_LABEL_RESERVE` are separate numbers. Reserving the wide figure at every width hides the wordmark to make room for a pill that is no longer that wide.
- **Ask the store whether the control is on screen, once.** `selectNowPlayingVisible` in `mediaPlaybackStore` answers that for the pill, and both the pill and the header's reserve read it. Two copies of "is it visible" is how a width reserve ends up describing a header nobody is looking at.
- **Charge a reserve only against what is still drawn.** A control that competes with the wordmark stops competing the moment the wordmark drops out; keeping its cost in a downstream threshold spends room nothing is occupying.

Testing this drives `leftSidebarWidth` in `useSettingsStore` directly, the same way the LIVE-pill tests do; jsdom measures nothing, so a real-layout test is not available. Assert the wordmark's ABSENCE at narrow widths, not that `truncate` is gone - the latter passes on a wordmark that still renders clipped.

---

## Right Bar Toolbar Density (`historyPillDensity`)

The History panel's toolbar is the same problem one panel over, and it is worth reading as the counter-example to a static threshold. The row is `[search button][USER][AGENT][AUTO][CUE][help button]`, it neither wraps nor scrolls, and it used to decide its own density from one number: `rightPanelWidth < RIGHT_PANEL_COMPACT_THRESHOLD`.

**A panel width cannot answer "does this fit".** What the pills need also depends on the interface font (the root is a proportional face now, and Inter's capitals average nearer 0.7em where Roboto Mono was a flat 0.6em), on the Cmd+= zoom, and on whether Cue is on - three pills or four. Same 420px panel, several different answers. When the answer came out wrong nothing shrank, because every child was `flex-shrink-0`: the overflow spilled out of both ends of a centred row and clipped the search and help buttons off the edges. A control the user cannot see is a control they do not have.

The fix is to measure, and the shape of it generalizes:

- **Measure the PARENT, never yourself.** The row's own width is the thing being decided, so a figure read from it is circular: it renders at some rung, measures itself, concludes it fits (it is its own width, so it always does), and never moves. `useFreeWidthInFlexRow` (in `useElementWidth.ts`) reports the parent's content box minus its other children and the gaps, which nothing about the row can influence.
- **Knowing the free width is not the same as taking it.** An earlier pass gave the row `flex-1` so it could measure itself, and that swallowed the whole toolbar: the search and help buttons were shoved against the two panel edges with a lake of dead space between them and the pills. The row is natural-width with `min-w-0` and its default shrink, so the toolbar's `justify-center` gathers pills and buttons into one centred group, and a squeeze the ladder has not caught up with shrinks THIS row instead of pushing a neighbour out. The ladder is opt-in via `fillWidth`; the Director's Notes copy sits beside an activity graph that already consumes the leftover width, so there is no free figure to read and it leaves the flag off.
- **Measure a mirror, never the live controls.** A hidden, out-of-flow copy of the labels at the BASE size gives a width that is a property of the font rather than of the rung currently rendered. Feeding the rendered pills back in would make each choice depend on the last one and oscillate.
- **Everything else is arithmetic, not a second measurement.** Label advance scales linearly with font size and the tracking is in `em`, so one measured width covers every rung. The padding, icon, and gaps are rem-based, so they are computed from the live root font size rather than from pixel literals - a literal is right only at a 16px root, which is the bug in miniature.
- **Declare a yield order.** `PILL_DENSITIES` gives up the icon first (it repeats what the pill spells out in words, and the glyph plus its gap is over an em per pill), then padding, then two steps of type size. Line height is fixed at every rung, so the pills keep one height and the toolbar does not change shape as the panel is dragged.
- **Keep a last-resort guarantee.** `min-w-0` plus `overflow-hidden` means that at an interface font the bottom rung cannot absorb, the pills clip and the buttons do not. Pick which one loses; do not leave it to paint order. Note `min-w-0` is the load-bearing half - a flex item defaults to `min-width: auto` and refuses to go below its content, which is how the row pushed its neighbours out in the first place.
- **Keep the static prediction as the pre-measurement prior.** `useElementWidth` reports 0 until its first observation, so the first paint has nothing to compare. The old `compact` flag is exactly the right guess for that one frame, which is why the prop stayed.

The selection logic is a pure function (`resolvePillDensity` in `src/renderer/components/History/historyPillDensity.ts`) precisely so it can be tested: jsdom has no layout engine, so the component test can only assert the layout contract (the row fills, the mirror exists, the overflow is contained) and the arithmetic has to be exercised separately.

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

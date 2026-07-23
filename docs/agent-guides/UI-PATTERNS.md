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

Dialog-style modals can offer persisted, center-anchored drag-to-resize via `useResizableModal()` (`src/renderer/hooks/ui/useResizableModal.ts`), backed by pure sizing/clamping helpers in `src/renderer/utils/modalSizing.ts` and the handle UI in `src/renderer/components/ui/ResizeHandles.tsx`. Sizes persist in the `modalSizes` setting (`src/renderer/stores/settingsStore.ts`: `setModalSize`/`resetModalSizes`), clamped to a `320x240` minimum and the `90vw x 90vh` app-wide ceiling described above, with per-modal `minSize`/`maxSize` overrides for dense tools or width-capped reading surfaces (e.g. Director's Notes caps `maxSize.width` at `1050`).

The shared `<Modal>` component wires this up automatically via `resizable`/`resizeKey`/`defaultSize`/`minSize`/`maxSize` props, but **resizing only activates when the caller passes an explicit, stable `resizeKey`.** Omitting it (the default for most `<Modal>` callers - simple confirms, help dialogs) falls back to the legacy fixed `width`/`maxHeight`/`scaleWidthWithFont` sizing instead of a title-derived key: a title/priority-derived fallback isn't stable across unrelated dialogs (every default-titled `ConfirmModal` would otherwise collide on one persisted size). Bespoke modal shells that don't use `<Modal>` (e.g. `QuitConfirmModal.tsx`) should stay off `useResizableModal` entirely if they're simple, non-resizable confirms.

When two toggleable states of the same modal need independent footprints (e.g. Prompt Composer's compact vs. fullscreen), use two distinct `resizeKey`s (`prompt-composer-compact` / `prompt-composer-fullscreen`) rather than one shared key with a mode-dependent `defaultSize` - `defaultSize` is only consulted before the first saved size exists, so a single key would let one mode's manual resize silently pin the other mode's size too.

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
  picker, file links via `remarkFileLinks`, right-click link/file/SVG context
  menus (inline `<svg>` diagrams get a Copy Image / Save Image menu via
  `SvgContextMenu` + `utils/svgExport.ts`), IPC-loaded local images, chat line
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

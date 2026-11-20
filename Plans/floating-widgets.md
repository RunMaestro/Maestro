# Floating Widgets: desktop-level windows for the gauge and the media player

Status: APPROVED DESIGN 2026-10-19. Built by the `2026-10-19-Floating-Widgets` playbook on `rc`.

## Goal

The Throughput Gauge and the media player float over the Main Window today, so they cannot leave the app's rectangle. Make each one its own desktop-level window, like Quick Chat: it floats over any app, on every Space, across monitors, and survives the Maestro window being minimized or behind something else. A Cappella's voice widget adopts the same pattern afterwards on the `acappella` branch.

## What must not change

- The browser build (`isWebDesktop()`) cannot open windows. There, both widgets render exactly as today: the in-app cards `FloatingThroughputGauge` and `FloatingMediaPlayer`.
- Every way in keeps working: hotkeys, palette entries, hamburger menu items, `maestro-cli throughput-gauge ...`, `maestro-cli open-file` (with `--queue`), the Now Playing indicator, the play/pause shortcut.
- The Throughput Gauge is an Encore Feature. While `encoreFeatures.throughputGauge` is off, its window does not exist and nothing about it runs (see memory "Disabled feature = zero footprint").
- A widget window never takes focus when it appears. The user is typing somewhere else.

## Architecture

### 1. Main process: `src/main/floating-widgets/`

- `window-bounds.ts`: helpers shared with Quick Chat. Move the bounds-sanitizing (`positive()`, finite x/y) and the "saved spot on a connected display" resolve (`resolveVisibleWindowPosition` + `screen.getDisplayMatching` clamp) out of `src/main/quick-chat/quick-chat-window.ts`. Quick Chat then imports them, with no behavior change.
- `floating-widget-window.ts`: `createFloatingWidgetWindow(spec, deps)` returns a controller for one widget: `show()`, `hide()`, `toggle()`, `isVisible()`, `getBounds()`, `setBounds(partial)`, `close()`, `getWindow()`, `webContents ready` tracking.
  - `spec`: `{ id: FloatingWidgetId; defaultSize; minSize; defaultPosition(workArea, size) }`.
  - The window is created lazily on first `show()` or first command and is only hidden after that, never closed, except by `close()` (feature off, app quit).
  - Window options are Quick Chat's: macOS `type: 'panel'`, `frame: false`, `transparent: true`, `backgroundColor: '#00000000'`, `hasShadow: true`, `resizable: true`, no minimize, maximize or fullscreen, `skipTaskbar: true`, `show: false`, `sandbox: true`, `contextIsolation: true`. `setAlwaysOnTop(true, 'floating')` and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. Deny `window.open` and navigation away. Load the renderer URL with `?floatingWidget=<id>`.
  - Show with `showInactive()`, never `focus()`. Reveal a fresh window on `ready-to-show` OR `did-finish-load` + 150ms, whichever comes first. A transparent panel may never emit `ready-to-show` (memory "Transparent panel skips ready-to-show").
  - Bounds persist per widget in the window-state store under a new key `floatingWidgets: Partial<Record<FloatingWidgetId, { x?: number; y?: number; width?: number; height?: number }>>` (type in `src/main/stores/types.ts`, next to `quickChat`). Save debounced with `WINDOW_STATE_SAVE_DEBOUNCE_MS`, flushed on hide and close, ignored while closing. Never save a size below the spec's minimum (Quick Chat's `recordBounds` explains why).
  - Register in the window registry with a new `WindowKind` value `'floating-widget'` (`src/main/window-registry.ts`). Remove it on `closed`.
- `floating-widget-relay.ts`: the bridge between the window that OWNS a widget's live state (its "authority") and the windows that show or drive it.
  - Authority per widget: `throughput-gauge` is the primary app window (it runs the rate engine). `media-player` is the media-player widget window (it owns the one media element).
  - IPC (`ipcMain.handle` / `on`, registered once):
    - `floatingWidgets:show|hide|toggle|isVisible|getBounds|setBounds (id, ...)`
    - `floatingWidgets:publishState (id, state)`: from the authority. Main keeps the latest state per widget and sends `floatingWidgets:state (id, state)` to every other live window (app windows and widget windows), using the existing safe-send helpers.
    - `floatingWidgets:getState (id)`: the latest state, for a window that just loaded.
    - `floatingWidgets:command (id, command)`: from any window. Main forwards `floatingWidgets:command (id, command)` to the authority. If the authority is a widget window that does not exist or has not signalled ready, main creates it (without showing it) and queues the command until `floatingWidgets:ready (id)` arrives from that window.
    - `floatingWidgets:ready (id)`: sent by a widget window once its root has mounted and subscribed.
  - Commands and state are plain JSON (structured-clone safe). Validate `id` against `FLOATING_WIDGET_IDS` on every handler.
- `src/shared/floatingWidgets.ts`: `FLOATING_WIDGET_IDS = ['throughput-gauge', 'media-player'] as const`, `FloatingWidgetId`, `isFloatingWidgetId()`, the specs' default and minimum sizes, and the command and state types each widget uses.
- Wiring in `src/main/index.ts`: build both controllers next to `quickChatController`, with the same `windowDeps`. Close the throughput window when `encoreFeatures.throughputGauge` turns off, and never create it while off (follow `store.onDidChange('encoreFeatures', ...)` the way the Encore lifecycle does). Close both on app quit, where Quick Chat closes.
- Preload: `src/main/preload/floatingWidgets.ts` exposes `window.maestro.floatingWidgets` (show, hide, toggle, isVisible, getBounds, setBounds, publishState, getState, onState, sendCommand, onCommand, ready). Register it in `src/main/preload/index.ts`, type it in `src/renderer/global.d.ts`, and add the events to the web bridge allow list (`src/main/web-server/handlers/bridgeDenyList.ts`) only if the browser build needs them (it does not; leave them out and say so in a comment).

### 2. Renderer foundation

- `src/renderer/utils/floatingWidgetMode.ts`: `floatingWidgetsAvailable()` is `!isWebDesktop() && !!window.maestro?.floatingWidgets`. Every host branches on this one function.
- `src/renderer/main.tsx`: `?floatingWidget=<id>` mounts `FloatingWidgetRoot`. Follow `CadenzaHudRoot` (`src/renderer/cadenzaHud.tsx`): `loadAllSettings()`, `useReloadSettingsOnExternalChange()` (`src/renderer/hooks/settings/useWindowSettingsSync.ts`), `useResolvedTheme()`, a `floating-widget-window` class on html and body for a transparent background, and remove `#initial-splash`.
- `src/renderer/floatingWidget/FloatingWidgetRoot.tsx` picks the widget body by id and calls `floatingWidgets.ready(id)` once mounted.
- `src/renderer/floatingWidget/FloatingWidgetFrame.tsx`: the card that fills the window, with a rounded border, the theme background and a title strip. The strip is the OS drag region (`WebkitAppRegion: 'drag'`), and its buttons are `no-drag`. It has a close (X) control and closes on Escape. The window itself is resizable by the OS, so there is no in-card resize grip.
- `src/renderer/utils/windowStoreMirror.ts` holds the one sync helper every widget uses:
  - `publishStoreState(id, store, select)`: authority side. Subscribe to a zustand store and publish `select(state)` when it changes (shallow-compare and coalesce to at most one publish per 100ms). Publish once immediately.
  - `mirrorStoreState(id, store, apply)`: replica side. Read `getState(id)` once, then apply every `onState` snapshot with `store.setState(apply(snapshot))`. Never publish back.
  - `sendWidgetCommand(id, command)` / `onWidgetCommand(id, handler)`.

### 3. Throughput Gauge

- `useThroughputCapture` stays in the primary window, unchanged.
- Extract the gauge body (styles, layouts, scope caption, settings popover trigger) out of `FloatingThroughputGauge.tsx` into `ThroughputGaugeBody.tsx`. The in-app card and the widget then draw the same thing.
- `ThroughputGaugeHost`:
  - While `floatingWidgetsAvailable()`, it renders no in-app card. It publishes `{ rates, peak, history }` with `publishStoreState('throughput-gauge', ...)` and drives the window from `throughputGaugeStore.visible`: true calls `floatingWidgets.show`, false calls `hide`.
  - It handles the widget's commands `hide` (calls `store.hide()`, so the visible latch and the window agree) and `reset-peak`.
  - When the feature flag is off, nothing runs.
- `src/renderer/floatingWidget/ThroughputGaugeWidget.tsx` renders `ThroughputGaugeBody` from the mirrored store inside `FloatingWidgetFrame`. Its X and Escape send the `hide` command; they do not hide the window directly. Settings edits go through the settings store as today, and the primary window picks them up through the external-change reload.
- `maestro-cli throughput-gauge` keeps its path (primary window store), and the window follows the latch. `status` gains `window: { x, y, width, height } | null`, the floating window's bounds when one exists.

### 4. Media player

- The media widget window is the authority. Its `MediaPlaybackHost` owns the one media element inside `FloatingWidgetFrame` (title = file name, subtitle = agent). In the primary window, `MediaPlaybackHost` renders nothing while `floatingWidgetsAvailable()`.
- The primary window's `useMediaPlaybackStore` becomes a replica:
  - State is mirrored from the authority.
  - Every action called in the replica is forwarded as `{ action, args }` to the authority. This happens through ONE generic wrapper applied to the store's action functions, not per-action code. The authority applies it by calling the same action on its own store.
  - IDs and timestamps are created only by the authority.
- Persistence (`mediaPlayerQueue`, settings-backed) is written by the authority only. A replica never writes it.
- Main creates the media window on the first forwarded command. At launch, it also creates the window when the persisted queue has an active item that is not dismissed. The authority shows its window when it holds an active, undismissed item, and hides it on dismiss or when the queue clears.
- Initial window size comes from the media kind (audio: a transport-height strip; video: 16:9 at the default width). The user resizes from there, and the size is remembered. The in-app `mediaPlayerFloatRect` geometry stays for the browser build.
- Every entry point still lands: opening a media file in the UI, `maestro-cli open-file` with and without `--queue`, the Now Playing indicator, the play/pause shortcut, the palette commands. They all call store actions on the replica, which forwards them.

### 5. Out of scope

- Quick Chat beyond sharing the bounds helpers.
- The cadenza HUD.
- A Cappella's voice widget: built on the `acappella` branch once this lands on `rc`.

## Verification without a person

Unit tests cover the controller (with mocked `BrowserWindow`), the relay (ordering, queue until ready, id validation), the mirror helper, the hosts in both modes, the replica forwarding, and the CLI status field. Do not run the test suite by hand: the `rc` pre-push hook runs the whole suite on push, and that is the gate. Run type-check and lint after every task.

## A Cappella adoption (acappella)

The `acappella-voice` spec uses an app authority: the originating voice-session window, with
primary-window fallback when no window is named. Main still owns the voice protocol; the hidden
A Cappella audio host still owns capture and playback. `VoiceHud` publishes its shared
`VoiceSessionProjection`, UI preferences, device list and Force Send availability with
`publishStoreState`. `VoiceWidget` uses `mirrorStoreState` and the existing HUD drawing inside
`FloatingWidgetFrame`, without another voice event subscription or microphone enumeration.

Every HUD control returns as a validated widget command, including mode cycling, microphone
selection, send wait, send phrases, transcript navigation, mute and Force Send. Minimize hides
the window without ending the session; X and Escape end it. The controller gates creation on
`aCappella`, closes on disable and quit, and owns persisted desktop bounds. App dialogs do not
hide the desktop widget. The relay rejects stale visibility changes and old-owner snapshots during an authority handoff;
Quick Chat keeps its existing voice controls. Browser builds retain the draggable in-app HUD,
and the explicit developer harness remains in-app.

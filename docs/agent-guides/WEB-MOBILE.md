<!-- Rewritten 2026-07-03 for Phase 06 (legacy mobile retirement). Reflects the web-desktop bundle as the sole browser interface. -->

# Web & Mobile Interface

Architecture, hooks, and patterns for reaching Maestro from a browser (desktop, tablet, or phone) over the local network.

---

## Overview

There is **one browser interface**: the **web-desktop bundle**. It is the same `src/renderer` React tree that Electron loads, recompiled for the browser. It talks to the Electron main process over a WebSocket bridge that mimics Electron IPC, so `window.maestro.*` calls work unchanged in the browser. Phones and tablets get the desktop UI with touch/mobile affordances layered on top (see [Touch, Keyboard & Voice](#touch-keyboard--voice-hooks)).

```text
Desktop App (Electron)
├── Main Process
│   └── Web Server (Fastify + @fastify/websocket)   src/main/web-server/WebServer.ts
│       ├── HTML/assets: /$TOKEN, /$TOKEN/desktop     -> dist/web-desktop bundle
│       ├── REST API:    /$TOKEN/api/*
│       ├── WebSocket:   /$TOKEN/ws                    (IPC bridge)
│       └── PWA:         /$TOKEN/manifest.json, /$TOKEN/sw.js, /$TOKEN/icons/
└── Browser client = the web-desktop bundle
    └── src/renderer compiled for the browser; window.maestro.* -> bridge.invoke over WS
```

The server stack is Fastify with plugins: `@fastify/cors`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/static`. See `src/main/web-server/WebServer.ts`.

<!-- doc-refs-ignore -->

> There is no longer a separate mobile React app. The legacy `src/web/mobile/` bundle was retired in Phase 06; its portable hooks were hoisted into `src/renderer`. See the [historical appendix](#appendix-legacy-mobile-retirement-historical) at the end of this guide.

---

## The Web-Desktop Bundle

### Directory Structure

```text
src/web-desktop/
├── index.html          # HTML template + inline boot-error surface (__maestroShowBootError)
├── bootstrap.ts        # Entry point (see below)
├── electron-shim.ts    # Aliased for `electron`: contextBridge -> window.maestro,
│                       #   ipcRenderer.invoke -> bridge.invoke over WS
└── sentry-shim.ts      # Aliased for `@sentry/electron` and `@sentry/electron/renderer`
```

Built by `vite.config.web-desktop.mts` into `dist/web-desktop/`. Scripts: `npm run dev:web-desktop`, `npm run build:web-desktop`.

### Boot Sequence (`bootstrap.ts`)

`src/web-desktop/bootstrap.ts` is the browser entry point:

1. Polyfills the few Node/Electron globals the renderer probes at import time (`process.env`, `process.versions.electron`, `process.platform`, `global`).
2. Sets `document.documentElement.dataset.runtime = 'web-desktop'` before first paint, so CSS can gate phone-only rules with `html[data-runtime='web-desktop']`. The native Electron app never sets this, so those rules stay inert there.
3. Imports the real preload (`src/main/preload/index`), which calls `contextBridge.exposeInMainWorld` - under the shim that populates `window.maestro`.
4. Mounts the real renderer (`src/renderer/main`).
5. Registers the PWA service worker via `registerServiceWorker()` from `src/web/utils/serviceWorker.ts`.

On failure it renders through the shared `index.html` error surface (`__maestroShowBootError`), which includes a same-network hint.

### The IPC Bridge

The web-desktop build aliases `electron` to `src/web-desktop/electron-shim.ts` in the Vite config. The renderer's preload factories run unchanged under the alias:

- `contextBridge.exposeInMainWorld('maestro', ...)` writes to `window.maestro` in the browser.
- `ipcRenderer.invoke(channel, ...args)` becomes a `bridge.invoke` WebSocket frame to `/$TOKEN/ws`, resolved by the main process and returned over the same socket.
- Main -> renderer push events reach browser clients through `safeSend` (`src/main/utils/safe-send.ts`), which fans each event out to the desktop `webContents` AND to the bridge via `broadcastBridgeEvent`. (One deliberate exception is documented in [Deferred: web-server/callbacks/\*.ts](#deferred-web-servercallbacksts).)
- Every broadcast frame carries a `seq`, and `BroadcastService` keeps the most recent ones. The `connected` frame carries the counter at connect time (`bridgeSeq`), which is where a fresh client's `lastSeq` starts. When the socket drops (mobile browsers suspend it on every app switch and screen lock), the shim reconnects with `?since=<lastSeq>&epoch=<serverRun>`; the server replays the missed frames right after `connected` and the page carries on in place. Only when the gap cannot be replayed (the server restarted, or the gap outran the buffer) does the shim fall back to `window.location.reload()`.
- Local audio/video: `fs:readFile` returns a `maestro-media://` stream URL that only the Electron protocol handler can serve. `resolveMediaStreamSrc()` (`src/renderer/utils/mediaStreamSrc.ts`) maps it in web-desktop onto `/<token>/media/stream/<mediaToken>/<hex>`, which `MediaRoutes` (`src/main/web-server/routes/mediaRoutes.ts`) hands to the SAME range-aware handler, so a browser plays and scrubs the file instead of showing "Cannot Play This File". Same shape as `resolveConcertoHtmlSrc()` for Concerto iframes.
- Clipboard: never call `navigator.clipboard` directly from renderer code. It is undefined over plain HTTP (a plain LAN address), which is how web-desktop is usually reached, so the bare call throws before it copies. Route every copy through `safeClipboardWrite()` in `src/renderer/utils/clipboard.ts`, which owns the browser-vs-host decision and the insecure-context fallback.

This is why the renderer's own Zustand stores, IPC service wrappers, and components all work in the browser with no web-specific fork.

### Two Clients, One Sessions Store

The browser runs the same renderer as the desktop, which means every client
holds its **own** session tree and flushes it back into the one shared sessions
store. Nothing reconciled those trees, so an agent created in the browser never
appeared on the desktop, and one closed in the browser was resurrected the moment
the desktop's stale copy was written again (issues #1398 / #1492).

Two rules follow, and both are load-bearing:

- **Agent lifecycle is pushed, not polled.** `sessions:setMany` / `sessions:setAll`
  (`src/main/ipc/handlers/persistence.ts`) report what entered and left the store
  on the `sessions:lifecycleSync` channel, and every other client applies the
  delta through `useSessionLifecycleSync`
  (`src/renderer/hooks/session/useSessionLifecycleSync.ts`), strictly in arrival
  order - an add still restoring when the close for the same agent lands makes
  that close look like it names an agent this client never had. Main also
  tombstones a closed id so a peer flush already in flight cannot re-add it -
  the newest 1000, bounded by COUNT rather than age, because a suspended browser
  tab can be away for hours and no agent id is ever reused, so an old tombstone
  has nothing left to block but a stale write. A client away long enough to
  outlive its tombstone reloads on reconnect regardless: `BridgeClient` has no
  replay, so it re-reads the store rather than flushing what it still held.
  `setAll` merges its opening snapshot into the stored tree and only broadcasts
  additions: the client may not have heard about agents a peer created, so an
  absent id is preserved rather than treated as a close. Real closes arrive as
  explicit `removeIds` through `setMany`. Both handlers share one main-process
  write queue, so a final-agent backup cannot overlap a peer addition and later
  overwrite it. The delta is deliberately lifecycle-only - tab contents, read-state and
  queued messages are still last-writer-wins.
- **Which agent a client is looking at is per-client.** Write and read it through
  `src/renderer/utils/activeSessionPersistence.ts`, never
  `window.maestro.sessions.getActiveSessionId()` directly. A browser tab reloads
  on every refocus, and reading the shared pointer landed the user on whatever
  the DESKTOP had focused instead of the agent they were working in. The read is
  a ladder: `sessionStorage` (this TAB's own choice - two web-desktop tabs share
  an origin, so a localStorage-only answer would have each tab overwriting the
  other's), then `localStorage` (the last choice made in this browser, for a
  freshly opened tab), then the shared value (a first visit should land where the
  desktop is). Writing still reports to the shared store as well, which is what
  plugin `session.activated` events and the CLI's current-agent answer are built
  on.

### Server-Injected Config

The main process injects configuration into `window.__MAESTRO_CONFIG__` inline in `index.html`, before any module runs:

```typescript
interface MaestroConfig {
	securityToken: string; // UUID - required in all API/WS/asset URLs
	sessionId: string | null; // Viewing a specific session, or null for the default view
	tabId: string | null; // Specific tab within a session
	apiBase: string; // e.g. "/$TOKEN/api"
	wsUrl: string; // e.g. "/$TOKEN/ws"
}
```

### URL Structure

```text
http://host:port/$SECURITY_TOKEN/                    # App root (web-desktop)
http://host:port/$SECURITY_TOKEN/desktop             # Same bundle, explicit path
http://host:port/$SECURITY_TOKEN/session/$SESSION_ID # Deep link into a session
```

The security token is a UUID that must be present in all API, WebSocket, and asset URLs. Static routing lives in `src/main/web-server/routes/staticRoutes.ts`; the token root, `/desktop`, `/session/:id`, and the valid-token catch-all all serve the web-desktop bundle's `index.html`.

---

## Touch, Keyboard & Voice Hooks

Because the browser runs the desktop renderer, all touch/mobile behavior lives **inside `src/renderer`**, gated at runtime so it stays inert on the native desktop app. There is no separate mobile hook tree.

### Touch primitives - `src/renderer/utils/touch.ts`

Canonical touch helpers. Do NOT re-derive `navigator.vibrate` calls or `matchMedia('(pointer: coarse)')` queries. Also documented in [SHARED-UTILS.md](SHARED-UTILS.md).

| Export               | Purpose                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `isCoarsePointer()`  | True when the primary pointer is a finger/stylus. Gate touch-only UI on it.                     |
| `isTapGesture()`     | True when a touchstart/touchend pair is a tap (within `tapMoveTolerance`), not a scroll.        |
| `triggerHaptic()`    | Fire `navigator.vibrate` when supported; no-op otherwise. Defaults to a 10ms tap.               |
| `supportsHaptics()`  | Whether `navigator.vibrate` exists.                                                             |
| `HAPTIC_PATTERNS`    | Named vibrate patterns: `tap`, `send`, `interrupt`, `success`, `error`.                         |
| `GESTURE_THRESHOLDS` | Gesture tuning: `swipeDistance`, `swipeTime`, `pullToRefresh`, `longPress`, `tapMoveTolerance`. |
| `MIN_TOUCH_TARGET`   | `44` - minimum touch target (px) per Apple HIG.                                                 |

### Hoisted hooks - `src/renderer/hooks/utils/`

These were lifted out of the legacy mobile bundle and now serve the renderer everywhere:

| Hook                    | Purpose                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `useKeyboardVisibility` | Tracks the virtual keyboard and publishes the `--keyboard-offset` CSS custom property so the active row rises above the soft keyboard. |
| `useLongPress`          | Scroll-aware long-press that opens right-click affordances (context menus, tab overlays). Built on `isTapGesture()`.                   |
| `useSwipeGestures`      | Directional swipe detection (drawer edge-swipe, session switching).                                                                    |
| `useVoiceInput`         | Voice-to-text via the Web Speech API for the AI input area.                                                                            |

### Terminal touch support

Added in Phase 06 for the xterm terminal:

- `src/renderer/components/TerminalTouchBar.tsx` - a compact key bar (Esc, Tab, sticky Ctrl, arrows, Enter) docked above the terminal on coarse-pointer devices. Buttons fire on `onPointerDown` with `preventDefault()` so terminal focus and the soft keyboard are never stolen.
- `src/renderer/utils/terminalKeys.ts` - shared `TERMINAL_KEY_SEQUENCES` and `toControlChar`, consumed by both the touch bar and `XTerminal.tsx` (sticky-Ctrl folds the next typed character into its control code). Key writes go through the SAME PTY path as keyboard input (`window.maestro.process.write`).
- `XTerminal.tsx` calls `term.focus()` on a genuine tap (`isTapGesture`) so mobile browsers reliably raise the soft keyboard.

---

## Phone Layout

Phones get the desktop renderer with a **phone layout**: fewer controls, icon-only toolbars, full-screen drawers, and sheets instead of anchored popovers. One predicate decides when that applies, and everything below keys off it.

### The predicate - `usePhoneLayout()` / `isPhoneLayout()`

`src/renderer/hooks/ui/useViewportBreakpoint.ts`. True for the web-desktop bundle at the `xs` breakpoint (below 640px, a phone held upright). Its CSS twin is `html[data-runtime='web-desktop'][data-bp='xs']` (the "Phone layout" section of `src/renderer/index.css`), so a surface simplified in JS and one simplified in CSS agree about when a phone is a phone.

It is viewport-driven on purpose, not pointer-driven: space is the constraint, and a desktop browser squeezed to phone width gets the same layout, which is also what makes it testable without touch emulation. Touch GESTURES (long-press, swipe) gate on `isCoarsePointer()` separately, because a tablet has a finger without being short on room. The native Electron app never reports phone layout, however narrow its window.

### What changes on a phone

| Surface                                        | Desktop                                                                                                                                                       | Phone                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab bar magnifier (`SearchPopover`)            | Menu: search tabs / messages / all tabs / snoozed                                                                                                             | Opens the tab switcher directly                                                                                                                                                                                                                                                     |
| Tab switcher (`TabSwitcherModal`)              | Resizable modal, mode pills, id / tokens / cost / gauge per row, keyboard legend                                                                              | Full screen, open tabs only, name + kind glyph + star per row (`PhoneTabRow`)                                                                                                                                                                                                       |
| Tab chip actions (all five chip types)         | Hover opens an anchored popover; on touch, tapping the active tab opened it                                                                                   | Tap always selects; LONG-PRESS opens a bottom sheet (`TabOverlayPortal`); native drag off                                                                                                                                                                                           |
| Left / Right drawers                           | 320px overlays over a backdrop                                                                                                                                | Full screen; close by swipe (the handlers ride the drawer itself, see `AppShell`), the panel's own close button, or by picking an agent                                                                                                                                             |
| Left Bar rows (`SessionItem`)                  | Name, provider line, location pills, bookmark, git count, Cue / startup glyphs                                                                                | Name and status dot; AUTO / ERR / unread / wizard state stays                                                                                                                                                                                                                       |
| Auto Run toolbar and editor bar, Files toolbar | Icon + label                                                                                                                                                  | Icon only; the label lives on as the tooltip / accessible name                                                                                                                                                                                                                      |
| Auto Run document row                          | Dropdown + new / refresh / folder buttons                                                                                                                     | Dropdown only ("Change Folder..." stays in its footer)                                                                                                                                                                                                                              |
| Composer (`InputArea`)                         | Always shown                                                                                                                                                  | Folds behind `PhoneComposerHandle` (default folded, remembered in `phone.composer.collapsed`); tap or swipe reveals it                                                                                                                                                              |
| Composer toolbar (`ToolbarControls`)           | Prompt composer, attach, mic, model + effort pills, History / Access / Thinking / Enter-to-send toggles, and a send + notification-bell column beside the box | Attach, mic, send (centre), and a "..." on one row. The pencil and the bell are dropped, everything else moves into `ComposerOptionsSheet` - a half-screen bottom sheet of expandable sections                                                                                      |
| Modals                                         | Escape / close pill                                                                                                                                           | Same, plus a swipe down from the top band closes the top layer (`useLayerSwipeDismiss`)                                                                                                                                                                                             |
| Resizable modals (`data-modal-resize-key`)     | Remembered size, clamped inside a padded overlay, resize grips                                                                                                | Full screen, no grips, no overlay padding (one CSS rule in the "Phone layout" block)                                                                                                                                                                                                |
| Keyboard hints (`data-shortcut-hint`)          | Chord badges beside menu rows, keycap in search boxes, arrow-key legends in footers                                                                           | Hidden, all of them, by one CSS rule                                                                                                                                                                                                                                                |
| Command palette                                | Number badges for Cmd+1..9, chord badges on rows                                                                                                              | Neither                                                                                                                                                                                                                                                                             |
| Hamburger menu                                 | Every entry                                                                                                                                                   | No "Keyboard Shortcuts" and no "Introductory Tour" (nothing to press, nowhere to anchor)                                                                                                                                                                                            |
| Main panel                                     | 400px floor so the header survives two sidebars                                                                                                               | No floor: the panel is the screen, and the floor pushed the header's last button off it                                                                                                                                                                                             |
| Main panel header readouts                     | Session cost pill, context-remaining %, LOCAL badge                                                                                                           | All three hidden by one CSS rule (`.header-cost-widget`, `.header-context-widget`, `.header-local-badge`). Readouts, not controls: cost and context live on in the Usage Dashboard and the context timeline, and the LOCAL badge has no behavior. The git pill's icon and menu stay |
| Right drawer after opening something in it     | Stays open                                                                                                                                                    | Closes when the active tab changes (a file tapped in Files, a session resumed from History)                                                                                                                                                                                         |
| Usage Dashboard, Director's Notes headers      | Full title, labeled export button, wrapping tab rows                                                                                                          | Usage Dashboard: a title row and a controls row (select, icon-only export, share). Director's Notes: single-line title, short tab labels in a sideways-scrolling strip, the activity graph on its own row                                                                           |
| New Agent choice                               | Two tiles side by side                                                                                                                                        | Stacked                                                                                                                                                                                                                                                                             |
| Terminal key bar                               | Fixed 44px keys                                                                                                                                               | Keys share the row width so all eight fit                                                                                                                                                                                                                                           |
| System Logs                                    | "Maestro System Logs" plus an entry count; search reachable only by Cmd+F                                                                                     | "System Logs", no count, a Search button in the header (kept on desktop too); the level filter row scrolls sideways                                                                                                                                                                 |
| Agent Sessions                                 | Search box, Named / Show All, and the mode dropdown on one row                                                                                                | Search box on its own row with the filters beneath it; the stats bar and each row's chips stop breaking mid-item                                                                                                                                                                    |
| File preview stats strip                       | Size / Lines / Tokens / Modified / Created on one line                                                                                                        | The same line, scrolling sideways instead of wrapping into three-line columns                                                                                                                                                                                                       |
| New tab menu                                   | Chord beside each row                                                                                                                                         | No chords                                                                                                                                                                                                                                                                           |
| Transcript images                              | `maestro-image://` protocol                                                                                                                                   | Rewritten to `/<token>/api/images/<name>` by `displayImageSrc()`; a browser cannot load the custom scheme                                                                                                                                                                           |

### Rules for a new surface

- Gate a simplification on `usePhoneLayout()` (or the CSS twin), never on `isCoarsePointer()` alone.
- A touch gesture gates on `isCoarsePointer()`; use `LongPressable` for long-press and `useSwipeGestures` for swipes rather than hand-rolling timers.
- A tab chip's menu renders through `TabOverlayPortal`; do not `createPortal` a `fixed z-[100]` shell by hand. Any OTHER surface that needs a bottom sheet uses `<PhoneBottomSheet>` directly - it is the shell `TabOverlayPortal` itself draws, so the scrim, the grip swipe, the close button and the safe-area padding are written once.
- A three-state setting that tap-cycles beside a mouse becomes a LIST on a phone. Cycling one step per tap hides the options, offers no way back, and makes the user tap through a state they did not want (see `ComposerOptionsSheet`, which lists Access, Thinking, Effort, and Model instead of stepping them). Write the "set this mode" field patch beside the existing cycle patch in `tabHelpers/focusFields.ts` and have the cycle delegate to it, rather than adding a second copy of the invariant.
- A control that hides its label on a phone keeps its `title` (or `aria-label`), so it keeps an accessible name and a long-press tooltip.
- Any keyboard-only hint (a chord badge, a `<kbd>` keycap in a search box, an `↑↓ navigate` legend) carries `data-shortcut-hint`; the phone stylesheet hides them all. Do not gate one in JSX.
- A modal that should fill a phone needs nothing: passing a `resizeKey` (or stamping `data-modal-resize-key`) is what the phone stylesheet keys on. A small dialog that should stay a dialog passes no key.
- A surface that pans on drag (a canvas, a graph) opts out of the swipe-to-dismiss safety net with `data-no-swipe-dismiss` on its root.
- Never host a gesture in an invisible `position: fixed` strip. The drawer-opening edge swipes used to live in two such strips, and the left one sat above the tab bar and swallowed every tap on the magnifier and the first chip. Gate the gesture on WHERE the touch starts instead (`useEdgeSwipeHandlers`, spread on the app shell).
- A sheet that covers the element that opened it must ignore the synthesized mouse and click events that trail a long-press release (`PHONE_SHEET_SCRIM_ARM_MS`, the `scrimArmMs` default on `<PhoneBottomSheet>`), or it closes the instant the finger lifts. A sheet opened by a plain TAP has no such trailer and passes `scrimArmMs={0}`, so its first dismissal is not swallowed.

---

### Standalone mode (iOS home screen)

Opened as a page in Safari, the web view sits below the browser chrome and
`env(safe-area-inset-top)` is 0. Added to the Home Screen with the
`black-translucent` status bar the entry HTML declares, the same page runs under
the status bar and has to clear it itself. Measured on an iPhone 16 Pro (iOS 26.5
simulator, 402x874pt):

| Value                                                             | Safari tab | Home-screen web app |
| ----------------------------------------------------------------- | ---------- | ------------------- |
| `innerHeight`, `100dvh`                                           | 714        | 874                 |
| `100svh`, `documentElement.clientHeight`, `html { height: 100% }` | 714        | **812**             |
| `env(safe-area-inset-top)` / `-bottom`                            | 0 / 0      | 62 / 34             |

Two rules in the "Home-screen web apps on iOS" block of `src/renderer/index.css`
follow from that table, and both are inert everywhere else because every other
runtime reports 0 for the insets and the same value for `100%` and `100dvh`:

- **The roots are `100dvh`, not `100%`.** `100%` is the small viewport, so the
  874pt shell inside an 812pt `#root` with `overflow: hidden` was clipped at the
  status-bar line, and the band under the composer showed the boot background
  from the entry HTML (`#0a0a0a`). That band is what a tester reported as the
  app "not reaching the bottom".
- **The shell, the floating drawers and the phone modal overlay pad by
  `--maestro-top-inset`.** iOS 26 draws a frosted status bar layer over any
  content under the bar and swallows taps in that band, so a header laid out at
  `y = 0` is dimmed, blurred and dead. The hamburger lived there, which is why
  the left-edge swipe was the only way to the menu.

### A dead button on the phone is usually the bridge, not the button

Every `window.maestro.*` call in the browser is a `bridge.invoke` frame over one
WebSocket (`src/web-desktop/electron-shim.ts`). Two properties of that path make
a working control look broken, and both are fixed in the bridge rather than per
caller:

- **A suspended socket does not reliably fire `close`.** iOS freezes the
  connection on app switch and screen lock, and the tab can come back with
  `readyState === OPEN` on a socket whose peer is gone. An invoke then parks in
  `pending` forever - no resolve, no reject, no error. `BridgeClient` now probes
  with the server's existing `ping` every 15s and closes the socket if no frame
  arrives within 8s, because `close` is the one path that already rejects every
  pending invoke and schedules a resuming reconnect. Any inbound frame counts as
  proof of life, not just a `pong`.
- **`ipcRenderer.send` and `ipcRenderer.invoke` are different directions.**
  `invoke` pairs with `ipcMain.handle`; `send` is fire-and-forget and pairs with
  `ipcMain.on`, which appears nowhere in the `_invokeHandlers` map. The shim has
  only one frame type, so it routes both through `bridge.invoke` - and every
  send-style API used to be a silent no-op in a browser, because the server
  answered "No ipcMain handler registered" and the shim's `send` wrapper, which
  cannot throw at its caller, logged it and swallowed it. `handleBridgeInvoke`
  now falls back to `ipcMain.emit` when a channel has `on` listeners. This was
  per-DIRECTION, not per-channel: any `send` API added later was born broken.

When a control genuinely does nothing on the phone but works on the desktop,
check for a third shape before hunting the component: a handler that `await`s an
IPC call **before** it renders anything. `probeSessionAiProcesses` did, so a slow
or hung round trip meant Enter produced no bubble, no queued card, and no error.
Draw the optimistic state first, or bound the call.

---

### The keyboard is not a viewport change

On iOS the on-screen keyboard slides **over** the layout viewport rather than
shrinking it, so `100dvh` is unchanged while the bottom ~45% of the screen is
covered. A full-screen phone modal sized to `100dvh` therefore keeps its full
height with its lower half behind the keys.

That is invisible until a surface autofocuses a text field on open, which both
search surfaces did: the command palette (`useFocusAfterRender` on its input) and
the tab switcher (`useFocusOnMount`). The keyboard was up from the first frame,
so the results list was born buried - the user could type to filter, but the rows
they were trying to scroll through were behind the keyboard. It reads as "I can
search but I can't scroll the list."

Two rules follow, and a phone surface with a list and a filter box needs both:

- **Size a full-screen phone modal to `var(--maestro-viewport-height, 100dvh)`,
  never bare `100dvh`.** That variable is `visualViewport.height`, the half that
  the keyboard does shrink, republished on every `visualViewport` resize by
  `installStandaloneStatusBarInset()`. The `100dvh` fallback covers a browser
  with no `visualViewport`, where the two are the same number anyway.
- **Do not autofocus the filter input on a phone.** Gate it on
  `usePhoneLayout()` - `useFocusAfterRender(ref, !phone)` or
  `useFocusOnMount(ref, undefined, !phone)`. The list is what the surface is for;
  a phone user taps the field when they want to type, and on the desktop the
  keyboard-first focus costs nothing and stays.

---

`--maestro-top-inset` is `max(env(safe-area-inset-top), var(--maestro-status-bar-inset))`.
The second operand exists because WebKit sometimes reports the inset as 0 and
shortens the viewport by the bar height instead
([WebKit bug 301994](https://bugs.webkit.org/show_bug.cgi?id=301994), reopened
against iOS 26.5 and the iOS 27 beta). `installStandaloneStatusBarInset()` in
`src/renderer/utils/standaloneStatusBar.ts` publishes `screen.height - innerHeight`
for a portrait home-screen web app, and the web bootstrap calls it before the
renderer loads. The fade itself is Apple's layer, not a Maestro gradient: the only
top gradient in the stylesheet is the light `chrome-sheen`, which also renders in
a Safari tab where no fade appears.

**Verifying on a simulator.** `xcrun simctl` cannot add a page to the Home
Screen, and the share sheet is the one Safari surface neither the accessibility
bridge nor synthesized taps reach. A configuration profile with a
`com.apple.webClip.managed` payload (`FullScreen` true) served with the
`application/x-apple-aspen-config` MIME type installs through Safari's download
prompt and Settings, all of which the Simulator exposes to macOS accessibility, and
the resulting web clip runs with `navigator.standalone === true`. Have the probe
page beacon its numbers to the serving host; screenshots are not needed for them.

## PWA (Progressive Web App)

The install prompt, offline shell, and app icons come from a small set of static assets that are the only load-bearing part of `src/web/` at runtime.

### Assets - `src/web/public/`

```text
src/web/public/
├── manifest.json       # PWA manifest (name, icons, display, theme color)
├── sw.js               # Service worker (offline shell, static asset caching)
└── icons/              # icon-72x72 ... icon-512x512 (8 sizes)
```

The web-desktop Vite config sets `publicDir: src/web/public`, so a `build:web-desktop` copies these into `dist/web-desktop/` alongside the app. This is the ONLY surviving consumer of `src/web/public/`.

### Serving

- `WebServer.resolveWebAssetsPath()` probes the web-desktop bundle root for `manifest.json` and sets `webAssetsPath` to it (== the bundle root). If the bundle is unbuilt it logs a warning and the PWA routes return 404.
- `staticRoutes.ts` serves `/$TOKEN/manifest.json` and `/$TOKEN/sw.js` (cached) from `webAssetsPath`.
- `WebServer.ts` mounts `/$TOKEN/icons/` from `webAssetsPath/icons`.

### Registration - `src/web/utils/serviceWorker.ts`

`registerServiceWorker()` (called from `bootstrap.ts`) reads the security token from `window.__MAESTRO_CONFIG__` and registers `/$TOKEN/sw.js` at scope `/$TOKEN/`. It swallows its own failures (unsupported browser, registration error) so it never affects boot. Its only dependency inside `src/web/` is `src/web/utils/logger.ts`.

**Load-bearing subset of `src/web/`:** `public/`, `utils/serviceWorker.ts`, and its transitive dep `utils/logger.ts`. Everything else under `src/web/` (`components/`, most of `hooks/` and `utils/`, `constants/`) is orphaned dead code after the legacy mobile retirement; nothing outside `src/web/` imports it. It is a candidate for a future sweep.

---

## Deferred: web-server/callbacks/\*.ts

Main-to-renderer push events only reach browser clients when they go through `safeSend` (`src/main/utils/safe-send.ts`), which fans each event out to the desktop `webContents` AND to the web-desktop bridge via `broadcastBridgeEvent`. The Phase 01 migration routed the session/app data sends across the IPC handlers through `safeSend` so web clients stop silently missing group chat, stats, Cue, and Auto Run events.

`src/main/web-server/web-server-factory.ts` and the per-domain callback modules it wires up (`src/main/web-server/callbacks/*.ts`) were deliberately left out of that migration. Their ~60 direct `webContents.send(...)` calls are not new events originating in the main process: they mirror actions that a web client already performed (over the WebSocket bridge) back onto the desktop renderer so the two surfaces stay in sync. Bridging those sends through `safeSend` would echo each web-originated action straight back to the web client that initiated it, causing duplicate state updates and feedback loops.

Wiring the factory into the bridge therefore requires an echo-suppression design (for example, tagging each mirrored event with its originating client id and having the bridge skip re-delivering it to that origin) before the sends can safely fan out. That work is out of scope for the safeSend parity pass and is tracked as a separate effort. Until then, leave the `web-server-factory.ts` / `callbacks/*.ts` sends as direct `webContents.send(...)` calls.

---

## Key Files Reference

| Concern               | Primary Files                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Browser entry / boot  | `src/web-desktop/bootstrap.ts`, `src/web-desktop/index.html`                                                           |
| Electron/Sentry shims | `src/web-desktop/electron-shim.ts`, `src/web-desktop/sentry-shim.ts`                                                   |
| Bundle build          | `vite.config.web-desktop.mts` (`npm run dev:web-desktop` / `build:web-desktop`)                                        |
| Web server + bridge   | `src/main/web-server/WebServer.ts`, `src/main/web-server/routes/staticRoutes.ts`                                       |
| Push-event fan-out    | `src/main/utils/safe-send.ts` (`broadcastBridgeEvent`)                                                                 |
| Cross-client sessions | `src/renderer/hooks/session/useSessionLifecycleSync.ts`, `src/renderer/utils/activeSessionPersistence.ts`              |
| Touch primitives      | `src/renderer/utils/touch.ts`                                                                                          |
| Touch/keyboard/voice  | `src/renderer/hooks/utils/{useKeyboardVisibility,useLongPress,useSwipeGestures,useVoiceInput}.ts`                      |
| Phone layout gate     | `src/renderer/hooks/ui/useViewportBreakpoint.ts` (`usePhoneLayout`), `src/renderer/index.css` ("Phone layout")         |
| Phone tab sheet       | `src/renderer/components/TabBar/TabOverlayPortal.tsx`, `src/renderer/components/shared/LongPressable.tsx`              |
| Phone composer fold   | `src/renderer/components/InputArea/components/PhoneComposerHandle.tsx`                                                 |
| Edge-swipe openers    | `src/renderer/hooks/utils/useEdgeSwipeHandlers.ts` (spread on the shell root in `AppShell.tsx`)                        |
| Swipe-to-dismiss      | `src/renderer/hooks/ui/useLayerSwipeDismiss.ts` (mounted in `LayerStackContext.tsx`)                                   |
| Web image route       | `src/main/web-server/routes/imageRoutes.ts`, `src/renderer/utils/sessionImageSrc.ts`, `src/shared/sessionImageRefs.ts` |
| Terminal touch        | `src/renderer/components/TerminalTouchBar.tsx`, `src/renderer/utils/terminalKeys.ts`                                   |
| PWA assets            | `src/web/public/` (manifest.json, sw.js, icons/)                                                                       |
| PWA registration      | `src/web/utils/serviceWorker.ts`                                                                                       |

---

## Appendix: Legacy Mobile Retirement (historical)

<!-- doc-refs-ignore:start -->

Before Phase 06, the browser interface was a **separate** mobile-optimized React app under `src/web/mobile/` (~39 components) with its own WebSocket/session hooks (`src/web/hooks/useWebSocket.ts`, `useSessions.ts`, ...) and its own Vite bundle (`vite.config.web.mts`, output `dist/web/`). By that point it was already dead: `staticRoutes.ts` served the web-desktop bundle for every SPA route, and the mobile bundle's `index.html` was never served. Its portable hooks had been hoisted into `src/renderer` (Phases 04-05).

Phase 06 retired it in three steps:

1. **Inventory (step 1):** cataloged every reference to the mobile app outside `src/web/`, with a keep/remove verdict (preserved below).
2. **Deletion (step 2):** `git rm -r src/web/mobile`; removed the four orphaned hoisted hooks from `src/web/hooks/`; removed the mobile entry points (`src/web/{App.tsx,main.tsx,index.html,index.ts}`); removed npm scripts `dev:web`/`build:web`, dropped `&& npm run build:web` from `build`, and deleted `vite.config.web.mts`; removed the legacy `dist/web/assets/` static mount. To keep the PWA alive, the asset source was repointed: the web-desktop Vite config gained `publicDir: src/web/public`, and `resolveWebAssetsPath()` now probes `manifest.json` in the web-desktop bundle instead of the retired `dist/web` directory.
3. **Documentation (step 3):** this rewrite.

### Retirement inventory (references outside `src/web/`)

Compiled 2026-07-03 (step 1). Acted on in step 2.

| Location (file:line)                           | What it is                                            | Verdict                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `package.json` `dev:web`                       | Dev server for the mobile bundle                      | REMOVED                                                                                                    |
| `package.json` `build:web`                     | Production build of the mobile bundle                 | REMOVED                                                                                                    |
| `package.json` `build`                         | Chained `&& npm run build:web`                        | EDITED (dropped)                                                                                           |
| `vite.config.web.mts` (whole file)             | Vite config for the mobile bundle; output `dist/web/` | REMOVED                                                                                                    |
| `WebServer.ts` `dist/web/assets/` mount        | Static mount of the compiled legacy mobile JS/CSS     | REMOVED                                                                                                    |
| `WebServer.ts` icons mount                     | Static mount of the PWA icons                         | KEPT (repointed to web-desktop bundle)                                                                     |
| `WebServer.ts` `resolveWebAssetsPath()`        | PWA asset path resolution                             | REWORKED (probes web-desktop `manifest.json`; dropped the mobile-app `index.html` + `assets/` requirement) |
| `staticRoutes.ts` manifest.json / sw.js routes | PWA routes reading `webAssetsPath`                    | KEPT                                                                                                       |
| `src/__tests__/web/mobile/*` (25 suites)       | Unit tests importing `src/web/mobile/*`               | REMOVED / rewritten                                                                                        |

<!-- doc-refs-ignore:end -->

### Cross-`src/web` keep dependency

`src/web-desktop/bootstrap.ts` imports `registerServiceWorker` from `src/web/utils/serviceWorker.ts`. This is the reason step 2 kept `serviceWorker.ts` (and its transitive dep `logger.ts`). The legacy importers of the same module went away with the mobile app.

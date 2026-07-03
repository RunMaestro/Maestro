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
- Main -> renderer push events reach browser clients through `safeSend` (`src/main/utils/safe-send.ts`), which fans each event out to the desktop `webContents` AND to the bridge via `broadcastBridgeEvent`. (One deliberate exception is documented in [Deferred: web-server-factory.ts](#deferred-web-server-factoryts).)

This is why the renderer's own Zustand stores, IPC service wrappers, and components all work in the browser with no web-specific fork.

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

## Deferred: web-server-factory.ts

Main-to-renderer push events only reach browser clients when they go through `safeSend` (`src/main/utils/safe-send.ts`), which fans each event out to the desktop `webContents` AND to the web-desktop bridge via `broadcastBridgeEvent`. The Phase 01 migration routed the session/app data sends across the IPC handlers through `safeSend` so web clients stop silently missing group chat, stats, Cue, and Auto Run events.

`src/main/web-server/web-server-factory.ts` was deliberately left out of that migration. Its ~58 direct `webContents.send(...)` calls are not new events originating in the main process: they mirror actions that a web client already performed (over the WebSocket bridge) back onto the desktop renderer so the two surfaces stay in sync. Bridging those sends through `safeSend` would echo each web-originated action straight back to the web client that initiated it, causing duplicate state updates and feedback loops.

Wiring the factory into the bridge therefore requires an echo-suppression design (for example, tagging each mirrored event with its originating client id and having the bridge skip re-delivering it to that origin) before the sends can safely fan out. That work is out of scope for the safeSend parity pass and is tracked as a separate effort. Until then, leave the `web-server-factory.ts` sends as direct `webContents.send(...)` calls.

---

## Key Files Reference

| Concern               | Primary Files                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Browser entry / boot  | `src/web-desktop/bootstrap.ts`, `src/web-desktop/index.html`                                      |
| Electron/Sentry shims | `src/web-desktop/electron-shim.ts`, `src/web-desktop/sentry-shim.ts`                              |
| Bundle build          | `vite.config.web-desktop.mts` (`npm run dev:web-desktop` / `build:web-desktop`)                   |
| Web server + bridge   | `src/main/web-server/WebServer.ts`, `src/main/web-server/routes/staticRoutes.ts`                  |
| Push-event fan-out    | `src/main/utils/safe-send.ts` (`broadcastBridgeEvent`)                                            |
| Touch primitives      | `src/renderer/utils/touch.ts`                                                                     |
| Touch/keyboard/voice  | `src/renderer/hooks/utils/{useKeyboardVisibility,useLongPress,useSwipeGestures,useVoiceInput}.ts` |
| Terminal touch        | `src/renderer/components/TerminalTouchBar.tsx`, `src/renderer/utils/terminalKeys.ts`              |
| PWA assets            | `src/web/public/` (manifest.json, sw.js, icons/)                                                  |
| PWA registration      | `src/web/utils/serviceWorker.ts`                                                                  |

---

## Appendix: Legacy Mobile Retirement (historical)

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

### Cross-`src/web` keep dependency

`src/web-desktop/bootstrap.ts` imports `registerServiceWorker` from `src/web/utils/serviceWorker.ts`. This is the reason step 2 kept `serviceWorker.ts` (and its transitive dep `logger.ts`). The legacy importers of the same module went away with the mobile app.

<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Web & Mobile Interface

Architecture, components, hooks, and patterns for the Maestro web/mobile remote control interface.

---

## Overview

The web interface is a **separate React application** from the desktop renderer. It provides remote control of Maestro sessions from mobile/tablet devices over the local network. Communication with the Electron main process happens via WebSocket and REST API, not Electron IPC.

```text
Desktop App (Electron)
├── Main Process
│   └── Web Server (Fastify + @fastify/websocket)
│       ├── REST API: /$TOKEN/api/*
│       └── WebSocket: /$TOKEN/ws
└── Web Client (separate React app)
    └── Connects over HTTP/WS to main process
```

The server stack is Fastify with plugins: `@fastify/cors`, `@fastify/websocket`, `@fastify/rate-limit`, `@fastify/static`. See `src/main/web-server/WebServer.ts`.

---

## Architecture

### Directory Structure

```text
src/web/
├── App.tsx                   # Root app component (contexts, routing)
├── main.tsx                  # Entry point (createRoot)
├── index.ts                  # Module exports
├── index.css                 # Global styles
├── index.html                # HTML template
├── components/               # Shared web components
│   ├── Badge.tsx
│   ├── Button.tsx
│   ├── Card.tsx
│   ├── Input.tsx
│   ├── PullToRefresh.tsx
│   ├── ThemeProvider.tsx
│   └── index.ts
├── hooks/                    # Web-specific hooks
│   ├── useBreakpoint.ts      # Viewport tier (phone/tablet/desktop) + short-viewport flag
│   ├── useIsMobile.ts        # Thin wrapper over useBreakpoint (deprecated for new code)
│   ├── useWebSocket.ts       # Core WS connection
│   ├── useSessions.ts        # Session state management
│   ├── useNotifications.ts   # Push notifications
│   ├── useOfflineQueue.ts    # Offline command queueing
│   ├── useUnreadBadge.ts     # Tab badge counter
│   ├── useCommandHistory.ts  # Command recall
│   ├── useSwipeGestures.ts   # Touch gestures
│   ├── useSwipeUp.ts         # Swipe-up for history
│   ├── usePullToRefresh.ts   # Pull-to-refresh
│   ├── useLongPress.ts       # Long-press detection
│   ├── useLongPressMenu.ts   # Long-press context menu
│   ├── useVoiceInput.ts      # Voice-to-text
│   ├── useKeyboardVisibility.ts  # Virtual keyboard state
│   ├── useDeviceColorScheme.ts   # System dark/light mode
│   ├── useSlashCommandAutocomplete.ts
│   ├── useMobileKeyboardHandler.ts
│   ├── useMobileViewState.ts
│   ├── useMobileSessionManagement.ts
│   ├── useMobileAutoReconnect.ts
│   └── index.ts
├── utils/                    # Web-specific utilities
│   ├── config.ts             # Server config from window.__MAESTRO_CONFIG__
│   ├── cssCustomProperties.ts
│   ├── logger.ts             # Web-specific logger
│   ├── serviceWorker.ts      # PWA offline support
│   └── viewState.ts          # View state persistence (localStorage)
├── mobile/                   # Mobile-optimized React app (~39 components)
│   ├── App.tsx               # Mobile app root (defines MobileHeader internally)
│   ├── index.tsx             # Mobile entry point
│   ├── constants.ts          # Haptic patterns, breakpoints
│   │
│   ├── AllSessionsView.tsx        # Dashboard session grid
│   ├── AutoRunDocumentCard.tsx    # Auto Run doc card
│   ├── AutoRunDocumentViewer.tsx  # Full Auto Run doc viewer
│   ├── AutoRunIndicator.tsx
│   ├── AutoRunPanel.tsx
│   ├── AutoRunSetupSheet.tsx
│   ├── AchievementsPanel.tsx
│   ├── AgentCreationSheet.tsx
│   ├── CommandHistoryDrawer.tsx
│   ├── CommandInputBar.tsx
│   ├── CommandInputButtons.tsx
│   ├── ConnectionStatusIndicator.tsx
│   ├── ContextManagementSheet.tsx
│   ├── CuePanel.tsx
│   ├── GitDiffViewer.tsx
│   ├── GitStatusPanel.tsx
│   ├── GroupChatPanel.tsx
│   ├── GroupChatSetupSheet.tsx
│   ├── LeftPanel.tsx              # Mobile left drawer
│   ├── MessageHistory.tsx
│   ├── MobileHistoryPanel.tsx
│   ├── MobileMarkdownRenderer.tsx
│   ├── NotificationSettingsSheet.tsx
│   ├── OfflineQueueBanner.tsx
│   ├── QuickActionsMenu.tsx
│   ├── RecentCommandChips.tsx
│   ├── ResponseViewer.tsx
│   ├── RightDrawer.tsx            # Mobile right drawer
│   ├── RightPanel.tsx
│   ├── SessionPillBar.tsx
│   ├── SessionStatusBanner.tsx
│   ├── SettingsPanel.tsx
│   ├── SlashCommandAutocomplete.tsx
│   ├── TabBar.tsx
│   ├── TabSearchModal.tsx
│   ├── UsageDashboardPanel.tsx
│   └── WebTerminal.tsx            # xterm-based mobile terminal
└── public/                   # Static assets
```

### Key Differences from Desktop Renderer

| Aspect          | Desktop                               | Web                        |
| --------------- | ------------------------------------- | -------------------------- |
| IPC             | `window.maestro.*` (Electron preload) | WebSocket + REST API       |
| State           | Zustand stores                        | React hooks + WS events    |
| Navigation      | Keyboard-first                        | Touch-first                |
| Process control | Direct PTY spawn                      | Commands sent over WS      |
| Theme source    | Settings store                        | Synced from desktop via WS |
| File system     | Direct IPC access                     | No direct FS access        |

---

## Configuration

### Server-Injected Config

The Electron main process injects configuration into `window.__MAESTRO_CONFIG__`:

```typescript
interface MaestroConfig {
	securityToken: string; // UUID - required in all API/WS URLs
	sessionId: string | null; // Viewing specific session or null for dashboard
	tabId: string | null; // Specific tab within session
	apiBase: string; // e.g., "/$TOKEN/api"
	wsUrl: string; // e.g., "/$TOKEN/ws"
}
```

Access via `getMaestroConfig()` from `src/web/utils/config.ts`.

### URL Structure

```text
http://host:port/$SECURITY_TOKEN/                    # Dashboard
http://host:port/$SECURITY_TOKEN/session/$SESSION_ID  # Session view
http://host:port/$SECURITY_TOKEN/session/$SESSION_ID?tabId=$TAB_ID  # Tab view
```

The security token is a UUID that must be present in all API and WebSocket URLs.

---

## WebSocket Communication

### Connection Hook (`useWebSocket`)

File: `src/web/hooks/useWebSocket.ts`

Manages WebSocket lifecycle:

```typescript
type WebSocketState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'authenticating'
	| 'authenticated';
```

The hook provides connection state, message sending, and event handlers. The primary auth path is the URL token (the `$SECURITY_TOKEN` segment), but the hook also exposes an explicit runtime handshake: `UseWebSocketReturn` includes `authenticate(token: string): void` and an `isAuthenticated: boolean` flag for clients that need to confirm auth state or re-authenticate over an existing connection. Typical usage: connect via URL token and rely on `isAuthenticated` to gate UI.

### Session Data Model

The WebSocket transmits `SessionData` objects:

```typescript
interface SessionData {
	id: string;
	name: string;
	toolType: string;
	state: string; // 'idle' | 'busy' | 'error' | 'connecting'
	inputMode: string; // 'ai' | 'terminal'
	cwd: string;
	groupId?: string | null;
	groupName?: string | null;
	groupEmoji?: string | null;
	usageStats?: UsageStats | null;
	lastResponse?: LastResponsePreview | null;
	agentSessionId?: string | null;
	aiTabs?: AITabData[]; // Multi-tab support
	activeTabId?: string | null;
}
```

### AI Tab Data

Each session can have multiple AI tabs. The WebSocket sends `AITabData`:

```typescript
interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: UsageStats | null;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
}
```

### Last Response Preview

For mobile display, responses are truncated server-side:

```typescript
interface LastResponsePreview {
	text: string; // First 3 lines or ~500 chars
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	fullLength: number; // Original length
}
```

---

## Session Management (`useSessions`)

File: `src/web/hooks/useSessions.ts`

Builds on `useWebSocket` to provide high-level session management:

```typescript
interface Session extends SessionData {
	isSending?: boolean;
	lastError?: string;
}

interface UseSessionsReturn {
	sessions: Session[];
	activeSession: Session | null;
	connectionState: WebSocketState;
	sendCommand: (sessionId: string, command: string) => Promise<boolean>;
	sendToActive: (command: string) => Promise<boolean>;
	interrupt: (sessionId: string) => Promise<boolean>;
	interruptActive: () => Promise<boolean>;
	switchMode: (sessionId: string, mode: InputMode) => Promise<boolean>;
	// ... tab ops (selectTab, newTab, closeTab, ...) and more
}
```

### Group Organization

Sessions are grouped into `GroupInfo` objects:

```typescript
interface GroupInfo {
	id: string | null; // null = ungrouped
	name: string;
	emoji: string | null;
	sessions: Session[];
}
```

---

## Mobile App Component Tree

```text
AppRoot (App.tsx)
├── ThemeProvider
│   └── MaestroModeContext.Provider
│       └── OfflineContext.Provider
│           └── MobileApp (mobile/App.tsx)
│               ├── MobileHeader
│               ├── OfflineQueueBanner
│               ├── SessionPillBar
│               ├── TabBar
│               ├── AutoRunIndicator
│               ├── CommandInputBar
│               │   ├── SlashCommandAutocomplete
│               │   └── CommandInputButtons
│               ├── ResponseViewer
│               ├── MessageHistory
│               ├── AllSessionsView
│               ├── MobileHistoryPanel
│               └── TabSearchModal
```

---

## Contexts

### OfflineContext

Tracks whether the device is offline:

```typescript
const { isOffline } = useOfflineStatus();
```

### MaestroModeContext

Manages dashboard vs. session view navigation:

```typescript
const {
	isDashboard,
	isSession,
	sessionId,
	tabId,
	securityToken,
	goToDashboard,
	goToSession,
	updateUrl,
} = useMaestroMode();
```

### DesktopTheme

Theme synced from the desktop app via WebSocket:

```typescript
const theme = useDesktopTheme();
```

---

## Responsive Breakpoints

### `useBreakpoint()`

File: `src/web/hooks/useBreakpoint.ts`

Single source of truth for viewport-tier decisions in the web UI. Prefer this hook over `useIsMobile()` (now a thin wrapper) and over ad-hoc `matchMedia` calls.

```typescript
const { tier, width, height, isPhone, isTablet, isDesktop, isShortViewport } = useBreakpoint();
```

| Field             | Type                                 | Meaning                                              |
| ----------------- | ------------------------------------ | ---------------------------------------------------- |
| `tier`            | `'phone' \| 'tablet' \| 'desktop'`   | Current tier derived from `width`                    |
| `width`           | `number`                             | `window.innerWidth` (debounced 150ms on resize)      |
| `height`          | `number`                             | `window.innerHeight` (debounced 150ms on resize)     |
| `isPhone`         | `boolean`                            | `width < 600` (`BREAKPOINTS.tablet`)                 |
| `isTablet`        | `boolean`                            | `600 <= width < 960`                                 |
| `isDesktop`       | `boolean`                            | `width >= 960` (`BREAKPOINTS.desktop`)               |
| `isShortViewport` | `boolean`                            | `height < 500` — orthogonal to tier                  |

Tier boundaries live in `BREAKPOINTS` (`src/web/mobile/constants.ts`) and are mirrored to CSS custom properties `--bp-tablet: 600px` and `--bp-desktop: 960px` in `src/web/index.css` so media queries and JS stay linked to one source of truth.

### When to use each tier

- **`isPhone`** — stacked / single-column layouts, edge-to-edge sheets, gesture-driven navigation. The phone tier is the mobile app's default design target.
- **`isTablet`** — dense layouts start to work but there's not enough width for a full desktop-style three-pane split. Good for two-pane overlays, wider sheets, and showing more controls inline instead of behind overflow menus.
- **`isDesktop`** — enough room for inline chrome, resizable side panels, and full-width headers. Use this to drop hamburger/overflow patterns in favor of visible toolbars.

### Choosing inline vs. Tailwind for tier-dependent styles

| Situation                                                                                | Use                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Purely visual (color, padding, border, radius, typography) varies by tier                | **Tailwind responsive variants** (`sm:`, `md:`, `lg:`) driven by CSS media queries — no hook needed. |
| Layout changes are structural (different component tree, props, or children per tier)    | **`useBreakpoint()` in JS** and branch on `isPhone` / `isTablet` / `isDesktop`. |
| One element has a handful of tier-conditional classes                                    | **Tailwind** first; only reach for inline styles if a value isn't a token. |
| You need the numeric width/height (e.g. to size an xterm grid or compute a scroll range) | **`useBreakpoint()`** — read `width` / `height` directly.                 |

Rule of thumb: reach for Tailwind first, JS-driven branching second. JS branching causes a re-render on every debounced resize and forces SSR/paint to wait on hydration; CSS media queries don't.

### `isShortViewport` usage

Orthogonal to tier — a landscape phone can be `isPhone && isShortViewport`, and a laptop with devtools open can be `isDesktop && isShortViewport`. Use it to collapse vertically-expensive chrome when the user is vertically cramped:

- Hide or collapse banners, headers, and pill bars that eat prime vertical space.
- Switch multi-line command inputs to single-line + overflow-expand.
- Skip decorative padding that would push primary content below the fold.

Do **not** use `isShortViewport` as a proxy for "mobile" — it only signals vertical pressure.

---

## Icon-only buttons and `title=` tooltips

Phase 6 Task 6.4 converted the `MobileHeader` icon toolbar into a true desktop-tier toolbar: each title-only icon button now renders a short inline label (e.g. "Agents", "Search", "Files", "Cue", "Alerts", "Settings", "Chat", "Usage", "Awards", "Context", "New Agent") when `isDesktop` is true. On `phone` and `tablet`, the button stays icon-only and lower-priority actions are still discoverable through the labeled overflow menu.

### Pattern

- `aria-label` and `title` remain on the button at every tier (screen-reader + native hover tooltip).
- The visible label is purely additive: `{isDesktop && <span className="text-[13px] font-medium leading-none whitespace-nowrap">Label</span>}` inside the button.
- `headerIconButtonClasses(isActive, compact, withLabel)` in `src/web/mobile/App.tsx` switches between the fixed `w-8 h-8` square and a relaxed `h-8 px-2 gap-1.5` flex row so the label sits cleanly beside the SVG icon.

### Allowed `title=`-only icon-button exceptions

The buttons below keep `title=` as their sole visible affordance at every tier. They are exempt from the "visible label on desktop" rule because they sit in tight panel-headers, overlays, or contextual affordances where a visible label would crowd the layout and the icon itself is contextually unambiguous:

| File | Button | Justification |
| ---- | ------ | ------------- |
| `src/web/mobile/LeftPanel.tsx` | New group / New agent / Close panel | Small icons in a dense LeftPanel header row; the panel itself labels the sessions. |
| `src/web/mobile/RightPanel.tsx` | Close panel | Standard `×` icon convention. |
| `src/web/mobile/RightDrawer.tsx` | Refresh file tree / Refresh documents | The button content is a `↻` Unicode glyph, not a pure SVG icon; the glyph serves as the label. |
| `src/web/mobile/MessageHistory.tsx` | Scroll to new messages | Floating affordance; arrow icon is self-describing. |
| `src/web/mobile/SessionStatusBanner.tsx` | Copy response to clipboard | Standard clipboard icon pattern, contextually near the response. |
| `src/web/mobile/SessionPillBar.tsx` | Search Sessions / History / Panel | Pill-bar controls; adding labels would break the horizontal scroll rhythm. |
| `src/web/mobile/TabBar.tsx` | Search N tabs / New Tab | Tab-bar affordances; text siblings are the tab labels themselves. |
| `src/web/mobile/WebTerminal.tsx` | Find-bar Prev / Next / Close | Find overlay is intentionally compact and `title=` already carries the keyboard shortcut (`Shift+Enter` / `Enter` / `Escape`). |
| `src/web/mobile/App.tsx` | Notification Settings (cog inside the notifications dropdown) | Sits inside a 280px dropdown header; adding a visible label would push the "Clear" button off-row. |
| `src/web/mobile/App.tsx` | More actions (`⋯`) | Only renders on `phone`/`tablet`; the three-dot menu is a universal affordance and it's the overflow trigger itself. |

If you add a new icon-only button, prefer the tier-aware inline-label pattern (desktop shows text, phone/tablet stays icon-only). Only add to this exception table if space constraints genuinely rule it out, and include a one-line justification as above.

---

## `onMouse*` handler policy

Phase 6 swept hover-reveal affordances and mouse-only drag/press out of the web UI. New code should not introduce `onMouseEnter` / `onMouseLeave` / `onMouseDown` / `onMouseMove` / `onMouseUp` handlers. The established alternatives are:

- **Hover reveal / bg swap / color fade** — use Tailwind `hover:` pseudo-classes (`hover:bg-[color-mix(in_srgb,var(--maestro-text-dim)_X%,transparent)]`, `hover:bg-accent`, `hover:text-text-main`). Touch devices never trigger `:hover`, so the affordance must either be always-visible (possibly dimmed) or redundant with an explicit tap target.
- **Drag / press / resize** — use `onPointerDown` + `setPointerCapture(pointerId)` + `pointerup` / `pointercancel` listeners (see `src/web/hooks/useResizableWebPanel.ts`). Attach `touch-none` to the handle so CSS `touch-action: none` lets the pointer capture route moves instead of scrolling the page.
- **Focus-visible affordance** — pair any interactive element with `outline-none focus-visible:ring-2 focus-visible:ring-accent` (add `focus-visible:ring-inset` if the element sits flush against a neighbour).

### Allowed `onMouseEnter` exceptions (keyboard-selection sync)

A residue of `onMouseEnter` handlers is allowed **only** where the handler syncs the keyboard-selected index to wherever the mouse last hovered, so arrow-key and pointer focus stay aligned in a popup that owns a `selectedIndex`. These handlers are no-ops on touch devices (no mouse → no enter event), so they do not create a mouse-only affordance. Run `rg -n "onMouse(Enter|Leave|Down|Move|Up)" src/web/` to audit; hits outside the table below should either be removed or added to the table with a justification.

| File | Line | Use |
| ---- | ---- | --- |
| `src/web/mobile/SlashCommandAutocomplete.tsx` | `onMouseEnter={() => onSelectedIndexChange?.(idx)}` on each command row | Keeps the popup's keyboard-highlighted row in sync with the mouse pointer. Click / `onTouchStart` / `onTouchEnd` handle the actual selection. |
| `src/web/mobile/QuickActionsMenu.tsx` | `onMouseEnter={() => setSelectedIndex(currentActionIndex)}` on each action button | Same contract as `SlashCommandAutocomplete` — `onClick` drives the real selection; `onMouseEnter` only nudges the keyboard-highlight index. |

If you catch yourself wanting a new `onMouseEnter` for anything other than keyboard-selection sync, reach for Tailwind `hover:` (visual) or `onPointerEnter` (needs to fire for stylus / pen too) instead. Upgrading the two entries above to `onPointerEnter` is a reasonable future refinement — noted in Phase 6 Task 6.1's inventory.

---

## Mobile-Specific Hooks

### `useOfflineQueue`

Queues commands typed while offline and sends them when reconnected:

```typescript
interface QueuedCommand {
	id: string;
	command: string;
	sessionId: string;
	timestamp: number;
	inputMode: 'ai' | 'terminal';
	attempts: number;
	lastError?: string;
}
```

Features:

- Persists to `localStorage` (survives page reloads)
- Max queue size: 50 commands
- Automatic retry on reconnection with 100ms delay between sends
- Manual retry and clearing

### `useNotifications`

Browser push notification management:

```typescript
const {
	permission, // 'default' | 'granted' | 'denied'
	isSupported,
	hasPrompted,
	requestPermission,
} = useNotifications({
	autoRequest: true,
	requestDelay: 2000,
	onGranted: () => console.log('Notifications enabled'),
});
```

### `useMobileViewState`

Persists view state to `localStorage`:

- Which overlays are open (all sessions, history panel, tab search)
- History filter and search state
- Active session and tab selection
- Screen size tracking (phone vs tablet breakpoint at 700px height)

### `useMobileKeyboardHandler`

Adapts keyboard shortcuts for the mobile interface.

### `useMobileAutoReconnect`

Automatic WebSocket reconnection with exponential backoff.

### `useMobileSessionManagement`

Session selection, switching, and tab management for mobile.

### Touch Gesture Hooks

- `useSwipeGestures` - Horizontal swipe for session switching
- `useSwipeUp` - Swipe up to reveal history
- `usePullToRefresh` - Pull-to-refresh for session data
- `useLongPress` / `useLongPressMenu` - Long-press for context menus

### `useVoiceInput`

Voice-to-text input using the Web Speech API.

### `useKeyboardVisibility`

Tracks virtual keyboard state on mobile devices to adjust layout.

### `useUnreadBadge`

Manages browser tab badge for unread session responses.

---

## Shared Web Components

Located in `src/web/components/`:

| Component       | Purpose                                    |
| --------------- | ------------------------------------------ |
| `ThemeProvider` | Provides theme context synced from desktop |
| `Button`        | Themed button with variants                |
| `Badge`         | Status badges                              |
| `Card`          | Content cards                              |
| `Input`         | Form inputs                                |
| `PullToRefresh` | Pull-to-refresh wrapper                    |

---

## Mobile Components

### `CommandInputBar`

Primary input surface. Supports two modes:

- **AI mode** - sends to AI agent
- **Terminal mode** - sends as shell command

Features:

- Slash command autocomplete
- Per-session, per-tab draft persistence
- Voice input toggle
- Image attachment
- Read-only mode indicator

### `SessionPillBar`

Horizontal scrollable session list. Each pill shows:

- Session name and status color
- Group emoji
- Unread indicator

### `TabBar`

Tab navigation within a session (mirroring the desktop tab system).

### `ResponseViewer`

Displays AI responses with:

- Markdown rendering (`MobileMarkdownRenderer`)
- Thinking indicator
- Response timestamp
- Full-length toggle

### `AllSessionsView`

Dashboard grid showing all active sessions with:

- Group organization
- Status indicators
- Quick session switching
- Cost and context usage display

### `MobileHistoryPanel`

History viewer with:

- Filter by type (all, auto-run, user)
- Search
- Expandable entries

### `AutoRunIndicator`

Compact auto-run status indicator showing current task progress.

---

## Service Worker & PWA

File: `src/web/utils/serviceWorker.ts`

The web interface registers a service worker for:

- Offline support (cached static assets)
- `isOffline()` detection
- Background sync for command queue

---

## Haptic Feedback

File: `src/web/mobile/constants.ts`

Touch interactions trigger haptic feedback via `navigator.vibrate()`:

```typescript
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

triggerHaptic(HAPTIC_PATTERNS.TAP); // Light tap
triggerHaptic(HAPTIC_PATTERNS.SUCCESS); // Success pattern
triggerHaptic(HAPTIC_PATTERNS.ERROR); // Error pattern
```

---

## Key Files Reference

| Concern           | Primary Files                                                        |
| ----------------- | -------------------------------------------------------------------- |
| App root          | `src/web/App.tsx`, `src/web/main.tsx`                                |
| Mobile app        | `src/web/mobile/App.tsx`, `src/web/mobile/index.tsx`                 |
| WebSocket         | `src/web/hooks/useWebSocket.ts`                                      |
| Sessions          | `src/web/hooks/useSessions.ts`                                       |
| Config            | `src/web/utils/config.ts`                                            |
| Theme             | `src/web/components/ThemeProvider.tsx`                               |
| Offline           | `src/web/hooks/useOfflineQueue.ts`, `src/web/utils/serviceWorker.ts` |
| View state        | `src/web/hooks/useMobileViewState.ts`, `src/web/utils/viewState.ts`  |
| Notifications     | `src/web/hooks/useNotifications.ts`                                  |
| Shared components | `src/web/components/`                                                |
| Mobile components | `src/web/mobile/`                                                    |
| Development       | `npm run dev:web`                                                    |

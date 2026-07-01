/**
 * Multi-Window IPC Handlers
 *
 * Exposes the `windows:*` channel surface that lets the renderer enumerate,
 * create, focus, and close windows, and inspect/move the agents (sessions) each
 * window owns. The {@link WindowRegistry} is the single source of truth for
 * window<->session ownership; these handlers are a thin transport layer over it
 * plus the window manager's secondary-window factory.
 *
 * Window construction (with all its security hardening) stays in
 * `app-lifecycle/window-manager.ts` - `windows:create` delegates to the
 * manager's `createSecondaryWindow`, which registers the new window itself.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type {
	WindowBounds,
	WindowHighlightDropZonePayload,
	WindowInfo,
	WindowPanelState,
	WindowSessionMovedPayload,
	WindowState,
} from '../../../shared/window-types';
import type { RegisteredWindow, WindowRegistry } from '../../window-registry';
import type { WindowManager } from '../../app-lifecycle/window-manager';
import { registeredWindowToWindowState } from '../../window-state-persistence';
import { requireDependency, withIpcErrorLogging } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[Windows]';

/**
 * Channel the main process broadcasts on whenever window<->session ownership
 * changes. Every open window's renderer listens (see the preload
 * `windows.onSessionMoved` API + `WindowContext`) and refreshes which agents it
 * surfaces plus the Left Bar's cross-window badges.
 */
export const WINDOW_SESSION_MOVED_CHANNEL = 'windows:sessionMoved';

/**
 * Channel the main process pushes to a single window's renderer to toggle its
 * tab-bar drop-zone highlight while a tab is dragged over it from another window
 * (Phase 3 tab drag-out feedback). Unlike {@link WINDOW_SESSION_MOVED_CHANNEL}
 * (broadcast to all), this is sent only to the window named in the payload - it
 * is a transient hover affordance, not an ownership change every window must see.
 */
export const WINDOW_HIGHLIGHT_DROP_ZONE_CHANNEL = 'windows:highlightDropZone';

/**
 * Dependencies for the windows handlers. Both are getters because the registry
 * and window manager are constructed at app-ready, after handler registration
 * runs; a getter lets the handlers resolve the live instance lazily (and report
 * a clear "not initialized" error if called before wiring).
 */
export interface WindowsHandlerDependencies {
	getWindowRegistry: () => WindowRegistry | null;
	getWindowManager: () => WindowManager | null;
}

/**
 * Lightweight runtime view of a window for `windows:list` / `windows:create`.
 * `activeSessionId` is renderer-driven state the registry does not track yet, so
 * it is reported as `null` until later phases wire per-window active-agent state.
 */
function toWindowInfo(entry: RegisteredWindow): WindowInfo {
	return {
		id: entry.id,
		isMain: entry.isMain,
		sessionIds: [...entry.sessionIds],
		activeSessionId: null,
	};
}

/** Resolve the registry entry for the window that sent an IPC message. */
function resolveCallingWindow(
	event: Electron.IpcMainInvokeEvent,
	registry: WindowRegistry
): RegisteredWindow | undefined {
	const browserWindow = BrowserWindow.fromWebContents(event.sender);
	if (!browserWindow) return undefined;
	return registry.getAll().find((entry) => entry.browserWindow === browserWindow);
}

/**
 * Subscribe to the {@link WindowRegistry} change signal and broadcast session
 * ownership moves to every open window on {@link WINDOW_SESSION_MOVED_CHANNEL}.
 *
 * Only the two ownership mutations are forwarded: `moveSession` (emits
 * `session-moved`) and `setSessionsForWindow` (emits `sessions-changed`). Window
 * open/close (`created`/`removed`) is intentionally NOT broadcast - an empty new
 * window changes no badges, and any session move into/out of a window already
 * emits `session-moved`. The broadcast goes to ALL windows (not just the ones
 * named in the change) because cross-window badges depend on the full ownership
 * map; each renderer re-reads the registry and decides what changed for it.
 *
 * Returns an unsubscribe function so callers (and tests) can tear the
 * subscription down.
 */
export function wireWindowRegistryBroadcast(registry: WindowRegistry): () => void {
	return registry.onChange((change) => {
		if (change.type !== 'session-moved' && change.type !== 'sessions-changed') return;
		const payload: WindowSessionMovedPayload = {
			type: change.type,
			windowId: change.windowId,
			sessionId: change.sessionId,
			fromWindowId: change.fromWindowId,
			toWindowId: change.toWindowId,
		};
		for (const entry of registry.getAll()) {
			const { browserWindow } = entry;
			if (browserWindow.isDestroyed()) continue;
			const { webContents } = browserWindow;
			if (webContents.isDestroyed()) continue;
			webContents.send(WINDOW_SESSION_MOVED_CHANNEL, payload);
		}
	});
}

/**
 * Register all `windows:*` IPC handlers.
 */
export function registerWindowsHandlers(deps: WindowsHandlerDependencies): void {
	const { getWindowRegistry, getWindowManager } = deps;

	// Create a secondary window (optionally owning some agents / sized to bounds).
	// The window manager builds + registers the window; we return its WindowInfo.
	ipcMain.handle(
		'windows:create',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'create' },
			async (sessionIds?: string[], bounds?: Partial<WindowState>): Promise<WindowInfo | null> => {
				const manager = requireDependency(getWindowManager, 'Window manager');
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				const browserWindow = manager.createSecondaryWindow(sessionIds ?? [], bounds);
				const entry = registry
					.getAll()
					.find((candidate) => candidate.browserWindow === browserWindow);
				if (!entry) {
					// createSecondaryWindow registers the window itself, so this should
					// not happen; if the manager was built without the registry the
					// window opened untracked - surface it rather than fabricate an id.
					logger.warn('Created window is not tracked by the registry', LOG_CONTEXT);
					return null;
				}
				return toWindowInfo(entry);
			}
		)
	);

	// Close a window by ID. The primary window can never be closed this way -
	// quitting the app is the primary's only teardown path.
	ipcMain.handle(
		'windows:close',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'close' },
			async (windowId: string): Promise<{ closed: boolean; error?: string }> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				const entry = registry.get(windowId);
				if (!entry) return { closed: false, error: 'Window not found' };
				if (entry.isMain) return { closed: false, error: 'Cannot close the primary window' };
				if (!entry.browserWindow.isDestroyed()) entry.browserWindow.close();
				return { closed: true };
			}
		)
	);

	// Enumerate every open window.
	ipcMain.handle(
		'windows:list',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'list' },
			async (): Promise<WindowInfo[]> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return registry.getAll().map(toWindowInfo);
			}
		)
	);

	// Which window owns a given agent (session), or null if none does.
	ipcMain.handle(
		'windows:getForSession',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'getForSession' },
			async (sessionId: string): Promise<string | null> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return registry.getWindowForSession(sessionId);
			}
		)
	);

	// Move an agent from one window to another.
	ipcMain.handle(
		'windows:moveSession',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'moveSession' },
			async (
				sessionId: string,
				fromWindowId: string,
				toWindowId: string
			): Promise<{ moved: boolean; error?: string }> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				if (!registry.get(fromWindowId) || !registry.get(toWindowId)) {
					return { moved: false, error: 'Unknown source or destination window' };
				}
				registry.moveSession(sessionId, fromWindowId, toWindowId);
				return { moved: true };
			}
		)
	);

	// Bring a window to the foreground (restoring it first if minimized).
	ipcMain.handle(
		'windows:focusWindow',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'focusWindow' },
			async (windowId: string): Promise<{ focused: boolean; error?: string }> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				const entry = registry.get(windowId);
				if (!entry || entry.browserWindow.isDestroyed()) {
					return { focused: false, error: 'Window not found' };
				}
				const { browserWindow } = entry;
				if (browserWindow.isMinimized()) browserWindow.restore();
				browserWindow.focus();
				return { focused: true };
			}
		)
	);

	// Find the window whose screen bounds contain a point (Phase 3 tab drag).
	ipcMain.handle(
		'windows:findWindowAtPoint',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'findWindowAtPoint' },
			async (screenX: number, screenY: number): Promise<string | null> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return registry.findWindowAtPoint(screenX, screenY);
			}
		)
	);

	// Toggle a window's tab-bar drop-zone highlight (Phase 3 tab drag-out). Sent
	// only to the target window's renderer; an unknown/destroyed window is a silent
	// no-op so a stale highlight request can never throw mid-drag.
	ipcMain.handle(
		'windows:highlightDropZone',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'highlightDropZone' },
			async (windowId: string, active: boolean): Promise<void> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				const entry = registry.get(windowId);
				if (!entry || entry.browserWindow.isDestroyed()) return;
				const { webContents } = entry.browserWindow;
				if (webContents.isDestroyed()) return;
				const payload: WindowHighlightDropZonePayload = { windowId, active };
				webContents.send(WINDOW_HIGHLIGHT_DROP_ZONE_CHANNEL, payload);
			}
		)
	);

	// The remaining two handlers resolve the *calling* window from event.sender,
	// so they take the raw (event, ...) form rather than withIpcErrorLogging
	// (which strips the event). Unexpected errors bubble to Sentry per policy.

	// Current window's full WindowState (bounds + owned agents).
	ipcMain.handle('windows:getState', (event: Electron.IpcMainInvokeEvent): WindowState | null => {
		const registry = requireDependency(getWindowRegistry, 'Window registry');
		const entry = resolveCallingWindow(event, registry);
		return entry ? registeredWindowToWindowState(entry) : null;
	});

	// Claim a freshly-created agent for the CALLING window, making it that window's
	// owner before the agent's process starts emitting output (spawn-flicker fix).
	// Resolved from event.sender so a window only ever claims an agent into itself;
	// an unregistered caller is a silent no-op. The registry emits sessions-changed,
	// which wireWindowRegistryBroadcast forwards to every window so the primary's
	// catch-all and the cross-window badges drop the now-owned agent.
	ipcMain.handle(
		'windows:registerSession',
		(event: Electron.IpcMainInvokeEvent, sessionId: string): { registered: boolean } => {
			const registry = requireDependency(getWindowRegistry, 'Window registry');
			const entry = resolveCallingWindow(event, registry);
			if (!entry) return { registered: false };
			registry.registerSession(entry.id, sessionId);
			return { registered: true };
		}
	);

	// Persist the calling window's panel-collapse UI state (per-window, not a
	// global setting). Resolved from event.sender so a window only ever writes its
	// own state; an unregistered caller is a silent no-op. A later read via
	// windows:getState reflects the new value.
	ipcMain.handle(
		'windows:setPanelState',
		(event: Electron.IpcMainInvokeEvent, panel: Partial<WindowPanelState>): void => {
			const registry = requireDependency(getWindowRegistry, 'Window registry');
			const entry = resolveCallingWindow(event, registry);
			if (entry) registry.setPanelState(entry.id, panel);
		}
	);

	// On-screen bounds of a window. Defaults to the calling window; pass a
	// windowId to query a specific one (Phase 3 tab drag).
	ipcMain.handle(
		'windows:getBounds',
		(event: Electron.IpcMainInvokeEvent, windowId?: string): WindowBounds | null => {
			const registry = requireDependency(getWindowRegistry, 'Window registry');
			const entry = windowId ? registry.get(windowId) : resolveCallingWindow(event, registry);
			if (!entry || entry.browserWindow.isDestroyed()) return null;
			return entry.browserWindow.getBounds();
		}
	);
}

/**
 * Window manager for creating and managing BrowserWindows.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 *
 * Every window (the primary and any secondary windows) is built by the shared
 * `createBrowserWindow` factory so the navigation guards, webview security
 * hardening, permission handling, crash detection, and off-screen placement
 * guarding are identical for all of them. Registry registration and the
 * auto-updater (primary-only) are wired by the `createWindow` /
 * `createSecondaryWindow` callers around that factory.
 */

import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import type Store from 'electron-store';
import type { SettingsStoreInterface, WindowState } from '../stores/types';
import type { WindowState as SharedWindowState } from '../../shared/window-types';
import { WINDOW_STATE_DEFAULTS } from '../stores/defaults';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';
import { generateUUID } from '../../shared/uuid';
import type { WindowRegistry } from '../window-registry';
import { saveWindowState, WINDOW_STATE_SAVE_DEBOUNCE_MS } from '../window-state-persistence';
import { debounce } from '../utils/debounce';
import { isWebContentsAvailable } from '../utils/safe-send';

const BROWSER_TAB_PARTITION_PREFIX = 'persist:maestro-browser-session-';
// `file:` is allowed so users can open local HTML they just generated
// (Plotly dashboards, etc.) inside Maestro instead of bouncing to the system
// browser. The webview is still hardened (sandbox, no node, webSecurity true)
// and only renders content the user explicitly opens.
const ALLOWED_BROWSER_TAB_EMBED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const ALLOWED_BROWSER_TAB_ABOUT_URLS = new Set(['about:blank']);
const ALLOWED_APP_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

/** Sentry severity levels */
type SentrySeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/** Sentry module type for crash reporting */
interface SentryModule {
	captureMessage: (
		message: string,
		captureContext?: { level?: SentrySeverityLevel; extra?: Record<string, unknown> }
	) => string;
}

/** Cached Sentry module reference */
let sentryModule: SentryModule | null = null;

type BrowserTabWebPreferences = Record<string, unknown> & {
	partition?: string;
	preload?: string;
	nodeIntegration?: boolean;
	nodeIntegrationInSubFrames?: boolean;
	contextIsolation?: boolean;
	sandbox?: boolean;
	webSecurity?: boolean;
	allowRunningInsecureContent?: boolean;
};

interface BrowserTabGuestContents {
	getType?: () => string;
	setWindowOpenHandler: (
		handler: ({ url }: { url: string }) => { action: 'deny' | 'allow' }
	) => void;
	on(
		event: 'will-navigate' | 'will-redirect',
		handler: (event: { preventDefault: () => void }, url: string) => void
	): void;
	on(event: string, handler: (...args: any[]) => void): void;
	executeJavaScript(code: string): Promise<unknown>;
	// Privileged Electron paste: bypasses the web-facing `clipboard-read`
	// permission that the permission handler denies to webviews (issue #1063).
	paste(): void;
}

function isAllowedBrowserTabUrl(rawUrl: string): boolean {
	if (ALLOWED_BROWSER_TAB_ABOUT_URLS.has(rawUrl)) return true;

	try {
		return ALLOWED_BROWSER_TAB_EMBED_PROTOCOLS.has(new URL(rawUrl).protocol);
	} catch {
		return false;
	}
}

function isAllowedBrowserTabPartition(partition: string): boolean {
	return partition.startsWith(BROWSER_TAB_PARTITION_PREFIX);
}

function hardenBrowserTabWebPreferences(webPreferences: BrowserTabWebPreferences): void {
	delete webPreferences.preload;
	delete (webPreferences as Record<string, unknown>).preloadURL;

	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.contextIsolation = true;
	webPreferences.sandbox = true;
	webPreferences.webSecurity = true;
	webPreferences.allowRunningInsecureContent = false;
}

function attachBrowserTabGuestSecurity(guestContents: BrowserTabGuestContents): void {
	const denyBrowserTabNavigation = (
		eventName: 'will-navigate' | 'will-redirect',
		event: { preventDefault: () => void },
		url: string
	) => {
		if (isAllowedBrowserTabUrl(url)) return;

		event.preventDefault();
		logger.warn(`Blocked browser-tab ${eventName}: ${url}`, 'Window', {
			url,
			type: guestContents.getType?.() ?? 'unknown',
		});
	};

	guestContents.setWindowOpenHandler(({ url }) => {
		logger.warn(`Blocked browser-tab popup: ${url}`, 'Window', {
			url,
			type: guestContents.getType?.() ?? 'unknown',
		});
		return { action: 'deny' };
	});

	guestContents.on('will-navigate', (event, url) => {
		denyBrowserTabNavigation('will-navigate', event, url);
	});

	guestContents.on('will-redirect', (event, url) => {
		denyBrowserTabNavigation('will-redirect', event, url);
	});
}

/**
 * Reports a crash event to Sentry from the main process.
 * Lazily loads Sentry to avoid module initialization issues.
 */
async function reportCrashToSentry(
	message: string,
	level: SentrySeverityLevel,
	extra?: Record<string, unknown>
): Promise<void> {
	try {
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.captureMessage(message, { level, extra });
	} catch {
		// Sentry not available (development mode or initialization failed)
		logger.debug('Sentry not available for crash reporting', 'Window');
	}
}

/** A display work-area rectangle in screen (DIP) coordinates. */
type DisplayWorkArea = { x: number; y: number; width: number; height: number };

/**
 * Centers a window of the given size inside a display's work area. The offset is
 * clamped to zero so a window larger than the work area still pins to its
 * top-left corner (its title bar) rather than spilling above/left of it.
 */
function centerWithinWorkArea(
	workArea: DisplayWorkArea,
	width: number,
	height: number
): { x: number; y: number } {
	return {
		x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
		y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
	};
}

/**
 * Resolves the on-screen position for a window restored from saved bounds,
 * accounting for display-configuration changes between sessions.
 *
 * The saved bounds are validated against the *current* displays:
 * `screen.getDisplayMatching` returns the display the saved rectangle most
 * closely intersects (when the monitor that held the window has been unplugged
 * this falls back to the nearest remaining display), and we check whether the
 * window's title bar would actually be reachable on it. Two cases leave the
 * saved coordinates unusable and the window invisible:
 *   - the window was saved minimized (Windows reports bounds of -32000,-32000), or
 *   - the monitor it lived on has been removed.
 * In both cases the window is repositioned onto the primary display so it can
 * never spawn off-screen. When there is no saved position at all we return
 * undefined x/y so Electron places the window itself.
 */
export function resolveVisibleWindowPosition(state: {
	x?: number;
	y?: number;
	width: number;
	height: number;
}): { x?: number; y?: number } {
	if (typeof state.x !== 'number' || typeof state.y !== 'number') {
		return {};
	}

	const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };

	// Validate against the display the saved bounds most closely intersect. If
	// that monitor is gone, getDisplayMatching returns the nearest remaining one
	// and the reachability check below fails, triggering a reposition.
	const matched = screen.getDisplayMatching(bounds);

	// The window is reachable if the center of its title bar lands inside the
	// matched display's work area, with a bottom margin so the title bar can't
	// sit below the screen edge where it can't be grabbed.
	const BOTTOM_MARGIN = 80;
	const TITLE_BAR_SAMPLE_Y = 16; // approximate title-bar height (px)
	const titleBar = { x: bounds.x + bounds.width / 2, y: bounds.y + TITLE_BAR_SAMPLE_Y };
	const { x, y, width, height } = matched.workArea;
	const isOnScreen =
		titleBar.x >= x &&
		titleBar.x <= x + width &&
		titleBar.y >= y &&
		titleBar.y <= y + height - BOTTOM_MARGIN;

	if (isOnScreen) {
		return { x: bounds.x, y: bounds.y };
	}

	// Off-screen (minimized sentinel or removed monitor): bring the window back
	// onto the primary display so it can never spawn invisible.
	return centerWithinWorkArea(screen.getPrimaryDisplay().workArea, bounds.width, bounds.height);
}

/** Bounds/state used to size and position a window at creation time. */
interface WindowCreationBounds {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	isMaximized?: boolean;
	isFullScreen?: boolean;
}

/** Dependencies for window manager */
export interface WindowManagerDependencies {
	/** Store for window state persistence */
	windowStateStore: Store<WindowState>;
	/** Whether running in development mode */
	isDevelopment: boolean;
	/** Path to the preload script */
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL */
	devServerUrl: string;
	/** Whether to use the native OS title bar instead of custom title bar */
	useNativeTitleBar: boolean;
	/** Whether to auto-hide the menu bar (Linux/Windows) */
	autoHideMenuBar: boolean;
	/**
	 * Lazy getter for the quit handler's confirmQuit function. Used by the
	 * auto-updater install path to bypass the busy-agent quit confirmation
	 * gate. Lazy because the quit handler is constructed after the window.
	 */
	getConfirmQuit?: () => (() => void) | null | undefined;
	/**
	 * Registry that tracks every window and which agents (sessions) it owns.
	 * Injected (rather than reached for as a module global) so window creation
	 * registers the primary as `isMain` and every secondary window it builds.
	 * Optional during the phased rollout: the primary is only registered when a
	 * registry is provided.
	 */
	windowRegistry?: WindowRegistry;
	/**
	 * Runtime settings store. Injected (rather than reached for as a module
	 * global) for window-related preferences read by later multi-window phases
	 * (per-window panel/session persistence).
	 */
	settingsStore?: SettingsStoreInterface;
	/**
	 * Lazy "is the app quitting" signal. When true, a closing secondary window
	 * skips registry cleanup since the registry is discarded with the process.
	 */
	getIsQuitting?: () => boolean;
}

/** Window manager instance */
export interface WindowManager {
	/**
	 * Create and show the main (primary) window. With no options the window
	 * restores from the legacy single-window store (backward compatible). On a
	 * multi-window restore the caller passes the saved primary's `bounds` and the
	 * `sessionIds` it owns so the primary comes back exactly where it was.
	 */
	createWindow: (options?: {
		sessionIds?: string[];
		bounds?: Partial<SharedWindowState>;
	}) => BrowserWindow;
	/**
	 * Create a secondary window owning `sessionIds`, registered with the window
	 * registry. The window self-identifies via a `?windowId=<id>` query appended
	 * to the renderer URL (read by the renderer in a later phase).
	 */
	createSecondaryWindow: (
		sessionIds: string[],
		bounds?: Partial<SharedWindowState>
	) => BrowserWindow;
}

/**
 * Creates a window manager for handling BrowserWindows.
 *
 * @param deps - Dependencies for window creation
 * @returns WindowManager instance
 */
export function createWindowManager(deps: WindowManagerDependencies): WindowManager {
	const {
		windowStateStore,
		isDevelopment,
		preloadPath,
		rendererProductionUrl,
		devServerUrl,
		useNativeTitleBar,
		autoHideMenuBar,
		getConfirmQuit,
		windowRegistry,
		getIsQuitting,
	} = deps;

	/**
	 * Builds the renderer URL for a window. Secondary windows get a
	 * `?windowId=<id>` query so the renderer can self-identify; the primary
	 * loads the bare URL unchanged.
	 */
	const buildEntryUrl = (windowId: string, isMain: boolean): string => {
		const base = isDevelopment ? devServerUrl : rendererProductionUrl;
		if (isMain) return base;
		const separator = base.includes('?') ? '&' : '?';
		return `${base}${separator}windowId=${encodeURIComponent(windowId)}`;
	};

	/**
	 * Shared factory that builds and fully hardens a BrowserWindow. EVERY window
	 * (primary and secondary) goes through here so the security hardening,
	 * navigation guards, permission handling, crash detection, and off-screen
	 * placement guarding are identical. Registry registration and the
	 * auto-updater (primary-only) are wired by the callers below.
	 */
	const createBrowserWindow = (options: {
		windowId: string;
		sessionIds: string[];
		bounds?: WindowCreationBounds;
		isMain: boolean;
	}): BrowserWindow => {
		const { windowId, bounds, isMain } = options;

		// Restore saved window state, discarding off-screen coordinates so the
		// window can never spawn invisible (saved while minimized -> -32000 on
		// Windows, or on an unplugged monitor); fall back to a centered window.
		const width = bounds?.width ?? WINDOW_STATE_DEFAULTS.width;
		const height = bounds?.height ?? WINDOW_STATE_DEFAULTS.height;
		const position = resolveVisibleWindowPosition({ x: bounds?.x, y: bounds?.y, width, height });

		const browserWindow = new BrowserWindow({
			x: position.x,
			y: position.y,
			width,
			height,
			minWidth: 1000,
			minHeight: 600,
			backgroundColor: '#0b0b0d',
			...(useNativeTitleBar ? {} : { titleBarStyle: 'hiddenInset' as const }),
			...(autoHideMenuBar ? { autoHideMenuBar: true } : {}),
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: true,
				// Embedded browser tabs use Electron's guest webview surface in the renderer.
				webviewTag: true,
			},
		});

		// Restore maximized/fullscreen state after window is created
		if (bounds?.isFullScreen) {
			browserWindow.setFullScreen(true);
		} else if (bounds?.isMaximized) {
			browserWindow.maximize();
		}

		logger.info('Browser window created', 'Window', {
			size: `${width}x${height}`,
			maximized: bounds?.isMaximized ?? false,
			fullScreen: bounds?.isFullScreen ?? false,
			mode: isDevelopment ? 'development' : 'production',
			isMain,
		});

		// Save window state before closing. Only the primary window backs the
		// legacy single-window store; secondary-window persistence rides on the
		// multi-window state wired below.
		if (isMain) {
			const saveLegacySingleWindowState = () => {
				try {
					const isMaximized = browserWindow.isMaximized();
					const isFullScreen = browserWindow.isFullScreen();
					const isMinimized = browserWindow.isMinimized();
					const savedBounds = browserWindow.getBounds();

					// Only save bounds when the window is in its normal state. While
					// minimized, Windows reports bounds of (-32000, -32000), which would
					// otherwise persist and make the window spawn off-screen next launch.
					if (!isMaximized && !isFullScreen && !isMinimized) {
						windowStateStore.set('x', savedBounds.x);
						windowStateStore.set('y', savedBounds.y);
						windowStateStore.set('width', savedBounds.width);
						windowStateStore.set('height', savedBounds.height);
					}
					windowStateStore.set('isMaximized', isMaximized);
					windowStateStore.set('isFullScreen', isFullScreen);
				} catch {
					// Ignore ENFILE/ENOSPC errors during window close — non-critical
				}
			};

			browserWindow.on('close', saveLegacySingleWindowState);
		}

		// Multi-window persistence: keep this window's entry in the persisted
		// MultiWindowState current as the user drags, resizes, or toggles
		// maximize/fullscreen. Debounced so a live drag/resize (which fires a
		// flood of move/resize events) collapses into one store write once the
		// user settles. Each window gets its own debounced closure, so one
		// window's activity never delays another's save. Only wired when a
		// registry is present (the window-state blob is keyed off registered
		// windows); the quit handler still takes the authoritative final snapshot.
		if (windowRegistry) {
			const persistWindowState = debounce(() => {
				saveWindowState(windowStateStore, windowRegistry, windowId);
			}, WINDOW_STATE_SAVE_DEBOUNCE_MS);

			const PERSIST_EVENTS = [
				'move',
				'resize',
				'maximize',
				'unmaximize',
				'enter-full-screen',
				'leave-full-screen',
			] as const;
			// Electron types `.on` with a distinct overload per event name, so a
			// union loop variable matches none of them. The cast is safe: every
			// listed event delivers a listener compatible with our `() => void`.
			for (const eventName of PERSIST_EVENTS) {
				browserWindow.on(eventName as 'resize', persistWindowState);
			}

			// Drop any queued save when the window goes away. The quit handler and
			// later removal-driven saves own the post-close layout; a debounced
			// callback firing after the window left the registry would just no-op.
			browserWindow.on('closed', () => persistWindowState.cancel());
		}

		// Load the app
		const entryUrl = buildEntryUrl(windowId, isMain);
		if (isDevelopment) {
			// Install React DevTools extension in development mode. The extension
			// installs into the shared session, so doing it once for the primary
			// window covers every window.
			if (isMain) {
				import('electron-devtools-installer')
					.then(({ default: installExtension, REACT_DEVELOPER_TOOLS }) => {
						installExtension(REACT_DEVELOPER_TOOLS)
							.then(() => logger.info('React DevTools extension installed', 'Window'))
							.catch((err: Error) =>
								logger.warn(`Failed to install React DevTools: ${err.message}`, 'Window')
							);
					})
					.catch((err: Error) =>
						logger.warn(`Failed to load electron-devtools-installer: ${err.message}`, 'Window')
					);
			}

			browserWindow.loadURL(entryUrl);
			// DevTools can be opened via Command-K menu instead of automatically on startup
			logger.info('Loading development server', 'Window');
		} else {
			browserWindow.loadURL(entryUrl);
			logger.info('Loading production build', 'Window');
			// Open DevTools in production if DEBUG env var is set
			if (process.env.DEBUG === 'true') {
				browserWindow.webContents.openDevTools();
			}
		}

		// ================================================================
		// Navigation & Window Security Hardening
		// ================================================================

		// Restrict renderer-created webviews to the browser-tab surface only.
		browserWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
			const src = typeof params.src === 'string' ? params.src : '';
			const partition =
				typeof webPreferences.partition === 'string' ? webPreferences.partition : '';

			hardenBrowserTabWebPreferences(webPreferences as BrowserTabWebPreferences);

			if (!isAllowedBrowserTabUrl(src) || !isAllowedBrowserTabPartition(partition)) {
				event.preventDefault();
				logger.warn(`Blocked unsafe webview attachment: ${src || '<empty src>'}`, 'Window', {
					src,
					partition,
				});
			}
		});

		browserWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
			attachBrowserTabGuestSecurity(guestContents as BrowserTabGuestContents);

			// Forward app shortcuts from the webview guest process to the renderer.
			// When a <webview> has focus, keyboard events are trapped in its guest
			// Chromium process and never reach the renderer's window keydown handler.
			//
			// Strategy: inject a bubble-phase keydown listener into the guest page.
			// After all page handlers have run, if the page did NOT call preventDefault
			// on a Meta/Ctrl keystroke, it means the page doesn't use that shortcut —
			// so we forward it to the app. If the page DID preventDefault, the page's
			// shortcut takes precedence and we leave it alone.
			const guest = guestContents as BrowserTabGuestContents;

			// Intercept app shortcuts BEFORE Chromium's built-in handlers consume them.
			// Some keys (e.g. Cmd+L for address bar focus) are handled by Chromium
			// internally and never reach the injected JS listener below.
			guest.on('before-input-event', (event, input) => {
				if (!input.meta && !input.control && !input.alt) return;
				if (input.type !== 'keyDown') return;
				const k = input.key.toLowerCase();
				// Cmd/Ctrl+V: drive paste through the trusted guest webContents API.
				// Chromium's native paste needs the `clipboard-read` permission, which
				// the permission handler denies to webviews as a security boundary, so
				// native paste silently fails inside browser-tab form fields (issue
				// #1063). guest.paste() is a privileged Electron call that bypasses
				// that web-facing permission, mirroring the right-click Paste menu
				// item (issue #1065).
				const isPaste = (input.meta || input.control) && !input.alt && !input.shift && k === 'v';
				if (isPaste) {
					event.preventDefault();
					guest.paste();
					return;
				}
				// Let the remaining standard text-editing shortcuts pass through to
				// the page. `f` is intentionally NOT in this list: Cmd+F must reach
				// the renderer so the in-page find bar can open.
				const isTextEditing =
					(input.meta || input.control) && !input.alt && !input.shift && 'acxz'.includes(k);
				const isRedo = (input.meta || input.control) && !input.alt && input.shift && k === 'z';
				if (isTextEditing || isRedo) return;
				event.preventDefault();
				browserWindow.webContents.send('browser-tab:shortcutKey', {
					key: input.key,
					code: input.code,
					meta: input.meta,
					control: input.control,
					alt: input.alt,
					shift: input.shift,
				});
			});

			// Capture-phase listener: intercepts app shortcuts BEFORE the page
			// can handle them.  We preventDefault+stopPropagation so the page
			// never sees the event, then forward it to the app via console.log.
			const shortcutInjection = `(function(){
				if(window.__maestroShortcutListenerInstalled)return;
				window.__maestroShortcutListenerInstalled=true;
				document.addEventListener('keydown',function(e){
					var hasMod=e.metaKey||e.ctrlKey;
					var hasAlt=e.altKey;
					if(!hasMod&&!hasAlt)return;
					var k=e.key.toLowerCase();
					var te=hasMod&&!hasAlt&&!e.shiftKey&&'acxz'.indexOf(k)!==-1;
					var re=hasMod&&!hasAlt&&e.shiftKey&&k==='z';
					if(te||re)return;
					e.preventDefault();
					e.stopPropagation();
					console.log('__MAESTRO_KEY__'+JSON.stringify({
						key:e.key,code:e.code,
						meta:e.metaKey,control:e.ctrlKey,
						alt:e.altKey,shift:e.shiftKey
					}));
				},true);
			})();`;
			const injectShortcutListener = () => {
				guest.executeJavaScript(shortcutInjection).catch(() => {});
			};
			guest.on('dom-ready', injectShortcutListener);
			guest.on('did-navigate', injectShortcutListener);
			// console-message args: (event, level, message, line, sourceId)
			guest.on('console-message', (...args: unknown[]) => {
				const message = typeof args[2] === 'string' ? args[2] : String(args[2] ?? '');
				const prefix = '__MAESTRO_KEY__';
				if (!message.startsWith(prefix)) return;
				try {
					const input = JSON.parse(message.slice(prefix.length));
					browserWindow.webContents.send('browser-tab:shortcutKey', input);
				} catch {
					// Malformed message, ignore
				}
			});
		});

		// Deny all popup/new-window requests — external links use IPC shell:openExternal
		browserWindow.webContents.setWindowOpenHandler(({ url }) => {
			logger.warn(`Blocked window.open request: ${url}`, 'Window');
			return { action: 'deny' };
		});

		// Restrict navigation to the app itself — prevent renderer from navigating away.
		// Both the dev-server URL and the renderer entry's file:// URL are constants
		// for the lifetime of this window, so compute them once at setup time rather
		// than on every navigation event. The production guard only allows the
		// renderer entry HTML itself: a previous "directory prefix" check let any
		// file inside the renderer dir through, which meant a stray <a href="foo.md">
		// in chat output could resolve relative to index.html and unload the app to
		// a non-existent bundle file.
		// The dev server serves the app at its root. A previous guard allowed the
		// ENTIRE dev origin through, which let any same-origin path (a game served
		// by the dev server, or a stray relative <a href="game/"> in chat/markdown
		// output) unload the app and take over the whole window. Page content
		// belongs in a <webview> browser tab, never the top-level frame, so the dev
		// guard is now as strict as production: only the app's own entry document
		// (origin AND pathname) may load top-level. HMR/full-reloads target the same
		// root URL and the renderer has no top-level URL routing, so this is safe.
		// `allowedProdEntryUrl` is THIS window's exact entry URL (which carries the
		// `?windowId=` query for secondary windows) so a programmatic reload to the
		// same URL is allowed while any other path is still rejected.
		const devEntryUrl = isDevelopment ? new URL(devServerUrl) : null;
		const allowedDevOrigin = devEntryUrl ? devEntryUrl.origin : null;
		const allowedDevPathname = devEntryUrl ? devEntryUrl.pathname || '/' : null;
		const allowedProdOrigin = isDevelopment ? null : new URL(rendererProductionUrl).origin;
		const allowedProdEntryUrl = isDevelopment ? null : entryUrl;
		browserWindow.webContents.on('will-navigate', (event, url) => {
			const parsedUrl = new URL(url);
			if (isDevelopment) {
				const pathname = parsedUrl.pathname || '/';
				if (parsedUrl.origin === allowedDevOrigin && pathname === allowedDevPathname) return;
			} else {
				if (parsedUrl.origin === allowedProdOrigin && url === allowedProdEntryUrl) return;
			}
			event.preventDefault();
			logger.warn(`Blocked navigation to: ${url}`, 'Window');
		});

		// Deny most browser permission requests (camera, mic, geolocation, etc.)
		// Allow clipboard access for the app window only, never embedded browser tabs.
		browserWindow.webContents.session.setPermissionRequestHandler(
			(webContents, permission, callback) => {
				const contentsType = webContents?.getType?.();
				const isAppWindow = contentsType === 'window';

				if (isAppWindow && ALLOWED_APP_PERMISSIONS.has(permission)) {
					callback(true);
				} else {
					if (contentsType === 'webview') {
						logger.warn(`Blocked browser-tab permission request: ${permission}`, 'Window', {
							permission,
							type: contentsType,
						});
					}
					callback(false);
				}
			}
		);

		// Spell check suggestions: Electron renders red squiggles automatically when
		// `spellcheck` is true on a form element, but the right-click "Did you mean..."
		// menu has to be wired up in the main process.
		browserWindow.webContents.on('context-menu', (_event, params) => {
			logger.debug('context-menu fired', 'Window', {
				isEditable: params.isEditable,
				misspelledWord: params.misspelledWord,
				suggestions: params.dictionarySuggestions,
				selectionText: params.selectionText,
			});

			if (!params.isEditable) return;

			const template: Electron.MenuItemConstructorOptions[] = [];

			const suggestions = params.dictionarySuggestions ?? [];
			if (params.misspelledWord) {
				if (suggestions.length === 0) {
					template.push({ label: 'No suggestions', enabled: false });
				} else {
					for (const suggestion of suggestions) {
						template.push({
							label: suggestion,
							click: () => browserWindow.webContents.replaceMisspelling(suggestion),
						});
					}
				}
				template.push(
					{ type: 'separator' },
					{
						label: 'Add to Dictionary',
						click: () =>
							browserWindow.webContents.session.addWordToSpellCheckerDictionary(
								params.misspelledWord
							),
					},
					{ type: 'separator' }
				);
			}

			template.push(
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ type: 'separator' },
				{ role: 'selectAll' }
			);

			Menu.buildFromTemplate(template).popup({ window: browserWindow });
		});

		browserWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window');
		});

		// ================================================================
		// Renderer Process Crash Detection
		// ================================================================
		// These handlers capture crashes that Sentry in the renderer cannot
		// report (because the renderer process is dead or broken).

		// Handle renderer process termination (crash, kill, OOM, etc.)
		browserWindow.webContents.on('render-process-gone', (_event, details) => {
			logger.error('Renderer process gone', 'Window', {
				reason: details.reason,
				exitCode: details.exitCode,
			});

			// `killed` (signal-terminated, e.g. app quit / OS shutdown / user
			// force-quit) and `clean-exit` are intentional terminations, not
			// crashes - the auto-reload guard below already treats them as such.
			// Reporting them as `fatal` Sentry events is pure noise; genuine
			// out-of-memory kills surface separately as reason `oom`. Only the
			// real crash reasons (`crashed`, `oom`, `abnormal-exit`, etc.) are
			// worth a breadcrumb. Fixes MAESTRO-4X/4Y.
			const intentionalTermination = details.reason === 'killed' || details.reason === 'clean-exit';
			if (!intentionalTermination) {
				// Report to Sentry from main process (always available)
				reportCrashToSentry(`Renderer process gone: ${details.reason}`, 'fatal', {
					reason: details.reason,
					exitCode: details.exitCode,
				});
			}

			// Auto-reload unless the process was intentionally killed
			if (details.reason !== 'killed' && details.reason !== 'clean-exit') {
				logger.info('Attempting to reload renderer after crash', 'Window');
				setTimeout(() => {
					if (!browserWindow.isDestroyed()) {
						browserWindow.webContents.reload();
					}
				}, 1000);
			}
		});

		// Handle window becoming unresponsive (frozen renderer)
		browserWindow.on('unresponsive', () => {
			logger.warn('Window became unresponsive', 'Window');
			reportCrashToSentry('Window unresponsive', 'warning', {
				memoryUsage: process.memoryUsage(),
			});
		});

		// Log when window recovers from unresponsive state
		browserWindow.on('responsive', () => {
			logger.info('Window became responsive again', 'Window');
		});

		// Note: the legacy 'crashed' event was removed in Electron 41 and
		// is now subsumed by 'render-process-gone' above (which reports to
		// Sentry with full reason/exitCode detail and handles auto-reload).

		// Handle page load failures (network issues, invalid URLs, etc.)
		browserWindow.webContents.on(
			'did-fail-load',
			(_event, errorCode, errorDescription, validatedURL) => {
				// Ignore aborted loads (user navigated away)
				if (errorCode === -3) return;

				logger.error('Page failed to load', 'Window', {
					errorCode,
					errorDescription,
					url: validatedURL,
				});
				reportCrashToSentry(`Page failed to load: ${errorDescription}`, 'error', {
					errorCode,
					errorDescription,
					url: validatedURL,
				});
			}
		);

		// Handle preload script errors
		browserWindow.webContents.on('preload-error', (_event, preloadScriptPath, error) => {
			logger.error('Preload script error', 'Window', {
				preloadPath: preloadScriptPath,
				error: error.message,
				stack: error.stack,
			});
			reportCrashToSentry('Preload script error', 'fatal', {
				preloadPath: preloadScriptPath,
				error: error.message,
				stack: error.stack,
			});
		});

		// Forward renderer console errors to main process logger and Sentry
		// This catches errors that happen before or outside React's error boundary
		browserWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
			// Level 2 = error (0=verbose, 1=info, 2=warning, 3=error)
			if (level === 3) {
				logger.error(`Renderer console error: ${message}`, 'Window', {
					line,
					source: sourceId,
				});

				// Report critical errors to Sentry
				// Filter out common noise (React dev warnings, etc.)
				const isCritical =
					message.includes('Uncaught') ||
					message.includes('TypeError') ||
					message.includes('ReferenceError') ||
					message.includes('Cannot read') ||
					message.includes('is not defined') ||
					message.includes('is not a function');

				if (isCritical) {
					reportCrashToSentry(`Renderer error: ${message}`, 'error', {
						line,
						source: sourceId,
					});
				}
			}
		});

		// Initialize auto-updater (only in production, and only for the primary
		// window - update checks/installs are a single app-wide concern).
		if (isMain) {
			if (!isDevelopment) {
				initAutoUpdater(browserWindow, {
					onBeforeQuitAndInstall: () => {
						const confirmQuit = getConfirmQuit?.();
						confirmQuit?.();
					},
				});
				logger.info('Auto-updater initialized', 'Window');
			} else {
				// Register stub handlers in development mode so users get a helpful error
				registerDevAutoUpdaterStubs();
				logger.info(
					'Auto-updater disabled in development mode (stub handlers registered)',
					'Window'
				);
			}
		}

		return browserWindow;
	};

	return {
		createWindow: (options?: {
			sessionIds?: string[];
			bounds?: Partial<SharedWindowState>;
		}): BrowserWindow => {
			const sessionIds = options?.sessionIds ?? [];
			// Restore from the saved multi-window primary bounds when restoring a
			// layout; otherwise fall back to the legacy single-window store.
			const bounds = options?.bounds ?? windowStateStore.store;
			// Adopt the saved window id (multi-window restore) so ids stay STABLE
			// across restart and id-keyed state (e.g. a custom window name) reconnects;
			// mint a fresh one for a first-ever launch with no saved layout.
			const windowId = options?.bounds?.id ?? generateUUID();
			const browserWindow = createBrowserWindow({
				windowId,
				sessionIds,
				bounds,
				isMain: true,
			});

			if (windowRegistry) {
				windowRegistry.create({
					windowId,
					browserWindow,
					sessionIds,
					isMain: true,
					name: options?.bounds?.name,
					// Restore the saved per-window panel-collapse state (undefined on a
					// fresh launch -> registry defaults to expanded).
					leftPanelCollapsed: options?.bounds?.leftPanelCollapsed,
					rightPanelCollapsed: options?.bounds?.rightPanelCollapsed,
				});
				// Keep the registry consistent if the primary closes. On macOS the
				// app stays alive after all windows close and a later `activate`
				// rebuilds a fresh primary, so the stale entry must not linger.
				browserWindow.on('closed', () => {
					windowRegistry.remove(windowId);
				});
			}

			return browserWindow;
		},

		createSecondaryWindow: (
			sessionIds: string[],
			bounds?: Partial<SharedWindowState>
		): BrowserWindow => {
			// Adopt the saved id on restore so ids stay stable across restart and a
			// custom window name (keyed by id) reconnects; mint fresh otherwise.
			const windowId = bounds?.id ?? generateUUID();
			const browserWindow = createBrowserWindow({
				windowId,
				sessionIds,
				bounds,
				isMain: false,
			});

			windowRegistry?.create({
				windowId,
				browserWindow,
				sessionIds,
				isMain: false,
				name: bounds?.name,
				// Restore the saved per-window panel-collapse state on layout restore.
				leftPanelCollapsed: bounds?.leftPanelCollapsed,
				rightPanelCollapsed: bounds?.rightPanelCollapsed,
			});

			browserWindow.on('closed', () => {
				// Skip registry work while the app is quitting - the registry is
				// discarded with the process, so reclaiming ownership or emitting a
				// change then is pointless.
				if (getIsQuitting?.() || !windowRegistry) return;

				// Reclaim any agents still owned by this window into the primary so
				// none are ever orphaned, THEN drop the closed window. The reclaim
				// moves broadcast `session-moved` to every live renderer (Phase 5),
				// so the primary's tab strip picks the agents up; a brief toast tells
				// the user where they went.
				const reclaimed = windowRegistry.reclaimSessionsToPrimary(windowId);
				windowRegistry.remove(windowId);
				if (reclaimed && reclaimed.movedSessionIds.length > 0) {
					notifySessionsReclaimedToPrimary(windowRegistry, reclaimed.movedSessionIds.length);
				}
			});

			return browserWindow;
		},
	};
}

/**
 * Toast the primary window's renderer that agents from a just-closed secondary
 * window were reclaimed into it. Reuses the existing `remote:notifyToast`
 * pipeline (preload `onRemoteNotifyToast` -> renderer `notifyToast`) rather than
 * a bespoke channel. Advisory only: a missing or destroyed primary renderer is
 * a silent no-op.
 */
function notifySessionsReclaimedToPrimary(registry: WindowRegistry, count: number): void {
	const primary = registry.getPrimary();
	if (!primary || !isWebContentsAvailable(primary.browserWindow)) return;
	const noun = count === 1 ? 'agent' : 'agents';
	primary.browserWindow.webContents.send('remote:notifyToast', {
		title: 'Window closed',
		message: `${count} ${noun} moved to main window`,
		color: 'theme' as const,
	});
}

// Track if stub handlers have been registered (module-level to persist across createWindow calls)
let devStubsRegistered = false;

/**
 * Registers stub IPC handlers for auto-updater in development mode.
 * These provide helpful error messages instead of silent failures.
 * Uses a module-level flag to ensure handlers are only registered once.
 */
function registerDevAutoUpdaterStubs(): void {
	// Only register once - prevents duplicate handler errors if createWindow is called multiple times
	if (devStubsRegistered) {
		logger.debug('Auto-updater stub handlers already registered, skipping', 'Window');
		return;
	}

	ipcMain.handle('updates:download', async () => {
		return {
			success: false,
			error: 'Auto-update is disabled in development mode. Please check update first.',
		};
	});

	ipcMain.handle('updates:install', async () => {
		logger.warn('Auto-update install called in development mode', 'AutoUpdater');
	});

	ipcMain.handle('updates:getStatus', async () => {
		return { status: 'idle' as const };
	});

	ipcMain.handle('updates:checkAutoUpdater', async () => {
		return { success: false, error: 'Auto-update is disabled in development mode' };
	});

	devStubsRegistered = true;
}

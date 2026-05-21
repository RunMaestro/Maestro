/**
 * Window manager for creating and managing the main BrowserWindow.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 */

import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import type Store from 'electron-store';
import type { MultiWindowState, WindowState } from '../stores/types';
import type { WindowInfo, WindowSessionsMovedToPrimaryEvent } from '../../shared/types/window';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';
import { WindowRegistry } from '../window-registry';

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

type WindowBounds = Pick<WindowState, 'x' | 'y' | 'width' | 'height'>;

function createDefaultWindowState(id: string): WindowState {
	return {
		id,
		x: 0,
		y: 0,
		width: 1400,
		height: 900,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

function getPrimaryWindowState(state: MultiWindowState): WindowState {
	return (
		state.windows.find((windowState) => windowState.id === state.primaryWindowId) ||
		state.windows[0] ||
		createDefaultWindowState('primary')
	);
}

function getWindowState(state: MultiWindowState, windowId?: string): WindowState {
	if (!windowId) {
		return getPrimaryWindowState(state);
	}

	return (
		state.windows.find((windowState) => windowState.id === windowId) ||
		createDefaultWindowState(windowId)
	);
}

function appendWindowIdToUrl(url: string, windowId: string): string {
	const parsedUrl = new URL(url);
	parsedUrl.searchParams.set('windowId', windowId);
	return parsedUrl.toString();
}

function findStoredWindowState(
	windowStateStore: Store<MultiWindowState>,
	windowId: string
): WindowState | undefined {
	return windowStateStore.store.windows.find((windowState) => windowState.id === windowId);
}

function getWindowList(
	windowRegistry: WindowRegistry,
	windowStateStore: Store<MultiWindowState>
): WindowInfo[] {
	return windowRegistry.getEntries().map(([windowId, entry]) => {
		const storedState = findStoredWindowState(windowStateStore, windowId);
		return {
			id: windowId,
			isMain: entry.isMain,
			sessionIds: entry.sessionIds,
			activeSessionId: storedState?.activeSessionId ?? null,
		};
	});
}

function broadcastSessionsMovedToPrimary(
	windowRegistry: WindowRegistry,
	payload: WindowSessionsMovedToPrimaryEvent
): void {
	for (const entry of windowRegistry.getAll()) {
		if (entry.browserWindow.isDestroyed() || entry.browserWindow.webContents.isDestroyed()) {
			continue;
		}
		entry.browserWindow.webContents.send('windows:sessionsMovedToPrimary', payload);
	}
}

/**
 * Resolves the window position to use, dropping saved coordinates that would
 * place the window off every visible display. Windows reports bounds of
 * (-32000, -32000) for a minimized window, and unplugging a monitor leaves
 * stale coordinates pointing at a display that no longer exists. In both cases
 * the restored window is invisible. When the saved position is unusable we
 * return undefined x/y so Electron centers the window on the primary display.
 */
function resolveVisibleWindowPosition(state: WindowState): { x?: number; y?: number } {
	if (typeof state.x !== 'number' || typeof state.y !== 'number') {
		return {};
	}

	// The window is reachable if the center of its title bar lands inside the
	// work area of some display, with a bottom margin so the title bar can't sit
	// below the screen edge where it can't be grabbed.
	const BOTTOM_MARGIN = 80;
	const TITLE_BAR_SAMPLE_Y = 16; // approximate title-bar height (px)
	const titleBar = { x: state.x + state.width / 2, y: state.y + TITLE_BAR_SAMPLE_Y };

	const isOnScreen = screen.getAllDisplays().some((display) => {
		const { x, y, width, height } = display.workArea;
		return (
			titleBar.x >= x &&
			titleBar.x <= x + width &&
			titleBar.y >= y &&
			titleBar.y <= y + height - BOTTOM_MARGIN
		);
	});

	return isOnScreen ? { x: state.x, y: state.y } : {};
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

/** Dependencies for window manager */
export interface WindowManagerDependencies {
	/** Store for window state persistence */
	windowStateStore: Store<MultiWindowState>;
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
	/** Registry for tracking all open windows */
	windowRegistry?: WindowRegistry;
	/** Whether the app is in the confirmed quit path */
	isQuitting?: () => boolean;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show a window */
	createWindow: (windowId?: string, sessionIds?: string[]) => BrowserWindow;
	/** Create a secondary window for the provided sessions */
	createSecondaryWindow: (sessionIds: string[], bounds: Partial<WindowBounds>) => BrowserWindow;
	/** Registry tracking all open windows */
	windowRegistry: WindowRegistry;
}

/**
 * Creates a window manager for handling the main BrowserWindow.
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
	} = deps;
	const windowRegistry = deps.windowRegistry ?? new WindowRegistry();
	windowRegistry.setWindowStateStore(windowStateStore);

	const createBrowserWindow = (
		savedState: WindowState,
		options: {
			windowId?: string;
			sessionIds?: string[];
			bounds?: Partial<WindowBounds>;
			isMain?: boolean;
		} = {}
	): BrowserWindow => {
		const position = options.bounds ? options.bounds : resolveVisibleWindowPosition(savedState);
		const windowOptions: BrowserWindowConstructorOptions = {
			x: options.bounds?.x ?? position.x,
			y: options.bounds?.y ?? position.y,
			width: options.bounds?.width ?? savedState.width,
			height: options.bounds?.height ?? savedState.height,
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
		};

		const entry = windowRegistry.create({
			...windowOptions,
			id: options.windowId,
			sessionIds: options.sessionIds ?? savedState.sessionIds,
			isMain: options.isMain,
		});
		const mainWindow = entry.browserWindow;
		const registryWindowId = options.windowId ?? String(mainWindow.id);

		// Restore maximized/fullscreen state after window is created
		if (savedState.isFullScreen) {
			mainWindow.setFullScreen(true);
		} else if (savedState.isMaximized) {
			mainWindow.maximize();
		}

		logger.info('Browser window created', 'Window', {
			id: registryWindowId,
			size: `${windowOptions.width}x${windowOptions.height}`,
			maximized: savedState.isMaximized,
			fullScreen: savedState.isFullScreen,
			mode: isDevelopment ? 'development' : 'production',
		});

		const saveWindowState = () => {
			try {
				windowRegistry.saveWindowState(registryWindowId);
			} catch {
				// Ignore ENFILE/ENOSPC errors during window close — non-critical
			}
		};
		let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
		const scheduleWindowStateSave = () => {
			if (saveWindowStateTimer) {
				clearTimeout(saveWindowStateTimer);
			}
			saveWindowStateTimer = setTimeout(() => {
				saveWindowStateTimer = null;
				saveWindowState();
			}, 250);
		};

		mainWindow.on('close', () => {
			if (!entry.isMain && !(deps.isQuitting?.() ?? false)) {
				const transfer = windowRegistry.moveSessionsToPrimary(registryWindowId);
				if (transfer) {
					windowRegistry.saveWindowState(transfer.toWindowId);
					broadcastSessionsMovedToPrimary(windowRegistry, {
						sessionIds: transfer.sessionIds,
						fromWindowId: registryWindowId,
						toWindowId: transfer.toWindowId,
						windows: getWindowList(windowRegistry, windowStateStore),
					});
				}
			}

			saveWindowState();
		});
		mainWindow.on('move', scheduleWindowStateSave);
		mainWindow.on('resize', scheduleWindowStateSave);
		mainWindow.on('maximize', scheduleWindowStateSave);
		mainWindow.on('unmaximize', scheduleWindowStateSave);
		mainWindow.on('enter-full-screen', scheduleWindowStateSave);
		mainWindow.on('leave-full-screen', scheduleWindowStateSave);

		// Load the app
		if (isDevelopment) {
			// Install React DevTools extension in development mode
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

			mainWindow.loadURL(appendWindowIdToUrl(devServerUrl, registryWindowId));
			// DevTools can be opened via Command-K menu instead of automatically on startup
			logger.info('Loading development server', 'Window');
		} else {
			mainWindow.loadURL(appendWindowIdToUrl(rendererProductionUrl, registryWindowId));
			logger.info('Loading production build', 'Window');
			// Open DevTools in production if DEBUG env var is set
			if (process.env.DEBUG === 'true') {
				mainWindow.webContents.openDevTools();
			}
		}

		// ================================================================
		// Navigation & Window Security Hardening
		// ================================================================

		// Restrict renderer-created webviews to the browser-tab surface only.
		mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
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

		mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
			attachBrowserTabGuestSecurity(guestContents as BrowserTabGuestContents);

			// Forward app shortcuts from the webview guest process to the renderer.
			// When a <webview> has focus, keyboard events are trapped in its guest
			// Chromium process and never reach the renderer's window keydown handler.
			const guest = guestContents as BrowserTabGuestContents;

			guest.on('before-input-event', (event, input) => {
				if (!input.meta && !input.control && !input.alt) return;
				if (input.type !== 'keyDown') return;
				const k = input.key.toLowerCase();
				const isPaste = (input.meta || input.control) && !input.alt && !input.shift && k === 'v';
				if (isPaste) {
					event.preventDefault();
					guest.paste();
					return;
				}
				const isTextEditing =
					(input.meta || input.control) && !input.alt && !input.shift && 'acxz'.includes(k);
				const isRedo = (input.meta || input.control) && !input.alt && input.shift && k === 'z';
				if (isTextEditing || isRedo) return;
				event.preventDefault();
				mainWindow.webContents.send('browser-tab:shortcutKey', {
					key: input.key,
					code: input.code,
					meta: input.meta,
					control: input.control,
					alt: input.alt,
					shift: input.shift,
				});
			});

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
			guest.on('console-message', (...args: unknown[]) => {
				const message = typeof args[2] === 'string' ? args[2] : String(args[2] ?? '');
				const prefix = '__MAESTRO_KEY__';
				if (!message.startsWith(prefix)) return;
				try {
					const input = JSON.parse(message.slice(prefix.length));
					mainWindow.webContents.send('browser-tab:shortcutKey', input);
				} catch {
					// Malformed message, ignore
				}
			});
		});

		// Deny all popup/new-window requests — external links use IPC shell:openExternal
		mainWindow.webContents.setWindowOpenHandler(({ url }) => {
			logger.warn(`Blocked window.open request: ${url}`, 'Window');
			return { action: 'deny' };
		});

		// Restrict navigation to the app itself — prevent renderer from navigating away.
		// Page content belongs in a <webview> browser tab, never the top-level frame.
		const devEntryUrl = isDevelopment ? new URL(devServerUrl) : null;
		const allowedDevOrigin = devEntryUrl ? devEntryUrl.origin : null;
		const allowedDevPathname = devEntryUrl ? devEntryUrl.pathname || '/' : null;
		const allowedProdOrigin = isDevelopment ? null : new URL(rendererProductionUrl).origin;
		const allowedProdEntryUrl = isDevelopment ? null : rendererProductionUrl;
		mainWindow.webContents.on('will-navigate', (event, url) => {
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
		mainWindow.webContents.session.setPermissionRequestHandler(
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
		mainWindow.webContents.on('context-menu', (_event, params) => {
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
							click: () => mainWindow.webContents.replaceMisspelling(suggestion),
						});
					}
				}
				template.push(
					{ type: 'separator' },
					{
						label: 'Add to Dictionary',
						click: () =>
							mainWindow.webContents.session.addWordToSpellCheckerDictionary(
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

			Menu.buildFromTemplate(template).popup({ window: mainWindow });
		});

		mainWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window');
			if (!entry.isMain && !(deps.isQuitting?.() ?? false)) {
				windowRegistry.removeWindowState(registryWindowId);
			}
			windowRegistry.remove(registryWindowId);
		});

		// ================================================================
		// Renderer Process Crash Detection
		// ================================================================
		// These handlers capture crashes that Sentry in the renderer cannot
		// report (because the renderer process is dead or broken).

		// Handle renderer process termination (crash, kill, OOM, etc.)
		mainWindow.webContents.on('render-process-gone', (_event, details) => {
			logger.error('Renderer process gone', 'Window', {
				reason: details.reason,
				exitCode: details.exitCode,
			});

			const intentionalTermination =
				details.reason === 'killed' || details.reason === 'clean-exit';
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
					if (!mainWindow.isDestroyed()) {
						mainWindow.webContents.reload();
					}
				}, 1000);
			}
		});

		// Handle window becoming unresponsive (frozen renderer)
		mainWindow.on('unresponsive', () => {
			logger.warn('Window became unresponsive', 'Window');
			reportCrashToSentry('Window unresponsive', 'warning', {
				memoryUsage: process.memoryUsage(),
			});
		});

		// Log when window recovers from unresponsive state
		mainWindow.on('responsive', () => {
			logger.info('Window became responsive again', 'Window');
		});

		// Note: the legacy 'crashed' event was removed in Electron 41 and
		// is now subsumed by 'render-process-gone' above (which reports to
		// Sentry with full reason/exitCode detail and handles auto-reload).

		// Handle page load failures (network issues, invalid URLs, etc.)
		mainWindow.webContents.on(
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
		mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
			logger.error('Preload script error', 'Window', {
				preloadPath,
				error: error.message,
				stack: error.stack,
			});
			reportCrashToSentry('Preload script error', 'fatal', {
				preloadPath,
				error: error.message,
				stack: error.stack,
			});
		});

		// Forward renderer console errors to main process logger and Sentry
		// This catches errors that happen before or outside React's error boundary
		mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
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

		// Initialize auto-updater (only in production)
		if (!isDevelopment) {
			initAutoUpdater(mainWindow, {
				onBeforeQuitAndInstall: () => {
					const confirmQuit = getConfirmQuit?.();
					confirmQuit?.();
				},
			});
			logger.info('Auto-updater initialized', 'Window');
		} else {
			// Register stub handlers in development mode so users get a helpful error
			registerDevAutoUpdaterStubs();
			logger.info('Auto-updater disabled in development mode (stub handlers registered)', 'Window');
		}

		return mainWindow;
	};

	return {
		createWindow: (windowId?: string, sessionIds?: string[]): BrowserWindow => {
			const savedState = getWindowState(windowStateStore.store, windowId);
			return createBrowserWindow(savedState, {
				windowId: windowId ?? savedState.id,
				sessionIds,
				isMain: windowRegistry.getPrimary() === undefined,
			});
		},
		createSecondaryWindow: (
			sessionIds: string[],
			bounds: Partial<WindowBounds> = {}
		): BrowserWindow => {
			return createBrowserWindow(createDefaultWindowState('secondary'), {
				sessionIds,
				bounds,
				isMain: false,
			});
		},
		windowRegistry,
	};
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

/**
 * Window manager for creating and managing the main BrowserWindow.
 * Handles window state persistence, DevTools, crash detection, and auto-updater initialization.
 */

import { pathToFileURL } from 'url';
import { BrowserWindow, Menu, ipcMain } from 'electron';
import type Store from 'electron-store';
import type { WindowState } from '../stores/types';
import { logger } from '../utils/logger';
import { initAutoUpdater } from '../auto-updater';

const BROWSER_TAB_PARTITION_PREFIX = 'persist:maestro-browser-session-';
const ALLOWED_BROWSER_TAB_EMBED_PROTOCOLS = new Set(['http:', 'https:']);
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

/** Dependencies for window manager */
export interface WindowManagerDependencies {
	/** Store for window state persistence */
	windowStateStore: Store<WindowState>;
	/** Whether running in development mode */
	isDevelopment: boolean;
	/** Path to the preload script */
	preloadPath: string;
	/** Path to the renderer HTML file (production) */
	rendererPath: string;
	/** Development server URL */
	devServerUrl: string;
	/** Whether to use the native OS title bar instead of custom title bar */
	useNativeTitleBar: boolean;
	/** Whether to auto-hide the menu bar (Linux/Windows) */
	autoHideMenuBar: boolean;
}

/** Window manager instance */
export interface WindowManager {
	/** Create and show the main window */
	createWindow: () => BrowserWindow;
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
		rendererPath,
		devServerUrl,
		useNativeTitleBar,
		autoHideMenuBar,
	} = deps;

	return {
		createWindow: (): BrowserWindow => {
			// Restore saved window state
			const savedState = windowStateStore.store;

			const mainWindow = new BrowserWindow({
				x: savedState.x,
				y: savedState.y,
				width: savedState.width,
				height: savedState.height,
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
			if (savedState.isFullScreen) {
				mainWindow.setFullScreen(true);
			} else if (savedState.isMaximized) {
				mainWindow.maximize();
			}

			logger.info('Browser window created', 'Window', {
				size: `${savedState.width}x${savedState.height}`,
				maximized: savedState.isMaximized,
				fullScreen: savedState.isFullScreen,
				mode: isDevelopment ? 'development' : 'production',
			});

			// Save window state before closing
			const saveWindowState = () => {
				try {
					const isMaximized = mainWindow.isMaximized();
					const isFullScreen = mainWindow.isFullScreen();
					const bounds = mainWindow.getBounds();

					// Only save bounds if not maximized/fullscreen (to restore proper size later)
					if (!isMaximized && !isFullScreen) {
						windowStateStore.set('x', bounds.x);
						windowStateStore.set('y', bounds.y);
						windowStateStore.set('width', bounds.width);
						windowStateStore.set('height', bounds.height);
					}
					windowStateStore.set('isMaximized', isMaximized);
					windowStateStore.set('isFullScreen', isFullScreen);
				} catch {
					// Ignore ENFILE/ENOSPC errors during window close — non-critical
				}
			};

			mainWindow.on('close', saveWindowState);

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

				mainWindow.loadURL(devServerUrl);
				// DevTools can be opened via Command-K menu instead of automatically on startup
				logger.info('Loading development server', 'Window');
			} else {
				mainWindow.loadFile(rendererPath);
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
					// Let standard text-editing shortcuts pass through to the page
					const isTextEditing =
						(input.meta || input.control) && !input.alt && !input.shift && 'acvxzf'.includes(k);
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
						var te=hasMod&&!hasAlt&&!e.shiftKey&&'acvxzf'.indexOf(k)!==-1;
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
			// Both the dev-server URL and the renderer entry's file:// URL are constants
			// for the lifetime of this window, so compute them once at setup time rather
			// than on every navigation event. The production guard only allows the
			// renderer entry HTML itself: a previous "directory prefix" check let any
			// file inside the renderer dir through, which meant a stray <a href="foo.md">
			// in chat output could resolve relative to index.html and unload the app to
			// a non-existent bundle file.
			const allowedDevOrigin = isDevelopment ? new URL(devServerUrl).origin : null;
			const rendererFileUrl = isDevelopment ? null : pathToFileURL(rendererPath).href;
			mainWindow.webContents.on('will-navigate', (event, url) => {
				const parsedUrl = new URL(url);
				if (isDevelopment) {
					if (parsedUrl.origin === allowedDevOrigin) return;
				} else {
					if (parsedUrl.protocol === 'file:' && url === rendererFileUrl) return;
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

				// Report to Sentry from main process (always available)
				reportCrashToSentry(`Renderer process gone: ${details.reason}`, 'fatal', {
					reason: details.reason,
					exitCode: details.exitCode,
				});

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

			// Handle page crashes (less severe than render-process-gone)
			mainWindow.webContents.on('crashed', (_event, killed) => {
				logger.error('WebContents crashed', 'Window', { killed });
				reportCrashToSentry('WebContents crashed', killed ? 'warning' : 'error', { killed });
			});

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
				initAutoUpdater(mainWindow);
				logger.info('Auto-updater initialized', 'Window');
			} else {
				// Register stub handlers in development mode so users get a helpful error
				registerDevAutoUpdaterStubs();
				logger.info(
					'Auto-updater disabled in development mode (stub handlers registered)',
					'Window'
				);
			}

			return mainWindow;
		},
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

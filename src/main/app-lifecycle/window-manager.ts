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

import { BrowserWindow } from 'electron';
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
import { attachGuestWebviewSecurity } from './guest-webview-security';
import { attachMainWindowNavigationGuards } from './main-window-navigation';
import { attachSpellCheckContextMenu } from './spell-check-menu';
import { attachWindowCrashHandlers } from './window-crash-handlers';
import { registerDevAutoUpdaterStubs } from './dev-auto-updater-stubs';
import { resolveVisibleWindowPosition } from './window-position';

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
					// Ignore ENFILE/ENOSPC errors during window close - non-critical
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

		attachGuestWebviewSecurity(browserWindow, preloadPath);
		attachMainWindowNavigationGuards(browserWindow, {
			isDevelopment,
			devServerUrl,
			rendererProductionUrl,
			entryUrl,
		});
		attachSpellCheckContextMenu(browserWindow);

		browserWindow.on('closed', () => {
			logger.info('Browser window closed', 'Window');
		});

		// ================================================================
		// Renderer Process Crash Detection
		// ================================================================
		// These handlers capture crashes that Sentry in the renderer cannot
		// report (because the renderer process is dead or broken).

		attachWindowCrashHandlers(browserWindow);
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

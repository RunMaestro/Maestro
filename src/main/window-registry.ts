/**
 * Window Registry for Multi-Window Support
 *
 * Tracks all open BrowserWindows and manages session-to-window mapping.
 * Implements GitHub issue #133 - allowing tabs to be dragged out into separate windows.
 *
 * Design decisions:
 * - Primary window (isMain: true) cannot be closed; closing it quits the app
 * - New sessions always open in the primary window (Cmd+N)
 * - Each session can only be open in one window at a time
 * - Clicking a session already open elsewhere focuses that window
 * - All windows have full UI (left sidebar, main panel, right panel)
 * - Window layouts are restored on app restart
 * - Session move operations are serialized via mutex to prevent race conditions
 */

import { BrowserWindow, screen } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './utils/logger';
import { getMultiWindowStateStore } from './stores';
import type { MultiWindowWindowState, MultiWindowStoreData } from './stores/types';

/**
 * Simple async mutex for serializing operations.
 * Prevents race conditions when rapidly moving sessions between windows.
 */
class AsyncMutex {
	private locked = false;
	private queue: Array<() => void> = [];

	/**
	 * Acquires the mutex lock. If already locked, waits in queue.
	 * @returns A release function to call when done
	 */
	async acquire(): Promise<() => void> {
		return new Promise((resolve) => {
			const tryAcquire = () => {
				if (!this.locked) {
					this.locked = true;
					resolve(() => this.release());
				} else {
					this.queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	/**
	 * Releases the mutex lock, allowing the next waiter to proceed.
	 */
	private release(): void {
		this.locked = false;
		const next = this.queue.shift();
		if (next) {
			next();
		}
	}

	/**
	 * Returns whether the mutex is currently locked.
	 */
	isLocked(): boolean {
		return this.locked;
	}

	/**
	 * Returns the number of operations waiting in queue.
	 */
	getQueueLength(): number {
		return this.queue.length;
	}
}

const LOG_CONTEXT = 'WindowRegistry';

/** Debounce delay in milliseconds for window state persistence */
const SAVE_STATE_DEBOUNCE_MS = 500;

/**
 * Internal window entry stored in the registry
 */
export interface WindowEntry {
	/** The Electron BrowserWindow instance */
	browserWindow: BrowserWindow;
	/** IDs of sessions currently open in this window */
	sessionIds: string[];
	/** Whether this is the primary (main) window */
	isMain: boolean;
	/** ID of the currently active session in this window */
	activeSessionId?: string;
}

/**
 * Options for creating a new window
 */
export interface CreateWindowOptions {
	/** Optional window ID (generated if not provided) */
	windowId?: string;
	/** Session IDs to open in this window */
	sessionIds?: string[];
	/** ID of the session to make active */
	activeSessionId?: string;
	/** Whether this is the primary window */
	isMain?: boolean;
	/** Window bounds (x, y, width, height) */
	bounds?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
}

/**
 * Result from creating a new window
 */
export interface CreateWindowResult {
	/** The unique window ID */
	windowId: string;
	/** The created BrowserWindow instance */
	browserWindow: BrowserWindow;
}

/**
 * Factory function type for creating BrowserWindow instances
 */
export type WindowFactory = (options: CreateWindowOptions) => BrowserWindow;

/**
 * WindowRegistry class that tracks all open BrowserWindows
 * and manages the mapping between sessions and windows.
 */
export class WindowRegistry {
	/** Map of windowId to WindowEntry */
	private windows: Map<string, WindowEntry> = new Map();

	/** ID of the primary (main) window */
	private primaryWindowId: string | null = null;

	/** Factory function for creating new BrowserWindow instances */
	private windowFactory: WindowFactory | null = null;

	/** Debounce timers for window state saves, keyed by windowId */
	private saveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	/** Whether stores are initialized (for testing) */
	private storesInitialized = true;

	/** Mutex for serializing session move operations to prevent race conditions */
	private sessionMutex: AsyncMutex = new AsyncMutex();

	/**
	 * Sets the factory function used to create new BrowserWindow instances.
	 * This allows dependency injection for window creation.
	 *
	 * @param factory - Factory function that creates BrowserWindow instances
	 */
	setWindowFactory(factory: WindowFactory): void {
		this.windowFactory = factory;
		logger.debug('Window factory set', LOG_CONTEXT);
	}

	/**
	 * Creates a new window and registers it in the registry.
	 *
	 * @param options - Options for creating the window
	 * @returns The window ID and BrowserWindow instance
	 * @throws Error if window factory is not set
	 */
	create(options: CreateWindowOptions = {}): CreateWindowResult {
		if (!this.windowFactory) {
			throw new Error('Window factory not set. Call setWindowFactory() first.');
		}

		const windowId = options.windowId || uuidv4();
		const isMain = options.isMain ?? this.windows.size === 0; // First window is primary by default
		const sessionIds = options.sessionIds || [];

		logger.info(`Creating window: ${windowId}`, LOG_CONTEXT, {
			isMain,
			sessionIds,
			activeSessionId: options.activeSessionId,
		});

		// Create the BrowserWindow using the factory
		const browserWindow = this.windowFactory({
			...options,
			windowId,
			isMain,
		});

		// Register the window entry
		const entry: WindowEntry = {
			browserWindow,
			sessionIds,
			isMain,
			activeSessionId: options.activeSessionId,
		};

		this.windows.set(windowId, entry);

		// Track primary window
		if (isMain) {
			this.primaryWindowId = windowId;
			logger.info(`Primary window set: ${windowId}`, LOG_CONTEXT);
		}

		// Handle window close event
		browserWindow.on('closed', () => {
			this.handleWindowClosed(windowId);
		});

		// Set up window state persistence events (debounced)
		this.setupWindowStatePersistence(windowId, browserWindow);

		logger.info(`Window created and registered: ${windowId}`, LOG_CONTEXT, {
			totalWindows: this.windows.size,
		});

		return { windowId, browserWindow };
	}

	/**
	 * Sets up event listeners for automatic window state persistence.
	 * Listens to move, resize, maximize, unmaximize, enter-full-screen, leave-full-screen.
	 * All saves are debounced to avoid excessive disk writes.
	 *
	 * @param windowId - The window ID to set up persistence for
	 * @param browserWindow - The BrowserWindow instance
	 */
	private setupWindowStatePersistence(windowId: string, browserWindow: BrowserWindow): void {
		const saveHandler = () => this.saveWindowState(windowId);

		// Position/size changes
		browserWindow.on('move', saveHandler);
		browserWindow.on('resize', saveHandler);

		// Window state changes
		browserWindow.on('maximize', saveHandler);
		browserWindow.on('unmaximize', saveHandler);
		browserWindow.on('enter-full-screen', saveHandler);
		browserWindow.on('leave-full-screen', saveHandler);

		logger.debug(`Window state persistence setup for: ${windowId}`, LOG_CONTEXT);
	}

	/**
	 * Persists a single window's state to the multi-window state store.
	 * Saves are debounced to avoid excessive writes during rapid events
	 * (e.g., when dragging a window).
	 *
	 * @param windowId - The window ID to save state for
	 */
	saveWindowState(windowId: string): void {
		// Cancel any pending save for this window
		const existingTimer = this.saveTimers.get(windowId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		// Debounce the save
		const timer = setTimeout(() => {
			this.saveTimers.delete(windowId);
			this.doSaveWindowState(windowId);
		}, SAVE_STATE_DEBOUNCE_MS);

		this.saveTimers.set(windowId, timer);
	}

	/**
	 * Actually performs the window state save (called after debounce).
	 *
	 * @param windowId - The window ID to save state for
	 */
	private doSaveWindowState(windowId: string): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Cannot save state for non-existent window: ${windowId}`, LOG_CONTEXT);
			return;
		}

		const { browserWindow } = entry;

		// Skip if window is destroyed
		if (browserWindow.isDestroyed()) {
			logger.debug(`Skipping state save for destroyed window: ${windowId}`, LOG_CONTEXT);
			return;
		}

		// Collect current window state
		const bounds = browserWindow.getBounds();
		const isMaximized = browserWindow.isMaximized();
		const isFullScreen = browserWindow.isFullScreen();

		// Get the display ID for the window's current position
		// This enables proper restoration on multi-monitor setups
		const displayId = this.getDisplayIdForBounds(bounds);

		const windowState: MultiWindowWindowState = {
			id: windowId,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized,
			isFullScreen,
			sessionIds: [...entry.sessionIds],
			activeSessionId: entry.activeSessionId,
			// Panel collapse state is managed by renderer, not available here
			// Default to false; will be updated when renderer syncs state
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
			displayId,
		};

		// Check if stores are initialized (for testing scenarios)
		if (!this.storesInitialized) {
			logger.debug(`Stores not initialized, skipping save for: ${windowId}`, LOG_CONTEXT);
			return;
		}

		try {
			const store = getMultiWindowStateStore();
			const currentState = store.store as MultiWindowStoreData;

			// Find and update or add this window's state
			const windowIndex = currentState.windows.findIndex((w) => w.id === windowId);
			if (windowIndex >= 0) {
				// Preserve panel collapse state from existing entry
				windowState.leftPanelCollapsed =
					currentState.windows[windowIndex].leftPanelCollapsed ?? false;
				windowState.rightPanelCollapsed =
					currentState.windows[windowIndex].rightPanelCollapsed ?? false;
				currentState.windows[windowIndex] = windowState;
			} else {
				currentState.windows.push(windowState);
			}

			// Update primary window ID if this is the primary window
			if (entry.isMain) {
				currentState.primaryWindowId = windowId;
			}

			// Save the updated state
			store.set(currentState);

			logger.debug(`Window state saved: ${windowId}`, LOG_CONTEXT, {
				bounds: `${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y})`,
				isMaximized,
				isFullScreen,
				sessionCount: entry.sessionIds.length,
				displayId,
			});
		} catch (error) {
			logger.error(`Failed to save window state: ${windowId}`, LOG_CONTEXT, { error });
		}
	}

	/**
	 * Gets the display ID for a given window bounds.
	 * Uses the display that contains the window's center point.
	 *
	 * @param bounds - The window bounds with x, y position
	 * @returns The display ID, or undefined if no display found
	 */
	private getDisplayIdForBounds(bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	}): number | undefined {
		try {
			// Calculate center point of window
			const centerX = bounds.x + bounds.width / 2;
			const centerY = bounds.y + bounds.height / 2;

			// Get the display at the window's center point
			const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
			return display?.id;
		} catch (error) {
			logger.warn('Failed to get display ID for window bounds', LOG_CONTEXT, { error, bounds });
			return undefined;
		}
	}

	/**
	 * Sets whether stores are initialized. Used in tests to prevent
	 * store access errors during unit testing.
	 *
	 * @param initialized - Whether stores are initialized
	 */
	setStoresInitialized(initialized: boolean): void {
		this.storesInitialized = initialized;
	}

	/**
	 * Gets a window entry by ID.
	 *
	 * @param windowId - The window ID to look up
	 * @returns The window entry or undefined if not found
	 */
	get(windowId: string): WindowEntry | undefined {
		return this.windows.get(windowId);
	}

	/**
	 * Gets all registered windows.
	 *
	 * @returns Array of [windowId, WindowEntry] tuples
	 */
	getAll(): Array<[string, WindowEntry]> {
		return Array.from(this.windows.entries());
	}

	/**
	 * Gets the primary (main) window entry.
	 *
	 * @returns The primary window entry or undefined if not set
	 */
	getPrimary(): WindowEntry | undefined {
		if (!this.primaryWindowId) {
			return undefined;
		}
		return this.windows.get(this.primaryWindowId);
	}

	/**
	 * Gets the primary window ID.
	 *
	 * @returns The primary window ID or null if not set
	 */
	getPrimaryId(): string | null {
		return this.primaryWindowId;
	}

	/**
	 * Removes a window from the registry.
	 * Note: This does not close the window; use for cleanup after window is closed.
	 *
	 * @param windowId - The window ID to remove
	 * @returns True if the window was found and removed
	 */
	remove(windowId: string): boolean {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Window not found for removal: ${windowId}`, LOG_CONTEXT);
			return false;
		}

		// Prevent removing the primary window
		if (entry.isMain) {
			logger.warn('Cannot remove primary window from registry', LOG_CONTEXT, { windowId });
			return false;
		}

		this.windows.delete(windowId);
		logger.info(`Window removed from registry: ${windowId}`, LOG_CONTEXT, {
			totalWindows: this.windows.size,
		});

		return true;
	}

	/**
	 * Gets the window ID that contains a specific session.
	 *
	 * @param sessionId - The session ID to look up
	 * @returns The window ID containing the session, or undefined if not found
	 */
	getWindowForSession(sessionId: string): string | undefined {
		for (const [windowId, entry] of this.windows.entries()) {
			if (entry.sessionIds.includes(sessionId)) {
				return windowId;
			}
		}
		return undefined;
	}

	/**
	 * Sets the session IDs for a specific window.
	 * This replaces all existing sessions in the window.
	 *
	 * @param windowId - The window ID to update
	 * @param sessionIds - The new array of session IDs
	 * @param activeSessionId - Optional ID of the active session
	 * @returns True if the window was found and updated
	 */
	setSessionsForWindow(windowId: string, sessionIds: string[], activeSessionId?: string): boolean {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Window not found for session update: ${windowId}`, LOG_CONTEXT);
			return false;
		}

		// Log the change
		const added = sessionIds.filter((id) => !entry.sessionIds.includes(id));
		const removed = entry.sessionIds.filter((id) => !sessionIds.includes(id));

		entry.sessionIds = [...sessionIds];
		if (activeSessionId !== undefined) {
			entry.activeSessionId = activeSessionId;
		}

		logger.debug(`Sessions updated for window: ${windowId}`, LOG_CONTEXT, {
			added,
			removed,
			total: sessionIds.length,
			activeSessionId: entry.activeSessionId,
		});

		return true;
	}

	/**
	 * Moves a session from one window to another (synchronous version).
	 * If the session is not in the source window, it will just be added to the target.
	 *
	 * NOTE: This is the internal synchronous implementation. For IPC handlers,
	 * use moveSessionAsync() instead to prevent race conditions.
	 *
	 * @param sessionId - The session ID to move
	 * @param fromWindowId - The source window ID (can be empty string to just add)
	 * @param toWindowId - The target window ID
	 * @returns True if the session was successfully moved
	 */
	moveSession(sessionId: string, fromWindowId: string, toWindowId: string): boolean {
		const toEntry = this.windows.get(toWindowId);
		if (!toEntry) {
			logger.warn(`Target window not found: ${toWindowId}`, LOG_CONTEXT);
			return false;
		}

		// Remove from source window if specified and exists
		if (fromWindowId) {
			const fromEntry = this.windows.get(fromWindowId);
			if (fromEntry) {
				const index = fromEntry.sessionIds.indexOf(sessionId);
				if (index !== -1) {
					fromEntry.sessionIds.splice(index, 1);
					logger.debug(`Session removed from source window`, LOG_CONTEXT, {
						sessionId,
						fromWindowId,
						remainingSessions: fromEntry.sessionIds.length,
					});

					// If the moved session was active, clear or update active session
					if (fromEntry.activeSessionId === sessionId) {
						fromEntry.activeSessionId =
							fromEntry.sessionIds.length > 0 ? fromEntry.sessionIds[0] : undefined;
					}
				}
			}
		}

		// Add to target window if not already there
		if (!toEntry.sessionIds.includes(sessionId)) {
			toEntry.sessionIds.push(sessionId);
			// Make the moved session active in the target window
			toEntry.activeSessionId = sessionId;

			logger.info(`Session moved to window`, LOG_CONTEXT, {
				sessionId,
				fromWindowId: fromWindowId || '(none)',
				toWindowId,
				targetSessions: toEntry.sessionIds.length,
			});
		}

		return true;
	}

	/**
	 * Moves a session from one window to another with mutex protection.
	 * This async version serializes concurrent move requests to prevent race conditions
	 * when users rapidly drag sessions between windows.
	 *
	 * @param sessionId - The session ID to move
	 * @param fromWindowId - The source window ID (can be empty string to just add)
	 * @param toWindowId - The target window ID
	 * @returns Promise resolving to true if the session was successfully moved
	 */
	async moveSessionAsync(
		sessionId: string,
		fromWindowId: string,
		toWindowId: string
	): Promise<boolean> {
		const release = await this.sessionMutex.acquire();
		try {
			logger.debug('Acquired session mutex for move', LOG_CONTEXT, {
				sessionId,
				fromWindowId: fromWindowId || '(none)',
				toWindowId,
				queueLength: this.sessionMutex.getQueueLength(),
			});
			return this.moveSession(sessionId, fromWindowId, toWindowId);
		} finally {
			release();
			logger.debug('Released session mutex after move', LOG_CONTEXT, { sessionId });
		}
	}

	/**
	 * Returns whether a session operation is currently in progress.
	 * Useful for testing and debugging race condition handling.
	 */
	isSessionOperationInProgress(): boolean {
		return this.sessionMutex.isLocked();
	}

	/**
	 * Returns the number of session operations waiting in queue.
	 * Useful for testing and debugging race condition handling.
	 */
	getSessionOperationQueueLength(): number {
		return this.sessionMutex.getQueueLength();
	}

	/**
	 * Adds a session to a window.
	 *
	 * @param windowId - The window ID to add the session to
	 * @param sessionId - The session ID to add
	 * @param makeActive - Whether to make this session the active one
	 * @returns True if the session was successfully added
	 */
	addSessionToWindow(windowId: string, sessionId: string, makeActive = true): boolean {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Window not found for adding session: ${windowId}`, LOG_CONTEXT);
			return false;
		}

		// Check if session is already in another window
		const existingWindowId = this.getWindowForSession(sessionId);
		if (existingWindowId && existingWindowId !== windowId) {
			logger.warn(`Session already in another window`, LOG_CONTEXT, {
				sessionId,
				existingWindowId,
				targetWindowId: windowId,
			});
			return false;
		}

		// Add if not already present
		if (!entry.sessionIds.includes(sessionId)) {
			entry.sessionIds.push(sessionId);
		}

		if (makeActive) {
			entry.activeSessionId = sessionId;
		}

		logger.debug(`Session added to window`, LOG_CONTEXT, {
			sessionId,
			windowId,
			makeActive,
			totalSessions: entry.sessionIds.length,
		});

		return true;
	}

	/**
	 * Removes a session from a window.
	 *
	 * @param windowId - The window ID to remove the session from
	 * @param sessionId - The session ID to remove
	 * @returns True if the session was found and removed
	 */
	removeSessionFromWindow(windowId: string, sessionId: string): boolean {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Window not found for removing session: ${windowId}`, LOG_CONTEXT);
			return false;
		}

		const index = entry.sessionIds.indexOf(sessionId);
		if (index === -1) {
			return false;
		}

		entry.sessionIds.splice(index, 1);

		// Update active session if needed
		if (entry.activeSessionId === sessionId) {
			entry.activeSessionId = entry.sessionIds.length > 0 ? entry.sessionIds[0] : undefined;
		}

		logger.debug(`Session removed from window`, LOG_CONTEXT, {
			sessionId,
			windowId,
			remainingSessions: entry.sessionIds.length,
		});

		return true;
	}

	/**
	 * Sets the active session for a window.
	 *
	 * @param windowId - The window ID
	 * @param sessionId - The session ID to make active
	 * @returns True if the session was set as active
	 */
	setActiveSession(windowId: string, sessionId: string): boolean {
		const entry = this.windows.get(windowId);
		if (!entry) {
			logger.warn(`Window not found for setting active session: ${windowId}`, LOG_CONTEXT);
			return false;
		}

		// Verify session is in this window
		if (!entry.sessionIds.includes(sessionId)) {
			logger.warn(`Session not in window`, LOG_CONTEXT, { sessionId, windowId });
			return false;
		}

		entry.activeSessionId = sessionId;
		logger.debug(`Active session set`, LOG_CONTEXT, { sessionId, windowId });
		return true;
	}

	/**
	 * Gets the active session ID for a window.
	 *
	 * @param windowId - The window ID
	 * @returns The active session ID or undefined
	 */
	getActiveSession(windowId: string): string | undefined {
		const entry = this.windows.get(windowId);
		return entry?.activeSessionId;
	}

	/**
	 * Gets the total number of registered windows.
	 *
	 * @returns The number of windows
	 */
	getWindowCount(): number {
		return this.windows.size;
	}

	/**
	 * Checks if a window ID exists in the registry.
	 *
	 * @param windowId - The window ID to check
	 * @returns True if the window exists
	 */
	has(windowId: string): boolean {
		return this.windows.has(windowId);
	}

	/**
	 * Gets the window ID for a BrowserWindow instance.
	 *
	 * @param browserWindow - The BrowserWindow to look up
	 * @returns The window ID or undefined
	 */
	getWindowIdForBrowserWindow(browserWindow: BrowserWindow): string | undefined {
		for (const [windowId, entry] of this.windows.entries()) {
			if (entry.browserWindow === browserWindow) {
				return windowId;
			}
		}
		return undefined;
	}

	/**
	 * Internal handler for when a window is closed.
	 * Cleans up the registry entry and any pending save timers.
	 *
	 * @param windowId - The ID of the closed window
	 */
	private handleWindowClosed(windowId: string): void {
		const entry = this.windows.get(windowId);
		if (!entry) {
			return;
		}

		// Cancel any pending save timer for this window
		const timer = this.saveTimers.get(windowId);
		if (timer) {
			clearTimeout(timer);
			this.saveTimers.delete(windowId);
		}

		logger.info(`Window closed: ${windowId}`, LOG_CONTEXT, {
			isMain: entry.isMain,
			sessionCount: entry.sessionIds.length,
		});

		// If primary window closed, the app should quit (handled elsewhere)
		// Just clean up the registry
		if (!entry.isMain) {
			this.windows.delete(windowId);
		}
	}

	/**
	 * Clears all windows from the registry.
	 * Used for testing or cleanup.
	 */
	clear(): void {
		// Clear all pending save timers
		for (const timer of this.saveTimers.values()) {
			clearTimeout(timer);
		}
		this.saveTimers.clear();

		this.windows.clear();
		this.primaryWindowId = null;
		logger.info('Window registry cleared', LOG_CONTEXT);
	}
}

/**
 * Singleton instance of the WindowRegistry.
 * Use this for global window management throughout the app.
 */
export const windowRegistry = new WindowRegistry();

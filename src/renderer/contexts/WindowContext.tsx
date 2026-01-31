/**
 * WindowContext - Multi-window state management for renderer
 *
 * This context provides window-specific state and operations for multi-window support.
 * Each renderer window has its own instance of this context with its own window state.
 *
 * Implements GitHub issue #133 - multi-window support.
 *
 * Provides:
 * - windowId: This window's unique identifier
 * - isMainWindow: Whether this is the primary window
 * - sessionIds: Sessions currently open in this window
 * - activeSessionId: The currently active session in this window
 * - openSession: Opens a session in this window or focuses existing window
 * - closeTab: Removes a session from this window
 * - moveSessionToNewWindow: Moves a session to a new window
 *
 * Initializes by calling window.maestro.windows.getState() on mount.
 * Listens for windows:sessionsChanged events to sync with main process.
 */

import React, {
	createContext,
	useContext,
	useState,
	useCallback,
	useMemo,
	useEffect,
	ReactNode,
	useRef,
} from 'react';
import type { WindowState, CreateWindowRequest } from '../../shared/types/window';

/**
 * Window context value - all window states and operations
 */
export interface WindowContextValue {
	/** This window's unique identifier (null until loaded) */
	windowId: string | null;

	/** Whether this is the primary (main) window */
	isMainWindow: boolean;

	/** IDs of sessions currently open in this window */
	sessionIds: string[];

	/** ID of the currently active session in this window */
	activeSessionId: string | undefined;

	/** Whether the window state has been loaded from main process */
	isLoaded: boolean;

	/**
	 * Opens a session in this window.
	 * If the session is already open in another window, focuses that window instead.
	 *
	 * @param sessionId - The session ID to open
	 * @returns Promise resolving to true if session was opened in this window,
	 *          false if it was already open elsewhere (and that window was focused)
	 */
	openSession: (sessionId: string) => Promise<boolean>;

	/**
	 * Removes a session from this window's tab bar.
	 * Does not delete the session, just removes it from display.
	 *
	 * @param sessionId - The session ID to remove from this window
	 */
	closeTab: (sessionId: string) => Promise<void>;

	/**
	 * Moves a session to a new window.
	 * Creates a new window and moves the session to it.
	 *
	 * @param sessionId - The session ID to move
	 * @returns Promise resolving to the new window's ID
	 */
	moveSessionToNewWindow: (sessionId: string) => Promise<string>;

	/**
	 * Sets the active session for this window.
	 *
	 * @param sessionId - The session ID to make active
	 */
	setActiveSession: (sessionId: string) => Promise<void>;

	/**
	 * Refreshes the window state from the main process.
	 */
	refresh: () => Promise<void>;
}

// Create context with null as default (will throw if used outside provider)
const WindowContext = createContext<WindowContextValue | null>(null);

interface WindowProviderProps {
	children: ReactNode;
}

/**
 * WindowProvider - Provides multi-window state management
 *
 * This provider manages the window-specific state for multi-window support.
 * It initializes by fetching state from the main process and subscribes
 * to session change events.
 *
 * Usage:
 * Wrap your app in this provider (inside ErrorBoundary, outside other providers):
 * <WindowProvider>
 *   <SessionProvider>
 *     <App />
 *   </SessionProvider>
 * </WindowProvider>
 */
export function WindowProvider({ children }: WindowProviderProps) {
	// Window state from main process
	const [windowId, setWindowId] = useState<string | null>(null);
	const [isMainWindow, setIsMainWindow] = useState<boolean>(true);
	const [sessionIds, setSessionIds] = useState<string[]>([]);
	const [activeSessionId, setActiveSessionIdState] = useState<string | undefined>(undefined);
	const [isLoaded, setIsLoaded] = useState<boolean>(false);

	// Ref to track if component is mounted
	const isMountedRef = useRef(true);

	// Ref to the current window ID for use in callbacks
	const windowIdRef = useRef<string | null>(null);
	windowIdRef.current = windowId;

	/**
	 * Fetches the initial window state from the main process
	 */
	const loadWindowState = useCallback(async () => {
		try {
			const state = await window.maestro.windows.getState();

			if (!isMountedRef.current) return;

			if (state) {
				setWindowId(state.id);
				setIsMainWindow(state.sessionIds.length === 0 ? true : state.sessionIds.length >= 0);
				setSessionIds(state.sessionIds);
				setActiveSessionIdState(state.activeSessionId);

				// Determine if this is the main window by checking with registry
				const windowInfo = await window.maestro.windows.list();
				const thisWindow = windowInfo.find((w) => w.id === state.id);
				if (thisWindow && isMountedRef.current) {
					setIsMainWindow(thisWindow.isMain);
				}
			} else {
				// Fallback: try to get just the window ID
				const id = await window.maestro.windows.getWindowId();
				if (id && isMountedRef.current) {
					setWindowId(id);
				}
			}

			if (isMountedRef.current) {
				setIsLoaded(true);
			}
		} catch (error) {
			console.error('[WindowContext] Failed to load window state:', error);
			if (isMountedRef.current) {
				setIsLoaded(true); // Mark as loaded even on error to prevent blocking
			}
		}
	}, []);

	/**
	 * Refresh window state from main process
	 */
	const refresh = useCallback(async () => {
		await loadWindowState();
	}, [loadWindowState]);

	/**
	 * Opens a session in this window or focuses the window containing it
	 */
	const openSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			// Check if session is already in another window
			const existingWindowId = await window.maestro.windows.getForSession(sessionId);

			if (existingWindowId && existingWindowId !== windowIdRef.current) {
				// Session is in another window - focus that window
				await window.maestro.windows.focusWindow(existingWindowId);
				return false;
			}

			// Session is not in another window or is in this window
			// Add it to this window's sessions if not already present
			if (!sessionIds.includes(sessionId)) {
				const currentWindowId = windowIdRef.current;
				if (currentWindowId) {
					const newSessionIds = [...sessionIds, sessionId];
					setSessionIds(newSessionIds);
					setActiveSessionIdState(sessionId);

					// Sync with main process
					await window.maestro.windows.setSessionsForWindow(
						currentWindowId,
						newSessionIds,
						sessionId
					);
				}
			} else {
				// Session already in this window - just make it active
				const currentWindowId = windowIdRef.current;
				if (currentWindowId) {
					setActiveSessionIdState(sessionId);
					await window.maestro.windows.setActiveSession(currentWindowId, sessionId);
				}
			}

			return true;
		},
		[sessionIds]
	);

	/**
	 * Removes a session from this window's tab bar
	 */
	const closeTab = useCallback(
		async (sessionId: string): Promise<void> => {
			const currentWindowId = windowIdRef.current;
			if (!currentWindowId) return;

			const newSessionIds = sessionIds.filter((id) => id !== sessionId);
			setSessionIds(newSessionIds);

			// Update active session if needed
			let newActiveSessionId = activeSessionId;
			if (activeSessionId === sessionId) {
				newActiveSessionId = newSessionIds.length > 0 ? newSessionIds[0] : undefined;
				setActiveSessionIdState(newActiveSessionId);
			}

			// Sync with main process
			await window.maestro.windows.setSessionsForWindow(
				currentWindowId,
				newSessionIds,
				newActiveSessionId
			);
		},
		[sessionIds, activeSessionId]
	);

	/**
	 * Moves a session to a new window
	 */
	const moveSessionToNewWindow = useCallback(async (sessionId: string): Promise<string> => {
		const currentWindowId = windowIdRef.current;

		// Create a new window with this session
		const request: CreateWindowRequest = {
			sessionIds: [sessionId],
			activeSessionId: sessionId,
		};

		const response = await window.maestro.windows.create(request);
		const newWindowId = response.windowId;

		// Move the session from this window to the new one
		if (currentWindowId) {
			await window.maestro.windows.moveSession({
				sessionId,
				fromWindowId: currentWindowId,
				toWindowId: newWindowId,
			});
		}

		return newWindowId;
	}, []);

	/**
	 * Sets the active session for this window
	 */
	const setActiveSession = useCallback(
		async (sessionId: string): Promise<void> => {
			const currentWindowId = windowIdRef.current;
			if (!currentWindowId) return;

			// Verify session is in this window
			if (!sessionIds.includes(sessionId)) {
				console.warn('[WindowContext] Cannot set active session - session not in window');
				return;
			}

			setActiveSessionIdState(sessionId);
			await window.maestro.windows.setActiveSession(currentWindowId, sessionId);
		},
		[sessionIds]
	);

	// Initialize window state on mount
	useEffect(() => {
		isMountedRef.current = true;
		void loadWindowState();

		return () => {
			isMountedRef.current = false;
		};
	}, [loadWindowState]);

	// Subscribe to session change events from main process
	useEffect(() => {
		const cleanup = window.maestro.windows.onSessionsChanged((event) => {
			// Only handle events for this window
			if (event.windowId !== windowIdRef.current) return;

			if (isMountedRef.current) {
				setSessionIds(event.sessionIds);
				setActiveSessionIdState(event.activeSessionId);
			}
		});

		return cleanup;
	}, []);

	// Subscribe to session moved events (broadcast to ALL windows)
	// This allows us to refresh state when sessions move between any windows
	useEffect(() => {
		const cleanup = window.maestro.windows.onSessionMoved((event) => {
			// Refresh our local state when any session moves
			// This updates UI elements like SessionList that show window badges
			if (isMountedRef.current) {
				void loadWindowState();
			}
		});

		return cleanup;
	}, [loadWindowState]);

	// Build context value
	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			isMainWindow,
			sessionIds,
			activeSessionId,
			isLoaded,
			openSession,
			closeTab,
			moveSessionToNewWindow,
			setActiveSession,
			refresh,
		}),
		[
			windowId,
			isMainWindow,
			sessionIds,
			activeSessionId,
			isLoaded,
			openSession,
			closeTab,
			moveSessionToNewWindow,
			setActiveSession,
			refresh,
		]
	);

	return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

/**
 * useWindow - Hook to access window context
 *
 * Must be used within a WindowProvider. Throws an error if used outside.
 *
 * @returns WindowContextValue - Window state and operations
 *
 * @example
 * const { windowId, isMainWindow, sessionIds, openSession } = useWindow();
 *
 * // Open a session in this window
 * const opened = await openSession('session-123');
 * if (!opened) {
 *   console.log('Session was in another window, which was focused');
 * }
 *
 * @example
 * const { moveSessionToNewWindow } = useWindow();
 *
 * // Move session to a new window
 * const newWindowId = await moveSessionToNewWindow('session-123');
 */
export function useWindow(): WindowContextValue {
	const context = useContext(WindowContext);

	if (!context) {
		throw new Error('useWindow must be used within a WindowProvider');
	}

	return context;
}

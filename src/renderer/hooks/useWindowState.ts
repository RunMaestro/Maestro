/**
 * useWindowState - Hook for managing window-specific UI state
 *
 * This hook provides per-window state management for UI elements like panel
 * collapse states. Unlike global settings, this state is specific to each
 * window and persists across app restarts via the multi-window store.
 *
 * Implements GitHub issue #133 - multi-window support.
 *
 * Usage:
 * const {
 *   leftPanelCollapsed,
 *   rightPanelCollapsed,
 *   setLeftPanelCollapsed,
 *   setRightPanelCollapsed,
 *   isLoaded
 * } = useWindowState();
 *
 * // Toggle panel
 * setLeftPanelCollapsed(!leftPanelCollapsed);
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Window-specific UI state
 */
export interface WindowUIState {
	/** Whether the left panel (session list) is collapsed */
	leftPanelCollapsed: boolean;

	/** Whether the right panel (files, history, auto run) is collapsed */
	rightPanelCollapsed: boolean;
}

/**
 * Return type for the useWindowState hook
 */
export interface UseWindowStateReturn {
	/** Whether the left panel is collapsed */
	leftPanelCollapsed: boolean;

	/** Whether the right panel is collapsed */
	rightPanelCollapsed: boolean;

	/** Set the left panel collapse state */
	setLeftPanelCollapsed: (collapsed: boolean) => void;

	/** Set the right panel collapse state */
	setRightPanelCollapsed: (collapsed: boolean) => void;

	/** Toggle the left panel collapse state */
	toggleLeftPanel: () => void;

	/** Toggle the right panel collapse state */
	toggleRightPanel: () => void;

	/** Whether the state has been loaded from the main process */
	isLoaded: boolean;

	/** Whether the tab bar drop zone should be highlighted (another window is dragging over this one) */
	dropZoneHighlighted: boolean;
}

/**
 * Default state values
 */
const DEFAULT_STATE: WindowUIState = {
	leftPanelCollapsed: false,
	rightPanelCollapsed: false,
};

/**
 * useWindowState - Manages window-specific UI state with main process persistence
 *
 * This hook loads the panel collapse state from the main process on mount
 * and syncs changes back to the main process for persistence.
 *
 * Key features:
 * - Per-window state (different windows can have different panel states)
 * - Persists across app restarts via the multi-window store
 * - Syncs changes to main process immediately
 * - Falls back to defaults if state not found
 *
 * @returns WindowUIState with setters and loading status
 */
export function useWindowState(): UseWindowStateReturn {
	const [leftPanelCollapsed, setLeftPanelCollapsedState] = useState(
		DEFAULT_STATE.leftPanelCollapsed
	);
	const [rightPanelCollapsed, setRightPanelCollapsedState] = useState(
		DEFAULT_STATE.rightPanelCollapsed
	);
	const [isLoaded, setIsLoaded] = useState(false);

	// Drop zone highlighting state (when another window is dragging over this one)
	const [dropZoneHighlighted, setDropZoneHighlighted] = useState(false);

	// Track if component is mounted
	const isMountedRef = useRef(true);

	// Track pending updates to debounce rapid changes
	const pendingUpdateRef = useRef<NodeJS.Timeout | null>(null);

	/**
	 * Load the initial state from the main process
	 */
	const loadState = useCallback(async () => {
		try {
			const panelState = await window.maestro.windows.getPanelState();

			if (!isMountedRef.current) return;

			if (panelState) {
				setLeftPanelCollapsedState(panelState.leftPanelCollapsed);
				setRightPanelCollapsedState(panelState.rightPanelCollapsed);
			}

			setIsLoaded(true);
		} catch (error) {
			console.error('[useWindowState] Failed to load panel state:', error);
			if (isMountedRef.current) {
				setIsLoaded(true); // Mark as loaded even on error to prevent blocking
			}
		}
	}, []);

	/**
	 * Persist state to the main process (debounced)
	 */
	const persistState = useCallback((state: Partial<WindowUIState>) => {
		// Clear any pending update
		if (pendingUpdateRef.current) {
			clearTimeout(pendingUpdateRef.current);
		}

		// Debounce to avoid excessive IPC calls during rapid toggles
		pendingUpdateRef.current = setTimeout(async () => {
			try {
				await window.maestro.windows.setPanelState(state);
			} catch (error) {
				console.error('[useWindowState] Failed to persist panel state:', error);
			}
		}, 100);
	}, []);

	/**
	 * Set left panel collapse state and persist
	 */
	const setLeftPanelCollapsed = useCallback(
		(collapsed: boolean) => {
			setLeftPanelCollapsedState(collapsed);
			persistState({ leftPanelCollapsed: collapsed });
		},
		[persistState]
	);

	/**
	 * Set right panel collapse state and persist
	 */
	const setRightPanelCollapsed = useCallback(
		(collapsed: boolean) => {
			setRightPanelCollapsedState(collapsed);
			persistState({ rightPanelCollapsed: collapsed });
		},
		[persistState]
	);

	/**
	 * Toggle left panel collapse state
	 */
	const toggleLeftPanel = useCallback(() => {
		setLeftPanelCollapsedState((prev) => {
			const newValue = !prev;
			persistState({ leftPanelCollapsed: newValue });
			return newValue;
		});
	}, [persistState]);

	/**
	 * Toggle right panel collapse state
	 */
	const toggleRightPanel = useCallback(() => {
		setRightPanelCollapsedState((prev) => {
			const newValue = !prev;
			persistState({ rightPanelCollapsed: newValue });
			return newValue;
		});
	}, [persistState]);

	// Load state on mount
	useEffect(() => {
		isMountedRef.current = true;
		void loadState();

		return () => {
			isMountedRef.current = false;
			// Clear any pending update on unmount
			if (pendingUpdateRef.current) {
				clearTimeout(pendingUpdateRef.current);
			}
		};
	}, [loadState]);

	// Listen for drop zone highlight events from other windows
	useEffect(() => {
		const cleanup = window.maestro.windows.onDropZoneHighlight((event) => {
			if (isMountedRef.current) {
				setDropZoneHighlighted(event.highlight);
			}
		});

		return cleanup;
	}, []);

	return {
		leftPanelCollapsed,
		rightPanelCollapsed,
		setLeftPanelCollapsed,
		setRightPanelCollapsed,
		toggleLeftPanel,
		toggleRightPanel,
		isLoaded,
		dropZoneHighlighted,
	};
}

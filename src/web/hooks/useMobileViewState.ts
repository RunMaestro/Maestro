/**
 * useMobileViewState - Mobile view state persistence and screen tracking hook
 *
 * Manages view state persistence to localStorage and tracks screen size changes.
 * This hook consolidates multiple related effects from mobile App.tsx:
 * - Screen size tracking (isSmallScreen state)
 * - View state persistence (showAllSessions, showHistoryPanel, showTabSearch)
 * - History panel state persistence (historyFilter, historySearchQuery, historySearchOpen)
 * - Session selection persistence (activeSessionId, activeTabId)
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * const {
 *   isSmallScreen,
 *   savedState,
 *   savedScrollState,
 *   persistViewState,
 *   persistHistoryState,
 *   persistSessionSelection,
 * } = useMobileViewState();
 * ```
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
	loadViewState,
	loadScrollState,
	debouncedSaveViewState,
	type ViewState,
	type ScrollState,
} from '../utils/viewState';

/**
 * Small screen breakpoint (pixels)
 * Below this height is considered a "small" screen (phone vs tablet)
 */
const SMALL_SCREEN_HEIGHT_THRESHOLD = 700;

/**
 * View overlay state for persistence
 */
export interface ViewOverlayState {
	showAllSessions: boolean;
	showHistoryPanel: boolean;
	showTabSearch: boolean;
}

/**
 * History panel state for persistence
 */
export interface HistoryPanelState {
	historyFilter: 'all' | 'AUTO' | 'USER';
	historySearchQuery: string;
	historySearchOpen: boolean;
}

/**
 * Session selection state for persistence
 */
export interface SessionSelectionState {
	activeSessionId: string | null;
	activeTabId: string | null;
}

/**
 * Return type for useMobileViewState hook
 */
export interface UseMobileViewStateReturn {
	/** Whether the current screen is considered "small" (< 700px height) */
	isSmallScreen: boolean;
	/** Initial view state loaded from localStorage */
	savedState: ViewState;
	/** Initial scroll state loaded from localStorage */
	savedScrollState: ScrollState;
	/** Persist view overlay state (showAllSessions, showHistoryPanel, showTabSearch) */
	persistViewState: (state: ViewOverlayState) => void;
	/** Persist history panel state (filter, search query, search open) */
	persistHistoryState: (state: HistoryPanelState) => void;
	/** Persist session selection state (activeSessionId, activeTabId) */
	persistSessionSelection: (state: SessionSelectionState) => void;
}

/**
 * Hook for managing mobile view state persistence and screen size tracking
 *
 * Provides:
 * - Screen size tracking with resize listener
 * - Initial state loading from localStorage
 * - Debounced persistence functions for different state categories
 *
 * @returns View state management utilities
 */
export function useMobileViewState(): UseMobileViewStateReturn {
	// Load saved state on initial render (only once via useMemo)
	const savedState = useMemo(() => loadViewState(), []);
	const savedScrollState = useMemo(() => loadScrollState(), []);

	// Track screen size for phone vs tablet detection
	const [isSmallScreen, setIsSmallScreen] = useState(
		typeof window !== 'undefined' ? window.innerHeight < SMALL_SCREEN_HEIGHT_THRESHOLD : false
	);

	// Track screen size changes
	useEffect(() => {
		const handleResize = () => {
			setIsSmallScreen(window.innerHeight < SMALL_SCREEN_HEIGHT_THRESHOLD);
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, []);

	// Debounced persistence function for view overlays
	const persistViewState = useCallback((state: ViewOverlayState) => {
		debouncedSaveViewState({
			showAllSessions: state.showAllSessions,
			showHistoryPanel: state.showHistoryPanel,
			showTabSearch: state.showTabSearch,
		});
	}, []);

	// Debounced persistence function for history panel state
	const persistHistoryState = useCallback((state: HistoryPanelState) => {
		debouncedSaveViewState({
			historyFilter: state.historyFilter,
			historySearchQuery: state.historySearchQuery,
			historySearchOpen: state.historySearchOpen,
		});
	}, []);

	// Debounced persistence function for session selection
	const persistSessionSelection = useCallback((state: SessionSelectionState) => {
		debouncedSaveViewState({
			activeSessionId: state.activeSessionId,
			activeTabId: state.activeTabId,
		});
	}, []);

	return {
		isSmallScreen,
		savedState,
		savedScrollState,
		persistViewState,
		persistHistoryState,
		persistSessionSelection,
	};
}

export default useMobileViewState;

/**
 * View State Persistence for Maestro Web Interface
 *
 * Saves and restores UI state to localStorage so the view persists across refreshes.
 * Includes: active views, session selection, scroll positions, and UI toggles.
 */

import { webLogger } from './logger';

const STORAGE_KEY = 'maestro-web-view-state';
const SCROLL_STORAGE_KEY = 'maestro-web-scroll-state';

/**
 * View state that gets persisted
 */
export interface ViewState {
	// Active overlays/views
	showAllSessions: boolean;
	showHistoryPanel: boolean;
	showTabSearch: boolean;

	// Session/tab selection
	activeSessionId: string | null;
	activeTabId: string | null;

	// Input mode
	inputMode: 'ai' | 'terminal';

	// History panel state
	historyFilter: 'all' | 'AUTO' | 'USER';
	historySearchOpen: boolean;
	historySearchQuery: string;

	// Timestamp for staleness check
	savedAt: number;
}

/**
 * Scroll positions for different views
 */
export interface ScrollState {
	messageHistory: number;
	allSessions: number;
	historyPanel: number;
}

/**
 * Default view state
 */
const DEFAULT_VIEW_STATE: ViewState = {
	showAllSessions: false,
	showHistoryPanel: false,
	showTabSearch: false,
	activeSessionId: null,
	activeTabId: null,
	inputMode: 'ai',
	historyFilter: 'all',
	historySearchOpen: false,
	historySearchQuery: '',
	savedAt: 0,
};

/**
 * Default scroll state
 */
const DEFAULT_SCROLL_STATE: ScrollState = {
	messageHistory: 0,
	allSessions: 0,
	historyPanel: 0,
};

/**
 * Maximum age of saved state before it's considered stale (5 minutes)
 */
const MAX_STATE_AGE_MS = 5 * 60 * 1000;

/**
 * Save view state to localStorage
 */
export function saveViewState(state: Partial<ViewState>): void {
	try {
		const currentState = loadViewState();
		const newState: ViewState = {
			...currentState,
			...state,
			savedAt: Date.now(),
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
		webLogger.debug('Saved view state', 'ViewState');
	} catch (error) {
		webLogger.error('Failed to save view state', 'ViewState', error);
	}
}

/**
 * Load view state from localStorage
 */
export function loadViewState(): ViewState {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) {
			return DEFAULT_VIEW_STATE;
		}

		const state = JSON.parse(stored) as ViewState;

		// Check if state is too old
		const age = Date.now() - (state.savedAt || 0);
		if (age > MAX_STATE_AGE_MS) {
			webLogger.debug('View state is stale, using defaults', 'ViewState');
			return DEFAULT_VIEW_STATE;
		}

		return { ...DEFAULT_VIEW_STATE, ...state };
	} catch (error) {
		webLogger.error('Failed to load view state', 'ViewState', error);
		return DEFAULT_VIEW_STATE;
	}
}

/**
 * Clear saved view state
 */
export function clearViewState(): void {
	try {
		localStorage.removeItem(STORAGE_KEY);
		localStorage.removeItem(SCROLL_STORAGE_KEY);
		webLogger.debug('Cleared view state', 'ViewState');
	} catch (error) {
		webLogger.error('Failed to clear view state', 'ViewState', error);
	}
}

/**
 * Save scroll position for a specific view
 */
export function saveScrollPosition(view: keyof ScrollState, position: number): void {
	try {
		const currentState = loadScrollState();
		const newState: ScrollState = {
			...currentState,
			[view]: position,
		};
		localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(newState));
	} catch (error) {
		webLogger.error('Failed to save scroll position', 'ViewState', error);
	}
}

/**
 * Load scroll positions from localStorage
 */
export function loadScrollState(): ScrollState {
	try {
		const stored = localStorage.getItem(SCROLL_STORAGE_KEY);
		if (!stored) {
			return DEFAULT_SCROLL_STATE;
		}
		return { ...DEFAULT_SCROLL_STATE, ...JSON.parse(stored) };
	} catch (error) {
		webLogger.error('Failed to load scroll state', 'ViewState', error);
		return DEFAULT_SCROLL_STATE;
	}
}

/**
 * Debounced save function to avoid excessive writes
 */
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveViewState(state: Partial<ViewState>, delay = 300): void {
	if (saveTimeout) {
		clearTimeout(saveTimeout);
	}
	saveTimeout = setTimeout(() => {
		saveViewState(state);
		saveTimeout = null;
	}, delay);
}

/**
 * Debounced scroll save (longer delay since scroll events fire frequently)
 */
let scrollSaveTimeout: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveScrollPosition(
	view: keyof ScrollState,
	position: number,
	delay = 500
): void {
	if (scrollSaveTimeout) {
		clearTimeout(scrollSaveTimeout);
	}
	scrollSaveTimeout = setTimeout(() => {
		saveScrollPosition(view, position);
		scrollSaveTimeout = null;
	}, delay);
}

/**
 * tabStore - Zustand store for tab operations and tab-specific UI state
 *
 * Tab DATA (aiTabs, filePreviewTabs, unifiedTabOrder, etc.) lives inside Session
 * objects in sessionStore. This store provides:
 *
 * 1. Tab operation actions — wrap tabHelpers.ts pure functions + sessionStore mutations,
 *    replacing ~43 callbacks currently threaded through App.tsx props
 * 2. Tab-specific UI state — gist content/URLs (the only tab state still in App.tsx)
 * 3. Selectors — derived tab state (activeTab, activeFileTab, unifiedTabs)
 *
 * Why tab data stays in sessionStore:
 * - Tab arrays are deeply embedded in the Session type (200+ call sites)
 * - Each session owns its own set of AI and file preview tabs
 * - tabHelpers.ts functions take Session → return modified Session
 * - Extracting tab data would be a massive, risky migration
 *
 * Instead, tabStore acts as a focused action layer over sessionStore,
 * giving components a clean API without prop-drilling 43 callbacks.
 *
 * Migration path:
 * 1. [CURRENT] Create tabStore with actions + UI state + selectors
 * 2. [NEXT] Migrate App.tsx tab callbacks to use tabStore actions
 * 3. [FUTURE] Components call tabStore directly, eliminating prop drilling
 */

import { create } from 'zustand';
import type { AITab, FilePreviewTab, UnifiedTab, TerminalTab, Session } from '../types';
import type { GistInfo } from '../components/GistPublishModal';
import {
	createTab as createTabHelper,
	closeTab as closeTabHelper,
	closeFileTab as closeFileTabHelper,
	reopenUnifiedClosedTab as reopenUnifiedClosedTabHelper,
	setActiveTab as setActiveTabHelper,
	getActiveTab,
	navigateToNextUnifiedTab as navigateToNextHelper,
	navigateToPrevUnifiedTab as navigateToPrevHelper,
	navigateToUnifiedTabByIndex as navigateToIndexHelper,
	navigateToLastUnifiedTab as navigateToLastHelper,
	buildUnifiedTabs,
	type CreateTabOptions,
	type CreateTabResult,
	type CloseTabOptions,
	type CloseTabResult,
	type CloseFileTabResult,
	type ReopenUnifiedClosedTabResult,
	type SetActiveTabResult,
	type NavigateToUnifiedTabResult,
} from '../utils/tabHelpers';
import {
	createTerminalTab as createTerminalTabHelper,
	addTerminalTab as addTerminalTabHelper,
	closeTerminalTab as closeTerminalTabHelper,
	selectTerminalTab as selectTerminalTabHelper,
	renameTerminalTab as renameTerminalTabHelper,
	getTerminalSessionId,
} from '../utils/terminalTabHelpers';
import { useSessionStore, selectActiveSession } from './sessionStore';

// ============================================================================
// Store Types
// ============================================================================

export interface TabStoreState {
	// Gist publishing state (moved from App.tsx local state)
	tabGistContent: { filename: string; content: string } | null;
	fileGistUrls: Record<string, GistInfo>;
}

export interface TabStoreActions {
	// === Gist UI state ===

	setTabGistContent: (content: { filename: string; content: string } | null) => void;
	setFileGistUrls: (urls: Record<string, GistInfo>) => void;
	setFileGistUrl: (path: string, info: GistInfo) => void;
	clearFileGistUrl: (path: string) => void;

	// === Tab CRUD (wraps tabHelpers + sessionStore) ===

	/**
	 * Create a new AI tab in the active session.
	 * Wraps tabHelpers.createTab + updates sessionStore.
	 */
	createTab: (options?: CreateTabOptions) => CreateTabResult | null;

	/**
	 * Close an AI tab in the active session.
	 * Wraps tabHelpers.closeTab + updates sessionStore.
	 */
	closeTab: (tabId: string, options?: CloseTabOptions) => CloseTabResult | null;

	/**
	 * Close a file preview tab in the active session.
	 * Wraps tabHelpers.closeFileTab + updates sessionStore.
	 */
	closeFileTab: (tabId: string) => CloseFileTabResult | null;

	/**
	 * Reopen the most recently closed tab (AI or file) in the active session.
	 * Wraps tabHelpers.reopenUnifiedClosedTab + updates sessionStore.
	 */
	reopenClosedTab: () => ReopenUnifiedClosedTabResult | null;

	// === Tab navigation ===

	/**
	 * Set the active AI tab in the active session.
	 * Wraps tabHelpers.setActiveTab + updates sessionStore.
	 */
	selectTab: (tabId: string) => SetActiveTabResult | null;

	/**
	 * Set the active file preview tab in the active session.
	 * Updates session's activeFileTabId directly.
	 */
	selectFileTab: (tabId: string) => void;

	/**
	 * Navigate to the next tab in unified order.
	 * @param showUnreadOnly - If true, only navigate through unread tabs
	 */
	navigateToNext: (showUnreadOnly?: boolean) => NavigateToUnifiedTabResult | null;

	/**
	 * Navigate to the previous tab in unified order.
	 * @param showUnreadOnly - If true, only navigate through unread tabs
	 */
	navigateToPrev: (showUnreadOnly?: boolean) => NavigateToUnifiedTabResult | null;

	/**
	 * Navigate to a tab by its position in the unified tab order.
	 */
	navigateToIndex: (index: number) => NavigateToUnifiedTabResult | null;

	/**
	 * Navigate to the last tab in unified order.
	 */
	navigateToLast: () => NavigateToUnifiedTabResult | null;

	// === Tab metadata ===

	/**
	 * Toggle the starred flag on an AI tab.
	 */
	starTab: (tabId: string) => void;

	/**
	 * Set the hasUnread flag on an AI tab.
	 */
	markUnread: (tabId: string, unread?: boolean) => void;

	/**
	 * Update the name of an AI tab.
	 */
	updateTabName: (tabId: string, name: string | null) => void;

	/**
	 * Toggle read-only mode on an AI tab.
	 */
	toggleReadOnly: (tabId: string) => void;

	/**
	 * Toggle saveToHistory flag on an AI tab.
	 */
	toggleSaveToHistory: (tabId: string) => void;

	/**
	 * Cycle through thinking modes: off → on → sticky → off.
	 */
	cycleThinkingMode: (tabId: string) => void;

	// === Tab reordering ===

	/**
	 * Reorder AI tabs within the active session.
	 * Moves tab from fromIndex to toIndex in the aiTabs array.
	 */
	reorderTabs: (fromIndex: number, toIndex: number) => void;

	/**
	 * Reorder tabs in the unified tab order (AI + file tabs).
	 * Moves tab from fromIndex to toIndex in unifiedTabOrder.
	 */
	reorderUnifiedTabs: (fromIndex: number, toIndex: number) => void;

	// === Terminal tab CRUD ===

	/**
	 * Create a new terminal tab in the active session.
	 * Switches inputMode to 'terminal' and sets activeTerminalTabId.
	 */
	createTerminalTab: (options?: { shell?: string; cwd?: string; name?: string | null }) => void;

	/**
	 * Close a terminal tab in the active session.
	 * Kills the associated PTY process. Refuses to close the last terminal tab.
	 */
	closeTerminalTab: (tabId: string) => void;

	/**
	 * Set the active terminal tab in the active session.
	 * Switches inputMode to 'terminal'.
	 */
	selectTerminalTab: (tabId: string) => void;

	/**
	 * Rename a terminal tab in the active session.
	 */
	renameTerminalTab: (tabId: string, name: string) => void;

	// === File tab content operations ===

	/**
	 * Update the edit content of a file preview tab.
	 */
	updateFileTabEditContent: (tabId: string, content: string | undefined) => void;

	/**
	 * Update the scroll position of a file preview tab.
	 */
	updateFileTabScrollPosition: (tabId: string, scrollTop: number) => void;

	/**
	 * Update the search query of a file preview tab.
	 */
	updateFileTabSearchQuery: (tabId: string, query: string) => void;

	/**
	 * Toggle edit mode on a file preview tab.
	 */
	toggleFileTabEditMode: (tabId: string) => void;
}

export type TabStore = TabStoreState & TabStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the active session from sessionStore.
 * Returns null if no active session exists.
 */
function getActiveSession(): Session | null {
	return selectActiveSession(useSessionStore.getState());
}

/**
 * Update the active session in sessionStore with a modified session.
 * Uses setSessions with a map to replace the session by ID.
 */
function updateActiveSession(updatedSession: Session): void {
	const { activeSessionId } = useSessionStore.getState();
	useSessionStore
		.getState()
		.setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? updatedSession : s)));
}

/**
 * Update a specific AI tab within the active session.
 * More efficient than full session replacement for single-tab updates.
 */
function updateAiTab(tabId: string, updates: Partial<AITab>): void {
	const { activeSessionId } = useSessionStore.getState();
	useSessionStore.getState().setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== activeSessionId) return s;
			const tabIndex = s.aiTabs.findIndex((t) => t.id === tabId);
			if (tabIndex === -1) return s;
			const newTabs = [...s.aiTabs];
			newTabs[tabIndex] = { ...newTabs[tabIndex], ...updates };
			return { ...s, aiTabs: newTabs };
		})
	);
}

/**
 * Update a specific file preview tab within the active session.
 */
function updateFileTab(tabId: string, updates: Partial<FilePreviewTab>): void {
	const { activeSessionId } = useSessionStore.getState();
	useSessionStore.getState().setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== activeSessionId) return s;
			const tabIndex = s.filePreviewTabs.findIndex((t) => t.id === tabId);
			if (tabIndex === -1) return s;
			const newTabs = [...s.filePreviewTabs];
			newTabs[tabIndex] = { ...newTabs[tabIndex], ...updates };
			return { ...s, filePreviewTabs: newTabs };
		})
	);
}

// Thinking mode cycle: off → on → sticky → off
const THINKING_CYCLE: Array<'off' | 'on' | 'sticky'> = ['off', 'on', 'sticky'];

// ============================================================================
// Store Implementation
// ============================================================================

export const useTabStore = create<TabStore>()((set) => ({
	// --- State ---
	tabGistContent: null,
	fileGistUrls: {},

	// --- Actions ---

	// Gist UI state
	setTabGistContent: (content) => set({ tabGistContent: content }),

	setFileGistUrls: (urls) => set({ fileGistUrls: urls }),

	setFileGistUrl: (path, info) =>
		set((s) => ({
			fileGistUrls: { ...s.fileGistUrls, [path]: info },
		})),

	clearFileGistUrl: (path) =>
		set((s) => {
			const { [path]: _, ...rest } = s.fileGistUrls;
			return { fileGistUrls: rest };
		}),

	// Tab CRUD
	createTab: (options?) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = createTabHelper(session, options);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	closeTab: (tabId, options?) => {
		const session = getActiveSession();
		if (!session) return null;
		const showUnreadOnly = false; // Caller can pass showUnreadOnly via closeTab options if needed
		const result = closeTabHelper(session, tabId, showUnreadOnly, options);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	closeFileTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = closeFileTabHelper(session, tabId);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	reopenClosedTab: () => {
		const session = getActiveSession();
		if (!session) return null;
		const result = reopenUnifiedClosedTabHelper(session);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	// Tab navigation
	selectTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = setActiveTabHelper(session, tabId);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	selectFileTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		// Verify the file tab exists
		if (!session.filePreviewTabs.some((t) => t.id === tabId)) return;
		updateActiveSession({ ...session, activeFileTabId: tabId });
	},

	navigateToNext: (showUnreadOnly?) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = navigateToNextHelper(session, showUnreadOnly);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	navigateToPrev: (showUnreadOnly?) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = navigateToPrevHelper(session, showUnreadOnly);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	navigateToIndex: (index) => {
		const session = getActiveSession();
		if (!session) return null;
		const result = navigateToIndexHelper(session, index);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	navigateToLast: () => {
		const session = getActiveSession();
		if (!session) return null;
		const result = navigateToLastHelper(session);
		if (!result) return null;
		updateActiveSession(result.session);
		return result;
	},

	// Tab metadata
	starTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = session.aiTabs.find((t) => t.id === tabId);
		if (!tab) return;
		updateAiTab(tabId, { starred: !tab.starred });
	},

	markUnread: (tabId, unread = true) => updateAiTab(tabId, { hasUnread: unread }),

	updateTabName: (tabId, name) => updateAiTab(tabId, { name }),

	toggleReadOnly: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = session.aiTabs.find((t) => t.id === tabId);
		if (!tab) return;
		updateAiTab(tabId, { readOnlyMode: !tab.readOnlyMode });
	},

	toggleSaveToHistory: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = session.aiTabs.find((t) => t.id === tabId);
		if (!tab) return;
		updateAiTab(tabId, { saveToHistory: !tab.saveToHistory });
	},

	cycleThinkingMode: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = session.aiTabs.find((t) => t.id === tabId);
		if (!tab) return;
		const currentMode = tab.showThinking ?? 'off';
		const currentIndex = THINKING_CYCLE.indexOf(currentMode);
		const nextMode = THINKING_CYCLE[(currentIndex + 1) % THINKING_CYCLE.length];
		updateAiTab(tabId, { showThinking: nextMode });
	},

	// Tab reordering
	reorderTabs: (fromIndex, toIndex) => {
		const session = getActiveSession();
		if (!session) return;
		const tabs = [...session.aiTabs];
		if (fromIndex < 0 || fromIndex >= tabs.length) return;
		if (toIndex < 0 || toIndex >= tabs.length) return;
		const [moved] = tabs.splice(fromIndex, 1);
		tabs.splice(toIndex, 0, moved);
		updateActiveSession({ ...session, aiTabs: tabs });
	},

	reorderUnifiedTabs: (fromIndex, toIndex) => {
		const session = getActiveSession();
		if (!session) return;
		const order = [...session.unifiedTabOrder];
		if (fromIndex < 0 || fromIndex >= order.length) return;
		if (toIndex < 0 || toIndex >= order.length) return;
		const [moved] = order.splice(fromIndex, 1);
		order.splice(toIndex, 0, moved);
		updateActiveSession({ ...session, unifiedTabOrder: order });
	},

	// Terminal tab CRUD
	createTerminalTab: (options?) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = createTerminalTabHelper(options?.shell, options?.cwd, options?.name);
		const updatedSession = addTerminalTabHelper(session, tab);
		updateActiveSession({ ...updatedSession, inputMode: 'terminal' });
	},

	closeTerminalTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		// Kill the PTY process before removing the tab
		window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
		const updatedSession = closeTerminalTabHelper(session, tabId);
		updateActiveSession(updatedSession);
	},

	selectTerminalTab: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const updatedSession = selectTerminalTabHelper(session, tabId);
		updateActiveSession({ ...updatedSession, inputMode: 'terminal' });
	},

	renameTerminalTab: (tabId, name) => {
		const session = getActiveSession();
		if (!session) return;
		const updatedSession = renameTerminalTabHelper(session, tabId, name);
		updateActiveSession(updatedSession);
	},

	// File tab content operations
	updateFileTabEditContent: (tabId, content) => updateFileTab(tabId, { editContent: content }),
	updateFileTabScrollPosition: (tabId, scrollTop) => updateFileTab(tabId, { scrollTop }),
	updateFileTabSearchQuery: (tabId, query) => updateFileTab(tabId, { searchQuery: query }),

	toggleFileTabEditMode: (tabId) => {
		const session = getActiveSession();
		if (!session) return;
		const tab = session.filePreviewTabs.find((t) => t.id === tabId);
		if (!tab) return;
		updateFileTab(tabId, { editMode: !tab.editMode });
	},
}));

// ============================================================================
// Selectors (derive from sessionStore)
// ============================================================================

/**
 * Select the active AI tab from the active session.
 * Use with useSessionStore: `useSessionStore(selectActiveTab)`
 *
 * @example
 * const activeTab = useSessionStore(selectActiveTab);
 */
export const selectActiveTab = (
	state: ReturnType<typeof useSessionStore.getState>
): AITab | undefined => {
	const session = selectActiveSession(state);
	return session ? getActiveTab(session) : undefined;
};

/**
 * Select the active file preview tab from the active session.
 * Use with useSessionStore: `useSessionStore(selectActiveFileTab)`
 *
 * @example
 * const activeFileTab = useSessionStore(selectActiveFileTab);
 */
export const selectActiveFileTab = (
	state: ReturnType<typeof useSessionStore.getState>
): FilePreviewTab | undefined => {
	const session = selectActiveSession(state);
	if (!session || !session.activeFileTabId) return undefined;
	return session.filePreviewTabs.find((t) => t.id === session.activeFileTabId);
};

/**
 * Select unified tabs (AI + file) in order for the active session.
 * Use with useSessionStore: `useSessionStore(selectUnifiedTabs)`
 *
 * @example
 * const unifiedTabs = useSessionStore(selectUnifiedTabs);
 */
export const selectUnifiedTabs = (
	state: ReturnType<typeof useSessionStore.getState>
): UnifiedTab[] => {
	const session = selectActiveSession(state);
	if (!session) return [];
	return buildUnifiedTabs(session);
};

/**
 * Select a specific AI tab by ID from the active session.
 *
 * @example
 * const tab = useSessionStore(selectTabById('tab-123'));
 */
export const selectTabById =
	(tabId: string) =>
	(state: ReturnType<typeof useSessionStore.getState>): AITab | undefined => {
		const session = selectActiveSession(state);
		return session?.aiTabs.find((t) => t.id === tabId);
	};

/**
 * Select a specific file preview tab by ID from the active session.
 *
 * @example
 * const fileTab = useSessionStore(selectFileTabById('file-tab-123'));
 */
export const selectFileTabById =
	(tabId: string) =>
	(state: ReturnType<typeof useSessionStore.getState>): FilePreviewTab | undefined => {
		const session = selectActiveSession(state);
		return session?.filePreviewTabs.find((t) => t.id === tabId);
	};

/**
 * Select the count of AI tabs in the active session.
 *
 * @example
 * const tabCount = useSessionStore(selectTabCount);
 */
export const selectTabCount = (state: ReturnType<typeof useSessionStore.getState>): number => {
	const session = selectActiveSession(state);
	return session?.aiTabs.length ?? 0;
};

/**
 * Select all AI tabs in the active session.
 *
 * @example
 * const tabs = useSessionStore(selectAllTabs);
 */
export const selectAllTabs = (state: ReturnType<typeof useSessionStore.getState>): AITab[] => {
	const session = selectActiveSession(state);
	return session?.aiTabs ?? [];
};

/**
 * Select all file preview tabs in the active session.
 *
 * @example
 * const fileTabs = useSessionStore(selectAllFileTabs);
 */
export const selectAllFileTabs = (
	state: ReturnType<typeof useSessionStore.getState>
): FilePreviewTab[] => {
	const session = selectActiveSession(state);
	return session?.filePreviewTabs ?? [];
};

/**
 * Select the active terminal tab from the active session.
 * Use with useSessionStore: `useSessionStore(selectActiveTerminalTab)`
 *
 * @example
 * const activeTerminalTab = useSessionStore(selectActiveTerminalTab);
 */
export const selectActiveTerminalTab = (
	state: ReturnType<typeof useSessionStore.getState>
): TerminalTab | undefined => {
	const session = selectActiveSession(state);
	if (!session || !session.activeTerminalTabId) return undefined;
	return session.terminalTabs?.find((t) => t.id === session.activeTerminalTabId);
};

/**
 * Select all terminal tabs in the active session.
 * Use with useSessionStore: `useSessionStore(selectTerminalTabs)`
 *
 * @example
 * const terminalTabs = useSessionStore(selectTerminalTabs);
 */
export const selectTerminalTabs = (
	state: ReturnType<typeof useSessionStore.getState>
): TerminalTab[] => {
	const session = selectActiveSession(state);
	return session?.terminalTabs ?? [];
};

// ============================================================================
// Non-React Access
// ============================================================================

/**
 * Get current tab store state outside React.
 *
 * @example
 * const { tabGistContent, fileGistUrls } = getTabState();
 */
export function getTabState() {
	return useTabStore.getState();
}

/**
 * Get stable tab action references outside React.
 *
 * @example
 * const { createTab, closeTab, selectTab } = getTabActions();
 */
export function getTabActions() {
	const state = useTabStore.getState();
	return {
		// Gist state
		setTabGistContent: state.setTabGistContent,
		setFileGistUrls: state.setFileGistUrls,
		setFileGistUrl: state.setFileGistUrl,
		clearFileGistUrl: state.clearFileGistUrl,
		// Tab CRUD
		createTab: state.createTab,
		closeTab: state.closeTab,
		closeFileTab: state.closeFileTab,
		reopenClosedTab: state.reopenClosedTab,
		// Tab navigation
		selectTab: state.selectTab,
		selectFileTab: state.selectFileTab,
		navigateToNext: state.navigateToNext,
		navigateToPrev: state.navigateToPrev,
		navigateToIndex: state.navigateToIndex,
		navigateToLast: state.navigateToLast,
		// Tab metadata
		starTab: state.starTab,
		markUnread: state.markUnread,
		updateTabName: state.updateTabName,
		toggleReadOnly: state.toggleReadOnly,
		toggleSaveToHistory: state.toggleSaveToHistory,
		cycleThinkingMode: state.cycleThinkingMode,
		// Tab reordering
		reorderTabs: state.reorderTabs,
		reorderUnifiedTabs: state.reorderUnifiedTabs,
		// File tab operations
		updateFileTabEditContent: state.updateFileTabEditContent,
		updateFileTabScrollPosition: state.updateFileTabScrollPosition,
		updateFileTabSearchQuery: state.updateFileTabSearchQuery,
		toggleFileTabEditMode: state.toggleFileTabEditMode,
		// Terminal tab CRUD
		createTerminalTab: state.createTerminalTab,
		closeTerminalTab: state.closeTerminalTab,
		selectTerminalTab: state.selectTerminalTab,
		renameTerminalTab: state.renameTerminalTab,
	};
}

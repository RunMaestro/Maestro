// Tab helper functions for AI multi-tab support
// These helpers manage AITab state within Maestro sessions

import { Session, AITab, ClosedTab, LogEntry, UsageStats, ToolType } from '../types';
import { generateId } from './ids';

/**
 * Get the initial name to show in the rename modal.
 * Returns empty string if no custom name is set (name is null),
 * or the custom name if user has set one.
 *
 * @param tab - The AI tab being renamed
 * @returns The name to pre-fill in the rename input (empty for auto-generated names)
 */
export function getInitialRenameValue(tab: AITab): string {
	return tab.name || '';
}

// Maximum number of closed tabs to keep in history
const MAX_CLOSED_TAB_HISTORY = 25;

/**
 * Check if a tab has draft content (unsent input or staged images).
 * Used for determining if a tab should be shown in "unread only" filter mode.
 *
 * @param tab - The AI tab to check
 * @returns True if the tab has unsent text input or staged images
 */
export function hasDraft(tab: AITab): boolean {
	return (
		(tab.inputValue && tab.inputValue.trim() !== '') ||
		(tab.stagedImages && tab.stagedImages.length > 0)
	);
}

/**
 * Check if a tab has an active (unfinished) wizard session.
 * Used to determine if closing the tab should show a confirmation modal.
 *
 * @param tab - The AI tab to check
 * @returns True if the tab has an active wizard that hasn't completed
 */
export function hasActiveWizard(tab: AITab): boolean {
	return tab.wizardState?.isActive === true;
}

/**
 * Get the list of navigable tabs based on filter settings.
 * When showUnreadOnly is true, only returns unread tabs and tabs with unsent drafts/staged images.
 * When false (default), returns all tabs.
 *
 * This helper consolidates the tab filtering logic used by navigation functions.
 *
 * @param session - The Maestro session containing tabs
 * @param showUnreadOnly - If true, filter to only unread tabs and tabs with drafts
 * @returns Array of navigable AITabs (may be empty if session has no tabs or filter excludes all)
 *
 * @example
 * // Get all tabs
 * const tabs = getNavigableTabs(session);
 *
 * @example
 * // Get only unread tabs and tabs with draft content
 * const unreadTabs = getNavigableTabs(session, true);
 */
export function getNavigableTabs(session: Session, showUnreadOnly = false): AITab[] {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return [];
	}

	if (showUnreadOnly) {
		return session.aiTabs.filter((tab) => tab.hasUnread || hasDraft(tab));
	}

	return session.aiTabs;
}

/**
 * Get the currently active AI tab for a session.
 * Returns the tab matching activeTabId, or the first tab if not found.
 * Returns undefined if the session has no tabs.
 *
 * @param session - The Maestro session
 * @returns The active AITab or undefined if no tabs exist
 */
export function getActiveTab(session: Session): AITab | undefined {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return undefined;
	}

	const activeTab = session.aiTabs.find((tab) => tab.id === session.activeTabId);

	// Fallback to first tab if activeTabId doesn't match any tab
	// (can happen after tab deletion or data corruption)
	return activeTab ?? session.aiTabs[0];
}

/**
 * Options for creating a new AI tab.
 */
export interface CreateTabOptions {
	agentSessionId?: string | null; // Claude Code session UUID (null for new tabs)
	logs?: LogEntry[]; // Initial conversation history
	name?: string | null; // User-defined name (null = show UUID octet)
	starred?: boolean; // Whether session is starred
	usageStats?: UsageStats; // Token usage stats
	saveToHistory?: boolean; // Whether to save synopsis to history after completions
	showThinking?: boolean; // Whether to show thinking/streaming content for this tab
}

/**
 * Result of creating a new tab - contains both the new tab and updated session.
 */
export interface CreateTabResult {
	tab: AITab; // The newly created tab
	session: Session; // Updated session with the new tab added and set as active
}

/**
 * Create a new AI tab for a session.
 * The new tab is appended to the session's aiTabs array and set as the active tab.
 *
 * @param session - The Maestro session to add the tab to
 * @param options - Optional tab configuration (agentSessionId, logs, name, starred)
 * @returns Object containing the new tab and updated session
 *
 * @example
 * // Create a new empty tab
 * const { tab, session: updatedSession } = createTab(session);
 *
 * @example
 * // Create a tab for an existing Claude session
 * const { tab, session: updatedSession } = createTab(session, {
 *   agentSessionId: 'abc123',
 *   name: 'My Feature',
 *   starred: true,
 *   logs: existingLogs
 * });
 */
export function createTab(
	session: Session,
	options: CreateTabOptions = {}
): CreateTabResult | null {
	if (!session) {
		return null;
	}

	const {
		agentSessionId = null,
		logs = [],
		name = null,
		starred = false,
		usageStats,
		saveToHistory = true,
		showThinking = false,
	} = options;

	// Create the new tab with default values
	const newTab: AITab = {
		id: generateId(),
		agentSessionId,
		name,
		starred,
		logs,
		inputValue: '',
		stagedImages: [],
		usageStats,
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory,
		showThinking,
	};

	// Update the session with the new tab added and set as active
	const updatedSession: Session = {
		...session,
		aiTabs: [...(session.aiTabs || []), newTab],
		activeTabId: newTab.id,
	};

	return {
		tab: newTab,
		session: updatedSession,
	};
}

/**
 * Options for closing a tab.
 */
export interface CloseTabOptions {
	/** If true, skip adding to closed tab history (e.g., for wizard tabs) */
	skipHistory?: boolean;
}

/**
 * Result of closing a tab - contains the closed tab info and updated session.
 */
export interface CloseTabResult {
	closedTab: ClosedTab; // The closed tab data with original index
	session: Session; // Updated session with tab removed
}

/**
 * Close an AI tab and optionally add it to the closed tab history.
 * The closed tab is stored in closedTabHistory for potential restoration via Cmd+Shift+T,
 * unless skipHistory is true (e.g., for wizard tabs which should not be restorable).
 * If the closed tab was active, the next tab (or previous if at end) becomes active.
 * When showUnreadOnly is true, prioritizes switching to the next unread tab.
 * If closing the last tab, a fresh new tab is created to replace it.
 *
 * @param session - The Maestro session containing the tab
 * @param tabId - The ID of the tab to close
 * @param showUnreadOnly - If true, prioritize switching to the next unread tab
 * @param options - Optional close options (e.g., skipHistory for wizard tabs)
 * @returns Object containing the closed tab info and updated session, or null if tab not found
 *
 * @example
 * const result = closeTab(session, 'tab-123');
 * if (result) {
 *   const { closedTab, session: updatedSession } = result;
 *   console.log(`Closed tab at index ${closedTab.index}`);
 * }
 *
 * @example
 * // Close wizard tab without adding to history
 * const result = closeTab(session, 'wizard-tab-id', false, { skipHistory: true });
 */
export function closeTab(
	session: Session,
	tabId: string,
	showUnreadOnly = false,
	options: CloseTabOptions = {}
): CloseTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	// Find the tab to close
	const tabIndex = session.aiTabs.findIndex((tab) => tab.id === tabId);
	if (tabIndex === -1) {
		return null;
	}

	const tabToClose = session.aiTabs[tabIndex];

	// Create closed tab entry with original index
	const closedTab: ClosedTab = {
		tab: { ...tabToClose },
		index: tabIndex,
		closedAt: Date.now(),
	};

	// Remove tab from aiTabs
	let updatedTabs = session.aiTabs.filter((tab) => tab.id !== tabId);

	// If we just closed the last tab, create a fresh new tab to replace it
	let newActiveTabId = session.activeTabId;
	if (updatedTabs.length === 0) {
		const freshTab: AITab = {
			id: generateId(),
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: Date.now(),
			state: 'idle',
		};
		updatedTabs = [freshTab];
		newActiveTabId = freshTab.id;
	} else if (session.activeTabId === tabId) {
		// If we closed the active tab, select the next appropriate tab

		if (showUnreadOnly) {
			// When filtering unread tabs, find the next unread tab to switch to
			// Build a temporary session with the updated tabs to use getNavigableTabs
			const tempSession = { ...session, aiTabs: updatedTabs };
			const navigableTabs = getNavigableTabs(tempSession, true);

			if (navigableTabs.length > 0) {
				// Find the position of the closed tab within the navigable tabs (before removal)
				// Then pick the tab at the same position or the last one if we were at the end
				const closedTabNavIndex = getNavigableTabs(session, true).findIndex((t) => t.id === tabId);
				const newNavIndex = Math.min(closedTabNavIndex, navigableTabs.length - 1);
				newActiveTabId = navigableTabs[Math.max(0, newNavIndex)].id;
			} else {
				// No more unread tabs - fall back to selecting by position in full list
				const newIndex = Math.min(tabIndex, updatedTabs.length - 1);
				newActiveTabId = updatedTabs[newIndex].id;
			}
		} else {
			// Normal mode: select the next tab or the previous one if at end
			const newIndex = Math.min(tabIndex, updatedTabs.length - 1);
			newActiveTabId = updatedTabs[newIndex].id;
		}
	}

	// Add to closed tab history unless skipHistory is set (e.g., for wizard tabs)
	// Wizard tabs should not be restorable via Cmd+Shift+T
	const updatedHistory = options.skipHistory
		? session.closedTabHistory || []
		: [closedTab, ...(session.closedTabHistory || [])].slice(0, MAX_CLOSED_TAB_HISTORY);

	// Create updated session
	const updatedSession: Session = {
		...session,
		aiTabs: updatedTabs,
		activeTabId: newActiveTabId,
		closedTabHistory: updatedHistory,
	};

	return {
		closedTab,
		session: updatedSession,
	};
}

/**
 * Result of reopening a closed tab.
 */
export interface ReopenTabResult {
	tab: AITab; // The reopened tab (either restored or existing duplicate)
	session: Session; // Updated session with tab restored/selected
	wasDuplicate: boolean; // True if we switched to an existing tab instead of restoring
}

/**
 * Reopen the most recently closed tab from the closed tab history.
 * Includes duplicate detection: if a tab with the same agentSessionId already exists,
 * switch to that existing tab instead of creating a duplicate.
 *
 * The tab is restored at its original index position if possible, otherwise appended to the end.
 * The reopened tab becomes the active tab.
 *
 * @param session - The Maestro session
 * @returns Object containing the reopened tab and updated session, or null if no closed tabs exist
 *
 * @example
 * const result = reopenClosedTab(session);
 * if (result) {
 *   const { tab, session: updatedSession, wasDuplicate } = result;
 *   if (wasDuplicate) {
 *     console.log(`Switched to existing tab ${tab.id}`);
 *   } else {
 *     console.log(`Restored tab ${tab.id} from history`);
 *   }
 * }
 */
export function reopenClosedTab(session: Session): ReopenTabResult | null {
	// Check if there's anything in the history
	if (!session.closedTabHistory || session.closedTabHistory.length === 0) {
		return null;
	}

	// Pop the most recently closed tab from history
	const [closedTabEntry, ...remainingHistory] = session.closedTabHistory;
	const tabToRestore = closedTabEntry.tab;

	// Check for duplicate: does a tab with the same agentSessionId already exist?
	// Note: null agentSessionId (new/empty tabs) are never considered duplicates
	if (tabToRestore.agentSessionId !== null) {
		const existingTab = session.aiTabs.find(
			(tab) => tab.agentSessionId === tabToRestore.agentSessionId
		);

		if (existingTab) {
			// Duplicate found - switch to existing tab instead of restoring
			// Still remove from history since user "used" their undo
			return {
				tab: existingTab,
				session: {
					...session,
					activeTabId: existingTab.id,
					closedTabHistory: remainingHistory,
				},
				wasDuplicate: true,
			};
		}
	}

	// No duplicate - restore the tab
	// Generate a new ID to avoid any ID conflicts
	const restoredTab: AITab = {
		...tabToRestore,
		id: generateId(),
	};

	// Insert at original index if possible, otherwise append
	const insertIndex = Math.min(closedTabEntry.index, session.aiTabs.length);
	const updatedTabs = [
		...session.aiTabs.slice(0, insertIndex),
		restoredTab,
		...session.aiTabs.slice(insertIndex),
	];

	return {
		tab: restoredTab,
		session: {
			...session,
			aiTabs: updatedTabs,
			activeTabId: restoredTab.id,
			closedTabHistory: remainingHistory,
		},
		wasDuplicate: false,
	};
}

/**
 * Result of setting the active tab.
 */
export interface SetActiveTabResult {
	tab: AITab; // The newly active tab
	session: Session; // Updated session with activeTabId changed
}

/**
 * Set the active AI tab for a session.
 * Changes which tab is currently displayed and receives input.
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the tab to make active
 * @returns Object containing the active tab and updated session, or null if tab not found
 *
 * @example
 * const result = setActiveTab(session, 'tab-456');
 * if (result) {
 *   const { tab, session: updatedSession } = result;
 *   console.log(`Now viewing tab: ${tab.name || tab.agentSessionId}`);
 * }
 */
export function setActiveTab(session: Session, tabId: string): SetActiveTabResult | null {
	// Validate that the session and tab exists
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	const targetTab = session.aiTabs.find((tab) => tab.id === tabId);
	if (!targetTab) {
		return null;
	}

	// If already active, return current state (no mutation needed)
	if (session.activeTabId === tabId) {
		return {
			tab: targetTab,
			session,
		};
	}

	return {
		tab: targetTab,
		session: {
			...session,
			activeTabId: tabId,
		},
	};
}

/**
 * Get the tab that is currently in write mode (busy state) for a session.
 * In write-mode locking, only one tab can be busy at a time per Maestro session
 * to prevent file clobbering when multiple Claude sessions write to the same project.
 *
 * @param session - The Maestro session
 * @returns The busy AITab or undefined if no tab is in write mode
 *
 * @example
 * const busyTab = getWriteModeTab(session);
 * if (busyTab) {
 *   console.log(`Tab ${busyTab.name || busyTab.agentSessionId} is currently writing`);
 *   // Disable input for other tabs
 * }
 */
export function getWriteModeTab(session: Session): AITab | undefined {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return undefined;
	}

	return session.aiTabs.find((tab) => tab.state === 'busy');
}

/**
 * Get all tabs that are currently busy (in write mode) for a session.
 * While the system enforces single write-mode, multiple busy tabs can exist
 * temporarily when resuming already-running sessions.
 *
 * This is useful for the busy tab indicator which needs to show ALL busy tabs,
 * not just the first one found.
 *
 * @param session - The Maestro session
 * @returns Array of busy AITabs (empty if none are busy)
 *
 * @example
 * const busyTabs = getBusyTabs(session);
 * if (busyTabs.length > 0) {
 *   // Show busy indicator with pills for each busy tab
 *   busyTabs.forEach(tab => {
 *     console.log(`Tab ${tab.name || tab.agentSessionId} is busy`);
 *   });
 * }
 */
export function getBusyTabs(session: Session): AITab[] {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return [];
	}

	return session.aiTabs.filter((tab) => tab.state === 'busy');
}

/**
 * Navigate to the next tab in the session's tab list.
 * Wraps around to the first tab if currently on the last tab.
 * When showUnreadOnly is true, only cycles through unread tabs and tabs with drafts.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, only navigate through unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if less than 2 tabs
 *
 * @example
 * const result = navigateToNextTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToNextTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length < 2) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	// Find current position in navigable tabs
	const currentIndex = navigableTabs.findIndex((tab) => tab.id === session.activeTabId);

	// If current tab is not in navigable list, go to first navigable tab
	if (currentIndex === -1) {
		const firstTab = navigableTabs[0];
		return {
			tab: firstTab,
			session: {
				...session,
				activeTabId: firstTab.id,
			},
		};
	}

	// If only one navigable tab, stay on it
	if (navigableTabs.length < 2) {
		return null;
	}

	// Wrap around to first tab if at the end
	const nextIndex = (currentIndex + 1) % navigableTabs.length;
	const nextTab = navigableTabs[nextIndex];

	return {
		tab: nextTab,
		session: {
			...session,
			activeTabId: nextTab.id,
		},
	};
}

/**
 * Navigate to the previous tab in the session's tab list.
 * Wraps around to the last tab if currently on the first tab.
 * When showUnreadOnly is true, only cycles through unread tabs and tabs with drafts.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, only navigate through unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if less than 2 tabs
 *
 * @example
 * const result = navigateToPrevTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToPrevTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length < 2) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	// Find current position in navigable tabs
	const currentIndex = navigableTabs.findIndex((tab) => tab.id === session.activeTabId);

	// If current tab is not in navigable list, go to last navigable tab
	if (currentIndex === -1) {
		const lastTab = navigableTabs[navigableTabs.length - 1];
		return {
			tab: lastTab,
			session: {
				...session,
				activeTabId: lastTab.id,
			},
		};
	}

	// If only one navigable tab, stay on it
	if (navigableTabs.length < 2) {
		return null;
	}

	// Wrap around to last tab if at the beginning
	const prevIndex = (currentIndex - 1 + navigableTabs.length) % navigableTabs.length;
	const prevTab = navigableTabs[prevIndex];

	return {
		tab: prevTab,
		session: {
			...session,
			activeTabId: prevTab.id,
		},
	};
}

/**
 * Navigate to a specific tab by its index (0-based).
 * Used for Cmd+1 through Cmd+8 shortcuts.
 * When showUnreadOnly is true, navigates within the filtered list (unread + drafts).
 *
 * @param session - The Maestro session
 * @param index - The 0-based index of the tab to navigate to
 * @param showUnreadOnly - If true, navigate within unread tabs and tabs with drafts
 * @returns Object containing the new active tab and updated session, or null if index out of bounds
 *
 * @example
 * // Navigate to the first tab (Cmd+1)
 * const result = navigateToTabByIndex(session, 0);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToTabByIndex(
	session: Session,
	index: number,
	showUnreadOnly = false
): SetActiveTabResult | null {
	if (!session || !session.aiTabs || session.aiTabs.length === 0) {
		return null;
	}

	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	// Check if index is within bounds
	if (index < 0 || index >= navigableTabs.length) {
		return null;
	}

	const targetTab = navigableTabs[index];

	// If already on this tab, return current state (no change needed)
	if (session.activeTabId === targetTab.id) {
		return {
			tab: targetTab,
			session,
		};
	}

	return {
		tab: targetTab,
		session: {
			...session,
			activeTabId: targetTab.id,
		},
	};
}

/**
 * Navigate to the last tab in the session's tab list.
 * Used for Cmd+0 shortcut.
 * When showUnreadOnly is true, navigates to the last tab in the filtered list (unread + drafts).
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, navigate to last unread/draft tab
 * @returns Object containing the new active tab and updated session, or null if no tabs
 *
 * @example
 * const result = navigateToLastTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToLastTab(
	session: Session,
	showUnreadOnly = false
): SetActiveTabResult | null {
	const navigableTabs = getNavigableTabs(session, showUnreadOnly);

	if (navigableTabs.length === 0) {
		return null;
	}

	const lastIndex = navigableTabs.length - 1;
	return navigateToTabByIndex(session, lastIndex, showUnreadOnly);
}

/**
 * Options for creating a new AI tab at a specific position.
 */
export interface CreateTabAtPositionOptions extends CreateTabOptions {
	/** Insert the new tab after this tab ID */
	afterTabId: string;
}

/**
 * Create a new AI tab at a specific position in the session's tab list.
 * The new tab is inserted immediately after the specified tab.
 *
 * @param session - The Maestro session to add the tab to
 * @param options - Tab configuration including position (afterTabId)
 * @returns Object containing the new tab and updated session, or null on error
 *
 * @example
 * // Create a compacted tab right after the source tab
 * const result = createTabAtPosition(session, {
 *   afterTabId: sourceTab.id,
 *   name: 'Session Compacted 2024-01-15',
 *   logs: summarizedLogs,
 * });
 */
export function createTabAtPosition(
	session: Session,
	options: CreateTabAtPositionOptions
): CreateTabResult | null {
	const result = createTab(session, options);
	if (!result) return null;

	// Find the index of the afterTabId
	const afterIndex = result.session.aiTabs.findIndex((t) => t.id === options.afterTabId);
	if (afterIndex === -1) return result;

	// Move the new tab to be right after afterTabId
	const tabs = [...result.session.aiTabs];
	const newTabIndex = tabs.findIndex((t) => t.id === result.tab.id);

	// Only move if the new tab isn't already in the right position
	if (newTabIndex !== afterIndex + 1) {
		const [newTab] = tabs.splice(newTabIndex, 1);
		tabs.splice(afterIndex + 1, 0, newTab);
	}

	return {
		tab: result.tab,
		session: { ...result.session, aiTabs: tabs },
	};
}

/**
 * Options for creating a merged session from multiple context sources.
 */
export interface CreateMergedSessionOptions {
	/** Name for the new merged session */
	name: string;
	/** Project root directory for the new session */
	projectRoot: string;
	/** Agent type for the new session */
	toolType: ToolType;
	/** Pre-merged conversation logs to initialize the tab with */
	mergedLogs: LogEntry[];
	/** Aggregated usage stats from merged contexts (optional) */
	usageStats?: UsageStats;
	/** Group ID to assign the session to (optional) */
	groupId?: string;
	/** Whether to save completions to history (default: true) */
	saveToHistory?: boolean;
	/** Whether to show thinking/streaming content (default: false) */
	showThinking?: boolean;
}

/**
 * Result of creating a merged session.
 */
export interface CreateMergedSessionResult {
	/** The newly created session with merged context */
	session: Session;
	/** The ID of the active tab in the new session */
	tabId: string;
}

/**
 * Create a new Maestro session pre-populated with merged context logs.
 * This is used when merging multiple sessions/tabs into a unified context
 * or when transferring context to a different agent type.
 *
 * The merged session is created with:
 * - A single tab containing the merged logs
 * - State set to 'idle' (ready to receive new input)
 * - Standard session structure matching App.tsx createNewSession pattern
 *
 * @param options - Configuration for the merged session
 * @returns Object containing the new session and its active tab ID
 *
 * @example
 * const { session, tabId } = createMergedSession({
 *   name: 'Merged Context',
 *   projectRoot: '/path/to/project',
 *   toolType: 'claude-code',
 *   mergedLogs: groomedLogs,
 *   usageStats: combinedStats
 * });
 * // Add session to app state and initialize agent
 */
export function createMergedSession(
	options: CreateMergedSessionOptions
): CreateMergedSessionResult {
	const {
		name,
		projectRoot,
		toolType,
		mergedLogs,
		usageStats,
		groupId,
		saveToHistory = true,
		showThinking = false,
	} = options;

	const sessionId = generateId();
	const tabId = generateId();

	// Create the initial tab with merged logs
	const mergedTab: AITab = {
		id: tabId,
		agentSessionId: null, // Will be assigned when agent spawns
		name: null, // Auto-generated name based on session UUID octet
		starred: false,
		logs: mergedLogs,
		inputValue: '',
		stagedImages: [],
		usageStats,
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory,
		showThinking,
	};

	// Create the merged session with standard structure
	// Matches the pattern from App.tsx createNewSession
	const session: Session = {
		id: sessionId,
		name,
		groupId,
		toolType,
		state: 'idle',
		cwd: projectRoot,
		fullPath: projectRoot,
		projectRoot, // Never changes, used for session storage
		isGitRepo: false, // Will be updated by caller if needed
		aiLogs: [], // Deprecated - logs are in aiTabs
		shellLogs: [
			{
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: 'Merged Context Session Ready.',
			},
		],
		workLog: [],
		contextUsage: 0,
		inputMode: toolType === 'terminal' ? 'terminal' : 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(Math.random() * 100),
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180, // Default: auto-refresh every 3 minutes
		shellCwd: projectRoot,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [mergedTab],
		activeTabId: tabId,
		closedTabHistory: [],
	};

	return { session, tabId };
}

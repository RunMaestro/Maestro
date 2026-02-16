// Tab helper functions for AI multi-tab support
// These helpers manage AITab state within Maestro sessions

import {
	Session,
	AITab,
	ClosedTab,
	ClosedTabEntry,
	FilePreviewTab,
	UnifiedTabRef,
	LogEntry,
	UsageStats,
	ToolType,
	ThinkingMode,
} from '../types';
import { generateId } from './ids';
import { getAutoRunFolderPath } from './existingDocsDetector';

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

/**
 * Attempt to extract a tab name from the user's message using fast client-side
 * pattern matching. This avoids spawning an expensive ephemeral agent for messages
 * that clearly reference a GitHub PR, issue, or similar identifiable resource.
 *
 * @param message - The user's input message
 * @returns A short tab name if a pattern matched, or null to fall back to agent naming
 */
export function extractQuickTabName(message: string): string | null {
	// GitHub PR URL: https://github.com/org/repo/pull/123
	const ghPrUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
	if (ghPrUrl) {
		return `PR #${ghPrUrl[2]}`;
	}

	// GitHub issue URL: https://github.com/org/repo/issues/123
	const ghIssueUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/);
	if (ghIssueUrl) {
		return `Issue #${ghIssueUrl[2]}`;
	}

	// GitHub discussion URL: https://github.com/org/repo/discussions/123
	const ghDiscussionUrl = message.match(/github\.com\/[^/]+\/([^/]+)\/discussions\/(\d+)/);
	if (ghDiscussionUrl) {
		return `Discussion #${ghDiscussionUrl[2]}`;
	}

	// Jira-style ticket: PROJ-1234
	const jiraTicket = message.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
	if (jiraTicket) {
		return jiraTicket[1];
	}

	// Linear-style ticket: PROJ-123 (shorter numbers)
	// Already covered by the Jira pattern above

	// Inline "PR #123" or "pull request #123" (not in a URL)
	const prRef = message.match(/\b(?:PR|pull request)\s*#(\d+)\b/i);
	if (prRef) {
		return `PR #${prRef[1]}`;
	}

	// Inline "issue #123"
	const issueRef = message.match(/\bissue\s*#(\d+)\b/i);
	if (issueRef) {
		return `Issue #${issueRef[1]}`;
	}

	return null;
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
	showThinking?: ThinkingMode; // Thinking display mode: 'off' | 'on' (temporary) | 'sticky' (persistent)
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
		showThinking = 'off',
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
	// Also clear activeFileTabId so the new AI tab is shown in the main panel
	// Add the new tab to unifiedTabOrder so it appears in the unified tab bar
	const newTabRef = { type: 'ai' as const, id: newTab.id };
	const updatedSession: Session = {
		...session,
		aiTabs: [...(session.aiTabs || []), newTab],
		activeTabId: newTab.id,
		activeFileTabId: null,
		unifiedTabOrder: [...(session.unifiedTabOrder || []), newTabRef],
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
		// If we closed the active tab, select the tab to the left (previous tab)
		// If closing the first tab, select the new first tab (was previously to the right)

		if (showUnreadOnly) {
			// When filtering unread tabs, find the previous unread tab to switch to
			// Build a temporary session with the updated tabs to use getNavigableTabs
			const tempSession = { ...session, aiTabs: updatedTabs };
			const navigableTabs = getNavigableTabs(tempSession, true);

			if (navigableTabs.length > 0) {
				// Find the position of the closed tab within the navigable tabs (before removal)
				// Then pick the tab to the left, or the first tab if we were at position 0
				const closedTabNavIndex = getNavigableTabs(session, true).findIndex((t) => t.id === tabId);
				const newNavIndex = Math.max(0, closedTabNavIndex - 1);
				newActiveTabId = navigableTabs[Math.min(newNavIndex, navigableTabs.length - 1)].id;
			} else {
				// No more unread tabs - fall back to selecting by position in full list
				// Select the tab to the left, or first tab if we were at position 0
				const newIndex = Math.max(0, tabIndex - 1);
				newActiveTabId = updatedTabs[newIndex].id;
			}
		} else {
			// Normal mode: select the tab to the left (previous tab)
			// If closing the first tab (index 0), select the new first tab
			const newIndex = Math.max(0, tabIndex - 1);
			newActiveTabId = updatedTabs[newIndex].id;
		}
	}

	// Add to closed tab history unless skipHistory is set (e.g., for wizard tabs)
	// Wizard tabs should not be restorable via Cmd+Shift+T
	const updatedHistory = options.skipHistory
		? session.closedTabHistory || []
		: [closedTab, ...(session.closedTabHistory || [])].slice(0, MAX_CLOSED_TAB_HISTORY);

	// Also remove from unifiedTabOrder to keep AI and file tabs in sync
	const updatedUnifiedTabOrder = (session.unifiedTabOrder || []).filter(
		(ref) => !(ref.type === 'ai' && ref.id === tabId)
	);

	// If we created a fresh tab, add it to unifiedTabOrder at the end
	let finalUnifiedTabOrder = updatedUnifiedTabOrder;
	if (session.aiTabs.length === 1 && updatedTabs.length === 1 && updatedTabs[0].id !== tabId) {
		// A fresh tab was created to replace the closed one
		const freshTabRef: UnifiedTabRef = { type: 'ai', id: updatedTabs[0].id };
		finalUnifiedTabOrder = [...updatedUnifiedTabOrder, freshTabRef];
	}

	// Create updated session
	const updatedSession: Session = {
		...session,
		aiTabs: updatedTabs,
		activeTabId: newActiveTabId,
		closedTabHistory: updatedHistory,
		unifiedTabOrder: finalUnifiedTabOrder,
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
 * Result of closing a file tab - contains the closed tab entry and updated session.
 */
export interface CloseFileTabResult {
	closedTabEntry: ClosedTabEntry; // The closed tab data with unified index
	session: Session; // Updated session with tab removed
}

/**
 * Close a file preview tab and add it to the unified closed tab history.
 * When the closed tab was active, selects the next tab in unifiedTabOrder.
 *
 * @param session - The Maestro session containing the file tab
 * @param tabId - The ID of the file tab to close
 * @returns Object containing the closed tab entry and updated session, or null if tab not found
 *
 * @example
 * const result = closeFileTab(session, 'file-tab-123');
 * if (result) {
 *   const { closedTabEntry, session: updatedSession } = result;
 *   console.log(`Closed file tab at unified index ${closedTabEntry.unifiedIndex}`);
 * }
 */
export function closeFileTab(session: Session, tabId: string): CloseFileTabResult | null {
	if (!session || !session.filePreviewTabs || session.filePreviewTabs.length === 0) {
		return null;
	}

	// Find the tab to close
	const tabToClose = session.filePreviewTabs.find((tab) => tab.id === tabId);
	if (!tabToClose) {
		return null;
	}

	// Find the position in unifiedTabOrder
	const unifiedIndex = session.unifiedTabOrder.findIndex(
		(ref) => ref.type === 'file' && ref.id === tabId
	);

	// Create closed tab entry
	const closedTabEntry: ClosedTabEntry = {
		type: 'file',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : session.unifiedTabOrder.length,
		closedAt: Date.now(),
	};

	// Remove from filePreviewTabs
	const updatedFilePreviewTabs = session.filePreviewTabs.filter((tab) => tab.id !== tabId);

	// Remove from unifiedTabOrder
	const updatedUnifiedTabOrder = session.unifiedTabOrder.filter(
		(ref) => !(ref.type === 'file' && ref.id === tabId)
	);

	// Determine new active tab if we closed the active file tab
	let newActiveFileTabId = session.activeFileTabId;
	let newActiveTabId = session.activeTabId;

	if (session.activeFileTabId === tabId) {
		// This was the active tab - select the tab to the left in unifiedTabOrder
		// If closing the first tab, select the new first tab
		if (updatedUnifiedTabOrder.length > 0 && unifiedIndex !== -1) {
			// Select the tab to the left (previous tab), or first tab if we were at position 0
			const newIndex = Math.max(0, unifiedIndex - 1);
			const nextTabRef = updatedUnifiedTabOrder[newIndex];

			if (nextTabRef.type === 'file') {
				// Previous tab is a file tab
				newActiveFileTabId = nextTabRef.id;
			} else {
				// Previous tab is an AI tab - switch to it
				newActiveTabId = nextTabRef.id;
				newActiveFileTabId = null;
			}
		} else if (updatedUnifiedTabOrder.length > 0) {
			// Fallback: just select the first available tab
			const firstTabRef = updatedUnifiedTabOrder[0];
			if (firstTabRef.type === 'file') {
				newActiveFileTabId = firstTabRef.id;
			} else {
				newActiveTabId = firstTabRef.id;
				newActiveFileTabId = null;
			}
		} else {
			// No tabs left - shouldn't happen as AI tabs should always exist
			newActiveFileTabId = null;
		}
	}

	// Add to unified closed tab history
	const updatedUnifiedHistory = [
		closedTabEntry,
		...(session.unifiedClosedTabHistory || []),
	].slice(0, MAX_CLOSED_TAB_HISTORY);

	return {
		closedTabEntry,
		session: {
			...session,
			filePreviewTabs: updatedFilePreviewTabs,
			unifiedTabOrder: updatedUnifiedTabOrder,
			activeFileTabId: newActiveFileTabId,
			activeTabId: newActiveTabId,
			unifiedClosedTabHistory: updatedUnifiedHistory,
		},
	};
}

/**
 * Add an AI tab to the unified closed tab history.
 * This should be called when closing an AI tab to enable Cmd+Shift+T for all tab types.
 * Note: This only adds to the unified history - the existing closeTab function already
 * handles the legacy closedTabHistory for backwards compatibility.
 *
 * @param session - The Maestro session
 * @param aiTab - The AI tab being closed
 * @param unifiedIndex - The tab's position in unifiedTabOrder
 * @returns Updated session with the tab added to unified history
 */
export function addAiTabToUnifiedHistory(
	session: Session,
	aiTab: AITab,
	unifiedIndex: number
): Session {
	const closedTabEntry: ClosedTabEntry = {
		type: 'ai',
		tab: { ...aiTab },
		unifiedIndex,
		closedAt: Date.now(),
	};

	const updatedUnifiedHistory = [
		closedTabEntry,
		...(session.unifiedClosedTabHistory || []),
	].slice(0, MAX_CLOSED_TAB_HISTORY);

	return {
		...session,
		unifiedClosedTabHistory: updatedUnifiedHistory,
	};
}

/**
 * Result of reopening a tab from unified closed tab history.
 */
export interface ReopenUnifiedClosedTabResult {
	tabType: 'ai' | 'file'; // Type of tab that was reopened
	tabId: string; // ID of the restored or existing tab
	session: Session; // Updated session with tab restored/selected
	wasDuplicate: boolean; // True if we switched to an existing tab instead of restoring
}

/**
 * Reopen the most recently closed tab from the unified closed tab history.
 * Handles both AI tabs and file preview tabs with appropriate duplicate detection:
 * - For AI tabs: checks if a tab with the same agentSessionId already exists
 * - For file tabs: checks if a tab with the same path already exists
 *
 * The tab is restored at its original unified index position if possible.
 * The reopened tab becomes the active tab.
 *
 * @param session - The Maestro session
 * @returns Object containing the reopened tab info and updated session, or null if no closed tabs exist
 *
 * @example
 * const result = reopenUnifiedClosedTab(session);
 * if (result) {
 *   const { tabType, tabId, session: updatedSession, wasDuplicate } = result;
 *   if (wasDuplicate) {
 *     console.log(`Switched to existing ${tabType} tab ${tabId}`);
 *   } else {
 *     console.log(`Restored ${tabType} tab ${tabId} from history`);
 *   }
 * }
 */
export function reopenUnifiedClosedTab(session: Session): ReopenUnifiedClosedTabResult | null {
	// Check if there's anything in the unified history
	if (!session.unifiedClosedTabHistory || session.unifiedClosedTabHistory.length === 0) {
		// Fall back to legacy closedTabHistory for backwards compatibility
		const legacyResult = reopenClosedTab(session);
		if (legacyResult) {
			return {
				tabType: 'ai',
				tabId: legacyResult.tab.id,
				session: legacyResult.session,
				wasDuplicate: legacyResult.wasDuplicate,
			};
		}
		return null;
	}

	// Pop the most recently closed tab from unified history
	const [closedEntry, ...remainingHistory] = session.unifiedClosedTabHistory;

	if (closedEntry.type === 'ai') {
		// Restoring an AI tab
		const tabToRestore = closedEntry.tab;

		// Check for duplicate: does a tab with the same agentSessionId already exist?
		if (tabToRestore.agentSessionId !== null) {
			const existingTab = session.aiTabs.find(
				(tab) => tab.agentSessionId === tabToRestore.agentSessionId
			);

			if (existingTab) {
				// Duplicate found - switch to existing tab instead of restoring
				return {
					tabType: 'ai',
					tabId: existingTab.id,
					session: {
						...session,
						activeTabId: existingTab.id,
						activeFileTabId: null,
						unifiedClosedTabHistory: remainingHistory,
					},
					wasDuplicate: true,
				};
			}
		}

		// No duplicate - restore the tab
		const restoredTab: AITab = {
			...tabToRestore,
			id: generateId(),
		};

		// Calculate insert position in aiTabs based on unified index
		// Find where this tab should go in unifiedTabOrder
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);

		// Count how many AI tabs come before this position
		let aiTabsBeforeIndex = 0;
		for (let i = 0; i < targetUnifiedIndex && i < session.unifiedTabOrder.length; i++) {
			if (session.unifiedTabOrder[i].type === 'ai') {
				aiTabsBeforeIndex++;
			}
		}
		const insertIndex = Math.min(aiTabsBeforeIndex, session.aiTabs.length);

		const updatedAiTabs = [
			...session.aiTabs.slice(0, insertIndex),
			restoredTab,
			...session.aiTabs.slice(insertIndex),
		];

		// Insert into unifiedTabOrder at the original position
		const newTabRef: UnifiedTabRef = { type: 'ai', id: restoredTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'ai',
			tabId: restoredTab.id,
			session: {
				...session,
				aiTabs: updatedAiTabs,
				activeTabId: restoredTab.id,
				activeFileTabId: null,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	} else {
		// Restoring a file tab
		const tabToRestore = closedEntry.tab;

		// Check for duplicate: does a tab with the same path already exist?
		const existingTab = session.filePreviewTabs.find((tab) => tab.path === tabToRestore.path);

		if (existingTab) {
			// Duplicate found - switch to existing tab instead of restoring
			return {
				tabType: 'file',
				tabId: existingTab.id,
				session: {
					...session,
					activeFileTabId: existingTab.id,
					unifiedClosedTabHistory: remainingHistory,
				},
				wasDuplicate: true,
			};
		}

		// No duplicate - restore the tab
		// Reset navigation history to just the current file to avoid stale/corrupted breadcrumbs
		const restoredTab: FilePreviewTab = {
			...tabToRestore,
			id: generateId(),
			// Clear any unsaved edit content since we're restoring from history
			editContent: undefined,
			editMode: false,
			// Reset breadcrumb history - start fresh with just the current file
			navigationHistory: [
				{ path: tabToRestore.path, name: tabToRestore.name, scrollTop: tabToRestore.scrollTop },
			],
			navigationIndex: 0,
		};

		// Add to filePreviewTabs
		const updatedFilePreviewTabs = [...session.filePreviewTabs, restoredTab];

		// Insert into unifiedTabOrder at the original position
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'file', id: restoredTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'file',
			tabId: restoredTab.id,
			session: {
				...session,
				filePreviewTabs: updatedFilePreviewTabs,
				activeFileTabId: restoredTab.id,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	}
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

	// If already active and no file tab is selected, return current state (no mutation needed)
	if (session.activeTabId === tabId && session.activeFileTabId === null) {
		return {
			tab: targetTab,
			session,
		};
	}

	// When selecting an AI tab, deselect any active file preview tab
	// This ensures only one tab type (AI or file) is active at a time
	return {
		tab: targetTab,
		session: {
			...session,
			activeTabId: tabId,
			activeFileTabId: null,
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
 * Result of navigating to a unified tab (can be AI or file tab).
 */
export interface NavigateToUnifiedTabResult {
	type: 'ai' | 'file';
	id: string;
	session: Session;
}

/**
 * Navigate to a tab by its index in the unified tab order.
 * Used for Cmd+1 through Cmd+9 shortcuts to jump to tabs by position.
 * Works with both AI tabs and file preview tabs in the unified tab system.
 *
 * @param session - The Maestro session
 * @param index - The 0-based index in unifiedTabOrder
 * @returns Object with the tab type, id, and updated session, or null if index out of bounds
 *
 * @example
 * // Navigate to the first tab (Cmd+1)
 * const result = navigateToUnifiedTabByIndex(session, 0);
 * if (result) {
 *   if (result.type === 'ai') {
 *     // AI tab - activeTabId is updated, activeFileTabId is cleared
 *   } else {
 *     // File tab - activeFileTabId is updated, activeTabId preserved
 *   }
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToUnifiedTabByIndex(
	session: Session,
	index: number
): NavigateToUnifiedTabResult | null {
	if (!session || !session.unifiedTabOrder || session.unifiedTabOrder.length === 0) {
		return null;
	}

	// Check if index is within bounds
	if (index < 0 || index >= session.unifiedTabOrder.length) {
		return null;
	}

	const targetTabRef = session.unifiedTabOrder[index];

	if (targetTabRef.type === 'ai') {
		// Navigate to AI tab - verify it exists
		const aiTab = session.aiTabs.find((tab) => tab.id === targetTabRef.id);
		if (!aiTab) return null;

		// If already active, return current state
		if (session.activeTabId === targetTabRef.id && session.activeFileTabId === null) {
			return {
				type: 'ai',
				id: targetTabRef.id,
				session,
			};
		}

		// Set the AI tab as active and clear file tab selection
		return {
			type: 'ai',
			id: targetTabRef.id,
			session: {
				...session,
				activeTabId: targetTabRef.id,
				activeFileTabId: null,
			},
		};
	} else {
		// Navigate to file tab - verify it exists
		const fileTab = session.filePreviewTabs.find((tab) => tab.id === targetTabRef.id);
		if (!fileTab) return null;

		// If already active, return current state
		if (session.activeFileTabId === targetTabRef.id) {
			return {
				type: 'file',
				id: targetTabRef.id,
				session,
			};
		}

		// Set the file tab as active (preserve activeTabId for switching back)
		return {
			type: 'file',
			id: targetTabRef.id,
			session: {
				...session,
				activeFileTabId: targetTabRef.id,
			},
		};
	}
}

/**
 * Navigate to the last tab in the unified tab order.
 * Used for Cmd+0 shortcut.
 *
 * @param session - The Maestro session
 * @returns Object with the tab type, id, and updated session, or null if no tabs
 */
export function navigateToLastUnifiedTab(session: Session): NavigateToUnifiedTabResult | null {
	if (!session || !session.unifiedTabOrder || session.unifiedTabOrder.length === 0) {
		return null;
	}

	const lastIndex = session.unifiedTabOrder.length - 1;
	return navigateToUnifiedTabByIndex(session, lastIndex);
}

/**
 * Get the current index in the unified tab order.
 * Returns the index of the currently active tab (file tab if active, otherwise AI tab).
 *
 * @param session - The Maestro session
 * @returns The index in unifiedTabOrder, or -1 if not found
 */
function getCurrentUnifiedTabIndex(session: Session): number {
	if (!session.unifiedTabOrder || session.unifiedTabOrder.length === 0) {
		return -1;
	}

	// If a file tab is active, find it in the unified order
	if (session.activeFileTabId) {
		return session.unifiedTabOrder.findIndex(
			(ref) => ref.type === 'file' && ref.id === session.activeFileTabId
		);
	}

	// Otherwise find the active AI tab
	return session.unifiedTabOrder.findIndex(
		(ref) => ref.type === 'ai' && ref.id === session.activeTabId
	);
}

/**
 * Navigate to the next tab in the unified tab order.
 * Cycles through both AI tabs and file preview tabs in their visual order.
 * Wraps around to the first tab if currently on the last tab.
 *
 * Note: The showUnreadOnly parameter is included for API compatibility but
 * only filters AI tabs - file tabs are always included in navigation.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, skip AI tabs that are not unread and don't have drafts
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 *
 * @example
 * const result = navigateToNextUnifiedTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToNextUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	if (!session || !session.unifiedTabOrder || session.unifiedTabOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session);

	// If current tab not found, go to first tab
	if (currentIndex === -1) {
		return navigateToUnifiedTabByIndex(session, 0);
	}

	// When showUnreadOnly is true, we need to skip AI tabs that are read and have no drafts
	if (showUnreadOnly) {
		const length = session.unifiedTabOrder.length;
		for (let offset = 1; offset < length; offset++) {
			const nextIndex = (currentIndex + offset) % length;
			const tabRef = session.unifiedTabOrder[nextIndex];

			// File tabs are always navigable
			if (tabRef.type === 'file') {
				return navigateToUnifiedTabByIndex(session, nextIndex);
			}

			// For AI tabs, check if it's unread or has a draft
			const aiTab = session.aiTabs.find((t) => t.id === tabRef.id);
			if (aiTab && (aiTab.hasUnread || hasDraft(aiTab))) {
				return navigateToUnifiedTabByIndex(session, nextIndex);
			}
		}
		// No navigable tab found
		return null;
	}

	// Simple case: just go to next tab with wrap-around
	const nextIndex = (currentIndex + 1) % session.unifiedTabOrder.length;
	return navigateToUnifiedTabByIndex(session, nextIndex);
}

/**
 * Navigate to the previous tab in the unified tab order.
 * Cycles through both AI tabs and file preview tabs in their visual order.
 * Wraps around to the last tab if currently on the first tab.
 *
 * Note: The showUnreadOnly parameter is included for API compatibility but
 * only filters AI tabs - file tabs are always included in navigation.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, skip AI tabs that are not unread and don't have drafts
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 *
 * @example
 * const result = navigateToPrevUnifiedTab(session);
 * if (result) {
 *   setSessions(prev => prev.map(s => s.id === session.id ? result.session : s));
 * }
 */
export function navigateToPrevUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	if (!session || !session.unifiedTabOrder || session.unifiedTabOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session);

	// If current tab not found, go to last tab
	if (currentIndex === -1) {
		return navigateToLastUnifiedTab(session);
	}

	// When showUnreadOnly is true, we need to skip AI tabs that are read and have no drafts
	if (showUnreadOnly) {
		const length = session.unifiedTabOrder.length;
		for (let offset = 1; offset < length; offset++) {
			const prevIndex = (currentIndex - offset + length) % length;
			const tabRef = session.unifiedTabOrder[prevIndex];

			// File tabs are always navigable
			if (tabRef.type === 'file') {
				return navigateToUnifiedTabByIndex(session, prevIndex);
			}

			// For AI tabs, check if it's unread or has a draft
			const aiTab = session.aiTabs.find((t) => t.id === tabRef.id);
			if (aiTab && (aiTab.hasUnread || hasDraft(aiTab))) {
				return navigateToUnifiedTabByIndex(session, prevIndex);
			}
		}
		// No navigable tab found
		return null;
	}

	// Simple case: just go to previous tab with wrap-around
	const length = session.unifiedTabOrder.length;
	const prevIndex = (currentIndex - 1 + length) % length;
	return navigateToUnifiedTabByIndex(session, prevIndex);
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
	/** Thinking display mode: 'off' | 'on' (temporary) | 'sticky' (persistent) */
	showThinking?: ThinkingMode;
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
		showThinking = 'off',
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
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tabId }],
		unifiedClosedTabHistory: [],
		// Default Auto Run folder path (user can change later)
		autoRunFolderPath: getAutoRunFolderPath(projectRoot),
	};

	return { session, tabId };
}

// Tab helper functions for AI multi-tab support
// These helpers manage AITab state within Maestro sessions

import {
	Session,
	AITab,
	ClosedTab,
	ClosedTabEntry,
	BrowserTab,
	FilePreviewTab,
	UnifiedTab,
	UnifiedTabRef,
	LogEntry,
	UsageStats,
	ToolType,
	ThinkingMode,
} from '../types';
import { generateId } from './ids';
import { getAutoRunFolderPath } from './existingDocsDetector';
import { createTerminalTab } from './terminalTabHelpers';
import { useSettingsStore } from '../stores/settingsStore';
import { isWindowsPlatform } from './platformUtils';
import { DEFAULT_BROWSER_TAB_URL, getBrowserTabTitle } from './browserTabPersistence';
import { getLiveDraft } from './liveDraftStore';

/**
 * Build the unified tab list from a session's tab data.
 * Follows unifiedTabOrder, then appends any orphaned tabs as a safety net
 * (e.g., from migration or state corruption).
 *
 * Single source of truth — used by useTabHandlers and tabStore selectors.
 */
export function buildUnifiedTabs(session: Session): UnifiedTab[] {
	if (!session) return [];
	const { aiTabs, filePreviewTabs, browserTabs, terminalTabs, unifiedTabOrder } = session;

	const aiTabMap = new Map((aiTabs || []).map((tab) => [tab.id, tab]));
	const fileTabMap = new Map((filePreviewTabs || []).map((tab) => [tab.id, tab]));
	const browserTabMap = new Map((browserTabs || []).map((tab) => [tab.id, tab]));
	const terminalTabMap = new Map((terminalTabs || []).map((tab) => [tab.id, tab]));

	const result: UnifiedTab[] = [];

	// Follow unified order for tabs that have entries
	for (const ref of unifiedTabOrder || []) {
		if (ref.type === 'ai') {
			const tab = aiTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'ai', id: ref.id, data: tab });
				aiTabMap.delete(ref.id);
			}
		} else if (ref.type === 'file') {
			const tab = fileTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'file', id: ref.id, data: tab });
				fileTabMap.delete(ref.id);
			}
		} else if (ref.type === 'browser') {
			const tab = browserTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'browser', id: ref.id, data: tab });
				browserTabMap.delete(ref.id);
			}
		} else {
			const tab = terminalTabMap.get(ref.id);
			if (tab) {
				result.push({ type: 'terminal', id: ref.id, data: tab });
				terminalTabMap.delete(ref.id);
			}
		}
	}

	// Append any orphaned tabs not in unified order (data integrity fallback)
	for (const [id, tab] of aiTabMap) {
		result.push({ type: 'ai', id, data: tab });
	}
	for (const [id, tab] of fileTabMap) {
		result.push({ type: 'file', id, data: tab });
	}
	for (const [id, tab] of browserTabMap) {
		result.push({ type: 'browser', id, data: tab });
	}
	for (const [id, tab] of terminalTabMap) {
		result.push({ type: 'terminal', id, data: tab });
	}

	return result;
}

/**
 * Ensure a tab ID is present in unifiedTabOrder.
 * Returns the order unchanged if already present, or with the tab appended.
 */
export function ensureInUnifiedTabOrder(
	unifiedTabOrder: UnifiedTabRef[],
	type: 'ai' | 'file' | 'browser' | 'terminal',
	id: string
): UnifiedTabRef[] {
	const exists = unifiedTabOrder.some((ref) => ref.type === type && ref.id === id);
	if (exists) return unifiedTabOrder;
	return [...unifiedTabOrder, { type, id }];
}

/**
 * Get a repaired unifiedTabOrder that includes any orphaned tabs.
 * Follows the existing unifiedTabOrder, then appends tabs that exist in
 * aiTabs/filePreviewTabs but are missing from the order.
 *
 * This keeps navigation in sync with rendering (which uses buildUnifiedTabs).
 * Returns the original array unchanged if no orphans are found (no allocation).
 */
export function getRepairedUnifiedTabOrder(session: Session): UnifiedTabRef[] {
	const order = session.unifiedTabOrder || [];
	const aiTabs = session.aiTabs || [];
	const fileTabs = session.filePreviewTabs || [];
	const browserTabs = session.browserTabs || [];
	const terminalTabs = session.terminalTabs || [];

	// Build sets of IDs that actually exist (for pruning stale entries)
	const liveAiIds = new Set(aiTabs.map((t) => t.id));
	const liveFileIds = new Set(fileTabs.map((t) => t.id));
	const liveBrowserIds = new Set(browserTabs.map((t) => t.id));
	const liveTerminalIds = new Set(terminalTabs.map((t) => t.id));

	// Prune stale entries and duplicates — refs whose tabs no longer exist, and
	// later duplicate refs for the same type+id (buildUnifiedTabs also skips both).
	// Without this, navigation indices diverge from the rendered tab bar.
	const seen = new Set<string>();
	const prunedOrder = order.filter((ref) => {
		const key = `${ref.type}:${ref.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		if (ref.type === 'ai') return liveAiIds.has(ref.id);
		if (ref.type === 'file') return liveFileIds.has(ref.id);
		if (ref.type === 'browser') return liveBrowserIds.has(ref.id);
		return liveTerminalIds.has(ref.id);
	});

	// Track which live IDs are already in the pruned order
	const aiIdsInOrder = new Set<string>();
	const fileIdsInOrder = new Set<string>();
	const browserIdsInOrder = new Set<string>();
	const terminalIdsInOrder = new Set<string>();
	for (const ref of prunedOrder) {
		if (ref.type === 'ai') aiIdsInOrder.add(ref.id);
		else if (ref.type === 'file') fileIdsInOrder.add(ref.id);
		else if (ref.type === 'browser') browserIdsInOrder.add(ref.id);
		else terminalIdsInOrder.add(ref.id);
	}

	// Collect orphaned tabs (exist in data but missing from order)
	const orphanedRefs: UnifiedTabRef[] = [];
	for (const tab of aiTabs) {
		if (!aiIdsInOrder.has(tab.id)) {
			orphanedRefs.push({ type: 'ai', id: tab.id });
		}
	}
	for (const tab of fileTabs) {
		if (!fileIdsInOrder.has(tab.id)) {
			orphanedRefs.push({ type: 'file', id: tab.id });
		}
	}
	for (const tab of browserTabs) {
		if (!browserIdsInOrder.has(tab.id)) {
			orphanedRefs.push({ type: 'browser', id: tab.id });
		}
	}
	for (const tab of terminalTabs) {
		if (!terminalIdsInOrder.has(tab.id)) {
			orphanedRefs.push({ type: 'terminal', id: tab.id });
		}
	}

	// Return original if nothing changed (avoids allocation)
	if (prunedOrder.length === order.length && orphanedRefs.length === 0) return order;
	if (orphanedRefs.length === 0) return prunedOrder;
	return [...prunedOrder, ...orphanedRefs];
}

/**
 * Get the initial name to show in the rename modal.
 * Returns empty string if no custom name is set (name is null),
 * or the custom name if user has set one.
 *
 * @param tab - The AI tab being renamed
 * @returns The name to pre-fill in the rename input (empty for auto-generated names)
 */
/**
 * Get the display name for a tab. Strictly per-tab — the title only reflects
 * THIS tab's own state, never another tab's id from the session level.
 *
 * Resolution order:
 *   1. `tab.name` if set (auto-rename or manual rename)
 *   2. `tab.agentSessionId` formatted (e.g. `SES_4BCD`, `THR_ABC1`, first UUID octet)
 *   3. "New Session"
 *
 * The `sessionAgentSessionId` parameter is accepted for signature compatibility
 * but intentionally ignored: borrowing it caused freshly-created sibling tabs
 * to inherit the previously-active tab's id (e.g. multiple OpenCode tabs all
 * displaying the same `SES_XXXX`).
 */
export function getTabDisplayName(tab: AITab, _sessionAgentSessionId?: string | null): string {
	if (tab.name) {
		return tab.name;
	}
	if (tab.agentSessionId) {
		return formatSessionId(tab.agentSessionId);
	}
	return 'New Session';
}

/**
 * Format a session/tab ID into a short display label.
 */
function formatSessionId(id: string): string {
	// OpenCode format: ses_XXXX... or SES_XXXX...
	if (id.toLowerCase().startsWith('ses_')) {
		return `SES_${id.slice(4, 8).toUpperCase()}`;
	}
	// Codex format: thread_XXXX...
	if (id.toLowerCase().startsWith('thread_')) {
		return `THR_${id.slice(7, 11).toUpperCase()}`;
	}
	// UUID format: has dashes, return first octet
	if (id.includes('-')) {
		return id.split('-')[0].toUpperCase();
	}
	// Generic fallback: first 8 chars uppercase
	return id.slice(0, 8).toUpperCase();
}

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
 * Prefers the live textarea value from liveDraftStore (which the active tab
 * keeps current on every keystroke) over `tab.inputValue` (only synced on
 * blur/submit). This keeps the draft indicator and close confirmation in
 * sync with what's actually on screen.
 *
 * @param tab - The AI tab to check
 * @returns True if the tab has unsent text input or staged images
 */
export function hasDraft(tab: AITab): boolean {
	const liveValue = getLiveDraft(tab.id);
	const text = liveValue !== undefined ? liveValue : (tab.inputValue ?? '');
	return text.trim() !== '' || (tab.stagedImages && tab.stagedImages.length > 0);
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
 * Check if a tab's active wizard has any user interaction.
 * Returns true if the user has sent messages, typed input, or staged images.
 * Used to decide whether closing the wizard should show a confirmation dialog.
 *
 * @param tab - The AI tab to check
 * @returns True if the wizard has user interaction worth confirming loss of
 */
export function hasWizardInteraction(tab: AITab): boolean {
	if (!tab.wizardState?.isActive) return false;
	const hasUserMessages =
		tab.wizardState.conversationHistory?.some((m) => m.role === 'user') ?? false;
	const hasInput = (tab.inputValue ?? '').trim() !== '';
	const hasImages = tab.stagedImages?.length > 0;
	return hasUserMessages || hasInput || hasImages;
}

/**
 * Filter a unified tab order down to the refs that TabBar actually displays when the
 * "unread only" tab filter is active. Matches TabBar.tsx's displayedUnifiedTabs logic so
 * keyboard jump shortcuts (Cmd+1..9, Cmd+0) stay aligned with the rendered tab strip.
 *
 * AI tabs pass if they're unread, busy, the active AI tab (in AI mode), have a draft, or
 * are starred (when that setting is on). File tabs pass only when the file-preview setting
 * is enabled. Terminal and browser tabs always pass (no unread semantics to filter on).
 *
 * @param session - The Maestro session supplying activeTabId / inputMode / aiTabs
 * @param order   - Unified tab order to filter (typically getRepairedUnifiedTabOrder(session))
 * @returns Filtered UnifiedTabRef[] in the same relative order
 */
export function filterUnifiedTabOrderForUnread(
	session: Session,
	order: UnifiedTabRef[]
): UnifiedTabRef[] {
	const settings = useSettingsStore.getState();
	const showStarred = settings.showStarredInUnreadFilter;
	const showFilePreviews = settings.showFilePreviewsInUnreadFilter;
	const inputMode = session.inputMode ?? 'ai';
	const activeTabId = session.activeTabId ?? null;

	return order.filter((ref) => {
		if (ref.type === 'ai') {
			const tab = session.aiTabs.find((t) => t.id === ref.id);
			if (!tab) return false;
			return (
				tab.hasUnread ||
				tab.state === 'busy' ||
				(inputMode === 'ai' && tab.id === activeTabId) ||
				hasDraft(tab) ||
				(showStarred && !!tab.starred)
			);
		}
		if (ref.type === 'file') return showFilePreviews;
		return true;
	});
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
		const showStarred = useSettingsStore.getState().showStarredInUnreadFilter;
		return session.aiTabs.filter(
			(tab) =>
				tab.hasUnread || tab.state === 'busy' || hasDraft(tab) || (showStarred && tab.starred)
		);
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

	// Update the session with the new tab added and set as active.
	// Clear activeFileTabId and activeTerminalTabId so the new AI tab is shown in the
	// main panel, and set inputMode to 'ai' so callers don't need to patch it manually.
	// Add the new tab to unifiedTabOrder so it appears in the unified tab bar.
	const newTabRef = { type: 'ai' as const, id: newTab.id };
	const updatedSession: Session = {
		...session,
		aiTabs: [...(session.aiTabs || []), newTab],
		activeTabId: newTab.id,
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		inputMode: 'ai' as const,
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
 *   logger.info(`Closed tab at index ${closedTab.index}`);
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
	// Fallback unified tab ref when the closed tab was active — may be terminal or file
	let fallbackRef: UnifiedTabRef | null = null;
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
			// Normal mode: use repaired unifiedTabOrder to find the correct left neighbor.
			// This respects the visual tab order which includes terminal and file tabs —
			// without this, closing an AI tab that sits to the right of a terminal tab
			// would fall back to a random AI tab instead of the adjacent terminal tab.
			// We use getRepairedUnifiedTabOrder to skip stale/duplicate refs (same as rendering).
			const unifiedOrder = getRepairedUnifiedTabOrder(session);
			const closedUnifiedIndex = unifiedOrder.findIndex(
				(ref) => ref.type === 'ai' && ref.id === tabId
			);
			const remainingUnified = unifiedOrder.filter(
				(ref) => !(ref.type === 'ai' && ref.id === tabId)
			);
			if (closedUnifiedIndex !== -1 && remainingUnified.length > 0) {
				const fallbackIndex = Math.max(0, closedUnifiedIndex - 1);
				fallbackRef = remainingUnified[Math.min(fallbackIndex, remainingUnified.length - 1)];
			} else {
				// unifiedTabOrder out of sync — fall back to aiTabs position
				const newIndex = Math.max(0, tabIndex - 1);
				newActiveTabId = updatedTabs[newIndex].id;
			}
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

	// Create updated session.
	// When the fallback is a non-AI tab (terminal or file), we must update the corresponding
	// active ID and inputMode so the UI switches to the correct view.
	const updatedSession: Session =
		fallbackRef?.type === 'terminal'
			? {
					...session,
					aiTabs: updatedTabs,
					// Keep activeTabId as-is; the terminal tab is now active
					activeTerminalTabId: fallbackRef.id,
					activeFileTabId: null,
					inputMode: 'terminal',
					closedTabHistory: updatedHistory,
					unifiedTabOrder: finalUnifiedTabOrder,
				}
			: fallbackRef?.type === 'file'
				? {
						...session,
						aiTabs: updatedTabs,
						activeFileTabId: fallbackRef.id,
						activeBrowserTabId: null,
						activeTerminalTabId: null,
						inputMode: 'ai',
						closedTabHistory: updatedHistory,
						unifiedTabOrder: finalUnifiedTabOrder,
					}
				: fallbackRef?.type === 'browser'
					? {
							...session,
							aiTabs: updatedTabs,
							activeFileTabId: null,
							activeBrowserTabId: fallbackRef.id,
							activeTerminalTabId: null,
							inputMode: 'ai',
							closedTabHistory: updatedHistory,
							unifiedTabOrder: finalUnifiedTabOrder,
						}
					: fallbackRef?.type === 'ai'
						? {
								...session,
								aiTabs: updatedTabs,
								activeTabId: fallbackRef.id,
								activeFileTabId: null,
								activeBrowserTabId: null,
								activeTerminalTabId: null,
								inputMode: 'ai',
								closedTabHistory: updatedHistory,
								unifiedTabOrder: finalUnifiedTabOrder,
							}
						: {
								...session,
								aiTabs: updatedTabs,
								activeTabId: newActiveTabId,
								closedTabHistory: updatedHistory,
								unifiedTabOrder: finalUnifiedTabOrder,
							};

	// If the closed tab was busy and no remaining tabs are busy, clean up
	// session-level busy state. The background process may still be running,
	// but the UI should not show a busy indicator for a tab that no longer exists.
	const closedTabWasBusy = tabToClose.state === 'busy';
	const anyRemainingTabBusy = updatedTabs.some((tab) => tab.state === 'busy');
	const finalSession =
		closedTabWasBusy && !anyRemainingTabBusy && updatedSession.busySource === 'ai'
			? {
					...updatedSession,
					state: 'idle' as const,
					busySource: undefined,
					thinkingStartTime: undefined,
				}
			: updatedSession;

	return {
		closedTab,
		session: finalSession,
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
 *     logger.info(`Switched to existing tab ${tab.id}`);
 *   } else {
 *     logger.info(`Restored tab ${tab.id} from history`);
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
					unifiedTabOrder: ensureInUnifiedTabOrder(
						session.unifiedTabOrder || [],
						'ai',
						existingTab.id
					),
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
			unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder || [], 'ai', restoredTab.id),
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
 *   logger.info(`Closed file tab at unified index ${closedTabEntry.unifiedIndex}`);
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

	// Use repaired order to skip stale/duplicate refs (same as rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);

	// Find the position in the repaired unifiedTabOrder
	const unifiedIndex = repairedOrder.findIndex((ref) => ref.type === 'file' && ref.id === tabId);

	// Create closed tab entry
	const closedTabEntry: ClosedTabEntry = {
		type: 'file',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : repairedOrder.length,
		closedAt: Date.now(),
	};

	// Remove from filePreviewTabs
	const updatedFilePreviewTabs = session.filePreviewTabs.filter((tab) => tab.id !== tabId);

	// Remove from unifiedTabOrder (filter from repaired order to persist the fix)
	const updatedUnifiedTabOrder = repairedOrder.filter(
		(ref) => !(ref.type === 'file' && ref.id === tabId)
	);

	// Determine new active tab if we closed the active file tab
	let newActiveFileTabId = session.activeFileTabId;
	let newActiveBrowserTabId = session.activeBrowserTabId;
	let newActiveTerminalTabId = session.activeTerminalTabId;
	let newActiveTabId = session.activeTabId;
	let newInputMode = session.inputMode;

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
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (nextTabRef.type === 'browser') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = nextTabRef.id;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (nextTabRef.type === 'terminal') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = nextTabRef.id;
				newInputMode = 'terminal';
			} else {
				// Previous tab is an AI tab - switch to it
				newActiveTabId = nextTabRef.id;
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			}
		} else if (updatedUnifiedTabOrder.length > 0) {
			// Fallback: just select the first available tab
			const firstTabRef = updatedUnifiedTabOrder[0];
			if (firstTabRef.type === 'file') {
				newActiveFileTabId = firstTabRef.id;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (firstTabRef.type === 'browser') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = firstTabRef.id;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			} else if (firstTabRef.type === 'terminal') {
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = firstTabRef.id;
				newInputMode = 'terminal';
			} else {
				newActiveTabId = firstTabRef.id;
				newActiveFileTabId = null;
				newActiveBrowserTabId = null;
				newActiveTerminalTabId = null;
				newInputMode = 'ai';
			}
		} else {
			// No tabs left - shouldn't happen as AI tabs should always exist
			newActiveFileTabId = null;
			newActiveBrowserTabId = null;
			newActiveTerminalTabId = null;
			newInputMode = 'ai';
		}
	}

	// Add to unified closed tab history
	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		closedTabEntry,
		session: {
			...session,
			filePreviewTabs: updatedFilePreviewTabs,
			unifiedTabOrder: updatedUnifiedTabOrder,
			activeFileTabId: newActiveFileTabId,
			activeBrowserTabId: newActiveBrowserTabId,
			activeTerminalTabId: newActiveTerminalTabId,
			activeTabId: newActiveTabId,
			inputMode: newInputMode,
			unifiedClosedTabHistory: updatedUnifiedHistory,
		},
	};
}

export interface CloseBrowserTabResult {
	closedTabEntry: ClosedTabEntry;
	session: Session;
}

export function closeBrowserTab(session: Session, tabId: string): CloseBrowserTabResult | null {
	if (!session || !session.browserTabs || session.browserTabs.length === 0) {
		return null;
	}

	const tabToClose = session.browserTabs.find((tab) => tab.id === tabId);
	if (!tabToClose) {
		return null;
	}

	const repairedOrder = getRepairedUnifiedTabOrder(session);
	const unifiedIndex = repairedOrder.findIndex((ref) => ref.type === 'browser' && ref.id === tabId);
	const closedTabEntry: ClosedTabEntry = {
		type: 'browser',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : repairedOrder.length,
		closedAt: Date.now(),
	};

	const updatedBrowserTabs = session.browserTabs.filter((tab) => tab.id !== tabId);
	const updatedUnifiedTabOrder = repairedOrder.filter(
		(ref) => !(ref.type === 'browser' && ref.id === tabId)
	);

	let nextActiveTabId = session.activeTabId;
	let nextActiveFileTabId = session.activeFileTabId;
	let nextActiveBrowserTabId = session.activeBrowserTabId;
	let nextActiveTerminalTabId = session.activeTerminalTabId;
	let nextInputMode = session.inputMode;

	if (session.activeBrowserTabId === tabId) {
		const fallbackRef =
			updatedUnifiedTabOrder.length > 0 && unifiedIndex !== -1
				? updatedUnifiedTabOrder[Math.max(0, unifiedIndex - 1)]
				: (updatedUnifiedTabOrder[0] ?? null);

		nextActiveBrowserTabId = null;
		if (fallbackRef?.type === 'ai') {
			nextActiveTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'file') {
			nextActiveFileTabId = fallbackRef.id;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'browser') {
			nextActiveBrowserTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextActiveTerminalTabId = null;
			nextInputMode = 'ai';
		} else if (fallbackRef?.type === 'terminal') {
			nextActiveTerminalTabId = fallbackRef.id;
			nextActiveFileTabId = null;
			nextInputMode = 'terminal';
		}
	}

	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		closedTabEntry,
		session: {
			...session,
			browserTabs: updatedBrowserTabs,
			unifiedTabOrder: updatedUnifiedTabOrder,
			activeTabId: nextActiveTabId,
			activeFileTabId: nextActiveFileTabId,
			activeBrowserTabId: nextActiveBrowserTabId,
			activeTerminalTabId: nextActiveTerminalTabId,
			inputMode: nextInputMode,
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

	const updatedUnifiedHistory = [closedTabEntry, ...(session.unifiedClosedTabHistory || [])].slice(
		0,
		MAX_CLOSED_TAB_HISTORY
	);

	return {
		...session,
		unifiedClosedTabHistory: updatedUnifiedHistory,
	};
}

/**
 * Result of reopening a tab from unified closed tab history.
 */
export interface ReopenUnifiedClosedTabResult {
	tabType: 'ai' | 'file' | 'browser' | 'terminal'; // Type of tab that was reopened
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
 *     logger.info(`Switched to existing ${tabType} tab ${tabId}`);
 *   } else {
 *     logger.info(`Restored ${tabType} tab ${tabId} from history`);
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
						unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder, 'ai', existingTab.id),
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
	} else if (closedEntry.type === 'file') {
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
					activeBrowserTabId: null,
					unifiedTabOrder: ensureInUnifiedTabOrder(session.unifiedTabOrder, 'file', existingTab.id),
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
				activeBrowserTabId: null,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	} else if (closedEntry.type === 'browser') {
		const closedBrowserTab = closedEntry.tab as BrowserTab;
		const restoredTab: BrowserTab = {
			...closedBrowserTab,
			id: generateId(),
			url: closedBrowserTab.url || DEFAULT_BROWSER_TAB_URL,
			title: getBrowserTabTitle(
				closedBrowserTab.url || DEFAULT_BROWSER_TAB_URL,
				closedBrowserTab.title
			),
			webContentsId: undefined,
		};

		const updatedBrowserTabs = [...(session.browserTabs || []), restoredTab];
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'browser', id: restoredTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'browser',
			tabId: restoredTab.id,
			session: {
				...session,
				browserTabs: updatedBrowserTabs,
				activeBrowserTabId: restoredTab.id,
				activeFileTabId: null,
				activeTabId: session.activeTabId,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
			},
			wasDuplicate: false,
		};
	} else {
		// Terminal tab restore — create a fresh terminal tab (old PTY is gone, can't restore)
		const closedTerminalTab = closedEntry.tab;
		const freshTab = createTerminalTab(
			closedTerminalTab.shellType,
			closedTerminalTab.cwd,
			closedTerminalTab.name
		);

		// Insert into unifiedTabOrder at the original position
		const targetUnifiedIndex = Math.min(closedEntry.unifiedIndex, session.unifiedTabOrder.length);
		const newTabRef: UnifiedTabRef = { type: 'terminal', id: freshTab.id };
		const updatedUnifiedTabOrder = [
			...session.unifiedTabOrder.slice(0, targetUnifiedIndex),
			newTabRef,
			...session.unifiedTabOrder.slice(targetUnifiedIndex),
		];

		return {
			tabType: 'terminal',
			tabId: freshTab.id,
			session: {
				...session,
				terminalTabs: [...(session.terminalTabs || []), freshTab],
				activeTerminalTabId: freshTab.id,
				unifiedTabOrder: updatedUnifiedTabOrder,
				unifiedClosedTabHistory: remainingHistory,
				inputMode: 'terminal',
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
 *   logger.info(`Now viewing tab: ${tab.name || tab.agentSessionId}`);
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

	// If already active, no file/terminal tab is selected, and already in AI mode, return current state
	if (
		session.activeTabId === tabId &&
		session.activeFileTabId === null &&
		session.activeBrowserTabId === null &&
		session.activeTerminalTabId === null &&
		session.inputMode === 'ai'
	) {
		return {
			tab: targetTab,
			session,
		};
	}

	// When selecting an AI tab, deselect any active file/terminal tab and switch to AI mode.
	// This ensures only one tab type (AI, file, or terminal) is active at a time, and
	// switching from terminal mode back to AI mode works by clicking any AI tab.
	// Clearing activeTerminalTabId is critical — getCurrentUnifiedTabIndex checks it first,
	// so a stale value causes next/prev tab navigation to start from the wrong position.
	return {
		tab: targetTab,
		session: {
			...session,
			activeTabId: tabId,
			activeFileTabId: null,
			activeBrowserTabId: null,
			activeTerminalTabId: null,
			inputMode: 'ai' as const,
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
 *   logger.info(`Tab ${busyTab.name || busyTab.agentSessionId} is currently writing`);
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
 *     logger.info(`Tab ${tab.name || tab.agentSessionId} is busy`);
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
	type: 'ai' | 'file' | 'browser' | 'terminal';
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
	index: number,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order that includes any orphaned tabs (keeps navigation
	// consistent with what buildUnifiedTabs renders in the tab bar)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length === 0) {
		return null;
	}

	// When the unread filter is active, index into the filtered order so Cmd+N matches
	// the Nth tab the user actually sees in the tab bar.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;

	// Check if index is within bounds
	if (index < 0 || index >= effectiveOrder.length) {
		return null;
	}

	const targetTabRef = effectiveOrder[index];
	// If orphans were repaired, persist the fix in the returned session
	const repairedSession =
		repairedOrder !== session.unifiedTabOrder
			? { ...session, unifiedTabOrder: repairedOrder }
			: session;

	if (targetTabRef.type === 'ai') {
		// Navigate to AI tab - verify it exists
		const aiTab = session.aiTabs.find((tab) => tab.id === targetTabRef.id);
		if (!aiTab) return null;

		// If already active, no file/terminal tab selected, and in AI mode, return current state.
		// The activeTerminalTabId check is critical: without it, a stale terminal selection
		// causes the early return to fire and skip the clearing update below, leaving
		// getCurrentUnifiedTabIndex pointing at the wrong tab.
		if (
			session.activeTabId === targetTabRef.id &&
			session.activeFileTabId === null &&
			session.activeTerminalTabId === null &&
			session.inputMode === 'ai'
		) {
			return {
				type: 'ai',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		// Set the AI tab as active, clear terminal/file selection, and ensure inputMode is 'ai'.
		// inputMode must be explicitly set because navigating from a terminal tab leaves inputMode
		// as 'terminal' in the spread — without this, MainPanel would continue rendering the
		// terminal view even though an AI tab is now active.
		return {
			type: 'ai',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeTabId: targetTabRef.id,
				activeFileTabId: null,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
			},
		};
	} else if (targetTabRef.type === 'file') {
		// Navigate to file tab - verify it exists
		const fileTab = session.filePreviewTabs.find((tab) => tab.id === targetTabRef.id);
		if (!fileTab) return null;

		// If already active and in AI mode, return current state (with repair if needed)
		if (session.activeFileTabId === targetTabRef.id && session.inputMode === 'ai') {
			return {
				type: 'file',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		// Set the file tab as active and ensure inputMode is 'ai' (file preview is shown in
		// non-terminal mode; without this, navigating from a terminal tab would leave the
		// terminal visible instead of showing the file preview).
		return {
			type: 'file',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeFileTabId: targetTabRef.id,
				activeBrowserTabId: null,
				activeTerminalTabId: null,
				inputMode: 'ai',
			},
		};
	} else if (targetTabRef.type === 'browser') {
		const browserTab = (session.browserTabs || []).find((tab) => tab.id === targetTabRef.id);
		if (!browserTab) return null;

		if (session.activeBrowserTabId === targetTabRef.id && session.inputMode === 'ai') {
			return {
				type: 'browser',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		return {
			type: 'browser',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeFileTabId: null,
				activeBrowserTabId: targetTabRef.id,
				activeTerminalTabId: null,
				inputMode: 'ai',
			},
		};
	} else {
		// Terminal tab — verify it exists and activate it
		const terminalTab = (session.terminalTabs || []).find((tab) => tab.id === targetTabRef.id);
		if (!terminalTab) return null;

		// If already active, return current state (with repair if needed)
		if (session.activeTerminalTabId === targetTabRef.id) {
			return {
				type: 'terminal',
				id: targetTabRef.id,
				session: repairedSession,
			};
		}

		return {
			type: 'terminal',
			id: targetTabRef.id,
			session: {
				...repairedSession,
				activeTerminalTabId: targetTabRef.id,
				activeFileTabId: null,
				activeBrowserTabId: null,
				inputMode: 'terminal',
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
export function navigateToLastUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are reachable via Cmd+0
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length === 0) {
		return null;
	}

	// When unread filter is active, "last" means the last tab currently shown in the tab bar.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;

	// Find the last valid tab, skipping orphaned entries
	for (let i = effectiveOrder.length - 1; i >= 0; i--) {
		const result = navigateToUnifiedTabByIndex(session, i, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Get the current index in the unified tab order.
 * Returns the index of the currently active tab (file tab if active, otherwise AI tab).
 *
 * @param session - The Maestro session
 * @returns The index in unifiedTabOrder, or -1 if not found
 */
function getCurrentUnifiedTabIndex(session: Session, effectiveOrder?: UnifiedTabRef[]): number {
	const order = effectiveOrder || getRepairedUnifiedTabOrder(session);
	if (order.length === 0) {
		return -1;
	}

	// If a terminal tab is active, find it in the unified order
	if (session.activeTerminalTabId) {
		return order.findIndex(
			(ref) => ref.type === 'terminal' && ref.id === session.activeTerminalTabId
		);
	}

	// If a file tab is active, find it in the unified order
	if (session.activeFileTabId) {
		return order.findIndex((ref) => ref.type === 'file' && ref.id === session.activeFileTabId);
	}

	if (session.activeBrowserTabId) {
		return order.findIndex(
			(ref) => ref.type === 'browser' && ref.id === session.activeBrowserTabId
		);
	}

	// Otherwise find the active AI tab
	return order.findIndex((ref) => ref.type === 'ai' && ref.id === session.activeTabId);
}

/**
 * Navigate to the next tab in the unified tab order.
 * Cycles through AI, file, terminal, and browser tabs in their visual order with wrap-around.
 *
 * When showUnreadOnly is true, walks within the same filtered list TabBar renders
 * (via filterUnifiedTabOrderForUnread) so keyboard navigation and display never diverge.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, cycle only through tabs visible under the unread filter
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 */
export function navigateToNextUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are included (consistent with tab bar rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length < 2) {
		return null;
	}

	// When the unread filter is on, walk within the exact list TabBar renders — the shared
	// filter is the single source of truth so navigation and display can never drift.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;
	if (effectiveOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	const length = effectiveOrder.length;

	// If current tab isn't in the visible list, land on the first visible tab
	if (currentIndex === -1) {
		return navigateToUnifiedTabByIndex(session, 0, showUnreadOnly);
	}

	for (let offset = 1; offset < length; offset++) {
		const nextIndex = (currentIndex + offset) % length;
		const result = navigateToUnifiedTabByIndex(session, nextIndex, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Navigate to the previous tab in the unified tab order.
 * Cycles through AI, file, terminal, and browser tabs in their visual order with wrap-around.
 *
 * When showUnreadOnly is true, walks within the same filtered list TabBar renders
 * (via filterUnifiedTabOrderForUnread) so keyboard navigation and display never diverge.
 *
 * @param session - The Maestro session
 * @param showUnreadOnly - If true, cycle only through tabs visible under the unread filter
 * @returns Object with the tab type, id, and updated session, or null if no navigation possible
 */
export function navigateToPrevUnifiedTab(
	session: Session,
	showUnreadOnly = false
): NavigateToUnifiedTabResult | null {
	// Use repaired order so orphaned tabs are included (consistent with tab bar rendering)
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	if (!session || repairedOrder.length < 2) {
		return null;
	}

	// When the unread filter is on, walk within the exact list TabBar renders — the shared
	// filter is the single source of truth so navigation and display can never drift.
	const effectiveOrder = showUnreadOnly
		? filterUnifiedTabOrderForUnread(session, repairedOrder)
		: repairedOrder;
	if (effectiveOrder.length < 2) {
		return null;
	}

	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	const length = effectiveOrder.length;

	// If current tab isn't in the visible list, land on the last visible tab
	if (currentIndex === -1) {
		return navigateToUnifiedTabByIndex(session, length - 1, showUnreadOnly);
	}

	for (let offset = 1; offset < length; offset++) {
		const prevIndex = (currentIndex - offset + length) % length;
		const result = navigateToUnifiedTabByIndex(session, prevIndex, showUnreadOnly);
		if (result) return result;
	}
	return null;
}

/**
 * Navigate to the closest terminal tab in the unified tab order.
 * Searches outward from the current position, alternating right then left.
 * If no current tab is found, returns the first terminal tab.
 *
 * @param session - The Maestro session
 * @returns Object with the tab type, id, and updated session, or null if no terminal tabs exist
 */
export function navigateToClosestTerminalTab(session: Session): NavigateToUnifiedTabResult | null {
	const effectiveOrder = getRepairedUnifiedTabOrder(session);
	if (!session || effectiveOrder.length === 0) return null;

	// Find all terminal tab indices
	const terminalIndices: number[] = [];
	for (let i = 0; i < effectiveOrder.length; i++) {
		if (effectiveOrder[i].type === 'terminal') {
			terminalIndices.push(i);
		}
	}
	if (terminalIndices.length === 0) return null;

	// If already on a terminal tab, cycle to the next terminal tab (wrapping around)
	const currentIndex = getCurrentUnifiedTabIndex(session, effectiveOrder);
	if (currentIndex >= 0 && effectiveOrder[currentIndex]?.type === 'terminal') {
		if (terminalIndices.length === 1) {
			return navigateToUnifiedTabByIndex(session, currentIndex);
		}
		const currentPos = terminalIndices.indexOf(currentIndex);
		const nextPos = (currentPos + 1) % terminalIndices.length;
		return navigateToUnifiedTabByIndex(session, terminalIndices[nextPos]);
	}

	// Find closest terminal tab by distance from current position
	if (currentIndex >= 0) {
		let closest = terminalIndices[0];
		let minDist = Math.abs(currentIndex - closest);
		for (let i = 1; i < terminalIndices.length; i++) {
			const dist = Math.abs(currentIndex - terminalIndices[i]);
			if (dist < minDist) {
				minDist = dist;
				closest = terminalIndices[i];
			}
		}
		return navigateToUnifiedTabByIndex(session, closest);
	}

	// Fallback: navigate to first terminal tab
	return navigateToUnifiedTabByIndex(session, terminalIndices[0]);
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
	const initialMergeTerminalTab = createTerminalTab(
		useSettingsStore.getState().defaultShell || (isWindowsPlatform() ? 'powershell' : 'zsh'),
		projectRoot,
		null
	);
	const session: Session = {
		id: sessionId,
		name,
		groupId,
		toolType,
		state: 'idle',
		cwd: projectRoot,
		fullPath: projectRoot,
		projectRoot, // Never changes, used for session storage
		createdAt: Date.now(),
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
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [initialMergeTerminalTab],
		activeTerminalTabId: null,
		unifiedTabOrder: [
			{ type: 'ai' as const, id: tabId },
			{ type: 'terminal' as const, id: initialMergeTerminalTab.id },
		],
		unifiedClosedTabHistory: [],
		// Default Auto Run folder path (user can change later)
		autoRunFolderPath: getAutoRunFolderPath(projectRoot),
	};

	return { session, tabId };
}

/**
 * Result of goToNextUnreadTab navigation.
 * - `jumped`: true if we switched to a different session
 * - `clearedCurrent`: true if we cleared the current session's unread tabs
 * - `targetSessionId`: the session ID we jumped to (if jumped)
 * - `targetTabId`: the tab ID to activate in the target session (if jumped)
 */
export interface GoToNextUnreadResult {
	jumped: boolean;
	clearedCurrent: boolean;
	targetSessionId?: string;
	targetTabId?: string;
}

/**
 * Compute the next unread session to jump to (relative to the current session
 * in the ordered session list), and return instructions for the caller to apply.
 *
 * Does NOT mutate state — the caller applies the result via setSessions/setActiveSessionId.
 */
export function findNextUnreadSession(
	orderedSessions: Session[],
	activeSessionId: string
): GoToNextUnreadResult {
	const currentIndex = orderedSessions.findIndex((s) => s.id === activeSessionId);
	const currentSession = orderedSessions.find((s) => s.id === activeSessionId);
	const isActionable = (tab: AITab) => tab.hasUnread || hasDraft(tab);
	const currentHasUnread = currentSession?.aiTabs?.some(isActionable) ?? false;

	// Search forward from current position, wrapping around
	for (let i = 1; i <= orderedSessions.length; i++) {
		const candidate = orderedSessions[(currentIndex + i) % orderedSessions.length];
		if (candidate.id !== activeSessionId && candidate.aiTabs?.some(isActionable)) {
			const firstUnreadTab = candidate.aiTabs.find(isActionable);
			return {
				jumped: true,
				clearedCurrent: currentHasUnread,
				targetSessionId: candidate.id,
				targetTabId: firstUnreadTab?.id !== candidate.activeTabId ? firstUnreadTab?.id : undefined,
			};
		}
	}

	// No other session has unread tabs
	return {
		jumped: false,
		clearedCurrent: currentHasUnread,
	};
}

import { useMemo } from 'react';
import type { Session, Group } from '../types';
import type { InboxItem, InboxFilterMode, InboxSortMode } from '../types/agent-inbox';

const MAX_MESSAGE_LENGTH = 250;
const DEFAULT_MESSAGE = 'No activity yet';

/**
 * Determines whether a session/tab combination should be included
 * based on the current filter mode.
 */
function matchesFilter(
	sessionState: Session['state'],
	hasUnread: boolean,
	filterMode: InboxFilterMode,
	isStarred: boolean
): boolean {
	switch (filterMode) {
		case 'all':
			return true;
		case 'unread':
			return hasUnread === true;
		case 'read':
			return hasUnread === false && (sessionState === 'idle' || sessionState === 'waiting_input');
		case 'starred':
			return isStarred === true;
		default:
			return false;
	}
}

/**
 * Computes a display name for a tab.
 * Uses tab.name if set, otherwise falls back to "Tab N".
 */
function getTabDisplayName(
	tab: { name: string | null; agentSessionId: string | null; id: string },
	tabIndex: number
): string {
	if (tab.name) return tab.name;
	return `Tab ${tabIndex + 1}`;
}

/**
 * Truncates text to MAX_MESSAGE_LENGTH with ellipsis.
 */
export function truncate(text: string): string {
	if (text.length <= MAX_MESSAGE_LENGTH) return text;
	return text.slice(0, MAX_MESSAGE_LENGTH) + '...';
}

/**
 * Extracts the first sentence from text (up to the first period, exclamation, or newline).
 */
function firstSentence(text: string): string {
	const match = text.match(/^[^.!?\n]+[.!?]?/);
	return match ? match[0].trim() : text.trim();
}

/**
 * Generates a 1-line smart summary from a tab's logs and session state.
 *
 * Rules:
 * - waiting_input: "Waiting: " + last AI message snippet
 * - Last AI message ends with "?": show the question directly
 * - Last AI message is a statement: "Done: " + first sentence
 * - Empty logs: "No activity yet"
 */
export function generateSmartSummary(
	logs: Session['aiLogs'] | undefined,
	sessionState: Session['state']
): string {
	const safeLogs = logs ?? [];
	if (safeLogs.length === 0) return DEFAULT_MESSAGE;

	// Look at the last 3 entries to find the most recent AI message
	const recentLogs = safeLogs.slice(-3);
	let lastAiText: string | undefined;
	for (let i = recentLogs.length - 1; i >= 0; i--) {
		const entry = recentLogs[i];
		if (!entry?.text) continue;
		if (entry.source === 'ai') {
			lastAiText = entry.text.trim();
			break;
		}
	}

	// If session is waiting for input, prefix with "Waiting: "
	if (sessionState === 'waiting_input') {
		if (lastAiText) return truncate('Waiting: ' + lastAiText);
		return truncate('Waiting: awaiting your response');
	}

	// If we found an AI message
	if (lastAiText) {
		// If it ends with a question mark, show the question directly
		if (lastAiText.endsWith('?')) return truncate(lastAiText);
		// Statement — prefix with "Done: " + first sentence
		return truncate('Done: ' + firstSentence(lastAiText));
	}

	// Fallback: use last log entry text regardless of source
	const lastLog = safeLogs[safeLogs.length - 1];
	if (lastLog?.text) return truncate(lastLog.text);

	return DEFAULT_MESSAGE;
}

/**
 * Derives a valid timestamp from available data.
 * Falls back through: last log entry → tab createdAt → Date.now()
 */
function deriveTimestamp(logs: Session['aiLogs'] | undefined, tabCreatedAt: number): number {
	// Try last log entry timestamp
	if (logs && logs.length > 0) {
		const lastTs = logs[logs.length - 1]?.timestamp;
		if (lastTs && Number.isFinite(lastTs) && lastTs > 0) return lastTs;
	}
	// Try tab createdAt
	if (Number.isFinite(tabCreatedAt) && tabCreatedAt > 0) return tabCreatedAt;
	// Fallback
	return Date.now();
}

/**
 * Sorts InboxItems based on the selected sort mode.
 */
function sortItems(items: InboxItem[], sortMode: InboxSortMode): InboxItem[] {
	const sorted = [...items];
	switch (sortMode) {
		case 'newest':
			sorted.sort((a, b) => b.timestamp - a.timestamp);
			break;
		case 'oldest':
			sorted.sort((a, b) => a.timestamp - b.timestamp);
			break;
		case 'grouped':
			sorted.sort((a, b) => {
				// Ungrouped (no groupName) goes last
				const aGroup = a.groupName ?? '\uffff';
				const bGroup = b.groupName ?? '\uffff';
				const groupCompare = aGroup.localeCompare(bGroup);
				if (groupCompare !== 0) return groupCompare;
				// Within same group, sort by timestamp descending
				return b.timestamp - a.timestamp;
			});
			break;
		case 'byAgent': {
			// Step 1: Group items by sessionName
			const agentGroups = new Map<string, InboxItem[]>();
			for (const item of sorted) {
				const key = item.sessionName;
				if (!agentGroups.has(key)) agentGroups.set(key, []);
				agentGroups.get(key)!.push(item);
			}

			// Step 2: Pre-compute metadata per group
			const groupMeta: { key: string; unreadCount: number; items: InboxItem[] }[] = [];
			for (const [key, groupItems] of agentGroups) {
				const unreadCount = groupItems.filter((i) => i.hasUnread).length;
				// Sort items within group: newest first
				groupItems.sort((a, b) => b.timestamp - a.timestamp);
				groupMeta.push({ key, unreadCount, items: groupItems });
			}

			// Step 3: Sort groups — unreads first (by count desc), then zero-unreads (alphabetical)
			groupMeta.sort((a, b) => {
				if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
				if (a.unreadCount === 0 && b.unreadCount > 0) return 1;
				if (a.unreadCount > 0 && b.unreadCount > 0) return b.unreadCount - a.unreadCount;
				return a.key.localeCompare(b.key);
			});

			// Step 4: Flatten back
			sorted.length = 0;
			for (const group of groupMeta) {
				sorted.push(...group.items);
			}
			break;
		}
	}
	return sorted;
}

/**
 * Data aggregation hook for Agent Inbox.
 *
 * Iterates all sessions and their AI tabs, filters based on session state
 * and tab unread status, then sorts the resulting InboxItems.
 *
 * Uses useMemo with exact dependency values (not refs) to prevent stale data.
 */
export function useAgentInbox(
	sessions: Session[],
	groups: Group[],
	filterMode: InboxFilterMode,
	sortMode: InboxSortMode
): InboxItem[] {
	return useMemo(() => {
		// Build group lookup map for O(1) access
		const groupMap = new Map<string, Group>();
		for (const group of groups) {
			groupMap.set(group.id, group);
		}

		const items: InboxItem[] = [];

		for (const session of sessions) {
			// Skip sessions with falsy id
			if (!session.id) continue;

			const tabs = session.aiTabs ?? [];

			for (let tabIdx = 0; tabIdx < tabs.length; tabIdx++) {
				const tab = tabs[tabIdx];
				const hasUnread = tab.hasUnread === true;

				if (!matchesFilter(session.state, hasUnread, filterMode, tab.starred === true)) continue;

				const parentGroup = session.groupId ? groupMap.get(session.groupId) : undefined;

				items.push({
					sessionId: session.id,
					tabId: tab.id,
					groupId: session.groupId ?? undefined,
					groupName: parentGroup?.name ?? undefined,
					sessionName: session.name,
					tabName: tabs.length > 1 ? getTabDisplayName(tab, tabIdx) : undefined,
					toolType: session.toolType,
					gitBranch: session.worktreeBranch ?? undefined,
					contextUsage: session.contextUsage ?? undefined,
					lastMessage: generateSmartSummary(tab.logs, session.state),
					timestamp: deriveTimestamp(tab.logs, tab.createdAt),
					state: session.state,
					hasUnread,
					starred: tab.starred === true,
				});
			}
		}

		return sortItems(items, sortMode);
	}, [sessions, groups, filterMode, sortMode]);
}

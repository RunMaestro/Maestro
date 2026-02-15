import { useMemo } from 'react'
import type { Session, Group } from '../types'
import type { InboxItem, InboxFilterMode, InboxSortMode } from '../types/agent-inbox'

const MAX_MESSAGE_LENGTH = 90
const DEFAULT_MESSAGE = 'No messages yet'

/**
 * Determines whether a session/tab combination should be included
 * based on the current filter mode.
 */
function matchesFilter(
	sessionState: Session['state'],
	hasUnread: boolean,
	filterMode: InboxFilterMode
): boolean {
	switch (filterMode) {
		case 'all':
			return hasUnread || sessionState === 'waiting_input' || sessionState === 'idle'
		case 'needs_input':
			return sessionState === 'waiting_input'
		case 'ready':
			return sessionState === 'idle' && hasUnread
		default:
			return false
	}
}

/**
 * Extracts last message text from a tab's logs, truncated to MAX_MESSAGE_LENGTH.
 */
function extractLastMessage(logs: Session['aiLogs'] | undefined): string {
	if (!logs || logs.length === 0) return DEFAULT_MESSAGE
	const lastLog = logs[logs.length - 1]
	if (!lastLog?.text) return DEFAULT_MESSAGE
	const text = lastLog.text
	if (text.length <= MAX_MESSAGE_LENGTH) return text
	return text.slice(0, MAX_MESSAGE_LENGTH) + '...'
}

/**
 * Derives a valid timestamp from available data.
 * Falls back through: last log entry → tab createdAt → Date.now()
 */
function deriveTimestamp(
	logs: Session['aiLogs'] | undefined,
	tabCreatedAt: number
): number {
	// Try last log entry timestamp
	if (logs && logs.length > 0) {
		const lastTs = logs[logs.length - 1]?.timestamp
		if (lastTs && Number.isFinite(lastTs) && lastTs > 0) return lastTs
	}
	// Try tab createdAt
	if (Number.isFinite(tabCreatedAt) && tabCreatedAt > 0) return tabCreatedAt
	// Fallback
	return Date.now()
}

/**
 * Sorts InboxItems based on the selected sort mode.
 */
function sortItems(items: InboxItem[], sortMode: InboxSortMode): InboxItem[] {
	const sorted = [...items]
	switch (sortMode) {
		case 'newest':
			sorted.sort((a, b) => b.timestamp - a.timestamp)
			break
		case 'oldest':
			sorted.sort((a, b) => a.timestamp - b.timestamp)
			break
		case 'grouped':
			sorted.sort((a, b) => {
				// Ungrouped (no groupName) goes last
				const aGroup = a.groupName ?? '\uffff'
				const bGroup = b.groupName ?? '\uffff'
				const groupCompare = aGroup.localeCompare(bGroup)
				if (groupCompare !== 0) return groupCompare
				// Within same group, sort by timestamp descending
				return b.timestamp - a.timestamp
			})
			break
	}
	return sorted
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
		const groupMap = new Map<string, Group>()
		for (const group of groups) {
			groupMap.set(group.id, group)
		}

		const items: InboxItem[] = []

		for (const session of sessions) {
			// Skip sessions with falsy id
			if (!session.id) continue

			const tabs = session.aiTabs ?? []

			for (const tab of tabs) {
				const hasUnread = tab.hasUnread === true

				if (!matchesFilter(session.state, hasUnread, filterMode)) continue

				const parentGroup = session.groupId ? groupMap.get(session.groupId) : undefined

				items.push({
					sessionId: session.id,
					tabId: tab.id,
					groupId: session.groupId ?? undefined,
					groupName: parentGroup?.name ?? undefined,
					sessionName: session.name,
					toolType: session.toolType,
					gitBranch: session.worktreeBranch ?? undefined,
					contextUsage: session.contextUsage ?? undefined,
					lastMessage: extractLastMessage(tab.logs),
					timestamp: deriveTimestamp(tab.logs, tab.createdAt),
					state: session.state,
					hasUnread,
				})
			}
		}

		return sortItems(items, sortMode)
	}, [sessions, groups, filterMode, sortMode])
}

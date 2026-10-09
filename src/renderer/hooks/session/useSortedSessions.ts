import { useMemo } from 'react';
import type { Session, Group } from '../../types';
import { stripLeadingEmojis, compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { computeSortedSessions, type SortedSessionsProjection } from './computeSortedSessions';

// Re-export for backwards compatibility with existing imports
export { stripLeadingEmojis, compareNamesIgnoringEmojis };
export type { SortedSessionsProjection };

/**
 * Dependencies for the useSortedSessions hook.
 * Prefer {@link computeSortedSessions} + {@link useSidebarNavStore} for new code.
 */
export interface UseSortedSessionsDeps {
	sessions: Session[];
	groups: Group[];
	bookmarksCollapsed: boolean;
	/**
	 * When true, visibleSessions excludes agents that don't need attention (and
	 * whose worktree children likewise don't). The active session (or its parent)
	 * is always kept visible so the user doesn't lose their place. Uses the same
	 * `sessionNeedsAttention` predicate as useSessionCategories so jump numbers
	 * and Alt+Cmd+N shortcuts match the rendered list.
	 */
	showUnreadAgentsOnly?: boolean;
	activeSessionId?: string | null;
	/** Agent ids auto-running an Auto Run playbook (the AUTO badge). */
	activeBatchSessionIds?: string[];
	/** Agent ids stuck auto-retrying an Agent Resilience outage. */
	stuckOutageSessionIds?: string[];
}

/** @deprecated Prefer SortedSessionsProjection from computeSortedSessions */
export type UseSortedSessionsReturn = SortedSessionsProjection;

/**
 * React wrapper around {@link computeSortedSessions}.
 * Left Bar consumers should read {@link useSidebarNavStore} instead; App no
 * longer mounts this hook.
 */
export function useSortedSessions(deps: UseSortedSessionsDeps): SortedSessionsProjection {
	const { sessions, groups, bookmarksCollapsed, showUnreadAgentsOnly, activeSessionId } = deps;

	return useMemo(
		() =>
			computeSortedSessions({
				sessions,
				groups,
				bookmarksCollapsed,
				showUnreadAgentsOnly,
				activeSessionId,
			}),
		[sessions, groups, bookmarksCollapsed, showUnreadAgentsOnly, activeSessionId]
	);
}

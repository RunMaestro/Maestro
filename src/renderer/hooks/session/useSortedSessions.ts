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
	showUnreadAgentsOnly?: boolean;
	activeSessionId?: string | null;
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

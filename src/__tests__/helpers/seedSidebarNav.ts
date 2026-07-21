/**
 * Seed / reset {@link useSidebarNavStore} for Left Bar tests.
 *
 * SessionList no longer takes sorted/starred as required props; tests that used
 * to pass those must publish them into the store (or compute from sessions).
 */

import type { Group, Session } from '../../renderer/types';
import type { StarredItem } from '../../renderer/hooks/session/useStarredItems';
import { computeSortedSessions } from '../../renderer/hooks/session/computeSortedSessions';
import { useSidebarNavStore } from '../../renderer/stores/sidebarNavStore';
import { useUIStore } from '../../renderer/stores/uiStore';

type ActivateStarred = (item: StarredItem) => void | Promise<void>;

/** Direct projection seed (unit tests that build sorted lists by hand). */
export interface SeedSidebarNavProjection {
	sortedSessions?: Session[];
	visibleSessions?: Session[];
	navSessions?: Session[];
	bookmarkNavSize?: number;
	navIndexMap?: Map<string, number>;
	starredItems?: StarredItem[];
	/** Optional mock; overrides the store's real activateStarredItem for assertions. */
	activateStarredItem?: ActivateStarred;
}

/** Compute projection from sessions (integration harnesses). */
export interface SeedSidebarNavFromSessions {
	sessions: Session[];
	groups?: Group[];
	activeSessionId?: string | null;
	bookmarksCollapsed?: boolean;
	showUnreadAgentsOnly?: boolean;
	activeBatchSessionIds?: string[];
	stuckOutageSessionIds?: string[];
	starredItems?: StarredItem[];
	activateStarredItem?: ActivateStarred;
}

export type SeedSidebarNavInput = SeedSidebarNavProjection | SeedSidebarNavFromSessions;

function isFromSessions(input: SeedSidebarNavInput): input is SeedSidebarNavFromSessions {
	return 'sessions' in input && Array.isArray(input.sessions);
}

/**
 * Write Left Bar nav / starred slices into sidebarNavStore.
 */
export function seedSidebarNav(input: SeedSidebarNavInput): void {
	if (isFromSessions(input)) {
		const ui = useUIStore.getState();
		const projection = computeSortedSessions({
			sessions: input.sessions,
			groups: input.groups ?? [],
			bookmarksCollapsed: input.bookmarksCollapsed ?? ui.bookmarksCollapsed,
			showUnreadAgentsOnly: input.showUnreadAgentsOnly ?? ui.showUnreadAgentsOnly,
			activeSessionId: input.activeSessionId,
			activeBatchSessionIds: input.activeBatchSessionIds,
			stuckOutageSessionIds: input.stuckOutageSessionIds,
		});
		useSidebarNavStore.setState({
			...projection,
			...(input.starredItems !== undefined ? { starredItems: input.starredItems } : {}),
			...(input.activateStarredItem
				? {
						activateStarredItem: input.activateStarredItem as (item: StarredItem) => Promise<void>,
					}
				: {}),
		});
		return;
	}

	const sorted = input.sortedSessions ?? [];
	useSidebarNavStore.setState({
		sortedSessions: sorted,
		visibleSessions: input.visibleSessions ?? sorted,
		navSessions: input.navSessions ?? sorted,
		bookmarkNavSize: input.bookmarkNavSize ?? 0,
		navIndexMap: input.navIndexMap ?? new Map(),
		starredItems: input.starredItems ?? [],
		...(input.activateStarredItem
			? {
					activateStarredItem: input.activateStarredItem as (item: StarredItem) => Promise<void>,
				}
			: {}),
	});
}

/** Restore sidebarNavStore to its module initial state (replace). */
export function resetSidebarNavStore(): void {
	useSidebarNavStore.setState(useSidebarNavStore.getInitialState(), true);
}

/**
 * SidebarNavSync - always-mounted host that owns Left Bar sort/nav/starred
 * subscriptions and writes {@link useSidebarNavStore}.
 *
 * Memoized with no props so MaestroConsoleInner re-renders do not re-run this
 * body; only its own store subscriptions wake it.
 */

import { memo, useCallback, useLayoutEffect, useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { useSidebarNavStore } from '../../stores/sidebarNavStore';
import { sidebarSessionEquality } from '../../stores/sessionEquality';
import { computeSortedSessions } from './computeSortedSessions';
import { useStarredItems } from './useStarredItems';
import { useWindowContextOptional } from '../../contexts/WindowContext';
import { scopeSessionsToOwningWindow } from '../../utils/windowTargets';

function SidebarNavSyncInner() {
	const windowCtx = useWindowContextOptional();
	const ownsSession = windowCtx?.ownsSession;

	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		sidebarSessionEquality
	);
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const showUnreadAgentsOnly = useUIStore((s) => s.showUnreadAgentsOnly);

	const setSortedProjection = useSidebarNavStore((s) => s.setSortedProjection);
	const setStarredItems = useSidebarNavStore((s) => s.setStarredItems);

	// Same window scope SessionList applies so keyboard / unread / cycle read the
	// agents this window actually shows (primary catch-all / secondary claimed).
	const sessionsForWindow = useMemo(
		() => scopeSessionsToOwningWindow(sessions, ownsSession),
		[sessions, ownsSession]
	);

	// useLayoutEffect (not useEffect): publish before paint and before parent
	// passive effects so the first committed frame and same-tick nav commands
	// see the current projection instead of the store's empty/previous one.
	useLayoutEffect(() => {
		setSortedProjection(
			computeSortedSessions({
				sessions: sessionsForWindow,
				groups,
				bookmarksCollapsed,
				showUnreadAgentsOnly,
				activeSessionId,
			})
		);
	}, [
		sessionsForWindow,
		groups,
		bookmarksCollapsed,
		showUnreadAgentsOnly,
		activeSessionId,
		setSortedProjection,
	]);

	// Event-time handlers - do not subscribe to sidebarNavStore jump/confirm
	// fields (those update when App re-registers and would wake this host).
	const onJumpToStarredSession = useCallback(
		(
			agentId: string,
			projectPath: string,
			agentSessionId: string,
			sessionName: string,
			parentSessionId: string
		) => {
			const fn = useSidebarNavStore.getState().onJumpToStarredSession;
			return fn
				? fn(agentId, projectPath, agentSessionId, sessionName, parentSessionId)
				: Promise.resolve(false);
		},
		[]
	);
	const showConfirmation = useCallback((message: string, onConfirm: () => void | Promise<void>) => {
		useSidebarNavStore.getState().showConfirmation?.(message, onConfirm);
	}, []);

	// Star list still uses the hook (async named-session load + star signature).
	// Results are mirrored into the store for SessionList / cycle / keyboard.
	const { starredItems } = useStarredItems({
		onJumpToStarredSession,
		showConfirmation,
		ownsSession,
	});

	useLayoutEffect(() => {
		setStarredItems(starredItems);
	}, [starredItems, setStarredItems]);

	return null;
}

export const SidebarNavSync = memo(SidebarNavSyncInner);

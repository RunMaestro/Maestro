/**
 * useStarredItems - single source of truth for the Left Bar "Starred Sessions"
 * section.
 *
 * Previously the starred list (open starred AI tabs + closed/named starred
 * sessions loaded async from disk) and its activation handler were computed
 * locally inside SessionList.tsx. Keyboard navigation lives in App.tsx and
 * could not see that list, so Cmd+[ / Cmd+] cycling skipped starred sessions
 * entirely. Lifting it here lets the render (SessionList) and the cycle
 * (cycleSession / useCycleSession) consume one owner.
 *
 * Reads sessions + showStarredSessionsSection directly from the stores; takes
 * the cross-agent jump + confirmation primitives (which originate in App) as
 * deps.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { updateSessionWith } from '../../stores/sessionStore';
import { getTabDisplayName } from '../../utils/tabHelpers';
import {
	notifyStarredSessionsChanged,
	onStarredSessionsChanged,
} from '../../utils/starredSessions';
import { captureException } from '../../utils/sentry';

// ============================================================================
// Types
// ============================================================================

/**
 * A single row in the "Starred Sessions" section. `open` rows are starred AI
 * tabs of currently-loaded agents (activation just focuses the tab). `closed`
 * rows are starred named sessions on disk whose conversation is not open
 * (activation resumes them against their owning agent, and may have aged out).
 */
export type StarredItem =
	| {
			kind: 'open';
			key: string;
			displayName: string;
			agentName: string;
			parentSessionId: string;
			tabId: string;
	  }
	| {
			kind: 'closed';
			key: string;
			displayName: string;
			agentName: string;
			parentSessionId: string;
			agentId: string;
			agentSessionId: string;
			projectPath: string;
			sessionName: string;
	  };

export interface UseStarredItemsDeps {
	/**
	 * Jump to a closed/named starred session, switching to its owning agent and
	 * resuming. Resolves to `false` when the conversation has aged out so we can
	 * offer to remove the now-dangling star.
	 */
	onJumpToStarredSession?: (
		agentId: string,
		projectPath: string,
		agentSessionId: string,
		sessionName: string,
		parentSessionId: string
	) => Promise<boolean>;
	/** Confirmation dialog used to offer removing an aged-out star. */
	showConfirmation?: (message: string, onConfirm: () => void | Promise<void>) => void;
	/**
	 * Multi-window: restrict the Starred section to agents THIS window owns, keyed
	 * on each item's `parentSessionId` (the owning agent). So each window's Starred
	 * list - and the Cmd+[/] cycling that shares this list - reflects only the
	 * agents visible in it. Omitted / returns true outside a WindowProvider
	 * (single-window app, web, isolation tests), leaving the list unscoped.
	 */
	ownsSession?: (sessionId: string) => boolean;
}

export interface UseStarredItemsReturn {
	/** Combined open + closed starred rows, sorted by display name. */
	starredItems: StarredItem[];
	/** Activate a starred row (focus its tab, or resume a closed session). */
	activateStarredItem: (item: StarredItem) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

export function useStarredItems(deps: UseStarredItemsDeps): UseStarredItemsReturn {
	const { onJumpToStarredSession, showConfirmation, ownsSession } = deps;

	// PERF: Star/open-tab signature only - streaming log/token flushes must not wake
	// App via this hook. List builders read sessions at memo/event time via getState().
	const starredOpenSignature = useSessionStore((s) =>
		s.sessions
			.map((sess) => {
				const tabs = (sess.aiTabs ?? [])
					.map(
						(t) => `${t.id}:${t.starred ? 1 : 0}:${t.agentSessionId ?? ''}:${getTabDisplayName(t)}`
					)
					.join(',');
				return `${sess.id}|${sess.name}|${sess.toolType}|${sess.projectRoot}|${tabs}`;
			})
			.join('\n')
	);
	const sessionCount = useSessionStore((s) => s.sessions.length);
	const showStarredSessionsSection = useSettingsStore((s) => s.showStarredSessionsSection);

	// Closed/named starred sessions are loaded lazily from disk (the parent agent
	// may not even be open). Cached here and refreshed when the agent list changes
	// or any star toggles, so the section stays in sync without a reload.
	const [starredNamedSessions, setStarredNamedSessions] = useState<
		Array<{
			agentId: string;
			agentSessionId: string;
			projectPath: string;
			sessionName: string;
			lastActivityAt?: number;
		}>
	>([]);

	const loadStarredNamedSessions = useCallback(async () => {
		if (!showStarredSessionsSection) return;
		try {
			const all = await window.maestro.agentSessions.getAllNamedSessions();
			setStarredNamedSessions(
				all
					.filter((s) => s.starred === true)
					.map((s) => ({
						agentId: s.agentId,
						agentSessionId: s.agentSessionId,
						projectPath: s.projectPath,
						sessionName: s.sessionName,
						lastActivityAt: s.lastActivityAt,
					}))
			);
		} catch (err) {
			captureException(err, { extra: { context: 'useStarredItems.loadStarredNamedSessions' } });
		}
	}, [showStarredSessionsSection]);

	// Refresh the closed/named cache when the agent count changes (a new session
	// may have been starred) and whenever any star toggles anywhere in the app
	// (so unstarring removes the row immediately instead of leaving a stale
	// closed twin behind).
	useEffect(() => {
		void loadStarredNamedSessions();
	}, [loadStarredNamedSessions, sessionCount]);
	useEffect(
		() => onStarredSessionsChanged(() => void loadStarredNamedSessions()),
		[loadStarredNamedSessions]
	);

	// Combine open starred AI tabs with closed starred named sessions into the
	// flat list rendered by the "Starred Sessions" Left Bar section.
	const starredItems = useMemo<StarredItem[]>(() => {
		if (!showStarredSessionsSection) return [];
		const sessions = useSessionStore.getState().sessions;
		const items: StarredItem[] = [];
		// Suppress a closed/named row whenever its conversation is already open as a
		// tab, regardless of that tab's star state. Tracking every open tab's
		// agentSessionId (not just starred ones) prevents a restored session from
		// rendering twice - once as the open tab and once as its lingering closed
		// twin - which is the duplication seen when restoring an aged-out star.
		const openAgentSessionIds = new Set<string>();
		for (const s of sessions) {
			if (!s.aiTabs) continue;
			for (const t of s.aiTabs) {
				if (t.agentSessionId) openAgentSessionIds.add(t.agentSessionId);
				if (!t.starred) continue;
				items.push({
					kind: 'open',
					key: `open:${s.id}:${t.id}`,
					displayName: getTabDisplayName(t),
					agentName: s.name,
					parentSessionId: s.id,
					tabId: t.id,
				});
			}
		}
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
		for (const closed of starredNamedSessions) {
			if (openAgentSessionIds.has(closed.agentSessionId)) continue;
			const parent = sessions.find(
				(s) => s.toolType === closed.agentId && norm(s.projectRoot) === norm(closed.projectPath)
			);
			if (!parent) continue;
			items.push({
				kind: 'closed',
				key: `closed:${parent.id}:${closed.agentSessionId}`,
				displayName: closed.sessionName,
				agentName: parent.name,
				parentSessionId: parent.id,
				agentId: closed.agentId,
				agentSessionId: closed.agentSessionId,
				projectPath: closed.projectPath,
				sessionName: closed.sessionName,
			});
		}
		// Multi-window: keep only starred rows whose owning agent (parentSessionId)
		// belongs to this window. `ownsSession` is null-safe true outside a
		// WindowProvider, so the single-window list is unchanged.
		const scoped = ownsSession ? items.filter((i) => ownsSession(i.parentSessionId)) : items;
		scoped.sort((a, b) => a.displayName.localeCompare(b.displayName));
		return scoped;
		// starredOpenSignature pins star/open-tab fields without a full sessions[] sub.
	}, [showStarredSessionsSection, starredOpenSignature, starredNamedSessions, ownsSession]);

	const activateStarredItem = useCallback(
		async (item: StarredItem) => {
			// Dismiss any active group chat first. App gates the group chat view on a
			// truthy activeGroupChatId and renders it on top of the session view, so
			// setting activeSessionId alone leaves the group chat covering everything
			// and the click appears to do nothing. Agent-row clicks clear it via a
			// wrapper (SessionList); mirror that here so both the open (early-return)
			// and closed paths navigate out of group chat. See issue #1175.
			useGroupChatStore.getState().setActiveGroupChatId(null);
			useSessionStore.getState().setActiveSessionId(item.parentSessionId);
			if (item.kind === 'open') {
				updateSessionWith(item.parentSessionId, (s) => ({
					...s,
					activeTabId: item.tabId,
					activeFileTabId: null,
					activeTerminalTabId: null,
					activeBrowserTabId: null,
					inputMode: 'ai',
				}));
				return;
			}
			// Closed session: ask the owning agent to resume it. If it can't be
			// loaded the conversation has aged out (no longer on disk), so offer to
			// remove the now-dangling star instead of silently doing nothing.
			const opened = await onJumpToStarredSession?.(
				item.agentId,
				item.projectPath,
				item.agentSessionId,
				item.sessionName,
				item.parentSessionId
			);
			if (opened === false) {
				showConfirmation?.(
					`"${item.sessionName}" is no longer available. It has aged out and its conversation could not be loaded. Remove the star?`,
					async () => {
						await window.maestro.agentSessions.setSessionStarred(
							item.agentId,
							item.projectPath,
							item.agentSessionId,
							false
						);
						// Drop it from the local list so the section updates immediately,
						// and broadcast so any other starred views refresh too.
						setStarredNamedSessions((prev) =>
							prev.filter(
								(s) =>
									!(
										s.agentId === item.agentId &&
										s.agentSessionId === item.agentSessionId &&
										s.projectPath === item.projectPath
									)
							)
						);
						notifyStarredSessionsChanged();
					}
				);
			}
		},
		[onJumpToStarredSession, showConfirmation]
	);

	return { starredItems, activateStarredItem };
}

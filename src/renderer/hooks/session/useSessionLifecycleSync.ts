/**
 * useSessionLifecycleSync.ts
 *
 * Keeps this renderer's agent list in step with the other clients.
 *
 * Every client - each desktop window and every web-desktop browser tab - runs
 * its own copy of the renderer with its own session tree, and each of them
 * flushes that tree back into the one shared sessions store. Nothing reconciled
 * them, so an agent created in the browser stayed invisible to the desktop, and
 * an agent CLOSED in the browser came back the moment the desktop's stale copy
 * went dirty and was merged in again (issues #1398 / #1492).
 *
 * The main process now reports what entered and left the store
 * (`sessions:lifecycleSync`); this hook applies that delta locally. It is
 * deliberately LIFECYCLE ONLY - agents appearing and disappearing, and AI tabs
 * closed inside an agent both clients hold - and does not try to merge a peer's
 * edits into an agent. Tab contents, read-state and queued messages still belong
 * to whichever client wrote last; syncing those needs a per-field model this
 * delta can't express.
 *
 * No feedback loop: applying a removal makes this client's next flush report the
 * same id in `removeIds`, but by then the store no longer has it, so main sends
 * nothing back. Applying an addition likewise re-persists an agent the store
 * already holds, which is an update rather than an add. A peer's tab close is
 * reported again by this client's next flush, and every other client already
 * closed that tab, so applying it there is a no-op.
 */

import { useEffect } from 'react';
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { closeTab } from '../../utils/tabHelpers';
import type { ClosedSessionTab } from '../../../shared/sessionTabChanges';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

export interface SessionLifecycleSyncPayload {
	added?: Session[];
	removedIds?: string[];
	closedTabs?: ClosedSessionTab[];
}

/**
 * Close the AI tabs a peer closed, in the agents this client still holds.
 *
 * Without this the tab stays on screen here, and this client's next flush of
 * the agent would carry it straight back to disk (main now refuses that, but the
 * user would still be looking at a tab that no longer exists anywhere else).
 * Goes through the same `closeTab` the remote close path uses, so the active
 * tab, unified order and a still-running turn are handled exactly as for a
 * local close. `preserveTabScopedWork`: the client that closed the tab already
 * told main it was gone, so main has nothing left to retire on our behalf.
 */
function applyClosedTabs(closedTabs: ClosedSessionTab[] | undefined): number {
	if (!closedTabs?.length) return 0;
	const bySession = new Map<string, string[]>();
	for (const { sessionId, tabId } of closedTabs) {
		if (!sessionId || !tabId) continue;
		bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), tabId]);
	}
	let closedCount = 0;
	useSessionStore.getState().setSessions((prev) => {
		let changed = false;
		const next = prev.map((session) => {
			const tabIds = bySession.get(session.id);
			if (!tabIds) return session;
			let updated = session;
			for (const tabId of tabIds) {
				// Filtered against this client's own tree: the push also reaches the
				// client that closed the tab, which no longer has it.
				if (!updated.aiTabs?.some((tab) => tab.id === tabId)) continue;
				const result = closeTab(updated, tabId, undefined, { preserveTabScopedWork: true });
				if (!result) continue;
				updated = result.session;
				closedCount += 1;
			}
			if (updated !== session) changed = true;
			return updated;
		});
		return changed ? next : prev;
	});
	return closedCount;
}

/**
 * Resolves once the startup load has put its sessions in the store.
 *
 * A delta that lands mid-load would be undone by it: the load ends in a single
 * `setSessions(restoredSessions)` that replaces the whole array, so an agent
 * added here vanishes again and one removed here comes back - and a resurrected
 * agent is then flushed back to disk, which is the exact bug this hook exists to
 * stop. Waiting costs nothing on the common path, where the load finished long
 * before any peer wrote.
 */
function whenSessionsLoaded(): Promise<void> {
	if (useSessionStore.getState().initialLoadComplete) return Promise.resolve();
	return new Promise((resolve) => {
		const unsubscribe = useSessionStore.subscribe((state) => {
			if (!state.initialLoadComplete) return;
			unsubscribe();
			resolve();
		});
	});
}

/**
 * @param restoreSession - the same migration/runtime-reset pass the startup load
 *   runs, so an agent arriving from a peer is prepared exactly like one read
 *   from disk (no busy state left over, no missing migrated fields).
 * @param reattachLiveTurns - the startup probe that asks main what it is
 *   actually running. An agent arriving from a peer is very often mid-turn (that
 *   is what made the user create it), and `restoreSession` resets every agent to
 *   idle, so without this it lands with an idle dot and no thinking pill while
 *   its transcript fills in.
 */
export function useSessionLifecycleSync(
	restoreSession: (session: Session) => Promise<Session>,
	reattachLiveTurns?: () => void | Promise<void>
): void {
	useEffect(() => {
		const api = window.maestro?.sessions;
		if (!api?.onLifecycleSync) return;

		let disposed = false;
		// Deltas apply strictly in arrival order. Each one suspends twice (waiting
		// for the startup load, then restoring the incoming agents), and letting
		// them overlap loses the ordering that gives them their meaning: an add
		// for X still restoring when a close for X arrives makes the close look
		// like it names an agent this client never had, and the add then commits
		// the agent the user just closed.
		let queue: Promise<void> = Promise.resolve();

		const applyDelta = async (payload: SessionLifecycleSyncPayload): Promise<void> => {
			await whenSessionsLoaded();
			if (disposed) return;

			const known = new Set(useSessionStore.getState().sessions.map((s) => s.id));
			// Both directions are filtered against what this client actually has:
			// the push reaches the client that wrote it too (the web bridge has no
			// per-client identity), and re-adding or re-removing would be churn.
			const removedIds = (payload.removedIds ?? []).filter((id) => known.has(id));
			const incoming = (payload.added ?? []).filter((s) => s?.id && !known.has(s.id));
			const closedTabCount = applyClosedTabs(payload.closedTabs);
			if (closedTabCount > 0) {
				logger.debug(`Applied ${closedTabCount} AI tab close(s) from a peer`, 'Sessions');
			}
			if (removedIds.length === 0 && incoming.length === 0) return;

			const restored = await Promise.all(incoming.map((s) => restoreSession(s)));
			if (disposed) return;

			const removeSet = new Set(removedIds);
			useSessionStore.getState().setSessions((prev) => {
				const kept = prev.filter((s) => !removeSet.has(s.id));
				// Re-check against the live list: the await above gives the local UI
				// room to have created or closed something in the meantime.
				const present = new Set(kept.map((s) => s.id));
				const additions = restored.filter((s) => !present.has(s.id));
				if (kept.length === prev.length && additions.length === 0) return prev;
				return [...kept, ...additions];
			});

			// The agent this client was looking at may be the one that closed.
			// Re-point at whatever is left, exactly as the local delete path does.
			const { activeSessionId, sessions } = useSessionStore.getState();
			if (removeSet.has(activeSessionId)) {
				useSessionStore.getState().setActiveSessionId(sessions[0]?.id ?? '');
			}

			// Put the busy indicators on anything that arrived mid-turn. Not
			// awaited: an agent painted idle for one frame before correcting
			// itself beats holding the list update on an IPC round trip.
			if (restored.length > 0) void reattachLiveTurns?.();

			logger.debug(
				`Applied peer session lifecycle delta: +${restored.length} / -${removedIds.length}`,
				'Sessions'
			);
		};

		const unsubscribe = api.onLifecycleSync((payload: SessionLifecycleSyncPayload) => {
			// Report a failed delta but keep the chain alive: it is what preserves
			// arrival order for every delta behind it, and a rejected link would
			// silently stop this client following its peers for the rest of the run.
			queue = queue
				.then(() => applyDelta(payload))
				.catch((err) => {
					captureException(err instanceof Error ? err : new Error(String(err)), {
						extra: { operation: 'useSessionLifecycleSync.applyDelta' },
					});
				});
		});

		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [restoreSession, reattachLiveTurns]);
}

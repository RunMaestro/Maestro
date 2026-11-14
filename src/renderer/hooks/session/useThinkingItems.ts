/**
 * useThinkingItems - narrow store subscription for the ThinkingStatusPill.
 *
 * PERF: Does not subscribe to the full `sessions` array reference. Uses
 * `useStoreWithEqualityFn` so MaestroConsoleInner / MainPanel are not
 * re-rendered on log streaming; only the leaf that paints the pill updates
 * when busy/orphan/token fields that the pill displays actually change.
 *
 * The local agents' items come first, then the busy tabs of every connected
 * Federation peer (`buildMirrorThinkingItems`), so work running on a host is on
 * the pill the same way local work is. With Federation off the mirror store is
 * empty and adds nothing.
 */

import { useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { Session, ThinkingItem } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { buildThinkingItems } from '../../utils/thinkingItems';
import { buildMirrorThinkingItems } from '../../utils/peerMirrorView';

function thinkingSessionEqual(a: Session, b: Session): boolean {
	if (a === b) return true;
	if (
		a.id !== b.id ||
		a.name !== b.name ||
		a.toolType !== b.toolType ||
		a.agentSessionId !== b.agentSessionId ||
		a.state !== b.state ||
		a.busySource !== b.busySource ||
		a.thinkingStartTime !== b.thinkingStartTime ||
		a.currentCycleTokens !== b.currentCycleTokens
	) {
		return false;
	}

	const aTabs = a.aiTabs;
	const bTabs = b.aiTabs;
	if (aTabs !== bTabs) {
		if (!aTabs || !bTabs || aTabs.length !== bTabs.length) return false;
		for (let i = 0; i < aTabs.length; i++) {
			const at = aTabs[i];
			const bt = bTabs[i];
			if (
				at.id !== bt.id ||
				at.agentSessionId !== bt.agentSessionId ||
				at.turnProvider !== bt.turnProvider ||
				at.tabProvider !== bt.tabProvider ||
				at.turnSessionId !== bt.turnSessionId ||
				at.providerSessions !== bt.providerSessions ||
				at.name !== bt.name ||
				at.state !== bt.state ||
				at.thinkingStartTime !== bt.thinkingStartTime
			) {
				return false;
			}
		}
	}

	const aOrphans = a.orphanedThinkingTabs;
	const bOrphans = b.orphanedThinkingTabs;
	if (aOrphans !== bOrphans) {
		if (!aOrphans || !bOrphans || aOrphans.length !== bOrphans.length) return false;
		for (let i = 0; i < aOrphans.length; i++) {
			const ao = aOrphans[i];
			const bo = bOrphans[i];
			if (
				ao.id !== bo.id ||
				ao.agentSessionId !== bo.agentSessionId ||
				ao.turnProvider !== bo.turnProvider ||
				ao.tabProvider !== bo.tabProvider ||
				ao.turnSessionId !== bo.turnSessionId ||
				ao.providerSessions !== bo.providerSessions ||
				ao.name !== bo.name ||
				ao.state !== bo.state ||
				ao.thinkingStartTime !== bo.thinkingStartTime
			) {
				return false;
			}
		}
	}

	return true;
}

function thinkingSessionsEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!thinkingSessionEqual(a[i], b[i])) return false;
	}
	return true;
}

/** Same mirrored busy tabs, with the same names and start times: the pill would paint the same. */
function mirrorItemsEqual(a: ThinkingItem[], b: ThinkingItem[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (
			x.session.id !== y.session.id ||
			x.session.name !== y.session.name ||
			x.tab?.id !== y.tab?.id ||
			x.tab?.name !== y.tab?.name ||
			x.tab?.thinkingStartTime !== y.tab?.thinkingStartTime
		) {
			return false;
		}
	}
	return true;
}

/**
 * Flat list of busy/orphan thinking items for the status pill: local agents, then mirrored ones.
 *
 * @param ownsSession Optional multi-window ownership predicate (from WindowContext). It scopes
 *   local agents only: a mirrored agent belongs to no window, so every window shows it.
 */
export function useThinkingItems(ownsSession?: (sessionId: string) => boolean): ThinkingItem[] {
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		thinkingSessionsEquality
	);
	// Rebuilt on every mirror push (a streamed turn pushes often), but compared by what the pill
	// paints, so a chunk of streamed text does not re-render it.
	const mirrorItems = useStoreWithEqualityFn(
		usePeerMirrorStore,
		(s) => buildMirrorThinkingItems(s.peers, s.order),
		mirrorItemsEqual
	);
	const localItems = useMemo(
		() => buildThinkingItems(sessions, ownsSession),
		[sessions, ownsSession]
	);
	return useMemo(
		() => (mirrorItems.length ? [...localItems, ...mirrorItems] : localItems),
		[localItems, mirrorItems]
	);
}

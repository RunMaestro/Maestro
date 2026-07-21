/**
 * useThinkingItems - narrow store subscription for the ThinkingStatusPill.
 *
 * PERF: Does not subscribe to the full `sessions` array reference. Uses
 * `useStoreWithEqualityFn` so MaestroConsoleInner / MainPanel are not
 * re-rendered on log streaming; only the leaf that paints the pill updates
 * when busy/orphan/token fields that the pill displays actually change.
 */

import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { Session, ThinkingItem } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { buildThinkingItems } from '../../utils/thinkingItems';

function thinkingSessionEqual(a: Session, b: Session): boolean {
	if (a === b) return true;
	if (
		a.id !== b.id ||
		a.name !== b.name ||
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

/**
 * Flat list of busy/orphan thinking items for the status pill.
 *
 * @param ownsSession Optional multi-window ownership predicate (from WindowContext).
 */
export function useThinkingItems(ownsSession?: (sessionId: string) => boolean): ThinkingItem[] {
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		thinkingSessionsEquality
	);
	return buildThinkingItems(sessions, ownsSession);
}

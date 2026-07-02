// Shared helpers for the per-session `unifiedTabOrder` array.
//
// Lives in its own file (rather than tabHelpers.ts or terminalTabHelpers.ts)
// so both consumers can import it without forming a circular dependency.

import type { Session, UnifiedTabRef } from '../types';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Find the index of the currently active tab within a unifiedTabOrder array.
 *
 * Priority mirrors the visual selection logic used elsewhere
 * (terminal > file > browser > ai) so insertions land next to whatever the
 * user actually sees as "current".
 *
 * Returns -1 when no active tab is present in the order.
 */
export function findActiveUnifiedTabIndex(session: Session, order: UnifiedTabRef[]): number {
	if (order.length === 0) return -1;
	// A tiled group takes over the whole panel, so when one is active it IS the
	// current tab - highest priority, ahead of any stale standalone selection. This
	// lets next/prev navigation start from the group and land on it as one unit.
	if (session.activeGroupId) {
		const groupIdx = order.findIndex(
			(ref) => ref.type === 'group' && ref.id === session.activeGroupId
		);
		if (groupIdx !== -1) return groupIdx;
	}
	if (session.activeTerminalTabId) {
		return order.findIndex(
			(ref) => ref.type === 'terminal' && ref.id === session.activeTerminalTabId
		);
	}
	if (session.activeFileTabId) {
		return order.findIndex((ref) => ref.type === 'file' && ref.id === session.activeFileTabId);
	}
	if (session.activeBrowserTabId) {
		return order.findIndex(
			(ref) => ref.type === 'browser' && ref.id === session.activeBrowserTabId
		);
	}
	return order.findIndex((ref) => ref.type === 'ai' && ref.id === session.activeTabId);
}

/**
 * Resolve the placement preference for a given tab type from user settings:
 *   - AI tabs use `newTabPlacement`
 *   - Browser tabs use `newBrowserTabPlacement`
 *   - Terminal tabs use `newTerminalPlacement`
 *   - File preview tabs use `openedFilePlacement`
 */
function resolvePlacementForType(type: UnifiedTabRef['type']): 'end' | 'after-current' {
	const settings = useSettingsStore.getState();
	switch (type) {
		case 'browser':
			return settings.newBrowserTabPlacement;
		case 'terminal':
			return settings.newTerminalPlacement;
		case 'file':
			return settings.openedFilePlacement;
		case 'ai':
		default:
			return settings.newTabPlacement;
	}
}

/**
 * Insert a UnifiedTabRef into the session's stored unifiedTabOrder according to
 * the user's per-type placement setting:
 *   - 'end': append the ref to the rightmost spot.
 *   - 'after-current': insert directly to the right of the currently active tab.
 * When the active tab can't be located in the order, the ref is appended
 * regardless of setting.
 *
 * Used by every "new tab" code path (AI, file, browser, terminal). The
 * placement is resolved from the appropriate setting based on `newRef.type`.
 */
export function insertAfterActiveInUnifiedTabOrder(
	session: Session,
	newRef: UnifiedTabRef
): UnifiedTabRef[] {
	const order = session.unifiedTabOrder || [];
	const placement = resolvePlacementForType(newRef.type);
	if (placement === 'end') {
		return [...order, newRef];
	}
	const activeIndex = findActiveUnifiedTabIndex(session, order);
	if (activeIndex === -1) {
		return [...order, newRef];
	}
	return [...order.slice(0, activeIndex + 1), newRef, ...order.slice(activeIndex + 1)];
}

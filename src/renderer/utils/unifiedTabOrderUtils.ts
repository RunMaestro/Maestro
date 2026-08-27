// Shared helpers for the per-session `unifiedTabOrder` array.
//
// Lives in its own file (rather than tabHelpers or terminalTabHelpers.ts)
// so both consumers can import it without forming a circular dependency.

import type { AITab, Session, UnifiedTabRef } from '../types';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Whether an AI tab is hidden from the tab strip and from tab-cycling shortcuts.
 * Currently only unopened cross-agent consult tabs (see `AITab.hidden`).
 *
 * The single predicate behind both visibility surfaces: `buildUnifiedTabs` (what
 * renders) and `getNavigableTabs` (what Cmd+1..9 / cycling reaches). They must
 * agree, or a shortcut lands on a tab the strip never showed.
 */
export function isAiTabHidden(tab: AITab): boolean {
	return tab.hidden === true;
}

/**
 * Narrow a unifiedTabOrder to the refs a keyboard shortcut may land on: the ones
 * `buildUnifiedTabs` actually renders as a chip.
 *
 * The stored order deliberately keeps the ref of a hidden AI tab (an unopened
 * cross-agent consult) - that ref is what restores the tab to its original
 * position when the user reveals it. The strip drops those refs, so indexing the
 * stored order makes navigation walk stops that have no chip: Cmd+Shift+[ appears
 * to skip a beat, and Cmd+N counts past a tab nobody can see. Every navigation
 * index, and every "pick the neighbor" fallback after a close, comes from THIS
 * list; only the write-back uses the stored one.
 *
 * Returns the input by reference when there is nothing to drop (the common case),
 * since callers memoize on identity.
 */
export function getNavigableUnifiedTabOrder(
	session: Session,
	order: UnifiedTabRef[]
): UnifiedTabRef[] {
	const hiddenAiIds = new Set((session.aiTabs || []).filter(isAiTabHidden).map((tab) => tab.id));
	if (hiddenAiIds.size === 0) return order;
	return order.filter((ref) => !(ref.type === 'ai' && hiddenAiIds.has(ref.id)));
}

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

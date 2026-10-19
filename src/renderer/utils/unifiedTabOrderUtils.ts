// Shared helpers for the per-session `unifiedTabOrder` array.
//
// Lives in its own file (rather than tabHelpers or terminalTabHelpers.ts)
// so both consumers can import it without forming a circular dependency.

import type { AITab, Session, UnifiedTabRef } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { getPoppedOutTabKeys } from '../stores/tabWindowStore';
import { tabRefKey, type SingleTabType } from '../../shared/unifiedTabRef';

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
 * The AI tabs a user-facing list may show: everything `buildUnifiedTabs` draws a
 * chip for, with hidden consult tabs dropped.
 *
 * Reach for this in any surface that ENUMERATES an agent's tabs - the tab
 * switcher, cross-tab search, a merge target list, a tab count in copy. A hidden
 * consult tab is a transcript the user never asked to open, so listing it offers
 * a row that has no chip to go back to, and counting it makes "Close all N tabs"
 * name a number the strip contradicts.
 *
 * Returns the input by reference when there is nothing to drop (the common case),
 * since callers memoize on identity.
 */
export function visibleAiTabs(tabs: AITab[] | undefined): AITab[] {
	if (!tabs || tabs.length === 0) return tabs ?? [];
	return tabs.some(isAiTabHidden) ? tabs.filter((tab) => !isAiTabHidden(tab)) : tabs;
}

/**
 * Whether an agent has an unread AI tab the user can actually get to.
 *
 * The single predicate behind every unread SIGNAL - the Left Bar row dot, the
 * collapsed rail dot, the sidebar bell, the tab strip's bell dot, and the
 * "needs attention" filter. A hidden consult tab is deliberately chip-less, so
 * counting one lights a badge with nothing on screen to clear it: the user
 * opens the agent, sees every tab already read, and the dot stays lit forever.
 *
 * Cross-agent consults are the whole reason this exists. A mention is answered
 * in the BACKGROUND on the consulted agent - it must not open a tab there and
 * must not raise an unread anywhere. Reach for this instead of
 * `aiTabs.some((t) => t.hasUnread)` in any surface that draws an unread mark.
 */
export function hasUnreadVisibleTab(tabs: AITab[] | undefined): boolean {
	return (tabs ?? []).some((tab) => tab.hasUnread && !isAiTabHidden(tab));
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
	// A tab popped out into a tab window has no chip in the owner either (D4).
	const shown = filterPoppedOutRefs(session.id, order);
	const hiddenAiIds = new Set((session.aiTabs || []).filter(isAiTabHidden).map((tab) => tab.id));
	if (hiddenAiIds.size === 0) return shown;
	return shown.filter((ref) => !(ref.type === 'ai' && hiddenAiIds.has(ref.id)));
}

/**
 * Drop the tabs of one kind that are popped out into a tab window (Tab Windows,
 * D4), for a surface that enumerates an agent's tabs in the owner window: the
 * tab switcher, cross-tab search, a tab count in copy.
 *
 * Reads the popped set from the store, so a memo over `tabs` must also depend on
 * `usePoppedOutTabKeys(agentId)`. Returns the input by reference when nothing is
 * dropped (the common case), since callers memoize on identity.
 */
export function withoutPoppedOutTabs<T extends { id: string }>(
	agentId: string | null | undefined,
	type: SingleTabType,
	tabs: T[]
): T[] {
	if (!agentId || tabs.length === 0) return tabs;
	const popped = getPoppedOutTabKeys(agentId);
	if (popped.size === 0) return tabs;
	const isPopped = (tab: T) => popped.has(tabRefKey({ type, id: tab.id }));
	return tabs.some(isPopped) ? tabs.filter((tab) => !isPopped(tab)) : tabs;
}

/**
 * The AI tabs the owner window's strip draws for an agent: {@link visibleAiTabs}
 * minus the tabs popped out into its tab window. The owner-window form of
 * `visibleAiTabs`, for every list and count the owner offers.
 *
 * Same memo rule and by-reference return as {@link withoutPoppedOutTabs}.
 */
export function ownerVisibleAiTabs(
	agentId: string | null | undefined,
	tabs: AITab[] | undefined
): AITab[] {
	return withoutPoppedOutTabs(agentId, 'ai', visibleAiTabs(tabs));
}

/**
 * Drop the refs of tabs popped out into a tab window (Tab Windows, D4).
 *
 * The stored order keeps a popped tab's ref, because that ref is what puts the
 * tab back in its slot on dock (TW-8). The owner window must not draw it or
 * land on it, so every list the owner picks a tab from is narrowed here, the
 * same way {@link getNavigableUnifiedTabOrder} narrows hidden consult tabs.
 * Group refs always survive: a whole tiled group is never popped out (D6).
 *
 * Returns the input by reference when nothing is dropped (the common case),
 * since callers memoize on identity.
 */
export function filterPoppedOutRefs<T extends UnifiedTabRef>(agentId: string, order: T[]): T[] {
	const popped = getPoppedOutTabKeys(agentId);
	if (popped.size === 0 || order.length === 0) return order;
	const isPopped = (ref: T) => ref.type !== 'group' && popped.has(tabRefKey(ref));
	return order.some(isPopped) ? order.filter((ref) => !isPopped(ref)) : order;
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

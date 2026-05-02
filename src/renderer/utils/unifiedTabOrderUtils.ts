// Shared helpers for the per-session `unifiedTabOrder` array.
//
// Lives in its own file (rather than tabHelpers.ts or terminalTabHelpers.ts)
// so both consumers can import it without forming a circular dependency.

import type { Session, UnifiedTabRef } from '../types';

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
 * Insert a UnifiedTabRef directly to the right of the currently active tab in
 * the session's stored unifiedTabOrder. When the active tab can't be located
 * in the order, the ref is appended.
 *
 * Used by every "new tab" code path (AI, file, browser, terminal) so that a
 * freshly created tab always lands next to the tab the user was on, regardless
 * of tab type.
 */
export function insertAfterActiveInUnifiedTabOrder(
	session: Session,
	newRef: UnifiedTabRef
): UnifiedTabRef[] {
	const order = session.unifiedTabOrder || [];
	const activeIndex = findActiveUnifiedTabIndex(session, order);
	if (activeIndex === -1) {
		return [...order, newRef];
	}
	return [...order.slice(0, activeIndex + 1), newRef, ...order.slice(activeIndex + 1)];
}

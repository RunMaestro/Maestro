import type { AITab, Session, UnifiedTabRef } from '../../../types';
import {
	addAiTabToUnifiedHistory,
	closeBrowserTab,
	closeTab,
	getRepairedUnifiedTabOrder,
	hasActiveWizard,
	hasDraft,
	isAiTabHidden,
} from '../../../utils/tabHelpers';
import { closeTerminalTab as closeTerminalTabHelper } from '../../../utils/terminalTabHelpers';

export function getActiveUnifiedRef(
	session: Session
): { type: UnifiedTabRef['type']; id: string } | null {
	if (session.inputMode === 'terminal' && session.activeTerminalTabId) {
		return { type: 'terminal', id: session.activeTerminalTabId };
	}
	if (session.activeFileTabId) {
		return { type: 'file', id: session.activeFileTabId };
	}
	if (session.activeBrowserTabId) {
		return { type: 'browser', id: session.activeBrowserTabId };
	}
	if (session.activeTabId) {
		return { type: 'ai', id: session.activeTabId };
	}
	return null;
}

/**
 * Resolve the pivot tab's index within the REPAIRED unified order (the exact
 * order the tab bar renders). Prefer an explicit pivot tab id - the tab whose
 * overlay menu the user clicked - and fall back to the active tab when none is
 * given (e.g. keyboard shortcuts and the command palette operate on the active
 * tab).
 *
 * Using the repaired order is critical for correctness: raw
 * session.unifiedTabOrder can contain stale/duplicate refs or omit orphaned
 * tabs, so its indices diverge from what the user sees. Slicing the raw order
 * (the previous behavior) could close every tab except the pivot when the
 * pivot happened to sit at raw index 0 while rendering mid-strip. Both the menu
 * enable/disable guards and closeTab's neighbor math already use the repaired
 * order - this aligns the close operation with them.
 */
function resolvePivot(
	session: Session,
	pivotTabId?: string
): { order: UnifiedTabRef[]; index: number } {
	const order = getRepairedUnifiedTabOrder(session);
	if (pivotTabId) {
		// Tab ids are unique across types, so match by id alone.
		const idx = order.findIndex((ref) => ref.id === pivotTabId);
		if (idx !== -1) return { order, index: idx };
	}
	const activeRef = getActiveUnifiedRef(session);
	const index = activeRef
		? order.findIndex((ref) => ref.type === activeRef.type && ref.id === activeRef.id)
		: -1;
	return { order, index };
}

export function getActiveUnifiedIndex(session: Session, pivotTabId?: string): number {
	return resolvePivot(session, pivotTabId).index;
}

export function getRefsExceptActive(session: Session, pivotTabId?: string): UnifiedTabRef[] {
	const { order, index } = resolvePivot(session, pivotTabId);
	if (index < 0) return [];
	return order.filter((_, i) => i !== index);
}

export function getRefsLeftOfActive(session: Session, pivotTabId?: string): UnifiedTabRef[] {
	const { order, index } = resolvePivot(session, pivotTabId);
	if (index <= 0) return [];
	return order.slice(0, index);
}

export function getRefsRightOfActive(session: Session, pivotTabId?: string): UnifiedTabRef[] {
	const { order, index } = resolvePivot(session, pivotTabId);
	if (index < 0 || index >= order.length - 1) return [];
	return order.slice(index + 1);
}

export function getTerminalTabIds(refs: UnifiedTabRef[]): string[] {
	return refs.filter((ref) => ref.type === 'terminal').map((ref) => ref.id);
}

export function getWizardTabIds(session: Session, refs: UnifiedTabRef[]): string[] {
	return refs
		.filter((ref) => ref.type === 'ai')
		.map((ref) => session.aiTabs.find((tab) => tab.id === ref.id))
		.filter((tab): tab is AITab => !!tab && hasActiveWizard(tab))
		.map((tab) => tab.id);
}

/**
 * Drop refs for AI tabs that hold an unsent draft. Bulk close operations
 * (close-left / close-right / close-others) use this to PRESERVE any tab with
 * unsaved input rather than closing it. A draft tab is never destroyed by a
 * bulk action - the user keeps it and the rest close silently.
 */
export function excludeDraftRefs(session: Session, refs: UnifiedTabRef[]): UnifiedTabRef[] {
	const draftAiIds = new Set(session.aiTabs.filter((tab) => hasDraft(tab)).map((tab) => tab.id));
	if (draftAiIds.size === 0) return refs;
	return refs.filter((ref) => !(ref.type === 'ai' && draftAiIds.has(ref.id)));
}

/**
 * Drop refs for hidden AI tabs (unopened cross-agent consults). The repaired
 * order deliberately KEEPS their refs so a revealed consult lands back in its
 * original position, which means a bulk close computed from that order would
 * take out a tab the strip never drew - destroying the consult transcript and
 * its resume id without the user ever seeing a chip for it.
 */
export function excludeHiddenAiRefs(session: Session, refs: UnifiedTabRef[]): UnifiedTabRef[] {
	const hiddenAiIds = new Set((session.aiTabs || []).filter(isAiTabHidden).map((tab) => tab.id));
	if (hiddenAiIds.size === 0) return refs;
	return refs.filter((ref) => !(ref.type === 'ai' && hiddenAiIds.has(ref.id)));
}

/**
 * Every preservation rule a bulk close (close-others / close-left / close-right)
 * must honor: keep unsent drafts, and keep tabs the strip never drew. One entry
 * point so the three bulk paths cannot drift on what survives.
 */
export function excludePreservedRefs(session: Session, refs: UnifiedTabRef[]): UnifiedTabRef[] {
	return excludeHiddenAiRefs(session, excludeDraftRefs(session, refs));
}

export function applyUnifiedTabClosures(session: Session, refsToClose: UnifiedTabRef[]): Session {
	let updatedSession = session;

	// Capture each AI tab's pre-close position in the repaired order so closed
	// tabs can be restored near their original spot via Cmd+Shift+T. Mirrors the
	// single-tab close path (performTabClose), which records into the unified
	// history; without this, bulk-closed AI tabs only landed in the legacy
	// closedTabHistory and could not be reopened while the unified history held
	// any entries.
	const repairedOrder = getRepairedUnifiedTabOrder(session);
	const unifiedIndexById = new Map<string, number>();
	repairedOrder.forEach((ref, i) => {
		if (ref.type === 'ai') unifiedIndexById.set(ref.id, i);
	});

	for (const tabRef of refsToClose) {
		if (tabRef.type === 'ai') {
			const tab = updatedSession.aiTabs.find((t) => t.id === tabRef.id);
			if (tab) {
				const isWizardTab = hasActiveWizard(tab);
				const result = closeTab(updatedSession, tab.id, false, {
					skipHistory: isWizardTab,
				});
				if (result) {
					updatedSession = result.session;
					// Wizard tabs are intentionally not restorable.
					if (!isWizardTab) {
						updatedSession = addAiTabToUnifiedHistory(
							updatedSession,
							tab,
							unifiedIndexById.get(tab.id) ?? 0
						);
					}
				}
			}
		} else if (tabRef.type === 'terminal') {
			updatedSession = closeTerminalTabHelper(updatedSession, tabRef.id);
		} else if (tabRef.type === 'browser') {
			const result = closeBrowserTab(updatedSession, tabRef.id);
			if (result) {
				updatedSession = result.session;
			}
		} else {
			updatedSession = {
				...updatedSession,
				filePreviewTabs: updatedSession.filePreviewTabs.filter((tab) => tab.id !== tabRef.id),
				unifiedTabOrder: updatedSession.unifiedTabOrder.filter(
					(ref) => !(ref.type === 'file' && ref.id === tabRef.id)
				),
			};
		}
	}

	return updatedSession;
}

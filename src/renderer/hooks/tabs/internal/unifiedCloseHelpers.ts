import type { AITab, Session, UnifiedTabRef } from '../../../types';
import { closeBrowserTab, closeTab, hasActiveWizard, hasDraft } from '../../../utils/tabHelpers';
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

export function getActiveUnifiedIndex(session: Session): number {
	const activeRef = getActiveUnifiedRef(session);
	if (!activeRef) return -1;
	return session.unifiedTabOrder.findIndex(
		(ref) => ref.type === activeRef.type && ref.id === activeRef.id
	);
}

export function getRefsExceptActive(session: Session): UnifiedTabRef[] {
	const activeRef = getActiveUnifiedRef(session);
	if (!activeRef) return [];
	return session.unifiedTabOrder.filter(
		(ref) => !(ref.type === activeRef.type && ref.id === activeRef.id)
	);
}

export function getRefsLeftOfActive(session: Session): UnifiedTabRef[] {
	const activeIndex = getActiveUnifiedIndex(session);
	if (activeIndex <= 0) return [];
	return session.unifiedTabOrder.slice(0, activeIndex);
}

export function getRefsRightOfActive(session: Session): UnifiedTabRef[] {
	const activeIndex = getActiveUnifiedIndex(session);
	if (activeIndex < 0 || activeIndex >= session.unifiedTabOrder.length - 1) return [];
	return session.unifiedTabOrder.slice(activeIndex + 1);
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

export function hasDraftInRefs(session: Session, refs: UnifiedTabRef[]): boolean {
	const aiTabIds = new Set(refs.filter((ref) => ref.type === 'ai').map((ref) => ref.id));
	return session.aiTabs.filter((tab) => aiTabIds.has(tab.id)).some((tab) => hasDraft(tab));
}

export function applyUnifiedTabClosures(session: Session, refsToClose: UnifiedTabRef[]): Session {
	let updatedSession = session;

	for (const tabRef of refsToClose) {
		if (tabRef.type === 'ai') {
			const tab = updatedSession.aiTabs.find((t) => t.id === tabRef.id);
			if (tab) {
				const result = closeTab(updatedSession, tab.id, false, {
					skipHistory: hasActiveWizard(tab),
				});
				if (result) {
					updatedSession = result.session;
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

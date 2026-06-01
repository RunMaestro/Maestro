import { useCallback } from 'react';
import { useInlineWizardContext } from '../../../contexts/InlineWizardContext';
import { useModalStore } from '../../../stores/modalStore';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { clearLiveDraft } from '../../../utils/liveDraftStore';
import { logger } from '../../../utils/logger';
import {
	closeBrowserTab as closeBrowserTabHelper,
	hasActiveWizard,
	hasDraft,
	hasWizardInteraction,
} from '../../../utils/tabHelpers';
import { getTerminalSessionId } from '../../../utils/terminalTabHelpers';
import type { CloseCurrentTabResult, UnifiedTabHandlersReturn } from './types';
import {
	applyUnifiedTabClosures,
	getActiveUnifiedIndex,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTerminalTabIds,
	getWizardTabIds,
	hasDraftInRefs,
} from './unifiedCloseHelpers';

interface UseUnifiedTabHandlersOptions {
	handleCloseFileTab: (tabId: string) => void;
}

export function useUnifiedTabHandlers({
	handleCloseFileTab,
}: UseUnifiedTabHandlersOptions): UnifiedTabHandlersReturn {
	const { endWizard: endInlineWizard } = useInlineWizardContext();

	const handleUnifiedTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				logger.debug('[useTabHandlers] handleUnifiedTabReorder', undefined, {
					fromIndex,
					toIndex,
					orderLength: s.unifiedTabOrder.length,
					order: s.unifiedTabOrder.map((r) => `${r.type}:${r.id.slice(0, 8)}`),
				});
				if (
					fromIndex < 0 ||
					fromIndex >= s.unifiedTabOrder.length ||
					toIndex < 0 ||
					toIndex >= s.unifiedTabOrder.length ||
					fromIndex === toIndex
				) {
					logger.debug(
						'[useTabHandlers] handleUnifiedTabReorder: bounds check failed, returning unchanged'
					);
					return s;
				}
				const newOrder = [...s.unifiedTabOrder];
				const [movedRef] = newOrder.splice(fromIndex, 1);
				newOrder.splice(toIndex, 0, movedRef);
				logger.debug('[useTabHandlers] handleUnifiedTabReorder: reordered', undefined, {
					movedRef,
					newOrder: newOrder.map((r) => `${r.type}:${r.id.slice(0, 8)}`),
				});
				return { ...s, unifiedTabOrder: newOrder };
			})
		);
	}, []);

	const closeRefs = useCallback(
		(
			getRefs: (session: Session) => ReturnType<typeof getRefsExceptActive>,
			wizardWarningLabel: 'close-others' | 'close-left' | 'close-right'
		) => {
			const { sessions, setSessions, activeSessionId } = useSessionStore.getState();
			const session = sessions.find((s) => s.id === activeSessionId);
			if (!session) return;

			const refsToClose = getRefs(session);
			if (refsToClose.length === 0) return;

			const terminalTabIds = getTerminalTabIds(refsToClose);
			refsToClose.filter((ref) => ref.type === 'ai').forEach((ref) => clearLiveDraft(ref.id));
			const wizardTabIds = getWizardTabIds(session, refsToClose);

			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					return applyUnifiedTabClosures(s, refsToClose);
				})
			);

			for (const tabId of terminalTabIds) {
				window.maestro.process.kill(getTerminalSessionId(session.id, tabId));
			}

			for (const tabId of wizardTabIds) {
				endInlineWizard(tabId).catch((error) =>
					logger.warn(
						`[useTabHandlers] Failed to end wizard on ${wizardWarningLabel}:`,
						undefined,
						error
					)
				);
			}
		},
		[endInlineWizard]
	);

	const performCloseOtherTabs = useCallback(() => {
		closeRefs(getRefsExceptActive, 'close-others');
	}, [closeRefs]);

	const handleCloseOtherTabs = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeTabId = session.activeFileTabId ?? session.activeTabId;
		const otherAiTabs = session.aiTabs.filter((t) => t.id !== activeTabId);
		const hasAnyDraft = otherAiTabs.some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseOtherTabs,
			});
		} else {
			performCloseOtherTabs();
		}
	}, [performCloseOtherTabs]);

	const performCloseTabsLeft = useCallback(() => {
		closeRefs(getRefsLeftOfActive, 'close-left');
	}, [closeRefs]);

	const handleCloseTabsLeft = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeIndex = getActiveUnifiedIndex(session);
		if (activeIndex <= 0) return;

		const tabRefsToClose = session.unifiedTabOrder.slice(0, activeIndex);
		if (hasDraftInRefs(session, tabRefsToClose)) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseTabsLeft,
			});
		} else {
			performCloseTabsLeft();
		}
	}, [performCloseTabsLeft]);

	const performCloseTabsRight = useCallback(() => {
		closeRefs(getRefsRightOfActive, 'close-right');
	}, [closeRefs]);

	const handleCloseTabsRight = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const activeIndex = getActiveUnifiedIndex(session);
		if (activeIndex < 0 || activeIndex >= session.unifiedTabOrder.length - 1) return;

		const tabRefsToClose = session.unifiedTabOrder.slice(activeIndex + 1);
		if (hasDraftInRefs(session, tabRefsToClose)) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close them?',
				onConfirm: performCloseTabsRight,
			});
		} else {
			performCloseTabsRight();
		}
	}, [performCloseTabsRight]);

	const handleCloseCurrentTab = useCallback((): CloseCurrentTabResult => {
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return { type: 'none' };

		if (session.inputMode === 'terminal' && session.activeTerminalTabId) {
			const tabId = session.activeTerminalTabId;
			const totalTabs =
				(session.aiTabs?.length || 0) +
				(session.filePreviewTabs?.length || 0) +
				(session.browserTabs?.length || 0) +
				(session.terminalTabs?.length || 0);
			if (totalTabs <= 1) {
				return { type: 'prevented' };
			}
			return { type: 'terminal', tabId };
		}

		if (session.activeFileTabId) {
			const tabId = session.activeFileTabId;
			handleCloseFileTab(tabId);
			return { type: 'file', tabId };
		}

		if (session.activeBrowserTabId) {
			const tabId = session.activeBrowserTabId;
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const result = closeBrowserTabHelper(s, tabId);
					return result ? result.session : s;
				})
			);
			return { type: 'browser', tabId };
		}

		if (session.activeTabId) {
			const tabId = session.activeTabId;
			const tab = session.aiTabs.find((t) => t.id === tabId);
			const isWizardTab = tab ? hasActiveWizard(tab) : false;
			const hasWizardUserInteraction = tab ? hasWizardInteraction(tab) : false;
			const tabHasDraft = tab ? hasDraft(tab) : false;

			return { type: 'ai', tabId, isWizardTab, hasWizardUserInteraction, hasDraft: tabHasDraft };
		}

		return { type: 'none' };
	}, [handleCloseFileTab]);

	return {
		handleUnifiedTabReorder,
		handleCloseOtherTabs,
		handleCloseTabsLeft,
		handleCloseTabsRight,
		handleCloseCurrentTab,
	};
}

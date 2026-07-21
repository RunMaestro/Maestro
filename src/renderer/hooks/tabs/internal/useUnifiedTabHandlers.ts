import { useCallback } from 'react';
import { useInlineWizardContext } from '../../../contexts/InlineWizardContext';
import { selectActiveSession, useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { clearLiveDraft } from '../../../utils/liveDraftStore';
import { logger } from '../../../utils/logger';
import {
	closeBrowserTab as closeBrowserTabHelper,
	hasActiveWizard,
	hasDraft,
	hasWizardInteraction,
	resolveFocusedPaneTabRef,
} from '../../../utils/tabHelpers';
import { getTerminalSessionId } from '../../../utils/terminalTabHelpers';
import type { CloseCurrentTabResult, UnifiedTabHandlersReturn } from './types';
import {
	applyUnifiedTabClosures,
	excludeDraftRefs,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTerminalTabIds,
	getWizardTabIds,
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
				// Diagnostic: bulk close is a separate terminal-removal path from the
				// store's closeTerminalTab. Log it with the same shape so every closed
				// terminal is accounted for in the logs (see "Closing terminal tab").
				const tab = (session.terminalTabs || []).find((t) => t.id === tabId);
				logger.info('Closing terminal tab', 'TerminalView', {
					sessionId: session.id,
					tabId,
					reason: wizardWarningLabel,
					pid: tab?.pid,
					state: tab?.state,
					hasStartupCommand: !!tab?.startupCommand,
					isRemote: !!(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId),
				});
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

	// Bulk close operations never destroy a tab with an unsent draft - such tabs
	// are filtered out of the close set so they survive. The rest close silently
	// (no confirmation prompt).
	const handleCloseOtherTabs = useCallback(
		(pivotTabId?: string) => {
			closeRefs(
				(session) => excludeDraftRefs(session, getRefsExceptActive(session, pivotTabId)),
				'close-others'
			);
		},
		[closeRefs]
	);

	const handleCloseTabsLeft = useCallback(
		(pivotTabId?: string) => {
			closeRefs(
				(session) => excludeDraftRefs(session, getRefsLeftOfActive(session, pivotTabId)),
				'close-left'
			);
		},
		[closeRefs]
	);

	const handleCloseTabsRight = useCallback(
		(pivotTabId?: string) => {
			closeRefs(
				(session) => excludeDraftRefs(session, getRefsRightOfActive(session, pivotTabId)),
				'close-right'
			);
		},
		[closeRefs]
	);

	const handleCloseCurrentTab = useCallback((): CloseCurrentTabResult => {
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return { type: 'none' };

		// A tiled group takes over the whole panel, so Cmd+W must close ONLY the
		// focused pane's tab (the visible tile), never whatever standalone active id
		// happens to linger (a file-focused pane, for instance, leaves activeTabId
		// pointing at some other AI tab). Resolve the focused leaf's ref and route it
		// through the matching per-kind close. The normalizeTabGroups self-heal effect
		// (MainPanelContent) then prunes the now-dangling leaf and collapses/dissolves
		// the group. No active group => fall through to the standalone logic below.
		if (session.activeGroupId) {
			const group = session.tabGroups?.find((g) => g.id === session.activeGroupId);
			const focusedRef = group ? resolveFocusedPaneTabRef(group) : null;
			if (focusedRef) {
				if (focusedRef.type === 'ai') {
					const tab = session.aiTabs.find((t) => t.id === focusedRef.id);
					const isWizardTab = tab ? hasActiveWizard(tab) : false;
					const hasWizardUserInteraction = tab ? hasWizardInteraction(tab) : false;
					const tabHasDraft = tab ? hasDraft(tab) : false;
					return {
						type: 'ai',
						tabId: focusedRef.id,
						isWizardTab,
						hasWizardUserInteraction,
						hasDraft: tabHasDraft,
					};
				}
				if (focusedRef.type === 'file') {
					handleCloseFileTab(focusedRef.id);
					return { type: 'file', tabId: focusedRef.id };
				}
				if (focusedRef.type === 'browser') {
					setSessions((prev: Session[]) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;
							const result = closeBrowserTabHelper(s, focusedRef.id);
							return result ? result.session : s;
						})
					);
					return { type: 'browser', tabId: focusedRef.id };
				}
				// Terminal tile: the keyboard handler completes the close via
				// handleCloseTerminalTab (killing the PTY). The group always has >=2 panes
				// here, so the standalone "prevented when it's the last tab" guard never applies.
				return { type: 'terminal', tabId: focusedRef.id };
			}
		}

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

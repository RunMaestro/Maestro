import { useCallback } from 'react';
import { useInlineWizardContext } from '../../../contexts/InlineWizardContext';
import { useModalStore } from '../../../stores/modalStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
	selectActiveSession,
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../../../stores/sessionStore';
import { clearLiveDraft } from '../../../utils/liveDraftStore';
import { logger } from '../../../utils/logger';
import { persistTabStarred } from '../../../utils/starredSessions';
import { isWebDesktop } from '../../../utils/runtimeContext';
import { noteDesktopAiTabSelection } from '../../../utils/desktopTabSelectionSync';
import {
	addAiTabToUnifiedHistory,
	closeTab,
	createTab,
	cycleShowThinkingFields,
	getActiveTab,
	getInitialRenameValue,
	getTabDisplayName,
	hasActiveWizard,
	hasDraft,
	hasWizardInteraction,
	restoreOrphanedTab,
	setActiveTab,
	toggleReadOnlyModeFields,
	visibleAiTabs,
} from '../../../utils/tabHelpers';
import type { AITabHandlersReturn } from './types';

export function useAITabHandlers(): AITabHandlersReturn {
	const { endWizard: endInlineWizard } = useInlineWizardContext();

	const createNewAITab = useCallback(() => {
		const { activeSessionId } = useSessionStore.getState();
		if (isWebDesktop()) {
			if (activeSessionId) {
				void window.maestro.web
					.requestNewTab(activeSessionId, false)
					.catch((error) =>
						logger.error('[useAITabHandlers] Failed to create desktop tab:', undefined, error)
					);
			}
			return;
		}

		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();

		if (!activeSessionId) return;
		updateSessionWith(activeSessionId, (session) => {
			const result = createTab(session, {
				saveToHistory: defaultSaveToHistory,
				showThinking: defaultShowThinking,
			});
			return result?.session ?? session;
		});
	}, []);

	const handleNewAgentSession = useCallback(() => {
		createNewAITab();
		useModalStore.getState().closeModal('agentSessions');
	}, [createNewAITab]);

	const handleTabSelect = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		let didSelectTab = false;
		updateSessionWith(activeSessionId, (s) => {
			if (s.orphanedThinkingTabs?.some((t) => t.id === tabId)) {
				const restored = restoreOrphanedTab(s, tabId);
				if (restored) {
					didSelectTab = true;
					return restored.session;
				}
			}
			const result = setActiveTab(s, tabId);
			didSelectTab = result !== null;
			return result ? result.session : s;
		});

		// Web -> Desktop requests already travel over remote:selectTab. Only a
		// selection originating in the desktop renderer should be reflected back
		// to Web-Desktop as desktop focus intent.
		if (didSelectTab && !isWebDesktop()) {
			noteDesktopAiTabSelection(activeSessionId, tabId);
		}
	}, []);

	const performTabClose = useCallback(
		(tabId: string) => {
			const { activeSessionId } = useSessionStore.getState();
			const sessionBeforeClose = useSessionStore
				.getState()
				.sessions.find((s) => s.id === activeSessionId);
			const tabBeforeClose = sessionBeforeClose?.aiTabs.find((t) => t.id === tabId);
			const wasWizardTab = !!tabBeforeClose && hasActiveWizard(tabBeforeClose);

			// Closing a starred tab is a context-loss boundary: capture the provider
			// transcript into Maestro's own mirror now, so it survives even if the
			// provider later deletes its copy. Fire-and-forget; no-op for unstarred
			// tabs or tabs that never got a provider session id.
			if (
				sessionBeforeClose &&
				tabBeforeClose?.starred &&
				tabBeforeClose.agentSessionId &&
				sessionBeforeClose.projectRoot
			) {
				window.maestro.agentSessions
					.snapshotStarredTranscript(
						sessionBeforeClose.toolType || 'claude-code',
						sessionBeforeClose.projectRoot,
						tabBeforeClose.agentSessionId,
						getTabDisplayName(tabBeforeClose)
					)
					.catch((error) =>
						logger.warn(
							'[useTabHandlers] Failed to mirror starred transcript on close',
							undefined,
							error
						)
					);
			}

			clearLiveDraft(tabId);
			updateSessionWith(activeSessionId, (s) => {
				const tab = s.aiTabs.find((t) => t.id === tabId);
				const isWizardTab = tab && hasActiveWizard(tab);
				const unifiedIndex = s.unifiedTabOrder.findIndex(
					(ref) => ref.type === 'ai' && ref.id === tabId
				);
				const result = closeTab(s, tabId, false, { skipHistory: isWizardTab });
				if (!result) return s;
				if (!isWizardTab && tab) {
					return addAiTabToUnifiedHistory(result.session, tab, unifiedIndex);
				}
				return result.session;
			});

			if (wasWizardTab) {
				endInlineWizard(tabId).catch((error) =>
					logger.warn('[useTabHandlers] Failed to end wizard on tab close:', undefined, error)
				);
			}
		},
		[endInlineWizard]
	);

	const handleTabClose = useCallback(
		(tabId: string) => {
			const session = selectActiveSession(useSessionStore.getState());
			const tab = session?.aiTabs.find((t) => t.id === tabId);

			if (tab && hasWizardInteraction(tab)) {
				useModalStore.getState().openModal('confirm', {
					message: 'Close this wizard? Your progress will be lost and cannot be restored.',
					onConfirm: () => performTabClose(tabId),
				});
			} else if (tab && hasActiveWizard(tab)) {
				performTabClose(tabId);
			} else if (tab && hasDraft(tab)) {
				useModalStore.getState().openModal('confirm', {
					message: 'This tab has an unsent draft. Are you sure you want to close it?',
					onConfirm: () => performTabClose(tabId),
				});
			} else {
				performTabClose(tabId);
			}
		},
		[performTabClose]
	);

	const handleNewTab = createNewAITab;

	// "Close all" means every tab the user can see. Hidden consult tabs (unopened
	// cross-agent @mentions) have no chip, so closing one here would silently
	// destroy a transcript and its resume id the user was never shown.
	const performCloseAllTabs = useCallback(() => {
		const { activeSessionId, sessions } = useSessionStore.getState();
		const activeSession = sessions.find((s) => s.id === activeSessionId);
		visibleAiTabs(activeSession?.aiTabs).forEach((t) => clearLiveDraft(t.id));

		const wizardTabIds = visibleAiTabs(activeSession?.aiTabs)
			.filter((t) => hasActiveWizard(t))
			.map((t) => t.id);

		updateSessionWith(activeSessionId, (s) => {
			let updatedSession = s;
			const tabIds = visibleAiTabs(s.aiTabs).map((t) => t.id);
			for (const tabId of tabIds) {
				const tab = updatedSession.aiTabs.find((t) => t.id === tabId);
				const result = closeTab(updatedSession, tabId, false, {
					skipHistory: tab ? hasActiveWizard(tab) : false,
				});
				if (result) {
					updatedSession = result.session;
				}
			}
			return updatedSession;
		});

		for (const tabId of wizardTabIds) {
			endInlineWizard(tabId).catch((error) =>
				logger.warn('[useTabHandlers] Failed to end wizard on close-all:', undefined, error)
			);
		}
	}, [endInlineWizard]);

	const handleCloseAllTabs = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const hasAnyDraft = visibleAiTabs(session.aiTabs).some((tab) => hasDraft(tab));
		if (hasAnyDraft) {
			useModalStore.getState().openModal('confirm', {
				message: 'Some tabs have unsent drafts. Are you sure you want to close all tabs?',
				onConfirm: performCloseAllTabs,
			});
		} else {
			performCloseAllTabs();
		}
	}, [performCloseAllTabs]);

	const handleRequestTabRename = useCallback((tabId: string) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = session.aiTabs?.find((t) => t.id === tabId);
		if (tab) {
			if (tab.isGeneratingName) {
				updateAiTab(session.id, tabId, (t) => ({ ...t, isGeneratingName: false }));
			}
			useModalStore.getState().openModal('renameTab', {
				tabId,
				initialName: getInitialRenameValue(tab),
			});
		}
	}, []);

	const handleTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { activeSessionId } = useSessionStore.getState();
		updateSessionWith(activeSessionId, (s) => {
			if (!s.aiTabs) return s;
			const tabs = [...s.aiTabs];
			const [movedTab] = tabs.splice(fromIndex, 1);
			tabs.splice(toIndex, 0, movedTab);
			return { ...s, aiTabs: tabs };
		});
	}, []);

	const handleUpdateTabByClaudeSessionId = useCallback(
		(agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => {
			const { activeSessionId } = useSessionStore.getState();
			updateSessionWith(activeSessionId, (s) => {
				const tabIndex = s.aiTabs.findIndex((tab) => tab.agentSessionId === agentSessionId);
				if (tabIndex === -1) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.agentSessionId === agentSessionId
							? {
									...tab,
									...(updates.name !== undefined ? { name: updates.name } : {}),
									...(updates.starred !== undefined ? { starred: updates.starred } : {}),
								}
							: tab
					),
				};
			});
		},
		[]
	);

	const handleTabStar = useCallback((tabId: string, starred: boolean) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tabToStar = session.aiTabs.find((t) => t.id === tabId);
		if (!tabToStar?.agentSessionId) return;

		persistTabStarred(session, tabToStar, starred);
		updateAiTab(session.id, tabId, (t) => ({ ...t, starred }));
	}, []);

	const handleTabMarkUnread = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		updateAiTab(activeSessionId, tabId, (t) => ({ ...t, hasUnread: true }));
	}, []);

	const handleToggleTabReadOnlyMode = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			...toggleReadOnlyModeFields(tab),
		}));
	}, []);

	const handleToggleTabSaveToHistory = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			saveToHistory: !tab.saveToHistory,
		}));
	}, []);

	const handleToggleTabShowThinking = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			...cycleShowThinkingFields(tab),
		}));
	}, []);

	const handleToggleTabEnterToSend = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const currentActiveTab = getActiveTab(session);
		if (!currentActiveTab) return;
		const globalDefault = useSettingsStore.getState().enterToSendAI;
		updateAiTab(session.id, currentActiveTab.id, (tab) => ({
			...tab,
			enterToSend: !(tab.enterToSend ?? globalDefault),
		}));
	}, []);

	return {
		performTabClose,
		handleNewAgentSession,
		handleTabSelect,
		handleTabClose,
		handleNewTab,
		handleTabReorder,
		handleCloseAllTabs,
		handleRequestTabRename,
		handleUpdateTabByClaudeSessionId,
		handleTabStar,
		handleTabMarkUnread,
		handleToggleTabReadOnlyMode,
		handleToggleTabSaveToHistory,
		handleToggleTabShowThinking,
		handleToggleTabEnterToSend,
	};
}

import { useCallback } from 'react';
import type { ThinkingMode } from '../../../../shared/types';
import { useInlineWizardContext } from '../../../contexts/InlineWizardContext';
import { useModalStore } from '../../../stores/modalStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { selectActiveSession, updateAiTab, useSessionStore } from '../../../stores/sessionStore';
import type { Session } from '../../../types';
import { clearLiveDraft } from '../../../utils/liveDraftStore';
import { logger } from '../../../utils/logger';
import { persistTabStarred } from '../../../utils/starredSessions';
import {
	addAiTabToUnifiedHistory,
	closeTab,
	createTab,
	getActiveTab,
	getInitialRenameValue,
	getTabDisplayName,
	hasActiveWizard,
	hasDraft,
	hasWizardInteraction,
	restoreOrphanedTab,
	setActiveTab,
	toggleReadOnlyModeFields,
} from '../../../utils/tabHelpers';
import type { AITabHandlersReturn } from './types';

export function useAITabHandlers(): AITabHandlersReturn {
	const { endWizard: endInlineWizard } = useInlineWizardContext();

	const handleNewAgentSession = useCallback(() => {
		const { setSessions } = useSessionStore.getState();
		const activeSessionId = useSessionStore.getState().activeSessionId;
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();

		setSessions((prev: Session[]) => {
			const currentSession = prev.find((s) => s.id === activeSessionId);
			if (!currentSession) return prev;
			return prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				const result = createTab(s, {
					saveToHistory: defaultSaveToHistory,
					showThinking: defaultShowThinking,
				});
				if (!result) return s;
				return result.session;
			});
		});
		useModalStore.getState().closeModal('agentSessions');
	}, []);

	const handleTabSelect = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				if (s.orphanedThinkingTabs?.some((t) => t.id === tabId)) {
					const restored = restoreOrphanedTab(s, tabId);
					if (restored) return restored.session;
				}
				const result = setActiveTab(s, tabId);
				return result ? result.session : s;
			})
		);
	}, []);

	const performTabClose = useCallback(
		(tabId: string) => {
			const { setSessions, activeSessionId } = useSessionStore.getState();
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
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
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
				})
			);

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

	const handleNewTab = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = createTab(s, {
					saveToHistory: defaultSaveToHistory,
					showThinking: defaultShowThinking,
				});
				if (!result) return s;
				return result.session;
			})
		);
	}, []);

	const performCloseAllTabs = useCallback(() => {
		const { setSessions, activeSessionId, sessions } = useSessionStore.getState();
		const activeSession = sessions.find((s) => s.id === activeSessionId);
		activeSession?.aiTabs.forEach((t) => clearLiveDraft(t.id));

		const wizardTabIds = (activeSession?.aiTabs ?? [])
			.filter((t) => hasActiveWizard(t))
			.map((t) => t.id);

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				let updatedSession = s;
				const tabIds = s.aiTabs.map((t) => t.id);
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
			})
		);

		for (const tabId of wizardTabIds) {
			endInlineWizard(tabId).catch((error) =>
				logger.warn('[useTabHandlers] Failed to end wizard on close-all:', undefined, error)
			);
		}
	}, [endInlineWizard]);

	const handleCloseAllTabs = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;

		const hasAnyDraft = session.aiTabs.some((tab) => hasDraft(tab));
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
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = session.aiTabs?.find((t) => t.id === tabId);
		if (tab) {
			if (tab.isGeneratingName) {
				setSessions((prev: Session[]) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, isGeneratingName: false } : t)),
						};
					})
				);
			}
			useModalStore.getState().openModal('renameTab', {
				tabId,
				initialName: getInitialRenameValue(tab),
			});
		}
	}, []);

	const handleTabReorder = useCallback((fromIndex: number, toIndex: number) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId || !s.aiTabs) return s;
				const tabs = [...s.aiTabs];
				const [movedTab] = tabs.splice(fromIndex, 1);
				tabs.splice(toIndex, 0, movedTab);
				return { ...s, aiTabs: tabs };
			})
		);
	}, []);

	const handleUpdateTabByClaudeSessionId = useCallback(
		(agentSessionId: string, updates: { name?: string | null; starred?: boolean }) => {
			const { setSessions, activeSessionId } = useSessionStore.getState();
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
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
				})
			);
		},
		[]
	);

	const handleTabStar = useCallback((tabId: string, starred: boolean) => {
		const { setSessions } = useSessionStore.getState();
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tabToStar = session.aiTabs.find((t) => t.id === tabId);
		if (!tabToStar?.agentSessionId) return;

		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== session.id) return s;
				const tab = s.aiTabs.find((t) => t.id === tabId);
				if (tab) {
					persistTabStarred(s, tab, starred);
				}
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, starred } : t)),
				};
			})
		);
	}, []);

	const handleTabMarkUnread = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, hasUnread: true } : t)),
				};
			})
		);
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

		const cycleThinkingMode = (current: ThinkingMode | undefined): ThinkingMode => {
			if (!current || current === 'off') return 'on';
			if (current === 'on') return 'sticky';
			return 'off';
		};

		updateAiTab(session.id, currentActiveTab.id, (tab) => {
			const newMode = cycleThinkingMode(tab.showThinking);
			if (newMode === 'off') {
				// Only thinking logs are storage-gated. Tool logs are always recorded
				// and hidden purely at render (see the global tool-call visibility
				// setting + TerminalOutput), so turning thinking off must never drop them.
				return {
					...tab,
					showThinking: 'off',
					logs: tab.logs.filter((l) => l.source !== 'thinking'),
				};
			}
			return { ...tab, showThinking: newMode };
		});
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

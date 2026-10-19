import { useCallback, type RefObject } from 'react';
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
import { snapshotClosedTabTranscript } from '../../../utils/starredSessions';
import { isWebDesktop } from '../../../utils/runtimeContext';
import { requestDesktopTabClose, requestDesktopTabCloses } from '../../../services/desktopTabClose';
import { noteDesktopAiTabSelection } from '../../../utils/desktopTabSelectionSync';
import { closeAiTabWithConfirm } from '../../../services/tabCloseConfirm';
import {
	cycleAiTabShowThinking,
	markAiTabUnread,
	setAiTabStarred,
	toggleAiTabEnterToSend,
	toggleAiTabReadOnlyMode,
	toggleAiTabSaveToHistory,
	type AiTabTarget,
} from '../../../services/aiTabActions';
import {
	addAiTabToUnifiedHistory,
	aiTabFocusFields,
	closeTab,
	createTab,
	getActiveTab,
	getInitialRenameValue,
	hasActiveWizard,
	restoreOrphanedTab,
	setActiveTab,
	ownerVisibleAiTabs,
	hasDraft,
} from '../../../utils/tabHelpers';
import type { AITabHandlersReturn } from './types';

/** The active agent's active AI tab, as an action target. */
function activeAiTabTarget(): AiTabTarget | null {
	const session = selectActiveSession(useSessionStore.getState());
	const tab = session ? getActiveTab(session) : undefined;
	return session && tab ? { sessionId: session.id, tabId: tab.id } : null;
}

/** Manage AI tabs, delegating browser inventory changes to the owning desktop. */
export function useAITabHandlers(
	inputRef?: RefObject<HTMLTextAreaElement | null>
): AITabHandlersReturn {
	const { endWizard: endInlineWizard } = useInlineWizardContext();

	const createNewAITab = useCallback(() => {
		const { activeSessionId } = useSessionStore.getState();
		const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
		if (!activeSessionId) return;

		if (isWebDesktop()) {
			// Focus the composer SYNCHRONOUSLY, inside the tap that asked for the
			// tab. iOS raises the on-screen keyboard only for a focus() that runs
			// in the user gesture's own call stack, and the tab itself is minted by
			// the desktop a WebSocket round trip away - so a focus deferred until
			// the answer lands moves the caret and leaves the keyboard down, which
			// on a phone means tapping the composer anyway. The textarea is not
			// keyed on the tab, so it keeps focus through the switch below.
			inputRef?.current?.focus();
			// Create on the host without moving another client's selected session or tab.
			void window.maestro.web
				.requestNewTab(activeSessionId, true)
				.then((result) => {
					if (!result?.tabId) return;
					// Draw the tab NOW rather than waiting to be told about it. The
					// desktop owns the tab inventory and publishes it from a 500ms
					// poll (`useRemoteIntegration`), so a client that only reacted to
					// the broadcast sat there doing nothing for up to half a second
					// after the tap. The answer already carries the id the desktop
					// minted, so adopt it: the inventory sync that follows matches on
					// id and keeps the tab this client already has.
					updateSessionWith(activeSessionId, (session) => {
						// The broadcast can win the race. Then the tab is already here
						// and all that is left is to make it the visible one - an
						// inventory snapshot deliberately never moves a browser
						// client's tab, since that focus belongs to whoever holds this
						// client, not to whoever is at the desktop.
						if (session.aiTabs.some((tab) => tab.id === result.tabId)) {
							return { ...session, ...aiTabFocusFields(result.tabId) };
						}
						const created = createTab(session, {
							id: result.tabId,
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
						});
						return created?.session ?? session;
					});
				})
				.catch((error) =>
					logger.error('[useAITabHandlers] Failed to create desktop tab:', undefined, error)
				);
			return;
		}

		updateSessionWith(activeSessionId, (session) => {
			const result = createTab(session, {
				saveToHistory: defaultSaveToHistory,
				showThinking: defaultShowThinking,
			});
			return result?.session ?? session;
		});
	}, [inputRef]);

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

	// `sessionId` names the agent when it is not the active one: a tab window's
	// owner closes a popped tab, which is never its active tab (Tab Windows).
	const performTabClose = useCallback(
		(tabId: string, sessionId?: string) => {
			const activeSessionId = sessionId ?? useSessionStore.getState().activeSessionId;
			const sessionBeforeClose = useSessionStore
				.getState()
				.sessions.find((s) => s.id === activeSessionId);
			const tabBeforeClose = sessionBeforeClose?.aiTabs.find((t) => t.id === tabId);
			const wasWizardTab = !!tabBeforeClose && hasActiveWizard(tabBeforeClose);

			if (isWebDesktop()) {
				void requestDesktopTabClose(activeSessionId, tabId, endInlineWizard);
				return;
			}
			if (sessionBeforeClose && tabBeforeClose) {
				snapshotClosedTabTranscript(sessionBeforeClose, tabBeforeClose);
			}

			clearLiveDraft(tabId);
			updateSessionWith(activeSessionId, (s) => {
				const tab = s.aiTabs.find((t) => t.id === tabId);
				const isWizardTab = tab && hasActiveWizard(tab);
				const unifiedIndex = s.unifiedTabOrder.findIndex(
					(ref) => ref.type === 'ai' && ref.id === tabId
				);
				// `undefined` = read the live unread-filter state, so closing a tab while
				// the strip is narrowed lands on a tab the user can still see.
				const result = closeTab(s, tabId, undefined, { skipHistory: isWizardTab });
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
			closeAiTabWithConfirm(tab, () => performTabClose(tabId));
		},
		[performTabClose]
	);

	const handleNewTab = createNewAITab;

	// "Close all" means every tab the user can see. Hidden consult tabs (unopened
	// cross-agent @mentions) have no chip, so closing one here would silently
	// destroy a transcript and its resume id the user was never shown. Tabs popped
	// out into a tab window are not in this window's strip either (D4).
	const performCloseAllTabs = useCallback(() => {
		const { activeSessionId, sessions } = useSessionStore.getState();
		const activeSession = sessions.find((s) => s.id === activeSessionId);
		if (isWebDesktop()) {
			void requestDesktopTabCloses(
				activeSessionId,
				ownerVisibleAiTabs(activeSessionId, activeSession?.aiTabs).map((tab) => tab.id),
				endInlineWizard
			);
			return;
		}
		ownerVisibleAiTabs(activeSessionId, activeSession?.aiTabs).forEach((t) => clearLiveDraft(t.id));

		const wizardTabIds = ownerVisibleAiTabs(activeSessionId, activeSession?.aiTabs)
			.filter((t) => hasActiveWizard(t))
			.map((t) => t.id);

		updateSessionWith(activeSessionId, (s) => {
			let updatedSession = s;
			const tabIds = ownerVisibleAiTabs(s.id, s.aiTabs).map((t) => t.id);
			for (const tabId of tabIds) {
				const tab = updatedSession.aiTabs.find((t) => t.id === tabId);
				// Filter state is irrelevant: no tab survives to be selected.
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

		const hasAnyDraft = ownerVisibleAiTabs(session.id, session.aiTabs).some((tab) => hasDraft(tab));
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

	// The per-tab marks and settings below are the shared explicit-target actions
	// (services/aiTabActions.ts), run here on the active agent. A tab window's
	// owner runs the same ones on the tab its intent names.
	const handleTabStar = useCallback((tabId: string, starred: boolean) => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		setAiTabStarred({ sessionId: session.id, tabId }, starred);
	}, []);

	const handleTabMarkUnread = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		markAiTabUnread({ sessionId: activeSessionId, tabId });
	}, []);

	const handleToggleTabReadOnlyMode = useCallback(() => {
		const target = activeAiTabTarget();
		if (target) toggleAiTabReadOnlyMode(target);
	}, []);

	const handleToggleTabSaveToHistory = useCallback(() => {
		const target = activeAiTabTarget();
		if (target) toggleAiTabSaveToHistory(target);
	}, []);

	const handleToggleTabShowThinking = useCallback(() => {
		const target = activeAiTabTarget();
		if (target) cycleAiTabShowThinking(target);
	}, []);

	const handleToggleTabEnterToSend = useCallback(() => {
		const target = activeAiTabTarget();
		if (target) toggleAiTabEnterToSend(target);
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

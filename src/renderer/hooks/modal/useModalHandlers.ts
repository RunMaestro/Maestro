/**
 * useModalHandlers — Extracted from App.tsx (Phase 2C)
 *
 * Handles all modal open/close lifecycle callbacks, agent error recovery,
 * lightbox navigation, celebration modals, leaderboard, quit confirmation,
 * and quick-action modal openers.
 *
 * Reads from: useModalStore, useSettingsStore, useSessionStore,
 *             useGroupChatStore, useAgentStore
 *
 * NOTE: getModalActions() calls are a legacy shim that wraps modalStore methods
 * for backward compatibility. New code should prefer useModalStore.getState()
 * directly. These will be migrated in a future cleanup pass.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { Session, LeaderboardRegistration } from '../../types';
import type { RecoveryAction } from '../../components/AgentErrorModal';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useAgentStore } from '../../stores/agentStore';
import { useAgentErrorRecovery } from '../agent/useAgentErrorRecovery';
import { getInitialRenameValue } from '../../utils/tabHelpers';
import { CONDUCTOR_BADGES } from '../../constants/conductorBadges';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModalHandlersReturn {
	// Derived state
	errorSession: Session | null;
	recoveryActions: RecoveryAction[];

	// Simple close handlers
	handleCloseGitDiff: () => void;
	handleCloseGitLog: () => void;
	handleCloseSettings: () => void;
	handleCloseDebugPackage: () => void;
	handleCloseShortcutsHelp: () => void;
	handleCloseAboutModal: () => void;
	handleCloseUpdateCheckModal: () => void;
	handleCloseProcessMonitor: () => void;
	handleCloseLogViewer: () => void;
	handleCloseConfirmModal: () => void;

	// Session-related close handlers
	handleCloseDeleteAgentModal: () => void;
	handleCloseNewInstanceModal: () => void;
	handleCloseEditAgentModal: () => void;
	handleCloseRenameSessionModal: () => void;
	handleCloseRenameTabModal: () => void;

	// Quit handlers
	handleConfirmQuit: () => void;
	handleCancelQuit: () => void;

	// Celebration handlers
	onKeyboardMasteryLevelUp: (level: number) => void;
	handleKeyboardMasteryCelebrationClose: () => void;
	handleStandingOvationClose: () => void;
	handleFirstRunCelebrationClose: () => void;

	// Leaderboard handlers
	handleOpenLeaderboardRegistration: () => void;
	handleOpenLeaderboardRegistrationFromAbout: () => void;
	handleCloseLeaderboardRegistration: () => void;
	handleSaveLeaderboardRegistration: (registration: LeaderboardRegistration) => void;
	handleLeaderboardOptOut: () => void;

	// Agent error handlers
	handleCloseAgentErrorModal: () => void;
	handleShowAgentErrorModal: () => void;
	handleClearAgentError: (sessionId: string, tabId?: string) => void;
	handleStartNewSessionAfterError: (sessionId: string) => void;
	handleRetryAfterError: (sessionId: string) => void;
	handleRestartAgentAfterError: (sessionId: string) => Promise<void>;
	handleAuthenticateAfterError: (sessionId: string) => void;

	// Open handlers
	handleOpenQueueBrowser: () => void;
	handleOpenTabSearch: () => void;
	handleOpenPromptComposer: () => void;
	handleOpenFuzzySearch: () => void;
	handleOpenCreatePR: () => void;
	handleOpenAboutModal: () => void;
	handleOpenBatchRunner: () => void;
	handleOpenMarketplace: () => void;

	// Session list openers
	handleEditAgent: (session: Session) => void;
	handleOpenCreatePRSession: (session: Session) => void;

	// Tour
	handleStartTour: () => void;

	// Lightbox
	handleSetLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	handleCloseLightbox: () => void;
	handleNavigateLightbox: (img: string) => void;
	handleDeleteLightboxImage: (img: string) => void;

	// Utility close handlers
	handleCloseAutoRunSetup: () => void;
	handleCloseBatchRunner: () => void;
	handleCloseTabSwitcher: () => void;
	handleCloseFileSearch: () => void;
	handleClosePromptComposer: () => void;
	handleCloseCreatePRModal: () => void;
	handleCloseSendToAgent: () => void;
	handleCloseQueueBrowser: () => void;
	handleCloseRenameGroupModal: () => void;

	// Quick actions modal openers
	handleQuickActionsRenameTab: () => void;
	handleQuickActionsOpenTabSwitcher: () => void;
	handleQuickActionsStartTour: () => void;
	handleQuickActionsEditAgent: (session: Session) => void;
	handleQuickActionsOpenMergeSession: () => void;
	handleQuickActionsOpenSendToAgent: () => void;
	handleQuickActionsOpenCreatePR: (session: Session) => void;

	// LogViewer shortcut handler
	handleLogViewerShortcutUsed: (shortcutId: string) => void;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const selectAgentErrorSessionId = (s: ReturnType<typeof useModalStore.getState>) =>
	s.getData('agentError')?.sessionId ?? null;
const selectLogViewerOpen = (s: ReturnType<typeof useModalStore.getState>) => s.isOpen('logViewer');
const selectShortcutsHelpOpen = (s: ReturnType<typeof useModalStore.getState>) =>
	s.isOpen('shortcutsHelp');

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useModalHandlers(
	inputRef: React.RefObject<HTMLTextAreaElement | null>,
	terminalOutputRef: React.RefObject<HTMLDivElement | null>
): ModalHandlersReturn {
	// --- Reactive subscriptions (for derived state & effects) ---
	const agentErrorModalSessionId = useModalStore(selectAgentErrorSessionId);
	const sessions = useSessionStore((s) => s.sessions);
	const logViewerOpen = useModalStore(selectLogViewerOpen);
	const shortcutsHelpOpen = useModalStore(selectShortcutsHelpOpen);
	const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);

	// ====================================================================
	// Derived State
	// ====================================================================

	const errorSession = useMemo(
		() =>
			agentErrorModalSessionId
				? (sessions.find((s) => s.id === agentErrorModalSessionId) ?? null)
				: null,
		[agentErrorModalSessionId, sessions]
	);

	// ====================================================================
	// Group A: Simple Close Handlers
	// ====================================================================

	const handleCloseGitDiff = useCallback(() => {
		getModalActions().setGitDiffPreview(null);
	}, []);

	const handleCloseGitLog = useCallback(() => {
		getModalActions().setGitLogOpen(false);
	}, []);

	const handleCloseSettings = useCallback(() => {
		getModalActions().setSettingsModalOpen(false);
	}, []);

	const handleCloseDebugPackage = useCallback(() => {
		getModalActions().setDebugPackageModalOpen(false);
	}, []);

	const handleCloseShortcutsHelp = useCallback(() => {
		getModalActions().setShortcutsHelpOpen(false);
	}, []);

	const handleCloseAboutModal = useCallback(() => {
		getModalActions().setAboutModalOpen(false);
	}, []);

	const handleCloseUpdateCheckModal = useCallback(() => {
		getModalActions().setUpdateCheckModalOpen(false);
	}, []);

	const handleCloseProcessMonitor = useCallback(() => {
		getModalActions().setProcessMonitorOpen(false);
	}, []);

	const handleCloseLogViewer = useCallback(() => {
		getModalActions().setLogViewerOpen(false);
	}, []);

	const handleCloseConfirmModal = useCallback(() => {
		getModalActions().setConfirmModalOpen(false);
	}, []);

	// ====================================================================
	// Group B: Session-Related Close Handlers
	// ====================================================================

	const handleCloseDeleteAgentModal = useCallback(() => {
		// setDeleteAgentSession(null) calls closeModal('deleteAgent') which clears both
		// the open state and the session data — no separate setDeleteAgentModalOpen needed.
		getModalActions().setDeleteAgentSession(null);
	}, []);

	const handleCloseNewInstanceModal = useCallback(() => {
		getModalActions().setNewInstanceModalOpen(false);
		getModalActions().setDuplicatingSessionId(null);
	}, []);

	const handleCloseEditAgentModal = useCallback(() => {
		// setEditAgentSession(null) calls closeModal('editAgent') which clears both
		// the open state and the session data — no separate setEditAgentModalOpen needed.
		getModalActions().setEditAgentSession(null);
	}, []);

	const handleCloseRenameSessionModal = useCallback(() => {
		getModalActions().setRenameInstanceModalOpen(false);
		getModalActions().setRenameInstanceSessionId(null);
	}, []);

	const handleCloseRenameTabModal = useCallback(() => {
		getModalActions().setRenameTabModalOpen(false);
		getModalActions().setRenameTabId(null);
	}, []);

	// ====================================================================
	// Group C: Quit Handlers
	// ====================================================================

	const handleConfirmQuit = useCallback(() => {
		getModalActions().setQuitConfirmModalOpen(false);
		window.maestro.app.confirmQuit();
	}, []);

	const handleCancelQuit = useCallback(() => {
		getModalActions().setQuitConfirmModalOpen(false);
		window.maestro.app.cancelQuit();
	}, []);

	// ====================================================================
	// Group D: Celebration Handlers
	// ====================================================================

	const onKeyboardMasteryLevelUp = useCallback((level: number) => {
		getModalActions().setPendingKeyboardMasteryLevel(level);
	}, []);

	const handleKeyboardMasteryCelebrationClose = useCallback(() => {
		const pendingLevel = useModalStore.getState().getData('keyboardMastery')?.level ?? null;
		if (pendingLevel !== null) {
			useSettingsStore.getState().acknowledgeKeyboardMasteryLevel(pendingLevel);
		}
		getModalActions().setPendingKeyboardMasteryLevel(null);
	}, []);

	const handleStandingOvationClose = useCallback(() => {
		const data = useModalStore.getState().getData('standingOvation');
		if (data) {
			useSettingsStore.getState().acknowledgeBadge(data.badge.level);
		}
		getModalActions().setStandingOvationData(null);
	}, []);

	const handleFirstRunCelebrationClose = useCallback(() => {
		getModalActions().setFirstRunCelebrationData(null);
	}, []);

	const handleLogViewerShortcutUsed = useCallback(
		(shortcutId: string) => {
			const result = useSettingsStore.getState().recordShortcutUsage(shortcutId);
			if (result.newLevel !== null) {
				onKeyboardMasteryLevelUp(result.newLevel);
			}
		},
		[onKeyboardMasteryLevelUp]
	);

	// ====================================================================
	// Group E: Leaderboard Handlers
	// ====================================================================

	const handleOpenLeaderboardRegistration = useCallback(() => {
		getModalActions().setLeaderboardRegistrationOpen(true);
	}, []);

	const handleOpenLeaderboardRegistrationFromAbout = useCallback(() => {
		getModalActions().setAboutModalOpen(false);
		getModalActions().setLeaderboardRegistrationOpen(true);
	}, []);

	const handleCloseLeaderboardRegistration = useCallback(() => {
		getModalActions().setLeaderboardRegistrationOpen(false);
	}, []);

	const handleSaveLeaderboardRegistration = useCallback((registration: LeaderboardRegistration) => {
		useSettingsStore.getState().setLeaderboardRegistration(registration);
	}, []);

	const handleLeaderboardOptOut = useCallback(() => {
		useSettingsStore.getState().setLeaderboardRegistration(null);
	}, []);

	// ====================================================================
	// Group F: Agent Error Handlers
	// ====================================================================

	const handleCloseAgentErrorModal = useCallback(() => {
		getModalActions().setAgentErrorModalSessionId(null);
	}, []);

	const handleShowAgentErrorModal = useCallback(() => {
		const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
		const currentSession = currentSessions.find((s) => s.id === activeSessionId);
		if (!currentSession) return;
		const activeTab = currentSession.aiTabs.find((t) => t.id === currentSession.activeTabId);
		if (!activeTab?.agentError) return;
		getModalActions().setAgentErrorModalSessionId(currentSession.id);
	}, []);

	const handleClearAgentError = useCallback((sessionId: string, tabId?: string) => {
		useAgentStore.getState().clearAgentError(sessionId, tabId);
		getModalActions().setAgentErrorModalSessionId(null);
	}, []);

	const handleStartNewSessionAfterError = useCallback(
		(sessionId: string) => {
			const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
			useAgentStore.getState().startNewSessionAfterError(sessionId, {
				saveToHistory: defaultSaveToHistory,
				showThinking: defaultShowThinking,
			});
			getModalActions().setAgentErrorModalSessionId(null);
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[inputRef]
	);

	const handleRetryAfterError = useCallback(
		(sessionId: string) => {
			useAgentStore.getState().retryAfterError(sessionId);
			getModalActions().setAgentErrorModalSessionId(null);
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[inputRef]
	);

	const handleRestartAgentAfterError = useCallback(
		async (sessionId: string) => {
			await useAgentStore.getState().restartAgentAfterError(sessionId);
			getModalActions().setAgentErrorModalSessionId(null);
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[inputRef]
	);

	const handleAuthenticateAfterError = useCallback(
		(sessionId: string) => {
			useAgentStore.getState().authenticateAfterError(sessionId);
			getModalActions().setAgentErrorModalSessionId(null);
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[inputRef]
	);

	// Use the agent error recovery hook to get recovery actions
	const { recoveryActions } = useAgentErrorRecovery({
		error: errorSession?.agentError,
		agentId: errorSession?.toolType || 'claude-code',
		sessionId: errorSession?.id || '',
		onNewSession: errorSession ? () => handleStartNewSessionAfterError(errorSession.id) : undefined,
		onRetry: errorSession ? () => handleRetryAfterError(errorSession.id) : undefined,
		onClearError: errorSession ? () => handleClearAgentError(errorSession.id) : undefined,
		onRestartAgent: errorSession ? () => handleRestartAgentAfterError(errorSession.id) : undefined,
		onAuthenticate: errorSession ? () => handleAuthenticateAfterError(errorSession.id) : undefined,
	});

	// ====================================================================
	// Group G: Simple Open Handlers
	// ====================================================================

	const handleOpenQueueBrowser = useCallback(() => {
		getModalActions().setQueueBrowserOpen(true);
	}, []);

	const handleOpenTabSearch = useCallback(() => {
		getModalActions().setTabSwitcherOpen(true);
	}, []);

	const handleOpenPromptComposer = useCallback(() => {
		getModalActions().setPromptComposerOpen(true);
	}, []);

	const handleOpenFuzzySearch = useCallback(() => {
		getModalActions().setFuzzyFileSearchOpen(true);
	}, []);

	const handleOpenCreatePR = useCallback(() => {
		getModalActions().setCreatePRModalOpen(true);
	}, []);

	const handleOpenAboutModal = useCallback(() => {
		getModalActions().setAboutModalOpen(true);
	}, []);

	const handleOpenBatchRunner = useCallback(() => {
		getModalActions().setBatchRunnerModalOpen(true);
	}, []);

	const handleOpenMarketplace = useCallback(() => {
		getModalActions().setMarketplaceModalOpen(true);
	}, []);

	// ====================================================================
	// Group H: Session List Modal Openers
	// ====================================================================

	const handleEditAgent = useCallback((session: Session) => {
		getModalActions().setEditAgentSession(session);
	}, []);

	const handleOpenCreatePRSession = useCallback((session: Session) => {
		getModalActions().setCreatePRSession(session);
	}, []);

	// ====================================================================
	// Group I: Tour Handler
	// ====================================================================

	const handleStartTour = useCallback(() => {
		getModalActions().setTourFromWizard(false);
		getModalActions().setTourOpen(true);
	}, []);

	// ====================================================================
	// Group J: Lightbox Handlers
	// ====================================================================

	const handleSetLightboxImage = useCallback(
		(image: string | null, contextImages?: string[], source: 'staged' | 'history' = 'history') => {
			const { activeGroupChatId } = useGroupChatStore.getState();
			const actions = getModalActions();
			// setLightboxImage opens the modal — must be called first so that
			// subsequent updateModalData calls (isGroupChat, allowDelete) find an active modal.
			actions.setLightboxImage(image);
			actions.setLightboxIsGroupChat(activeGroupChatId !== null);
			actions.setLightboxAllowDelete(source === 'staged');
			actions.setLightboxImages(contextImages || []);
			actions.setLightboxSource(source);
		},
		[]
	);

	const handleCloseLightbox = useCallback(() => {
		const actions = getModalActions();
		actions.setLightboxImage(null);
		actions.setLightboxImages([]);
		actions.setLightboxSource('history');
		actions.setLightboxIsGroupChat(false);
		actions.setLightboxAllowDelete(false);
		setTimeout(() => inputRef.current?.focus(), 0);
	}, [inputRef]);

	const handleNavigateLightbox = useCallback((img: string) => {
		getModalActions().setLightboxImage(img);
	}, []);

	const handleDeleteLightboxImage = useCallback((img: string) => {
		const lightboxData = useModalStore.getState().getData('lightbox');
		const isGroupChat = lightboxData?.isGroupChat ?? false;

		if (isGroupChat) {
			useGroupChatStore
				.getState()
				.setGroupChatStagedImages((prev) => prev.filter((i) => i !== img));
		} else {
			// Update staged images for active tab in session store
			const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
			const session = currentSessions.find((s) => s.id === activeSessionId);
			if (session) {
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== s.activeTabId) return tab;
								return {
									...tab,
									stagedImages: (tab.stagedImages || []).filter((i) => i !== img),
								};
							}),
						};
					})
				);
			}
		}

		// Update lightbox images so navigation stays in sync
		const currentImages = lightboxData?.images ?? [];
		getModalActions().setLightboxImages(currentImages.filter((i) => i !== img));
	}, []);

	// ====================================================================
	// Group K: Utility Close Handlers
	// ====================================================================

	const handleCloseAutoRunSetup = useCallback(() => {
		getModalActions().setAutoRunSetupModalOpen(false);
	}, []);

	const handleCloseBatchRunner = useCallback(() => {
		getModalActions().setBatchRunnerModalOpen(false);
	}, []);

	const handleCloseTabSwitcher = useCallback(() => {
		getModalActions().setTabSwitcherOpen(false);
	}, []);

	const handleCloseFileSearch = useCallback(() => {
		getModalActions().setFuzzyFileSearchOpen(false);
	}, []);

	const handleClosePromptComposer = useCallback(() => {
		getModalActions().setPromptComposerOpen(false);
		setTimeout(() => inputRef.current?.focus(), 0);
	}, [inputRef]);

	const handleCloseCreatePRModal = useCallback(() => {
		getModalActions().setCreatePRModalOpen(false);
		getModalActions().setCreatePRSession(null);
	}, []);

	const handleCloseSendToAgent = useCallback(() => {
		getModalActions().setSendToAgentModalOpen(false);
	}, []);

	const handleCloseQueueBrowser = useCallback(() => {
		getModalActions().setQueueBrowserOpen(false);
	}, []);

	const handleCloseRenameGroupModal = useCallback(() => {
		getModalActions().setRenameGroupModalOpen(false);
	}, []);

	// ====================================================================
	// Group M: Quick Actions Modal Openers
	// ====================================================================

	const handleQuickActionsRenameTab = useCallback(() => {
		const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
		const currentSession = currentSessions.find((s) => s.id === activeSessionId);
		if (currentSession?.inputMode === 'ai' && currentSession.activeTabId) {
			const activeTab = currentSession.aiTabs?.find((t) => t.id === currentSession.activeTabId);
			if (activeTab?.agentSessionId) {
				const actions = getModalActions();
				actions.setRenameTabId(activeTab.id);
				actions.setRenameTabInitialName(getInitialRenameValue(activeTab));
				actions.setRenameTabModalOpen(true);
			}
		}
	}, []);

	const handleQuickActionsOpenTabSwitcher = useCallback(() => {
		const { sessions: currentSessions, activeSessionId } = useSessionStore.getState();
		const currentSession = currentSessions.find((s) => s.id === activeSessionId);
		if (currentSession?.inputMode === 'ai' && currentSession.aiTabs) {
			getModalActions().setTabSwitcherOpen(true);
		}
	}, []);

	const handleQuickActionsStartTour = useCallback(() => {
		getModalActions().setTourFromWizard(false);
		getModalActions().setTourOpen(true);
	}, []);

	const handleQuickActionsEditAgent = useCallback((session: Session) => {
		getModalActions().setEditAgentSession(session);
	}, []);

	const handleQuickActionsOpenMergeSession = useCallback(() => {
		getModalActions().setMergeSessionModalOpen(true);
	}, []);

	const handleQuickActionsOpenSendToAgent = useCallback(() => {
		getModalActions().setSendToAgentModalOpen(true);
	}, []);

	const handleQuickActionsOpenCreatePR = useCallback((session: Session) => {
		getModalActions().setCreatePRSession(session);
	}, []);

	// ====================================================================
	// Effects
	// ====================================================================

	// Restore focus when LogViewer closes to ensure global hotkeys work
	useEffect(() => {
		if (!logViewerOpen) {
			setTimeout(() => {
				if (inputRef.current) {
					inputRef.current.focus();
				} else if (terminalOutputRef.current) {
					terminalOutputRef.current.focus();
				} else {
					(document.activeElement as HTMLElement)?.blur();
					document.body.focus();
				}
			}, 50);
		}
	}, [logViewerOpen, inputRef, terminalOutputRef]);

	// Reset shortcuts search when modal closes
	useEffect(() => {
		if (!shortcutsHelpOpen) {
			getModalActions().setShortcutsSearchQuery('');
		}
	}, [shortcutsHelpOpen]);

	// Check for unacknowledged badges on startup (show missed standing ovations)
	useEffect(() => {
		if (settingsLoaded && sessionsLoaded) {
			const { getUnacknowledgedBadgeLevel, autoRunStats } = useSettingsStore.getState();
			const unacknowledgedLevel = getUnacknowledgedBadgeLevel();
			if (unacknowledgedLevel !== null) {
				const badge = CONDUCTOR_BADGES.find((b) => b.level === unacknowledgedLevel);
				if (badge) {
					// Show the standing ovation overlay for the missed badge
					// Small delay to ensure UI is fully rendered
					setTimeout(() => {
						getModalActions().setStandingOvationData({
							badge,
							isNewRecord: false, // We don't know if it was a record, so default to false
							recordTimeMs: autoRunStats.longestRunMs,
						});
					}, 1000);
				}
			}
		}
		// autoRunStats.longestRunMs and getUnacknowledgedBadgeLevel intentionally omitted -
		// this effect runs once on startup to check for missed badges, not on every stats update
	}, [settingsLoaded, sessionsLoaded]);

	// Check for unacknowledged badges when user returns to the app
	// Uses multiple triggers: visibility change, window focus, and mouse activity
	// This catches badges earned during overnight Auto Runs when display was off
	useEffect(() => {
		if (!settingsLoaded || !sessionsLoaded) return;

		// Debounce to avoid showing multiple times
		let checkPending = false;

		const checkForUnacknowledgedBadge = () => {
			// Don't show if there's already an ovation displayed
			const currentOvation = useModalStore.getState().getData('standingOvation');
			if (currentOvation) return;
			if (checkPending) return;

			const { getUnacknowledgedBadgeLevel, autoRunStats } = useSettingsStore.getState();
			const unacknowledgedLevel = getUnacknowledgedBadgeLevel();
			if (unacknowledgedLevel !== null) {
				const badge = CONDUCTOR_BADGES.find((b) => b.level === unacknowledgedLevel);
				if (badge) {
					checkPending = true;
					// Small delay to let the UI stabilize
					setTimeout(() => {
						// Double-check in case it was acknowledged in the meantime
						if (!useModalStore.getState().getData('standingOvation')) {
							getModalActions().setStandingOvationData({
								badge,
								isNewRecord: false,
								recordTimeMs: autoRunStats.longestRunMs,
							});
						}
						checkPending = false;
					}, 500);
				}
			}
		};

		const handleVisibilityChange = () => {
			// Only check when becoming visible
			if (!document.hidden) {
				checkForUnacknowledgedBadge();
			}
		};

		const handleWindowFocus = () => {
			// Window gained focus - user is actively looking at the app
			checkForUnacknowledgedBadge();
		};

		// Mouse move handler with heavy debounce - only triggers once per 30 seconds
		let lastMouseCheck = 0;
		const handleMouseMove = () => {
			const now = Date.now();
			if (now - lastMouseCheck > 30000) {
				// 30 second debounce
				lastMouseCheck = now;
				checkForUnacknowledgedBadge();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('focus', handleWindowFocus);
		document.addEventListener('mousemove', handleMouseMove, { passive: true });

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('focus', handleWindowFocus);
			document.removeEventListener('mousemove', handleMouseMove);
		};
	}, [settingsLoaded, sessionsLoaded]);

	// Check for unacknowledged keyboard mastery levels on startup
	useEffect(() => {
		if (settingsLoaded && sessionsLoaded) {
			const unacknowledgedLevel = useSettingsStore
				.getState()
				.getUnacknowledgedKeyboardMasteryLevel();
			if (unacknowledgedLevel !== null) {
				// Show the keyboard mastery level-up celebration after a short delay
				setTimeout(() => {
					getModalActions().setPendingKeyboardMasteryLevel(unacknowledgedLevel);
				}, 1200); // Slightly longer delay than badge to avoid overlap
			}
		}
		// getUnacknowledgedKeyboardMasteryLevel intentionally omitted -
		// this effect runs once on startup to check for unacknowledged levels, not on function changes
	}, [settingsLoaded, sessionsLoaded]);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		// Derived state
		errorSession,
		recoveryActions,

		// Simple close handlers
		handleCloseGitDiff,
		handleCloseGitLog,
		handleCloseSettings,
		handleCloseDebugPackage,
		handleCloseShortcutsHelp,
		handleCloseAboutModal,
		handleCloseUpdateCheckModal,
		handleCloseProcessMonitor,
		handleCloseLogViewer,
		handleCloseConfirmModal,

		// Session-related close handlers
		handleCloseDeleteAgentModal,
		handleCloseNewInstanceModal,
		handleCloseEditAgentModal,
		handleCloseRenameSessionModal,
		handleCloseRenameTabModal,

		// Quit handlers
		handleConfirmQuit,
		handleCancelQuit,

		// Celebration handlers
		onKeyboardMasteryLevelUp,
		handleKeyboardMasteryCelebrationClose,
		handleStandingOvationClose,
		handleFirstRunCelebrationClose,

		// Leaderboard handlers
		handleOpenLeaderboardRegistration,
		handleOpenLeaderboardRegistrationFromAbout,
		handleCloseLeaderboardRegistration,
		handleSaveLeaderboardRegistration,
		handleLeaderboardOptOut,

		// Agent error handlers
		handleCloseAgentErrorModal,
		handleShowAgentErrorModal,
		handleClearAgentError,
		handleStartNewSessionAfterError,
		handleRetryAfterError,
		handleRestartAgentAfterError,
		handleAuthenticateAfterError,

		// Open handlers
		handleOpenQueueBrowser,
		handleOpenTabSearch,
		handleOpenPromptComposer,
		handleOpenFuzzySearch,
		handleOpenCreatePR,
		handleOpenAboutModal,
		handleOpenBatchRunner,
		handleOpenMarketplace,

		// Session list openers
		handleEditAgent,
		handleOpenCreatePRSession,

		// Tour
		handleStartTour,

		// Lightbox
		handleSetLightboxImage,
		handleCloseLightbox,
		handleNavigateLightbox,
		handleDeleteLightboxImage,

		// Utility close handlers
		handleCloseAutoRunSetup,
		handleCloseBatchRunner,
		handleCloseTabSwitcher,
		handleCloseFileSearch,
		handleClosePromptComposer,
		handleCloseCreatePRModal,
		handleCloseSendToAgent,
		handleCloseQueueBrowser,
		handleCloseRenameGroupModal,

		// Quick actions modal openers
		handleQuickActionsRenameTab,
		handleQuickActionsOpenTabSwitcher,
		handleQuickActionsStartTour,
		handleQuickActionsEditAgent,
		handleQuickActionsOpenMergeSession,
		handleQuickActionsOpenSendToAgent,
		handleQuickActionsOpenCreatePR,

		// LogViewer shortcut handler
		handleLogViewerShortcutUsed,
	};
}

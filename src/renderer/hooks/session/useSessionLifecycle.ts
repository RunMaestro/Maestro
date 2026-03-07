/**
 * useSessionLifecycle — extracted from App.tsx (Phase 2H)
 *
 * Owns session operation callbacks and session-level effects:
 *   - handleSaveEditAgent: persist agent config changes
 *   - handleRenameTab: rename tab with multi-agent persistence
 *   - performDeleteSession: multi-step session deletion with cleanup
 *   - showConfirmation: modal coordination helper
 *   - toggleTabStar / toggleTabUnread / toggleUnreadFilter: tab state toggles
 *
 * Effects:
 *   - Groups persistence (sync groups to electron-store)
 *   - Navigation history tracking (push on session/tab change)
 *
 * Reads from: sessionStore, modalStore, uiStore
 */

import { useCallback, useEffect } from 'react';
import type { Session, AITab } from '../../types';
import type { ToolType } from '../../../shared/types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useModalStore } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { notifyToast } from '../../stores/notificationStore';
import { getActiveTab } from '../../utils/tabHelpers';
import { renameTerminalTab as renameTerminalTabHelper } from '../../utils/terminalTabHelpers';
import type { NavHistoryEntry } from './useNavigationHistory';
import { captureException } from '../../utils/sentry';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface SessionLifecycleDeps {
	/** Flush debounced session persistence immediately (from useDebouncedPersistence) */
	flushSessionPersistence: () => void;
	/** Track removed worktree paths to prevent re-discovery (from useWorktreeHandlers) */
	setRemovedWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Push a navigation entry to the shared history stack */
	pushNavigation: (entry: NavHistoryEntry) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface SessionLifecycleReturn {
	/** Save agent configuration changes (name, nudge, custom path/args/env, SSH config) */
	handleSaveEditAgent: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => void;
	/** Rename the currently-selected tab (persists to agent session storage + history) */
	handleRenameTab: (newName: string) => void;
	/** Delete a session: kill processes, clean up playbooks, optionally erase working dir */
	performDeleteSession: (session: Session, eraseWorkingDirectory: boolean) => Promise<void>;
	/** Show a confirmation modal with a message and callback */
	showConfirmation: (message: string, onConfirm: () => void) => void;
	/** Toggle star on the active tab */
	toggleTabStar: () => void;
	/** Toggle unread status on the active tab */
	toggleTabUnread: () => void;
	/** Toggle unread filter with active tab save/restore */
	toggleUnreadFilter: () => void;
}

// ============================================================================
// Selectors
// ============================================================================

const selectRenameTabId = (s: ReturnType<typeof useModalStore.getState>) =>
	s.getData('renameTab')?.tabId ?? null;
const selectGroups = (s: ReturnType<typeof useSessionStore.getState>) => s.groups;
const selectInitialLoadComplete = (s: ReturnType<typeof useSessionStore.getState>) =>
	s.initialLoadComplete;
const selectActiveSessionId = (s: ReturnType<typeof useSessionStore.getState>) => s.activeSessionId;

// ============================================================================
// Hook
// ============================================================================

export function useSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycleReturn {
	const { flushSessionPersistence, setRemovedWorktreePaths, pushNavigation } = deps;

	// --- Store subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);
	const renameTabId = useModalStore(selectRenameTabId);
	const groups = useSessionStore(selectGroups);
	const initialLoadComplete = useSessionStore(selectInitialLoadComplete);
	const activeSessionId = useSessionStore(selectActiveSessionId);

	// ====================================================================
	// Callbacks
	// ====================================================================

	const handleSaveEditAgent = useCallback(
		(
			sessionId: string,
			name: string,
			toolType?: ToolType,
			nudgeMessage?: string,
			customPath?: string,
			customArgs?: string,
			customEnvVars?: Record<string, string>,
			customModel?: string,
			customContextWindow?: number,
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			}
		) => {
			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;

					const updatedFields: Partial<Session> = {
						name,
						nudgeMessage,
						customPath,
						customArgs,
						customEnvVars,
						customModel,
						customContextWindow,
						sessionSshRemoteConfig,
					};

					// If provider changed, reset tabs and provider-specific config
					if (toolType && toolType !== s.toolType) {
						const newTabId = generateId();
						const freshTab: AITab = {
							id: newTabId,
							agentSessionId: null,
							name: null,
							starred: false,
							logs: [],
							inputValue: '',
							stagedImages: [],
							createdAt: Date.now(),
							state: 'idle',
							saveToHistory: true,
						};

						Object.assign(updatedFields, {
							toolType,
							aiTabs: [freshTab],
							activeTabId: newTabId,
							closedTabHistory: [],
							// Clear provider-specific overrides
							customPath: undefined,
							customArgs: undefined,
							customEnvVars: undefined,
							customModel: undefined,
							customContextWindow: undefined,
							// Reset file preview tabs and unified tab order
							filePreviewTabs: [],
							activeFileTabId: null,
							unifiedTabOrder: [{ type: 'ai' as const, id: newTabId }],
							unifiedClosedTabHistory: [],
							// Reset agent runtime state
							state: 'idle' as const,
							aiPid: 0,
							executionQueue: [],
						});

						// Kill the existing AI process for this session
						window.maestro.process.kill(`${sessionId}-ai`).catch(() => {
							// Process may not exist — that's fine
						});
					}

					return { ...s, ...updatedFields };
				})
			);
		},
		[]
	);

	const handleRenameTab = useCallback(
		(newName: string) => {
			if (!activeSession || !renameTabId) return;

			// If this is a terminal tab, delegate to terminal tab rename helper
			if (activeSession.terminalTabs?.some((t) => t.id === renameTabId)) {
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSession.id
							? renameTerminalTabHelper(s, renameTabId, newName)
							: s
					)
				);
				return;
			}

			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					// Find the tab to get its agentSessionId for persistence
					const tab = s.aiTabs.find((t) => t.id === renameTabId);
					const oldName = tab?.name;

					window.maestro.logger.log(
						'info',
						`Tab renamed: "${oldName || '(auto)'}" → "${newName || '(cleared)'}"`,
						'TabNaming',
						{
							tabId: renameTabId,
							sessionId: activeSession.id,
							agentSessionId: tab?.agentSessionId,
							oldName,
							newName: newName || null,
						}
					);

					if (tab?.agentSessionId) {
						// Persist name to agent session metadata (async, fire and forget)
						// Use projectRoot (not cwd) for consistent session storage access
						const agentId = s.toolType || 'claude-code';
						if (agentId === 'claude-code') {
							window.maestro.claude
								.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
								.catch((err) => {
									captureException(err, {
										extra: {
											tabId: renameTabId,
											agentSessionId: tab.agentSessionId,
											operation: 'persist-tab-name-claude',
										},
									});
								});
						} else {
							window.maestro.agentSessions
								.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
								.catch((err) => {
									captureException(err, {
										extra: {
											tabId: renameTabId,
											agentSessionId: tab.agentSessionId,
											agentType: agentId,
											operation: 'persist-tab-name-agent',
										},
									});
								});
						}
						// Also update past history entries with this agentSessionId
						window.maestro.history
							.updateSessionName(tab.agentSessionId, newName || '')
							.catch((err) => {
								captureException(err, {
									extra: {
										agentSessionId: tab.agentSessionId,
										operation: 'update-history-session-name',
									},
								});
							});
					} else {
						window.maestro.logger.log(
							'info',
							'Tab renamed (no agentSessionId, skipping persistence)',
							'TabNaming',
							{
								tabId: renameTabId,
							}
						);
					}
					return {
						...s,
						aiTabs: s.aiTabs.map((t) =>
							// Clear isGeneratingName to cancel any in-progress automatic naming
							t.id === renameTabId ? { ...t, name: newName || null, isGeneratingName: false } : t
						),
					};
				})
			);
		},
		[activeSession, renameTabId]
	);

	const performDeleteSession = useCallback(
		async (session: Session, eraseWorkingDirectory: boolean) => {
			const id = session.id;

			// Record session closure for Usage Dashboard (before cleanup)
			window.maestro.stats.recordSessionClosed(id, Date.now());

			// Kill both processes for this session
			try {
				await window.maestro.process.kill(`${id}-ai`);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'kill-ai' },
				});
			}

			try {
				await window.maestro.process.kill(`${id}-terminal`);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'kill-terminal' },
				});
			}

			// Delete associated playbooks
			try {
				await window.maestro.playbooks.deleteAll(id);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'delete-playbooks' },
				});
			}

			// If this is a worktree session, track its path to prevent re-discovery
			if (session.worktreeParentPath && session.cwd) {
				setRemovedWorktreePaths((prev) => new Set([...prev, session.cwd]));
			}

			// Optionally erase the working directory (move to trash)
			if (eraseWorkingDirectory && session.cwd) {
				try {
					await window.maestro.shell.trashItem(session.cwd);
				} catch (error) {
					captureException(error, {
						extra: { sessionId: id, cwd: session.cwd, operation: 'trash-working-directory' },
					});
					notifyToast({
						title: 'Failed to Erase Directory',
						message: error instanceof Error ? error.message : 'Unknown error',
						type: 'error',
					});
				}
			}

			const { sessions: currentSessions } = useSessionStore.getState();
			const newSessions = currentSessions.filter((s) => s.id !== id);
			useSessionStore.getState().setSessions(newSessions);
			// Flush immediately for critical operation (session deletion)
			setTimeout(() => flushSessionPersistence(), 0);
			if (newSessions.length > 0) {
				useSessionStore.getState().setActiveSessionId(newSessions[0].id);
			} else {
				useSessionStore.getState().setActiveSessionId('');
			}
		},
		[flushSessionPersistence, setRemovedWorktreePaths]
	);

	const showConfirmation = useCallback((message: string, onConfirm: () => void) => {
		// Use openModal with data in a single call to avoid race condition where
		// updateModalData fails because the modal hasn't been opened yet (no existing data)
		useModalStore.getState().openModal('confirm', { message, onConfirm });
	}, []);

	const toggleTabStar = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = getActiveTab(session);
		if (!tab) return;

		const newStarred = !tab.starred;
		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== session.id) return s;
				// Persist starred status to session metadata (async, fire and forget)
				// Use projectRoot (not cwd) for consistent session storage access
				if (tab.agentSessionId) {
					const agentId = s.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						window.maestro.claude
							.updateSessionStarred(s.projectRoot, tab.agentSessionId, newStarred)
							.catch((err) => {
								captureException(err, {
									extra: {
										sessionId: s.id,
										agentSessionId: tab.agentSessionId,
										operation: 'persist-starred-claude',
									},
								});
							});
					} else {
						window.maestro.agentSessions
							.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, newStarred)
							.catch((err) => {
								captureException(err, {
									extra: {
										sessionId: s.id,
										agentSessionId: tab.agentSessionId,
										agentType: agentId,
										operation: 'persist-starred-agent',
									},
								});
							});
					}
				}
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tab.id ? { ...t, starred: newStarred } : t)),
				};
			})
		);
	}, []);

	const toggleTabUnread = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		if (!session) return;
		const tab = getActiveTab(session);
		if (!tab) return;

		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== session.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tab.id ? { ...t, hasUnread: !t.hasUnread } : t)),
				};
			})
		);
	}, []);

	const toggleUnreadFilter = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		const { showUnreadOnly } = useUIStore.getState();

		if (!showUnreadOnly) {
			// Entering filter mode: save current active tab
			useUIStore.getState().setPreFilterActiveTabId(session?.activeTabId || null);
		} else {
			// Exiting filter mode: restore previous active tab if it still exists
			const preFilterActiveTabId = useUIStore.getState().preFilterActiveTabId;
			if (preFilterActiveTabId && session) {
				const tabStillExists = session.aiTabs.some((t) => t.id === preFilterActiveTabId);
				if (tabStillExists) {
					useSessionStore.getState().setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;
							return { ...s, activeTabId: preFilterActiveTabId };
						})
					);
				}
				useUIStore.getState().setPreFilterActiveTabId(null);
			}
		}
		useUIStore.getState().setShowUnreadOnly(!showUnreadOnly);
	}, []);

	// ====================================================================
	// Effects
	// ====================================================================

	// Persist groups directly (groups change infrequently, no need to debounce)
	useEffect(() => {
		if (initialLoadComplete) {
			window.maestro.groups.setAll(groups);
		}
	}, [groups, initialLoadComplete]);

	// Track navigation history when session or AI tab changes
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);

	useEffect(() => {
		// Group chat navigation takes precedence when a group chat is open
		if (activeGroupChatId) {
			pushNavigation({ groupChatId: activeGroupChatId });
		} else if (activeSession) {
			pushNavigation({
				sessionId: activeSession.id,
				tabId:
					activeSession.inputMode === 'ai' && activeSession.aiTabs?.length > 0
						? activeSession.activeTabId
						: undefined,
			});
		}
	}, [
		activeSessionId,
		activeSession?.activeTabId,
		activeSession?.inputMode,
		activeSession?.aiTabs?.length,
		activeGroupChatId,
	]);

	return {
		handleSaveEditAgent,
		handleRenameTab,
		performDeleteSession,
		showConfirmation,
		toggleTabStar,
		toggleTabUnread,
		toggleUnreadFilter,
	};
}

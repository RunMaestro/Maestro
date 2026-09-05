/**
 * useSessionLifecycle - extracted from App.tsx (Phase 2H)
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
 * Reads from: sessionStore, modalStore
 */

import { useCallback, useEffect } from 'react';
import type { Session, FailoverConfig } from '../../types';
import type { ToolType } from '../../../shared/types';
import { getClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { switchTabProvider } from '../../utils/providerTabSessions';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useModalStore } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { getActiveTab, extractQuickTabName } from '../../utils/tabHelpers';
import {
	renameTerminalTab as renameTerminalTabHelper,
	getTerminalSessionId,
} from '../../utils/terminalTabHelpers';
import { resolveActiveNavTab } from './useNavigationHistory';
import type { NavHistoryEntry } from './useNavigationHistory';
import { captureException } from '../../utils/sentry';
import { persistTabStarred } from '../../utils/starredSessions';
import { clearFailover, getActiveEndpoint } from '../../stores/failoverStore';
import { toggleTabUnreadFilter } from '../../services/unreadFilters';
import { failoverArmed, findEndpoint } from '../../../shared/providerFailover';

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
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
			syncHistory?: boolean;
			shareHistoryToProjectDir?: boolean;
		},
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean,
		failoverConfig?: FailoverConfig,
		customEnvVarsDisabled?: Record<string, string>
	) => void;
	/** Rename the currently-selected tab (persists to agent session storage + history) */
	handleRenameTab: (newName: string) => void;
	/** Auto-name the currently-selected tab: close modal, show spinner, generate name via agent */
	handleAutoNameTab: () => void;
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
			newSessionMessage?: string,
			customPath?: string,
			customArgs?: string,
			customEnvVars?: Record<string, string>,
			customModel?: string,
			customContextWindow?: number,
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
				syncHistory?: boolean;
				shareHistoryToProjectDir?: boolean;
			},
			enableMaestroP?: boolean,
			maestroPPath?: string,
			maestroPMode?: 'interactive' | 'dynamic',
			retryOnAvailabilityErrors?: boolean,
			retryOnTokenExhaustion?: boolean,
			failoverConfig?: FailoverConfig,
			customEnvVarsDisabled?: Record<string, string>
		) => {
			// Provider Failover: snapshot whether this agent is currently pinned to a
			// backup endpoint BEFORE the update below, so we can tell after the fact
			// whether the saved config still covers it.
			const activeEndpoint = getActiveEndpoint(sessionId);

			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;

					const updatedFields: Partial<Session> = {
						name,
						nudgeMessage,
						newSessionMessage,
						customPath,
						customArgs,
						customEnvVars,
						customEnvVarsDisabled,
						customModel,
						customContextWindow,
						sessionSshRemoteConfig,
						enableMaestroP,
						maestroPPath,
						maestroPMode,
						// Agent Resilience: resilience is provider-agnostic, so it is NOT
						// cleared on a provider switch below (unlike maestroP fields).
						retryOnAvailabilityErrors,
						retryOnTokenExhaustion,
						failoverConfig,
					};

					// If the provider changed, park each tab's provider-specific state and
					// restore whatever the incoming provider left behind. Tabs, transcripts,
					// closed-tab history, and file preview tabs are all preserved: none of
					// them are provider-specific, and switching back has to land the user on
					// the same conversation they left.
					if (toolType && toolType !== s.toolType) {
						Object.assign(updatedFields, {
							toolType,
							aiTabs: s.aiTabs.map((tab) => switchTabProvider(tab, s.toolType, toolType)),
							// Clear provider-specific overrides. These are agent-level config,
							// not per-tab conversation state, so they are not parked - the edit
							// modal already resets its own fields on a provider switch.
							customPath: undefined,
							customArgs: undefined,
							customEnvVars: undefined,
							customEnvVarsDisabled: undefined,
							customModel: undefined,
							customContextWindow: undefined,
							enableMaestroP: undefined,
							maestroPPath: undefined,
							maestroPMode: undefined,
							// Endpoint env carries provider-specific base URLs and tokens.
							failoverConfig: undefined,
						});

						// Any turn already in flight keeps running under the provider it was
						// sent with: settings are codified at send, and this change applies from
						// the next message. So the agent process is deliberately left alone, and
						// the session's busy state with it. `turnProvider` on each tab is what
						// keeps that turn's late events attributed to the old provider.
					}

					return { ...s, ...updatedFields };
				})
			);

			// Provider Failover: the update above may disarm failover or drop the
			// endpoint this agent is actively pinned to (an explicit edit, or the
			// provider-switch reset a few lines up, which clears failoverConfig
			// outright). The live pin is in-memory only (renderer store + main
			// overlay) and will NOT disappear just because the session record
			// changed underneath it, so it has to be cleared explicitly here.
			// clearFailover no-ops when the agent isn't currently pinned, so this
			// is always safe to check.
			if (activeEndpoint) {
				const newConfig = useSessionStore
					.getState()
					.sessions.find((s) => s.id === sessionId)?.failoverConfig;
				const stillCovered =
					failoverArmed(newConfig) && !!findEndpoint(newConfig, activeEndpoint.id);
				if (!stillCovered) {
					void clearFailover(sessionId);
				}
			}
		},
		[]
	);

	const handleRenameTab = useCallback(
		(newName: string) => {
			if (!activeSession || !renameTabId) return;

			// If this is a terminal tab, delegate to terminal tab rename helper
			if (activeSession.terminalTabs?.some((t) => t.id === renameTabId)) {
				useSessionStore
					.getState()
					.setSessions((prev) =>
						prev.map((s) =>
							s.id === activeSession.id ? renameTerminalTabHelper(s, renameTabId, newName) : s
						)
					);
				return;
			}

			// If this is a browser tab, set a user-assigned name that locks the
			// displayed label. An empty value clears it, letting the website set the
			// tab title again. We never touch `title` so the live page title stays
			// tracked underneath and reappears once the custom name is cleared.
			if (activeSession.browserTabs?.some((t) => t.id === renameTabId)) {
				const nextCustomTitle = newName.trim() || undefined;
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;
						return {
							...s,
							browserTabs: (s.browserTabs || []).map((t) =>
								t.id === renameTabId ? { ...t, customTitle: nextCustomTitle } : t
							),
						};
					})
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

	const handleAutoNameTab = useCallback(() => {
		if (!activeSession || !renameTabId) return;

		const tab = activeSession.aiTabs.find((t) => t.id === renameTabId);
		if (!tab || !tab.logs.length) return;

		// Collect user messages (first ~2000 chars) for the naming prompt
		const userMessages: string[] = [];
		let totalLength = 0;
		for (const entry of tab.logs) {
			if (entry.source === 'user' && entry.text.trim()) {
				const text = entry.text.trim();
				if (totalLength + text.length > 2000) {
					userMessages.push(text.substring(0, 2000 - totalLength));
					break;
				}
				userMessages.push(text);
				totalLength += text.length;
			}
		}
		const summary = userMessages.join('\n\n');
		if (!summary) return;

		const sessionId = activeSession.id;
		const tabId = renameTabId;

		// Close the modal immediately
		useModalStore.getState().closeModal('renameTab');

		// Fast-path: try extracting a name from known patterns first
		const quickName = extractQuickTabName(summary);
		if (quickName) {
			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, name: quickName } : t)),
					};
				})
			);
			return;
		}

		// Show spinner on the tab
		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== sessionId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, isGeneratingName: true } : t)),
				};
			})
		);

		// Fire and forget - generate name via ephemeral agent
		window.maestro.tabNaming
			.generateTabName({
				userMessage: summary,
				agentType: activeSession.toolType,
				cwd: activeSession.cwd,
				sessionSshRemoteConfig: activeSession.sessionSshRemoteConfig,
				// Forward session env so naming uses the same provider auth as the chat.
				sessionCustomEnvVars: activeSession.customEnvVars,
				// Honor the agent's Claude token source for the naming spawn.
				// Shared extractor guarantees the SAME complete triple the chat
				// spawn forwards - no partial/drifting forward possible.
				...getClaudeTokenSourceFields(activeSession),
			})
			.then((generatedName) => {
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => {
								if (t.id !== tabId) return t;
								return {
									...t,
									isGeneratingName: false,
									...(generatedName ? { name: generatedName } : {}),
								};
							}),
						};
					})
				);

				if (generatedName) {
					window.maestro.logger.log(
						'info',
						`Auto tab named (manual): "${generatedName}"`,
						'TabNaming',
						{ tabId, sessionId, generatedName }
					);
				}
			})
			.catch((error) => {
				window.maestro.logger.log('error', 'Auto tab naming (manual) failed', 'TabNaming', {
					tabId,
					sessionId,
					error: String(error),
				});
				// Clear spinner on error
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, isGeneratingName: false } : t)),
						};
					})
				);
			});
	}, [activeSession, renameTabId]);

	const performDeleteSession = useCallback(
		async (session: Session, eraseWorkingDirectory: boolean) => {
			const id = session.id;

			// Record session closure for Usage Dashboard (before cleanup)
			window.maestro.stats.recordSessionClosed(id, Date.now());

			// Kill all processes for this session (AI + legacy terminal + terminal tabs)
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

			// Kill terminal tab PTYs - each tab has its own PTY with ID {sessionId}-terminal-{tabId}
			for (const tab of session.terminalTabs || []) {
				try {
					await window.maestro.process.kill(getTerminalSessionId(id, tab.id));
				} catch (error) {
					captureException(error, {
						extra: { sessionId: id, tabId: tab.id, operation: 'kill-terminal-tab' },
					});
				}
			}

			// Delete associated playbooks
			try {
				await window.maestro.playbooks.deleteAll(id);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'delete-playbooks' },
				});
			}

			// Provider Failover: drop any live pin (renderer + main overlay) so a
			// deleted agent's session id can't keep routing prompts to a backup
			// provider if it's ever reused. No-op when the agent isn't pinned.
			try {
				await clearFailover(id);
			} catch (error) {
				captureException(error, {
					extra: { sessionId: id, operation: 'clear-failover' },
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
		// Star toggle only applies when an AI tab is the visible view - not when a
		// terminal, file preview, or browser tab is focused.
		if (session.inputMode !== 'ai' || session.activeFileTabId || session.activeBrowserTabId) {
			return;
		}
		const tab = getActiveTab(session);
		if (!tab) return;

		const newStarred = !tab.starred;
		useSessionStore.getState().setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== session.id) return s;
				// Persist starred status to session metadata (async) and broadcast the
				// change so the Left Bar's starred-sessions cache refreshes. Uses
				// projectRoot (not cwd) for consistent session storage access.
				persistTabStarred(s, tab, newStarred);
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
		toggleTabUnreadFilter();
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
			// Resolve the active tab across all kinds using the same priority as
			// findActiveUnifiedTabIndex (terminal > file > browser > ai) so the
			// breadcrumb tracks whichever tab the user actually sees.
			const { tabId, tabKind } = resolveActiveNavTab(activeSession);
			pushNavigation({ sessionId: activeSession.id, tabId, tabKind });
		}
	}, [
		activeSessionId,
		activeSession?.activeTabId,
		activeSession?.activeFileTabId,
		activeSession?.activeBrowserTabId,
		activeSession?.activeTerminalTabId,
		activeSession?.inputMode,
		activeSession?.aiTabs?.length,
		activeGroupChatId,
	]);

	return {
		handleSaveEditAgent,
		handleRenameTab,
		handleAutoNameTab,
		performDeleteSession,
		showConfirmation,
		toggleTabStar,
		toggleTabUnread,
		toggleUnreadFilter,
	};
}

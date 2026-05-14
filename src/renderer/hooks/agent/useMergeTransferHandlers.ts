/**
 * useMergeTransferHandlers — extracted from App.tsx (Phase 2.5)
 *
 * Orchestrates merge-session and send-to-agent workflows:
 *   - useMergeSessionWithSessions (merge context between sessions)
 *   - useSendToAgentWithSessions (transfer context to a different agent)
 *   - Transfer source/target agent tracking state
 *   - 7 handler callbacks wired to AppModals + MainPanel
 *
 * Reads from: sessionStore, modalStore
 * Writes to: modalStore (merge/send-to-agent modal open state)
 */

import { useState, useCallback } from 'react';
import type { Session, ToolType, LogEntry, AITab } from '../../types';
import type { GroomingProgress } from '../../types/contextMerge';
import type { MergeOptions } from '../../components/MergeSessionModal';
import type { SendToAgentOptions } from '../../components/SendToAgentModal';
import type { MergeState } from '../../stores/operationStore';
import type { TransferState } from '../../stores/operationStore';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { substituteTemplateVariables } from '../../utils/templateVariables';
import { gitService } from '../../services/git';
import { maestroSystemPrompt } from '../../../prompts';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMergeSessionWithSessions } from './useMergeSession';
import { useSendToAgentWithSessions } from './useSendToAgent';
import { captureException } from '../../utils/sentry';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseMergeTransferHandlersDeps {
	/** Sessions ref for non-reactive access in callbacks */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Active session ID ref for non-reactive access in callbacks */
	activeSessionIdRef: React.MutableRefObject<string>;
	/** Navigate to a session (dismisses group chat, flushes batched updates) */
	setActiveSessionId: (id: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseMergeTransferHandlersReturn {
	// Merge state (from useMergeSessionWithSessions)
	mergeState: MergeState;
	mergeProgress: GroomingProgress | null;
	mergeStartTime: number;
	mergeSourceName: string | undefined;
	mergeTargetName: string | undefined;
	cancelMergeTab: (tabId: string) => void;
	clearMergeTabState: (tabId: string) => void;

	// Transfer state (from useSendToAgentWithSessions)
	transferState: TransferState;
	transferProgress: GroomingProgress | null;
	transferSourceAgent: ToolType | null;
	transferTargetAgent: ToolType | null;

	// Handlers
	handleCloseMergeSession: () => void;
	handleMerge: (
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions
	) => Promise<{ success: boolean; error?: string }>;
	handleCancelTransfer: () => void;
	handleCompleteTransfer: () => void;
	handleSendToAgent: (
		targetSessionId: string,
		options: SendToAgentOptions
	) => Promise<{ success: boolean; error?: string; newSessionId?: string; newTabId?: string }>;
	handleMergeWith: (tabId: string) => void;
	handleOpenSendToAgentModal: (tabId: string) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useMergeTransferHandlers(
	deps: UseMergeTransferHandlersDeps
): UseMergeTransferHandlersReturn {
	const { sessionsRef, activeSessionIdRef, setActiveSessionId } = deps;

	// --- Store subscriptions ---
	const sessions = useSessionStore((s) => s.sessions);
	const setSessions = useSessionStore((s) => s.setSessions);
	const activeSession = useSessionStore(selectActiveSession);

	// --- Transfer agent tracking state ---
	const [transferSourceAgent, setTransferSourceAgent] = useState<ToolType | null>(null);
	const [transferTargetAgent, setTransferTargetAgent] = useState<ToolType | null>(null);

	// ====================================================================
	// useMergeSessionWithSessions — merge context between sessions
	// ====================================================================

	const {
		mergeState,
		progress: mergeProgress,
		error: _mergeError,
		startTime: mergeStartTime,
		sourceName: mergeSourceName,
		targetName: mergeTargetName,
		executeMerge,
		cancelTab: cancelMergeTab,
		cancelMerge: _cancelMerge,
		clearTabState: clearMergeTabState,
		reset: resetMerge,
	} = useMergeSessionWithSessions({
		sessions,
		setSessions,
		activeTabId: activeSession?.activeTabId,
		onSessionCreated: (info) => {
			// Navigate to the newly created merged session
			setActiveSessionId(info.sessionId);
			getModalActions().setMergeSessionModalOpen(false);

			// Build informative message with token info
			const tokenInfo = info.estimatedTokens
				? ` (~${info.estimatedTokens.toLocaleString()} tokens)`
				: '';
			const savedInfo =
				info.tokensSaved && info.tokensSaved > 0
					? ` Saved ~${info.tokensSaved.toLocaleString()} tokens.`
					: '';
			const sourceInfo =
				info.sourceSessionName && info.targetSessionName
					? `"${info.sourceSessionName}" + "${info.targetSessionName}"`
					: info.sessionName;

			// Show toast notification in the UI
			notifyToast({
				type: 'success',
				title: 'Session Merged',
				message: `Created "${info.sessionName}" from ${sourceInfo}${tokenInfo}.${savedInfo}`,
				sessionId: info.sessionId,
			});

			// Show desktop notification for visibility when app is not focused
			window.maestro.notification.show(
				'Session Merged',
				`Created "${info.sessionName}" with merged context`
			);

			// Clear the merge state for the source tab after a short delay
			if (activeSession?.activeTabId) {
				setTimeout(() => {
					clearMergeTabState(activeSession.activeTabId);
				}, 1000);
			}
		},
		onMergeComplete: (sourceTabId, result) => {
			// For merge into existing tab, navigate to target and show toast
			if (activeSession && result.success && result.targetSessionId) {
				const tokenInfo = result.estimatedTokens
					? ` (~${result.estimatedTokens.toLocaleString()} tokens)`
					: '';
				const savedInfo =
					result.tokensSaved && result.tokensSaved > 0
						? ` Saved ~${result.tokensSaved.toLocaleString()} tokens.`
						: '';

				// Navigate to the target session/tab so autoSendOnActivate will trigger
				// This ensures the merged context is immediately sent to the agent
				setActiveSessionId(result.targetSessionId);
				if (result.targetTabId) {
					const targetTabId = result.targetTabId; // Extract to satisfy TypeScript narrowing
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== result.targetSessionId) return s;
							return { ...s, activeTabId: targetTabId };
						})
					);
				}

				notifyToast({
					type: 'success',
					title: 'Context Merged',
					message: `"${result.sourceSessionName || 'Current Session'}" → "${
						result.targetSessionName || 'Selected Session'
					}"${tokenInfo}.${savedInfo}`,
				});

				// Clear the merge state for the source tab
				setTimeout(() => {
					clearMergeTabState(sourceTabId);
				}, 1000);
			}
		},
	});

	// ====================================================================
	// useSendToAgentWithSessions — transfer context to a different agent
	// ====================================================================

	const {
		transferState,
		progress: transferProgress,
		error: _transferError,
		executeTransfer: _executeTransfer,
		cancelTransfer,
		reset: resetTransfer,
	} = useSendToAgentWithSessions({
		sessions,
		setSessions,
		onSessionCreated: (sessionId, sessionName) => {
			// Navigate to the newly created transferred session
			setActiveSessionId(sessionId);
			getModalActions().setSendToAgentModalOpen(false);

			// Show toast notification in the UI
			notifyToast({
				type: 'success',
				title: 'Context Transferred',
				message: `Created "${sessionName}" with transferred context`,
			});

			// Show desktop notification for visibility when app is not focused
			window.maestro.notification.show(
				'Context Transferred',
				`Created "${sessionName}" with transferred context`
			);

			// Reset the transfer state after a short delay to allow progress modal to show "Complete"
			setTimeout(() => {
				resetTransfer();
				setTransferSourceAgent(null);
				setTransferTargetAgent(null);
			}, 1500);
		},
	});

	// ====================================================================
	// Handlers
	// ====================================================================

	// MergeSessionModal handlers
	const handleCloseMergeSession = useCallback(() => {
		getModalActions().setMergeSessionModalOpen(false);
		resetMerge();
	}, [resetMerge]);

	const handleMerge = useCallback(
		async (targetSessionId: string, targetTabId: string | undefined, options: MergeOptions) => {
			// Close the modal - merge will show in the input area overlay
			getModalActions().setMergeSessionModalOpen(false);

			if (!activeSession) {
				return { success: false as const, error: 'No active session' };
			}

			// Execute merge using the hook (callbacks handle toasts and navigation)
			const result = await executeMerge(
				activeSession,
				activeSession.activeTabId,
				targetSessionId,
				targetTabId,
				options
			);

			if (!result.success) {
				notifyToast({
					type: 'error',
					title: 'Merge Failed',
					message: result.error || 'Failed to merge contexts',
				});
			}
			// Note: Success toasts are handled by onSessionCreated (for new sessions)
			// and onMergeComplete (for merging into existing sessions) callbacks

			return result;
		},
		[activeSession, executeMerge]
	);

	// TransferProgressModal handlers
	const handleCancelTransfer = useCallback(() => {
		cancelTransfer();
		setTransferSourceAgent(null);
		setTransferTargetAgent(null);
	}, [cancelTransfer]);

	const handleCompleteTransfer = useCallback(() => {
		resetTransfer();
		setTransferSourceAgent(null);
		setTransferTargetAgent(null);
	}, [resetTransfer]);

	const handleSendToAgent = useCallback(
		async (targetSessionId: string, options: SendToAgentOptions) => {
			if (!activeSession) {
				getModalActions().setSendToAgentModalOpen(false);
				return { success: false, error: 'No active session' };
			}

			// Find the target session
			const targetSession = sessions.find((s) => s.id === targetSessionId);
			if (!targetSession) {
				return { success: false, error: 'Target session not found' };
			}

			// Store source and target agents for progress modal display
			setTransferSourceAgent(activeSession.toolType);
			setTransferTargetAgent(targetSession.toolType);

			// Close the selection modal - progress modal will take over
			getModalActions().setSendToAgentModalOpen(false);

			// Get source tab context
			const sourceTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
			if (!sourceTab) {
				setTransferSourceAgent(null);
				setTransferTargetAgent(null);
				return { success: false, error: 'Source tab not found' };
			}

			// Format the context as text to be sent to the agent
			// Only include user messages and AI responses, not system messages
			const formattedContext = sourceTab.logs
				.filter(
					(log) =>
						log.text &&
						log.text.trim() &&
						(log.source === 'user' || log.source === 'ai' || log.source === 'stdout')
				)
				.map((log) => {
					const role = log.source === 'user' ? 'User' : 'Assistant';
					return `${role}: ${log.text}`;
				})
				.join('\n\n');

			const sourceName =
				activeSession.name || activeSession.projectRoot.split('/').pop() || 'Unknown';
			const sourceAgentName = activeSession.toolType;

			// Create the context message to be sent directly to the agent
			const contextMessage = formattedContext
				? `# Context from Previous Session

The following is a conversation from another session ("${sourceName}" using ${sourceAgentName}). Review this context to understand the prior work and decisions made.

---

${formattedContext}

---

# Your Task

You are taking over this conversation. Based on the context above, provide a brief summary of where things left off and ask what the user would like to focus on next.`
				: 'No context available from the previous session.';

			// Transfer context to the target session's active tab
			// Create a new tab in the target session and immediately send context to agent
			const newTabId = `tab-${Date.now()}`;
			const transferNotice: LogEntry = {
				id: `transfer-notice-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text: `Context transferred from "${sourceName}" (${sourceAgentName})${
					options.groomContext ? ' - cleaned to reduce size' : ''
				}`,
			};

			// Create user message entry for the context being sent
			const userContextMessage: LogEntry = {
				id: `user-context-${Date.now()}`,
				timestamp: Date.now(),
				source: 'user',
				text: contextMessage,
			};

			const newTab: AITab = {
				id: newTabId,
				name: `From: ${sourceName}`,
				logs: [transferNotice, userContextMessage],
				agentSessionId: null,
				starred: false,
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'busy', // Start in busy state since we're spawning immediately
				thinkingStartTime: Date.now(),
				awaitingSessionId: true, // Mark as awaiting session ID
			};

			// Add the new tab to the target session and set it as active
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id === targetSessionId) {
						return {
							...s,
							state: 'busy',
							busySource: 'ai',
							thinkingStartTime: Date.now(),
							aiTabs: [...s.aiTabs, newTab],
							activeTabId: newTabId,
							unifiedTabOrder: [
								...(s.unifiedTabOrder || []),
								{ type: 'ai' as const, id: newTabId },
							],
						};
					}
					return s;
				})
			);

			// Navigate to the target session
			setActiveSessionId(targetSessionId);

			// Calculate estimated tokens for the toast
			const estimatedTokens = sourceTab.logs
				.filter((log) => log.text && log.source !== 'system')
				.reduce((sum, log) => sum + Math.round((log.text?.length || 0) / 4), 0);
			const tokenInfo = estimatedTokens > 0 ? ` (~${estimatedTokens.toLocaleString()} tokens)` : '';

			// Show success toast
			notifyToast({
				type: 'success',
				title: 'Context Sent',
				message: `"${sourceName}" → "${targetSession.name}"${tokenInfo}`,
				sessionId: targetSessionId,
				tabId: newTabId,
			});

			// Reset transfer state
			resetTransfer();
			setTransferSourceAgent(null);
			setTransferTargetAgent(null);

			// Spawn the agent with the context - do this after state updates
			(async () => {
				try {
					// Get agent configuration
					const agent = await window.maestro.agents.get(targetSession.toolType);
					if (!agent) throw new Error(`${targetSession.toolType} agent not found`);

					const baseArgs = agent.args ?? [];
					const commandToUse = agent.path || agent.command;

					// Build the full prompt with Maestro system prompt for new sessions
					let effectivePrompt = contextMessage;

					// Get git branch for template substitution
					let gitBranch: string | undefined;
					if (targetSession.isGitRepo) {
						try {
							const status = await gitService.getStatus(targetSession.cwd);
							gitBranch = status.branch;
						} catch (error) {
							captureException(error, {
								extra: {
									cwd: targetSession.cwd,
									sessionId: targetSessionId,
									isGitRepo: targetSession.isGitRepo,
									operation: 'git-status-for-transfer',
								},
							});
						}
					}

					// Read conductorProfile from settings store at call time
					const conductorProfile = useSettingsStore.getState().conductorProfile;

					// Prepend Maestro system prompt since this is a new session
					if (maestroSystemPrompt) {
						const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
							session: targetSession,
							gitBranch,
							conductorProfile,
							readOnlyMode: false,
						});
						effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
					}

					// Spawn agent
					const spawnSessionId = `${targetSessionId}-ai-${newTabId}`;
					await window.maestro.process.spawn({
						sessionId: spawnSessionId,
						toolType: targetSession.toolType,
						cwd: targetSession.cwd,
						command: commandToUse,
						args: [...baseArgs],
						prompt: effectivePrompt,
						// Per-session config overrides (if set)
						sessionCustomPath: targetSession.customPath,
						sessionCustomArgs: targetSession.customArgs,
						sessionCustomEnvVars: targetSession.customEnvVars,
						sessionCustomModel: targetSession.customModel,
						sessionCustomContextWindow: targetSession.customContextWindow,
						sessionSshRemoteConfig: targetSession.sessionSshRemoteConfig,
					});
				} catch (error) {
					captureException(error, {
						extra: {
							targetSessionId,
							toolType: targetSession.toolType,
							newTabId,
							operation: 'context-transfer-spawn',
						},
					});
					const errorLog: LogEntry = {
						id: `error-${Date.now()}`,
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to spawn agent - ${(error as Error).message}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== targetSessionId) return s;
							return {
								...s,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === newTabId
										? {
												...tab,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: [...tab.logs, errorLog],
											}
										: tab
								),
							};
						})
					);
				}
			})();

			return { success: true, newSessionId: targetSessionId, newTabId };
		},
		[activeSession, sessions, setSessions, setActiveSessionId, resetTransfer]
	);

	// Tab context menu handlers — switch to tab then open modal
	const handleMergeWith = useCallback(
		(tabId: string) => {
			const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
			if (currentSession) {
				setSessions((prev) =>
					prev.map((s) => (s.id === currentSession.id ? { ...s, activeTabId: tabId } : s))
				);
			}
			getModalActions().setMergeSessionModalOpen(true);
		},
		[sessionsRef, activeSessionIdRef, setSessions]
	);

	const handleOpenSendToAgentModal = useCallback(
		(tabId: string) => {
			const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
			if (currentSession) {
				setSessions((prev) =>
					prev.map((s) => (s.id === currentSession.id ? { ...s, activeTabId: tabId } : s))
				);
			}
			getModalActions().setSendToAgentModalOpen(true);
		},
		[sessionsRef, activeSessionIdRef, setSessions]
	);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		// Merge state
		mergeState,
		mergeProgress,
		mergeStartTime,
		mergeSourceName,
		mergeTargetName,
		cancelMergeTab,
		clearMergeTabState,

		// Transfer state
		transferState,
		transferProgress,
		transferSourceAgent,
		transferTargetAgent,

		// Handlers
		handleCloseMergeSession,
		handleMerge,
		handleCancelTransfer,
		handleCompleteTransfer,
		handleSendToAgent,
		handleMergeWith,
		handleOpenSendToAgentModal,
	};
}

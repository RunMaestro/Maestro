/**
 * useRemoteHandlers — extracted from App.tsx (Phase 2K)
 *
 * Handles remote command processing from the web interface:
 *   - handleRemoteCommand event listener (terminal + AI mode dispatching)
 *   - handleQuickActionsToggleRemoteControl (live mode toggle)
 *   - sessionSshRemoteNames (memoized map for group chat participant cards)
 *
 * Reads from: sessionStore, settingsStore, uiStore
 * Event: 'maestro:remoteCommand' custom DOM event
 */

import { useEffect, useMemo, useCallback } from 'react';
import type { Session, SessionState, LogEntry, CustomAICommand, QueuedItem } from '../../types';
import { hasCapabilityCached } from '../agent/useAgentCapabilities';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { substituteTemplateVariables } from '../../utils/templateVariables';
import { gitService } from '../../services/git';
import { captureException } from '../../utils/sentry';
import { filterYoloArgs } from '../../utils/agentArgs';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';
import { logger } from '../../utils/logger';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseRemoteHandlersDeps {
	/** Sessions ref for non-reactive access in event handlers */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Custom AI commands ref (updated on every render) */
	customAICommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** Spec-Kit commands ref */
	speckitCommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** OpenSpec commands ref */
	openspecCommandsRef: React.MutableRefObject<CustomAICommand[]>;
	/** BMAD commands ref */
	bmadCommandsRef?: React.MutableRefObject<CustomAICommand[]>;
	/** Toggle global live mode (web interface) */
	toggleGlobalLive: () => Promise<void>;
	/** Whether live/remote mode is active */
	isLiveMode: boolean;
	/** SSH remote configs from app initialization */
	sshRemoteConfigs: Array<{ id: string; name: string }>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseRemoteHandlersReturn {
	/** Toggle remote control live mode */
	handleQuickActionsToggleRemoteControl: () => Promise<void>;
	/** Map of session names to SSH remote config names */
	sessionSshRemoteNames: Map<string, string>;
}

// ============================================================================
// Selectors
// ============================================================================

const selectSessions = (s: ReturnType<typeof useSessionStore.getState>) => s.sessions;

// ============================================================================
// Hook
// ============================================================================

export function useRemoteHandlers(deps: UseRemoteHandlersDeps): UseRemoteHandlersReturn {
	const {
		sessionsRef,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
		toggleGlobalLive,
		isLiveMode,
		sshRemoteConfigs,
	} = deps;

	// --- Store subscriptions ---
	const sessions = useSessionStore(selectSessions);
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const addLogToTab = useMemo(() => useSessionStore.getState().addLogToTab, []);
	const setSuccessFlashNotification = useMemo(
		() => useUIStore.getState().setSuccessFlashNotification,
		[]
	);

	// ====================================================================
	// sessionSshRemoteNames — memoized map for group chat participant cards
	// ====================================================================

	const sessionSshRemoteNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const session of sessions) {
			if (session.sessionSshRemoteConfig?.enabled && session.sessionSshRemoteConfig.remoteId) {
				const sshConfig = sshRemoteConfigs.find(
					(c) => c.id === session.sessionSshRemoteConfig?.remoteId
				);
				if (sshConfig) {
					map.set(session.name, sshConfig.name);
				}
			}
		}
		return map;
	}, [sessions, sshRemoteConfigs]);

	// ====================================================================
	// handleRemoteCommand — processes commands from web interface
	// ====================================================================

	useEffect(() => {
		const handleRemoteCommand = async (event: Event) => {
			const customEvent = event as CustomEvent<{
				sessionId: string;
				command: string;
				inputMode?: 'ai' | 'terminal';
				/** Optional explicit tab target (from `maestro-cli dispatch --session
				 *  <tabId>`). When unset, falls back to the active tab. When set
				 *  but unknown, the command is dropped (we never silently re-route
				 *  to the active tab — callers chaining `--session <tabId>` would
				 *  otherwise believe the command landed in the requested tab). */
				tabId?: string;
				/** When true, bypass the renderer's busy-state guard. Mirrors the
				 *  server-side `force` bit so `dispatch --force` can land on a
				 *  busy session without being dropped at this boundary. */
				force?: boolean;
			}>;
			const {
				sessionId,
				command,
				inputMode: webInputMode,
				tabId: requestedTabId,
				force,
			} = customEvent.detail;

			logger.info('[Remote] Processing remote command via event:', undefined, {
				sessionId,
				command: command.substring(0, 50),
				webInputMode,
				requestedTabId,
			});

			// Find the session directly from sessionsRef (not from React state which may be stale)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				logger.info('[Remote] ERROR: Session not found in sessionsRef:', undefined, sessionId);
				return;
			}

			// Use web's inputMode if provided, otherwise fall back to session state
			const effectiveInputMode = webInputMode || session.inputMode;

			logger.info('[Remote] Found session:', undefined, {
				id: session.id,
				agentSessionId: session.agentSessionId || 'none',
				state: session.state,
				sessionInputMode: session.inputMode,
				effectiveInputMode,
				toolType: session.toolType,
			});

			// Handle terminal mode commands
			if (effectiveInputMode === 'terminal') {
				logger.info('[Remote] Terminal mode - using runCommand for clean output');

				// Add user message to shell logs and set state to busy
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'terminal',
							// TODO: Remove shellLogs once terminal tabs migration is complete
							...(!s.terminalTabs?.length && {
								shellLogs: [
									...s.shellLogs,
									{
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: command,
									},
								],
							}),
						};
					})
				);

				// Use runCommand for clean stdout/stderr capture (same as desktop)
				// When SSH is enabled for the session, the command runs on the remote host
				const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
				const commandCwd = isRemote
					? session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd
					: session.shellCwd || session.cwd;
				try {
					await window.maestro.process.runCommand({
						sessionId: sessionId,
						command: command,
						cwd: commandCwd,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					});
					logger.info('[Remote] Terminal command completed successfully');
				} catch (error: unknown) {
					captureException(error, {
						extra: {
							sessionId,
							toolType: session.toolType,
							mode: 'terminal',
							operation: 'remote-command',
						},
					});
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							return {
								...s,
								state: 'idle' as SessionState,
								busySource: undefined,
								thinkingStartTime: undefined,
								// TODO: Remove shellLogs once terminal tabs migration is complete
								...(!s.terminalTabs?.length && {
									shellLogs: [
										...s.shellLogs,
										{
											id: generateId(),
											timestamp: Date.now(),
											source: 'system',
											text: `Error: Failed to run command - ${errorMessage}`,
										},
									],
								}),
							};
						})
					);
				}
				return;
			}

			// Handle AI mode for batch-mode agents
			if (!hasCapabilityCached(session.toolType, 'supportsBatchMode')) {
				logger.info('[Remote] Not a batch-mode agent, skipping');
				return;
			}

			// Check if session is busy. `force: true` bypasses queueing so
			// `dispatch --force` can land immediately on a busy tab.
			if (session.state === 'busy' && !force) {
				const targetTab = getActiveTab(session);
				if (!targetTab) {
					logger.info('[Remote] Session is busy and has no active tab, cannot queue command');
					return;
				}

				const queuedItem: QueuedItem = {
					id: generateId(),
					timestamp: Date.now(),
					tabId: targetTab.id,
					type: command.trim().startsWith('/') ? 'command' : 'message',
					...(command.trim().startsWith('/') ? { command: command.trim() } : { text: command }),
					tabName: targetTab.name || undefined,
					readOnlyMode: targetTab.readOnlyMode,
				};

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? { ...s, executionQueue: [...(s.executionQueue ?? []), queuedItem] }
							: s
					)
				);
				logger.info('[Remote] Session is busy, queued command instead');
				return;
			}

			// Resolve the target tab BEFORE the slash-command branch so unknown-
			// command error logs land on the targeted tab instead of whichever
			// tab happens to be active. This also lets us short-circuit early
			// when `--session <tabId>` names a tab that no longer exists, rather
			// than silently re-routing to the active tab (which would mislead
			// callers chaining `command_result.tabId` back as `--session`).
			const requestedTab = requestedTabId
				? session.aiTabs?.find((t) => t.id === requestedTabId)
				: undefined;
			if (requestedTabId && !requestedTab) {
				logger.warn(
					`[Remote] Requested tabId "${requestedTabId}" not found in session ${sessionId} — dropping command (avoiding silent re-route to active tab)`
				);
				return;
			}
			const targetTab = requestedTab ?? getActiveTab(session);
			const writeTabId = targetTab?.id;

			// Check for slash commands (built-in and custom)
			let promptToSend = command;
			let commandMetadata: { command: string; description: string } | undefined;

			// Handle slash commands (custom AI commands only)
			if (command.trim().startsWith('/')) {
				const commandText = command.trim();
				logger.info('[Remote] Detected slash command:', undefined, commandText);

				const matchingCustomCommand = customAICommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);
				const matchingSpeckitCommand = speckitCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);
				const matchingOpenspecCommand = openspecCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);
				const matchingBmadCommand = bmadCommandsRef?.current.find(
					(cmd) => cmd.command === commandText
				);

				const matchingCommand =
					matchingCustomCommand ||
					matchingSpeckitCommand ||
					matchingOpenspecCommand ||
					matchingBmadCommand;

				if (matchingCommand) {
					logger.info('[Remote] Found matching command:', undefined, [
						matchingCommand.command,
						matchingSpeckitCommand
							? '(spec-kit)'
							: matchingOpenspecCommand
								? '(openspec)'
								: matchingBmadCommand
									? '(bmad)'
									: '(custom)',
					]);

					// Get git branch for template substitution
					let gitBranch: string | undefined;
					if (session.isGitRepo) {
						try {
							const status = await gitService.getStatus(session.cwd);
							gitBranch = status.branch;
						} catch (error) {
							captureException(error, {
								extra: {
									cwd: session.cwd,
									sessionId: session.id,
									sessionName: session.name,
									operation: 'git-status-for-remote-command',
								},
							});
						}
					}

					// Read conductorProfile from settings store at call time
					const conductorProfile = useSettingsStore.getState().conductorProfile;

					// Substitute template variables. Use the resolved target tab
					// id for `activeTabId` so substitutions reflect the dispatch
					// target rather than whatever tab is actually active in the UI.
					promptToSend = substituteTemplateVariables(matchingCommand.prompt, {
						session,
						gitBranch,
						groupId: session.groupId,
						activeTabId: writeTabId ?? session.activeTabId,
						conductorProfile,
					});
					commandMetadata = {
						command: matchingCommand.command,
						description: matchingCommand.description,
					};

					logger.info(
						'[Remote] Substituted prompt (first 100 chars):',
						undefined,
						promptToSend.substring(0, 100)
					);
				} else {
					// Unknown slash command — route the error log to the targeted
					// tab (not whichever tab happens to be active) so the caller
					// sees the error in the conversation they dispatched into.
					logger.info('[Remote] Unknown slash command:', undefined, commandText);
					addLogToTab(
						sessionId,
						{
							source: 'system',
							text: `Unknown command: ${commandText}`,
						},
						writeTabId
					);
					return;
				}
			}

			try {
				// Get agent configuration for this session's tool type
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					logger.info(`[Remote] ERROR: Agent not found for toolType: ${session.toolType}`);
					return;
				}

				// The agent-config await above is a real microtask gap. Re-check
				// that the tab we resolved still exists; if it was closed in the
				// interim, abort before spawning so the agent doesn't start with
				// a `${sessionId}-ai-${tabId}` route that nothing reads from.
				if (writeTabId) {
					const liveSession = sessionsRef.current.find((s) => s.id === sessionId);
					const tabStillExists = liveSession?.aiTabs?.some((t) => t.id === writeTabId);
					if (!tabStillExists) {
						logger.warn(
							`[Remote] Target tab "${writeTabId}" was closed before spawn — dropping command`
						);
						return;
					}
				}

				const tabAgentSessionId = targetTab?.agentSessionId;
				const isReadOnly = targetTab?.readOnlyMode;

				// Filter out YOLO/skip-permissions flags when read-only mode is active
				const agentArgs = agent.args ?? [];
				const spawnArgs = isReadOnly ? filterYoloArgs(agentArgs, agent) : [...agentArgs];

				// Include tab ID in targetSessionId for proper output routing
				const targetSessionId = `${sessionId}-ai-${targetTab?.id || 'default'}`;
				const commandToUse = agent.path ?? agent.command ?? '';

				const appendSystemPrompt = await prepareMaestroSystemPrompt({
					session,
					activeTabId: targetTab?.id,
				});

				// Determine whether to send the prompt via stdin on Windows to avoid
				// exceeding the command line length limit. Remote commands may include
				// substituted slash command prompts that can be very large.
				const isSshSession = Boolean(session.sessionSshRemoteConfig?.enabled);
				const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
					isSshSession,
					supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
					hasImages: false, // Remote commands do not send images
				});

				logger.info('[Remote] Spawning agent:', undefined, {
					maestroSessionId: sessionId,
					targetSessionId,
					targetTabId: targetTab?.id,
					tabAgentSessionId: tabAgentSessionId || 'NEW SESSION',
					isResume: !!tabAgentSessionId,
					hasAppendSystemPrompt: !!appendSystemPrompt,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend.substring(0, 100),
				});

				// Add user message to target tab's logs and set state to busy
				const userLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'user',
					text: promptToSend,
					...(commandMetadata && { aiCommand: commandMetadata }),
				};

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Pin the target tab id so we don't accidentally write into a
						// different active tab if the user switched while we awaited
						// the agent config above.
						const resolvedWriteTabId = writeTabId ?? s.activeTabId;
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === resolvedWriteTabId
											? {
													...tab,
													state: 'busy' as const,
													logs: [...tab.logs, userLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!s.aiTabs?.some((t) => t.id === resolvedWriteTabId)) {
							logger.error('[runAICommand] Target tab not found in session — dropping user log');
							return s;
						}

						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'ai',
							thinkingStartTime: Date.now(),
							currentCycleTokens: 0,
							currentCycleBytes: 0,
							...(commandMetadata && {
								aiCommandHistory: Array.from(
									new Set([...(s.aiCommandHistory || []), command.trim()])
								).slice(-50),
							}),
							aiTabs: updatedAiTabs,
						};
					})
				);

				// Spawn agent with the prompt
				await window.maestro.process.spawn({
					sessionId: targetSessionId,
					toolType: session.toolType,
					cwd: session.cwd,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend,
					appendSystemPrompt,
					agentSessionId: tabAgentSessionId ?? undefined,
					readOnlyMode: isReadOnly,
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: session.customEnvVars,
					sessionCustomModel: session.customModel,
					sessionCustomContextWindow: session.customContextWindow,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					// Windows stdin handling - slash command prompts after template
					// substitution can exceed shell command line limits
					sendPromptViaStdin,
					sendPromptViaStdinRaw,
				});

				logger.info(`[Remote] ${session.toolType} spawn initiated successfully`);
			} catch (error: unknown) {
				captureException(error, {
					extra: { sessionId, toolType: session.toolType, mode: 'ai', operation: 'remote-spawn' },
				});
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorLogEntry: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: `Error: Failed to process remote command - ${errorMessage}`,
				};
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Mirror the success path: route the error log to the same tab
						// we tried to write into, falling back to active when unset.
						const resolvedWriteTabId = writeTabId ?? s.activeTabId;
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === resolvedWriteTabId
											? {
													...tab,
													state: 'idle' as const,
													thinkingStartTime: undefined,
													logs: [...tab.logs, errorLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!s.aiTabs?.some((t) => t.id === resolvedWriteTabId)) {
							logger.error(
								'[runAICommand error] Target tab not found in session — dropping error log'
							);
							return s;
						}

						return {
							...s,
							state: 'idle' as SessionState,
							busySource: undefined,
							thinkingStartTime: undefined,
							aiTabs: updatedAiTabs,
						};
					})
				);
			}
		};
		window.addEventListener('maestro:remoteCommand', handleRemoteCommand);
		return () => window.removeEventListener('maestro:remoteCommand', handleRemoteCommand);
	}, []);

	// ====================================================================
	// handleQuickActionsToggleRemoteControl
	// ====================================================================

	const handleQuickActionsToggleRemoteControl = useCallback(async () => {
		await toggleGlobalLive();
		if (isLiveMode) {
			setSuccessFlashNotification('Remote Control: OFFLINE — See indicator at top of left panel');
		} else {
			setSuccessFlashNotification(
				'Remote Control: LIVE — See LIVE indicator at top of left panel for QR code'
			);
		}
		setTimeout(() => setSuccessFlashNotification(null), 4000);
	}, [toggleGlobalLive, isLiveMode, setSuccessFlashNotification]);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		handleQuickActionsToggleRemoteControl,
		sessionSshRemoteNames,
	};
}

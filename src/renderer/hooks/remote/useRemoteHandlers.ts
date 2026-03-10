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
import type { Session, ToolType, SessionState, LogEntry, CustomAICommand } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { substituteTemplateVariables } from '../../utils/templateVariables';
import { gitService } from '../../services/git';
import { captureException } from '../../utils/sentry';
import { filterYoloArgs } from '../../utils/agentArgs';

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
		toggleGlobalLive,
		isLiveMode,
		sshRemoteConfigs,
	} = deps;

	// --- Store subscriptions ---
	const sessions = useSessionStore(selectSessions);
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const addLogToActiveTab = useMemo(() => useSessionStore.getState().addLogToTab, []);
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
			}>;
			const { sessionId, command, inputMode: webInputMode } = customEvent.detail;

			console.log('[Remote] Processing remote command via event:', {
				sessionId,
				command: command.substring(0, 50),
				webInputMode,
			});

			// Find the session directly from sessionsRef (not from React state which may be stale)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) {
				console.log('[Remote] ERROR: Session not found in sessionsRef:', sessionId);
				return;
			}

			// Use web's inputMode if provided, otherwise fall back to session state
			const effectiveInputMode = webInputMode || session.inputMode;

			console.log('[Remote] Found session:', {
				id: session.id,
				agentSessionId: session.agentSessionId || 'none',
				state: session.state,
				sessionInputMode: session.inputMode,
				effectiveInputMode,
				toolType: session.toolType,
			});

			// Handle terminal mode commands
			if (effectiveInputMode === 'terminal') {
				console.log('[Remote] Terminal mode - using runCommand for clean output');

				// Add user message to shell logs and set state to busy
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return {
							...s,
							state: 'busy' as SessionState,
							busySource: 'terminal',
							shellLogs: [
								...s.shellLogs,
								{
									id: generateId(),
									timestamp: Date.now(),
									source: 'user',
									text: command,
								},
							],
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
					console.log('[Remote] Terminal command completed successfully');
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
								shellLogs: [
									...s.shellLogs,
									{
										id: generateId(),
										timestamp: Date.now(),
										source: 'system',
										text: `Error: Failed to run command - ${errorMessage}`,
									},
								],
							};
						})
					);
				}
				return;
			}

			// Handle AI mode for batch-mode agents (Claude Code, Codex, OpenCode)
			const supportedBatchAgents: ToolType[] = ['claude-code', 'codex', 'opencode'];
			if (!supportedBatchAgents.includes(session.toolType)) {
				console.log('[Remote] Not a batch-mode agent, skipping');
				return;
			}

			// Check if session is busy
			if (session.state === 'busy') {
				console.log('[Remote] Session is busy, cannot process command');
				return;
			}

			// Check for slash commands (built-in and custom)
			let promptToSend = command;
			let commandMetadata: { command: string; description: string } | undefined;

			// Handle slash commands (custom AI commands only)
			if (command.trim().startsWith('/')) {
				const commandText = command.trim();
				console.log('[Remote] Detected slash command:', commandText);

				const matchingCustomCommand = customAICommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);
				const matchingSpeckitCommand = speckitCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);
				const matchingOpenspecCommand = openspecCommandsRef.current.find(
					(cmd) => cmd.command === commandText
				);

				const matchingCommand =
					matchingCustomCommand || matchingSpeckitCommand || matchingOpenspecCommand;

				if (matchingCommand) {
					console.log(
						'[Remote] Found matching command:',
						matchingCommand.command,
						matchingSpeckitCommand
							? '(spec-kit)'
							: matchingOpenspecCommand
								? '(openspec)'
								: '(custom)'
					);

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

					// Substitute template variables
					promptToSend = substituteTemplateVariables(matchingCommand.prompt, {
						session,
						gitBranch,
						conductorProfile,
					});
					commandMetadata = {
						command: matchingCommand.command,
						description: matchingCommand.description,
					};

					console.log(
						'[Remote] Substituted prompt (first 100 chars):',
						promptToSend.substring(0, 100)
					);
				} else {
					// Unknown slash command
					console.log('[Remote] Unknown slash command:', commandText);
					addLogToActiveTab(sessionId, {
						source: 'system',
						text: `Unknown command: ${commandText}`,
					});
					return;
				}
			}

			try {
				// Get agent configuration for this session's tool type
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					console.log(`[Remote] ERROR: Agent not found for toolType: ${session.toolType}`);
					return;
				}

				// Get the ACTIVE TAB's agentSessionId for session continuity
				const activeTab = getActiveTab(session);
				const tabAgentSessionId = activeTab?.agentSessionId;
				const isReadOnly = activeTab?.readOnlyMode;

				// Filter out YOLO/skip-permissions flags when read-only mode is active
				const agentArgs = agent.args ?? [];
				const spawnArgs = isReadOnly ? filterYoloArgs(agentArgs, agent) : [...agentArgs];

				// Include tab ID in targetSessionId for proper output routing
				const targetSessionId = `${sessionId}-ai-${activeTab?.id || 'default'}`;
				const commandToUse = agent.path ?? agent.command;

				console.log('[Remote] Spawning agent:', {
					maestroSessionId: sessionId,
					targetSessionId,
					activeTabId: activeTab?.id,
					tabAgentSessionId: tabAgentSessionId || 'NEW SESSION',
					isResume: !!tabAgentSessionId,
					command: commandToUse,
					args: spawnArgs,
					prompt: promptToSend.substring(0, 100),
				});

				// Add user message to active tab's logs and set state to busy
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

						const activeTab = getActiveTab(s);
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === s.activeTabId
											? {
													...tab,
													state: 'busy' as const,
													logs: [...tab.logs, userLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!activeTab) {
							console.error(
								'[runAICommand] No active tab found - session has no aiTabs, this should not happen'
							);
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
					agentSessionId: tabAgentSessionId ?? undefined,
					readOnlyMode: isReadOnly,
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: session.customEnvVars,
					sessionCustomModel: session.customModel,
					sessionCustomContextWindow: session.customContextWindow,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				});

				console.log(`[Remote] ${session.toolType} spawn initiated successfully`);
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
						const activeTab = getActiveTab(s);
						const updatedAiTabs =
							s.aiTabs?.length > 0
								? s.aiTabs.map((tab) =>
										tab.id === s.activeTabId
											? {
													...tab,
													state: 'idle' as const,
													thinkingStartTime: undefined,
													logs: [...tab.logs, errorLogEntry],
												}
											: tab
									)
								: s.aiTabs;

						if (!activeTab) {
							console.error(
								'[runAICommand error] No active tab found - session has no aiTabs, this should not happen'
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

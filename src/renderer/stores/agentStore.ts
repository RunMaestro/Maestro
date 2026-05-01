/**
 * agentStore - Zustand store for agent lifecycle orchestration
 *
 * This store follows the tabStore pattern: it does NOT own session-level agent
 * state (state, busySource, agentError, etc. — those stay in sessionStore).
 * Instead it provides orchestration actions that compose sessionStore mutations
 * with IPC calls for agent lifecycle management.
 *
 * Responsibilities:
 * 1. Agent detection cache — avoid repeated IPC calls for agent configs
 * 2. Error recovery actions — clearError, restart, retry, newSession, authenticate
 * 3. Agent lifecycle actions — kill, interrupt
 *
 * Can be used outside React via useAgentStore.getState().
 */

import { create } from 'zustand';
import type {
	Session,
	SessionState,
	AgentConfig,
	LogEntry,
	QueuedItem,
	CustomAICommand,
	SpecKitCommand,
	OpenSpecCommand,
	BmadCommand,
	PmCommand,
} from '../types';
import { createTab, getActiveTab } from '../utils/tabHelpers';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../utils/spawnHelpers';
import { generateId } from '../utils/ids';
import { useSessionStore, selectSessionById } from './sessionStore';
import { DEFAULT_IMAGE_ONLY_PROMPT } from '../hooks/input/useInputProcessing';
import { substituteTemplateVariables } from '../utils/templateVariables';
import { gitService } from '../services/git';
import { filterYoloArgs } from '../utils/agentArgs';
import { logger } from '../utils/logger';

// ============================================================================
// Store Types
// ============================================================================

export interface AgentStoreState {
	/** Cached agent detection results from main process */
	availableAgents: AgentConfig[];
	/** Whether agent detection has completed at least once */
	agentsDetected: boolean;
}

export interface AgentStoreActions {
	// === Agent Detection Cache ===

	/** Detect available agents and cache the results */
	refreshAgents: (sshRemoteId?: string) => Promise<void>;

	/** Look up a cached agent config by ID */
	getAgentConfig: (agentId: string) => AgentConfig | undefined;

	// === Error Recovery (extracted from App.tsx) ===

	/**
	 * Clear agent error state on a session and optionally a specific tab.
	 * Resets session to idle, clears error fields, notifies main process.
	 */
	clearAgentError: (sessionId: string, tabId?: string) => void;

	/**
	 * Start a new tab in the session after an error (recovery action).
	 * Clears error and creates a fresh AI tab.
	 */
	startNewSessionAfterError: (
		sessionId: string,
		options?: { saveToHistory?: boolean; showThinking?: 'off' | 'on' | 'sticky' }
	) => void;

	/**
	 * Clear error and let user retry manually (recovery action).
	 */
	retryAfterError: (sessionId: string) => void;

	/**
	 * Kill the agent process and clear error (recovery action for crashes).
	 * Agent will be respawned when user sends next message.
	 */
	restartAgentAfterError: (sessionId: string) => Promise<void>;

	/**
	 * Clear error and switch to terminal mode for re-authentication.
	 */
	authenticateAfterError: (sessionId: string) => void;

	// === Queue Processing ===

	/**
	 * Process a queued item (message or command) for a session.
	 * Builds spawn config and dispatches to the agent process.
	 */
	processQueuedItem: (
		sessionId: string,
		item: QueuedItem,
		deps: ProcessQueuedItemDeps
	) => Promise<void>;

	// === Agent Lifecycle ===

	/** Kill an agent process by session ID and optional suffix */
	killAgent: (sessionId: string, suffix?: string) => Promise<void>;

	/** Send interrupt (CTRL+C) to an agent process */
	interruptAgent: (sessionId: string) => Promise<void>;
}

/**
 * Dependencies passed from App.tsx for processQueuedItem.
 * These are mutable values from hooks/refs that can't be imported directly.
 */
export interface ProcessQueuedItemDeps {
	conductorProfile: string;
	customAICommands: CustomAICommand[];
	speckitCommands: SpecKitCommand[];
	openspecCommands: OpenSpecCommand[];
	bmadCommands?: BmadCommand[];
	pmCommands?: PmCommand[];
}

export type AgentStore = AgentStoreState & AgentStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find a session by ID from sessionStore.
 */
function getSession(sessionId: string): Session | undefined {
	return selectSessionById(sessionId)(useSessionStore.getState());
}

/**
 * Update a specific session in sessionStore using an updater function.
 */
function updateSession(sessionId: string, updater: (s: Session) => Session): void {
	useSessionStore
		.getState()
		.setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useAgentStore = create<AgentStore>()((set, get) => ({
	// --- State ---
	availableAgents: [],
	agentsDetected: false,

	// --- Actions ---

	refreshAgents: async (sshRemoteId?) => {
		const agents = await window.maestro.agents.detect(sshRemoteId);
		set({ availableAgents: agents, agentsDetected: true });
	},

	getAgentConfig: (agentId) => {
		return get().availableAgents.find((a) => a.id === agentId);
	},

	clearAgentError: (sessionId, tabId?) => {
		updateSession(sessionId, (s) => {
			const targetTabId = tabId ?? s.agentErrorTabId;
			const updatedAiTabs = targetTabId
				? s.aiTabs.map((tab) => (tab.id === targetTabId ? { ...tab, agentError: undefined } : tab))
				: s.aiTabs;
			return {
				...s,
				agentError: undefined,
				agentErrorTabId: undefined,
				agentErrorPaused: false,
				state: 'idle' as SessionState,
				aiTabs: updatedAiTabs,
			};
		});
		// Close the agent error modal if open
		window.maestro.agentError.clearError(sessionId).catch((err) => {
			logger.error('Failed to clear agent error:', undefined, err);
		});
	},

	startNewSessionAfterError: (sessionId, options?) => {
		const session = getSession(sessionId);
		if (!session) return;

		// Clear the error state
		get().clearAgentError(sessionId);

		// Create a new tab in the session
		updateSession(sessionId, (s) => {
			const result = createTab(s, {
				saveToHistory: options?.saveToHistory,
				showThinking: options?.showThinking,
			});
			if (!result) return s;
			return result.session;
		});
	},

	retryAfterError: (sessionId) => {
		get().clearAgentError(sessionId);
	},

	restartAgentAfterError: async (sessionId) => {
		const session = getSession(sessionId);
		if (!session) return;

		// Clear the error state
		get().clearAgentError(sessionId);

		// Kill any existing AI process
		try {
			await window.maestro.process.kill(`${sessionId}-ai`);
		} catch {
			// Process may not exist
		}
	},

	authenticateAfterError: (sessionId) => {
		const session = getSession(sessionId);
		if (!session) return;

		get().clearAgentError(sessionId);

		// Switch to terminal mode for re-auth (clear activeFileTabId to prevent orphaned file preview)
		useSessionStore.getState().setActiveSessionId(sessionId);
		updateSession(sessionId, (s) => ({ ...s, inputMode: 'terminal', activeFileTabId: null }));
	},

	processQueuedItem: async (sessionId, item, deps) => {
		const session = getSession(sessionId);
		if (!session) {
			logger.error('[processQueuedItem] Session not found:', undefined, sessionId);
			return;
		}

		// Find the TARGET tab for this queued item (NOT the active tab!)
		// The item carries its intended tabId from when it was queued
		const tabByItemId = session.aiTabs.find((tab) => tab.id === item.tabId);

		if (!tabByItemId && item.tabId) {
			logger.warn(
				'[processQueuedItem] Target tab was deleted after queueing. Aborting to prevent executing on wrong tab.',
				undefined,
				{ sessionId, itemTabId: item.tabId }
			);
			// Reset session to idle since we're aborting this queued item
			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						state: 'idle' as SessionState,
						busySource: undefined,
						thinkingStartTime: undefined,
					};
				})
			);
			return;
		}

		const targetTab = tabByItemId || getActiveTab(session);

		if (!targetTab) {
			logger.error(
				'[processQueuedItem] No target tab found — session has no aiTabs. Aborting spawn.',
				undefined,
				{ sessionId, itemTabId: item.tabId }
			);
			return;
		}

		const targetSessionId = `${sessionId}-ai-${targetTab.id}`;

		try {
			// Get agent configuration for this session's tool type
			const agent = await window.maestro.agents.get(session.toolType);
			if (!agent) throw new Error(`Agent not found for toolType: ${session.toolType}`);

			// Get the TARGET TAB's agentSessionId for session continuity
			const tabAgentSessionId = targetTab.agentSessionId;
			const isReadOnly = item.readOnlyMode || targetTab.readOnlyMode;

			// Filter out YOLO/skip-permissions flags when read-only mode is active
			const spawnArgs = isReadOnly
				? filterYoloArgs(agent.args || [], agent)
				: [...(agent.args || [])];

			const commandToUse = agent.path ?? agent.command ?? '';

			// Check if this is a message with images but no text
			const hasImages = item.images && item.images.length > 0;
			const hasText = item.text && item.text.trim();
			const isImageOnlyMessage = item.type === 'message' && hasImages && !hasText;

			if (item.type === 'message' && (hasText || isImageOnlyMessage)) {
				// Process a message - spawn agent with the message text
				const effectivePrompt = isImageOnlyMessage ? DEFAULT_IMAGE_ONLY_PROMPT : item.text!;

				// NOTE: The user-visible log entry for this message is appended by the
				// caller that dequeued the item (e.g. useAgentListeners onExit,
				// useInterruptHandler, useQueueProcessing.dispatchQueuedItem,
				// handleQuickActionsDebugReleaseQueuedItem) so it lands atomically with
				// the dequeue/state-busy transition. Adding it here too would duplicate.

				const appendSystemPrompt = await prepareMaestroSystemPrompt({
					session,
					activeTabId: targetTab.id,
				});

				const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
					isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
					supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
					hasImages: !!hasImages,
				});

				logger.info('[processQueuedItem] Spawning agent with queued message:', undefined, {
					sessionId: targetSessionId,
					toolType: session.toolType,
					prompt: effectivePrompt,
					promptLength: effectivePrompt?.length,
					hasAgentSessionId: !!tabAgentSessionId,
					agentSessionId: tabAgentSessionId,
					hasAppendSystemPrompt: !!appendSystemPrompt,
					isReadOnly,
					argsLength: spawnArgs.length,
					args: spawnArgs,
				});

				await window.maestro.process.spawn({
					sessionId: targetSessionId,
					toolType: session.toolType,
					cwd: session.cwd,
					command: commandToUse,
					args: spawnArgs,
					prompt: effectivePrompt,
					images: hasImages ? item.images : undefined,
					appendSystemPrompt,
					agentSessionId: tabAgentSessionId ?? undefined,
					readOnlyMode: isReadOnly,
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: session.customEnvVars,
					sessionCustomModel: targetTab.customModel ?? session.customModel,
					sessionCustomEffort: targetTab.customEffort ?? session.customEffort,
					sessionCustomContextWindow: session.customContextWindow,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
					sendPromptViaStdin,
					sendPromptViaStdinRaw,
				});
			} else if (item.type === 'command' && item.command) {
				// Process a slash command - find matching command
				// Check user-defined commands first, then agent-discovered commands with prompts
				const matchingCommand =
					deps.customAICommands.find((cmd) => cmd.command === item.command) ||
					deps.speckitCommands.find((cmd) => cmd.command === item.command) ||
					deps.openspecCommands.find((cmd) => cmd.command === item.command) ||
					deps.bmadCommands?.find((cmd) => cmd.command === item.command) ||
					deps.pmCommands?.find((cmd) => cmd.command === item.command);

				if (matchingCommand) {
					let gitBranch: string | undefined;
					if (session.isGitRepo) {
						try {
							const status = await gitService.getStatus(session.cwd);
							gitBranch = status.branch;
						} catch {
							// Ignore git errors
						}
					}

					// Substitute $ARGUMENTS or {{ARGS}} with command arguments,
					// or append args if no placeholder is found.
					let promptWithArgs = matchingCommand.prompt;
					if (item.commandArgs) {
						if (/\$ARGUMENTS/g.test(promptWithArgs)) {
							promptWithArgs = promptWithArgs.replace(/\$ARGUMENTS/g, item.commandArgs);
						} else if (/\{\{ARGS\}\}/g.test(promptWithArgs)) {
							promptWithArgs = promptWithArgs.replace(/\{\{ARGS\}\}/g, item.commandArgs);
						} else {
							// No placeholder found — append trailing text after the prompt
							promptWithArgs = `${promptWithArgs}\n\n${item.commandArgs}`;
						}
					} else {
						promptWithArgs = promptWithArgs
							.replace(/\$ARGUMENTS/g, '')
							.replace(/\{\{ARGS\}\}/g, '');
					}

					// Substitute {{TEMPLATE_VARIABLES}}
					const substitutedPrompt = substituteTemplateVariables(promptWithArgs, {
						session,
						gitBranch,
						groupId: session.groupId,
						activeTabId: targetTab.id,
						conductorProfile: deps.conductorProfile,
					});

					const appendSystemPromptForCommand = await prepareMaestroSystemPrompt({
						session,
						activeTabId: targetTab.id,
					});

					// Add user log showing the command with its interpolated prompt
					useSessionStore.getState().addLogToTab(
						sessionId,
						{
							source: 'user',
							text: substitutedPrompt,
							aiCommand: {
								command: matchingCommand.command,
								description: matchingCommand.description,
							},
							...(item.forceParallel && { forceParallel: true }),
						},
						item.tabId
					);

					// Track this command for automatic synopsis on completion
					updateSession(sessionId, (s) => ({
						...s,
						pendingAICommandForSynopsis: matchingCommand.command,
					}));

					// Compute stdin flags for command spawn (commands never have images)
					const { sendPromptViaStdin: cmdSendViaStdin, sendPromptViaStdinRaw: cmdSendViaStdinRaw } =
						getStdinFlags({
							isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
							supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
							hasImages: false,
						});

					// Spawn agent with the prompt
					await window.maestro.process.spawn({
						sessionId: targetSessionId,
						toolType: session.toolType,
						cwd: session.cwd,
						command: commandToUse,
						args: spawnArgs,
						prompt: substitutedPrompt,
						appendSystemPrompt: appendSystemPromptForCommand,
						agentSessionId: tabAgentSessionId ?? undefined,
						readOnlyMode: isReadOnly,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionCustomEnvVars: session.customEnvVars,
						sessionCustomModel: targetTab.customModel ?? session.customModel,
						sessionCustomEffort: targetTab.customEffort ?? session.customEffort,
						sessionCustomContextWindow: session.customContextWindow,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						sendPromptViaStdin: cmdSendViaStdin,
						sendPromptViaStdinRaw: cmdSendViaStdinRaw,
					});
				} else {
					// Unknown command - add error log and reset to idle
					useSessionStore.getState().addLogToTab(sessionId, {
						source: 'system',
						text: `Unknown command: ${item.command}`,
					});
					useSessionStore.getState().setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const updatedAiTabs = s.aiTabs?.map((tab) =>
								tab.id === item.tabId
									? {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
										}
									: tab
							);
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
			}
		} catch (error: any) {
			logger.error('[processQueuedItem] Failed to process queued item:', undefined, error);
			const errorLogEntry: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: `Error: Failed to process queued ${item.type} - ${error.message}`,
			};
			useSessionStore.getState().setSessions((prev) =>
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
						logger.error(
							'[processQueuedItem error] No active tab found - session has no aiTabs, this should not happen'
						);
					}

					return {
						...s,
						state: 'idle',
						busySource: undefined,
						thinkingStartTime: undefined,
						aiTabs: updatedAiTabs,
					};
				})
			);
		}
	},

	killAgent: async (sessionId, suffix?) => {
		const target = suffix ? `${sessionId}-${suffix}` : `${sessionId}-ai`;
		try {
			await window.maestro.process.kill(target);
		} catch {
			// Process may not exist
		}
	},

	interruptAgent: async (sessionId) => {
		try {
			await window.maestro.process.interrupt(sessionId);
		} catch {
			// Process may not exist
		}
	},
}));

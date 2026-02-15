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
 * Can be used outside React via useAgentStore.getState() / getAgentActions().
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
} from '../types';
import { createTab, getActiveTab } from '../utils/tabHelpers';
import { generateId } from '../utils/ids';
import { useSessionStore } from './sessionStore';
import { DEFAULT_IMAGE_ONLY_PROMPT } from '../hooks/input/useInputProcessing';
import { maestroSystemPrompt } from '../../prompts';
import { substituteTemplateVariables } from '../utils/templateVariables';
import { gitService } from '../services/git';

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
}

export type AgentStore = AgentStoreState & AgentStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find a session by ID from sessionStore.
 */
function getSession(sessionId: string): Session | undefined {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId);
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
			console.error('Failed to clear agent error:', err);
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

		// Switch to terminal mode for re-auth
		useSessionStore.getState().setActiveSessionId(sessionId);
		updateSession(sessionId, (s) => ({ ...s, inputMode: 'terminal' }));
	},

	processQueuedItem: async (sessionId, item, deps) => {
		const session = getSession(sessionId);
		if (!session) {
			console.error('[processQueuedItem] Session not found:', sessionId);
			return;
		}

		// Find the TARGET tab for this queued item (NOT the active tab!)
		// The item carries its intended tabId from when it was queued
		const tabByItemId = session.aiTabs.find((tab) => tab.id === item.tabId);

		if (!tabByItemId && item.tabId) {
			console.warn(
				'[processQueuedItem] Target tab was deleted after queueing. Aborting to prevent executing on wrong tab.',
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
			console.error(
				'[processQueuedItem] No target tab found — session has no aiTabs. Aborting spawn.',
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
				? (agent.args || []).filter(
						(arg) =>
							arg !== '--dangerously-skip-permissions' &&
							arg !== '--dangerously-bypass-approvals-and-sandbox'
					)
				: [...(agent.args || [])];

			const commandToUse = agent.path ?? agent.command;

			// Check if this is a message with images but no text
			const hasImages = item.images && item.images.length > 0;
			const hasText = item.text && item.text.trim();
			const isImageOnlyMessage = item.type === 'message' && hasImages && !hasText;

			if (item.type === 'message' && (hasText || isImageOnlyMessage)) {
				// Process a message - spawn agent with the message text
				let effectivePrompt = isImageOnlyMessage ? DEFAULT_IMAGE_ONLY_PROMPT : item.text!;

				// For NEW sessions (no agentSessionId), prepend Maestro system prompt
				const isNewSession = !tabAgentSessionId;
				if (isNewSession && maestroSystemPrompt) {
					let gitBranch: string | undefined;
					if (session.isGitRepo) {
						try {
							const status = await gitService.getStatus(session.cwd);
							gitBranch = status.branch;
						} catch {
							// Ignore git errors
						}
					}

					const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
						session,
						gitBranch,
						conductorProfile: deps.conductorProfile,
					});

					effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${effectivePrompt}`;
				}

				console.log('[processQueuedItem] Spawning agent with queued message:', {
					sessionId: targetSessionId,
					toolType: session.toolType,
					prompt: effectivePrompt,
					promptLength: effectivePrompt?.length,
					hasAgentSessionId: !!tabAgentSessionId,
					agentSessionId: tabAgentSessionId,
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
					agentSessionId: tabAgentSessionId ?? undefined,
					readOnlyMode: isReadOnly,
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionCustomEnvVars: session.customEnvVars,
					sessionCustomModel: session.customModel,
					sessionCustomContextWindow: session.customContextWindow,
					sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				});
			} else if (item.type === 'command' && item.command) {
				// Process a slash command - find matching command
				const matchingCommand =
					deps.customAICommands.find((cmd) => cmd.command === item.command) ||
					deps.speckitCommands.find((cmd) => cmd.command === item.command) ||
					deps.openspecCommands.find((cmd) => cmd.command === item.command);

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

					// Substitute $ARGUMENTS with command arguments, or append args if no placeholder
					let promptWithArgs = matchingCommand.prompt;
					if (item.commandArgs) {
						if (/\$ARGUMENTS/g.test(promptWithArgs)) {
							promptWithArgs = promptWithArgs.replace(/\$ARGUMENTS/g, item.commandArgs);
						} else {
							// No $ARGUMENTS placeholder — append trailing text after the prompt
							promptWithArgs = `${promptWithArgs}\n\n${item.commandArgs}`;
						}
					} else {
						promptWithArgs = promptWithArgs.replace(/\$ARGUMENTS/g, '');
					}

					// Substitute {{TEMPLATE_VARIABLES}}
					const substitutedPrompt = substituteTemplateVariables(promptWithArgs, {
						session,
						gitBranch,
						conductorProfile: deps.conductorProfile,
					});

					// For NEW sessions, prepend Maestro system prompt
					const isNewSessionForCommand = !tabAgentSessionId;
					let promptForAgent = substitutedPrompt;
					if (isNewSessionForCommand && maestroSystemPrompt) {
						const substitutedSystemPrompt = substituteTemplateVariables(maestroSystemPrompt, {
							session,
							gitBranch,
							conductorProfile: deps.conductorProfile,
						});
						promptForAgent = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${substitutedPrompt}`;
					}

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
						},
						item.tabId
					);

					// Track this command for automatic synopsis on completion
					updateSession(sessionId, (s) => ({
						...s,
						pendingAICommandForSynopsis: matchingCommand.command,
					}));

					// Spawn agent with the prompt
					await window.maestro.process.spawn({
						sessionId: targetSessionId,
						toolType: session.toolType,
						cwd: session.cwd,
						command: commandToUse,
						args: spawnArgs,
						prompt: promptForAgent,
						agentSessionId: tabAgentSessionId ?? undefined,
						readOnlyMode: isReadOnly,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionCustomEnvVars: session.customEnvVars,
						sessionCustomModel: session.customModel,
						sessionCustomContextWindow: session.customContextWindow,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
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
			console.error('[processQueuedItem] Failed to process queued item:', error);
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
						console.error(
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

// ============================================================================
// Selectors
// ============================================================================

/** Select the list of available (detected) agents */
export const selectAvailableAgents = (state: AgentStore): AgentConfig[] => state.availableAgents;

/** Select whether agent detection has completed */
export const selectAgentsDetected = (state: AgentStore): boolean => state.agentsDetected;

// ============================================================================
// Non-React Access
// ============================================================================

/**
 * Get the current agent store state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getAgentState() {
	return useAgentStore.getState();
}

/**
 * Get stable agent action references outside React.
 */
export function getAgentActions() {
	const state = useAgentStore.getState();
	return {
		refreshAgents: state.refreshAgents,
		getAgentConfig: state.getAgentConfig,
		processQueuedItem: state.processQueuedItem,
		clearAgentError: state.clearAgentError,
		startNewSessionAfterError: state.startNewSessionAfterError,
		retryAfterError: state.retryAfterError,
		restartAgentAfterError: state.restartAgentAfterError,
		authenticateAfterError: state.authenticateAfterError,
		killAgent: state.killAgent,
		interruptAgent: state.interruptAgent,
	};
}

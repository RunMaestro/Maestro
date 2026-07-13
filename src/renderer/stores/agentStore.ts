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
} from '../types';
import type {
	AgentCapabilitiesSnapshot,
	AgentCapabilitiesSnapshotMap,
} from '../../shared/agentCapabilities';
import { buildSnapshotKey } from '../../shared/agentCapabilities';
import { resolveTabPermissionMode } from '../../shared/agentMetadata';
import { createTab, getActiveTab } from '../utils/tabHelpers';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../utils/spawnHelpers';
import { generateId } from '../utils/ids';
import { useSessionStore, selectSessionById } from './sessionStore';
// Agent Resilience: snapshot dispatched prompts for auto-retry. Import cycle
// with retryStore is safe — both sides only touch each other inside runtime
// callbacks, never at module-eval time.
import { noteDispatch } from './retryStore';
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
	/**
	 * Persisted capability snapshots mirrored from the main process.
	 * Key is `agentId` (local) or `agentId:remoteUuid` (SSH).
	 */
	capabilitySnapshots: AgentCapabilitiesSnapshotMap;
	/** True once `loadCapabilitySnapshots()` has fetched the initial map. */
	capabilitySnapshotsLoaded: boolean;
}

export interface AgentStoreActions {
	// === Agent Detection Cache ===

	/** Detect available agents and cache the results */
	refreshAgents: (sshRemoteId?: string) => Promise<void>;

	/** Look up a cached agent config by ID */
	getAgentConfig: (agentId: string) => AgentConfig | undefined;

	// === Capability Snapshots (status + version + last probed) ===

	/** Fetch all persisted snapshots from main and start the live subscription. */
	loadCapabilitySnapshots: () => Promise<void>;

	/** Look up a snapshot by agent id (and optional SSH remote uuid). */
	getCapabilitySnapshot: (
		agentId: string,
		remoteId?: string
	) => AgentCapabilitiesSnapshot | undefined;

	/** Request a fresh probe for one agent. Updates flow back via the event subscription. */
	reprobeAgent: (
		agentId: string,
		sshRemoteId?: string
	) => Promise<AgentCapabilitiesSnapshot | null>;

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

/**
 * Holds the unsubscribe handle for the snapshot-updated IPC bridge so we
 * don't register multiple listeners if `loadCapabilitySnapshots()` runs
 * more than once (e.g. during hot reload).
 */
let snapshotUnsubscribe: (() => void) | null = null;

export const useAgentStore = create<AgentStore>()((set, get) => ({
	// --- State ---
	availableAgents: [],
	agentsDetected: false,
	capabilitySnapshots: {},
	capabilitySnapshotsLoaded: false,

	// --- Actions ---

	refreshAgents: async (sshRemoteId?) => {
		const agents = await window.maestro.agents.detect(sshRemoteId);
		set({ availableAgents: agents, agentsDetected: true });
	},

	getAgentConfig: (agentId) => {
		return get().availableAgents.find((a) => a.id === agentId);
	},

	loadCapabilitySnapshots: async () => {
		// Always flip `loaded` true so the UI never gets stuck on "Loading…"
		// when the IPC call rejects (renderer disposal, main-process crash).
		// Errors still bubble up so Sentry / ErrorBoundary can record them.
		try {
			const snapshots = await window.maestro.agents.getAllSnapshots();
			set({ capabilitySnapshots: snapshots, capabilitySnapshotsLoaded: true });
		} catch (err) {
			set({ capabilitySnapshotsLoaded: true });
			throw err;
		}

		// Wire the live update subscription exactly once. Subsequent calls
		// (e.g. across hot reloads) reuse the existing listener; calling
		// `removeListener` from a previous closure handles renderer reloads.
		if (snapshotUnsubscribe) {
			snapshotUnsubscribe();
			snapshotUnsubscribe = null;
		}
		snapshotUnsubscribe = window.maestro.agents.onSnapshotUpdated((payload) => {
			const current = get().capabilitySnapshots;
			const next = { ...current };
			if (payload.snapshot === null) {
				delete next[payload.key];
			} else {
				next[payload.key] = payload.snapshot;
			}
			set({ capabilitySnapshots: next });
		});
	},

	getCapabilitySnapshot: (agentId, remoteId) => {
		// Delegate to the shared key builder so this never drifts from the
		// main-process snapshot store's key format.
		return get().capabilitySnapshots[buildSnapshotKey(agentId, remoteId)];
	},

	reprobeAgent: async (agentId, sshRemoteId) => {
		return window.maestro.agents.reprobe(agentId, sshRemoteId);
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
		// The item carries its intended tabId from when it was queued. A tab that
		// was closed while it still had queued work lives on in orphanedThinkingTabs
		// (fire-and-forget background send), so it is also a valid target - look
		// there before deciding the tab is truly gone.
		const tabByItemId =
			session.aiTabs.find((tab) => tab.id === item.tabId) ||
			session.orphanedThinkingTabs?.find((tab) => tab.id === item.tabId);

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

		// Agent Resilience: snapshot the exact prompt (keyed on the RESOLVED target
		// tab so it matches the error listener's tab) so it can be auto-resent if
		// this turn fails with a transient upstream error. We record the item with
		// its tabId pinned to the resolved target — `item.tabId` may be undefined
		// when the item fell back to the active tab.
		noteDispatch(sessionId, { ...item, tabId: targetTab.id }, deps);

		try {
			// Get agent configuration for this session's tool type
			const agent = await window.maestro.agents.get(session.toolType);
			if (!agent) throw new Error(`Agent not found for toolType: ${session.toolType}`);

			// Get the TARGET TAB's agentSessionId for session continuity
			const tabAgentSessionId = targetTab.agentSessionId;
			const isReadOnly =
				item.readOnlyMode === true ||
				targetTab.readOnlyMode === true ||
				targetTab.permissionMode === 'readonly';
			const effectivePermissionMode = isReadOnly ? 'readonly' : resolveTabPermissionMode(targetTab);

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
					permissionMode: effectivePermissionMode,
					sessionCustomPath: session.customPath,
					sessionCustomArgs: session.customArgs,
					sessionAdditionalDirectories: session.additionalDirectories,
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
				const matchingAgentCommand = session.agentCommands?.find(
					(cmd) => cmd.command === item.command && cmd.prompt
				);
				const matchingCommand =
					deps.customAICommands.find((cmd) => cmd.command === item.command) ||
					deps.speckitCommands.find((cmd) => cmd.command === item.command) ||
					deps.openspecCommands.find((cmd) => cmd.command === item.command) ||
					deps.bmadCommands?.find((cmd) => cmd.command === item.command) ||
					(matchingAgentCommand
						? {
								command: matchingAgentCommand.command,
								description: matchingAgentCommand.description,
								prompt: matchingAgentCommand.prompt!,
							}
						: undefined);

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
						permissionMode: effectivePermissionMode,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionAdditionalDirectories: session.additionalDirectories,
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
					useSessionStore.getState().addLogToTab(
						sessionId,
						{
							source: 'error',
							text: `Unknown command: ${item.command}`,
						},
						item.tabId
					);
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
				source: 'error',
				text: `Error: Failed to process queued ${item.type} - ${error.message}`,
			};
			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					const resolvedTabId = item.tabId ?? s.activeTabId;
					const updatedAiTabs =
						s.aiTabs?.length > 0
							? s.aiTabs.map((tab) =>
									tab.id === resolvedTabId
										? {
												...tab,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: [...tab.logs, errorLogEntry],
											}
										: tab
								)
							: s.aiTabs;

					const targetTabExists = s.aiTabs?.some((tab) => tab.id === resolvedTabId);
					if (!targetTabExists) {
						logger.error(
							'[processQueuedItem error] Target tab not found - error log dropped',
							undefined,
							{
								sessionId,
								resolvedTabId,
							}
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

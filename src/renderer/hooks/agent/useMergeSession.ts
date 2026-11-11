/**
 * useMergeSession Hook
 *
 * Manages the complete workflow for merging session contexts:
 * 1. Extract context from source session/tab
 * 2. Extract context from target session/tab
 * 3. Optionally groom contexts using AI to remove duplicates
 * 4. Create a new session with the merged/groomed logs
 * 5. Clean up any temporary resources
 *
 * This hook coordinates between:
 * - ContextGroomingService for AI-powered context consolidation
 * - tabHelpers for creating merged sessions
 * - Per-tab state tracking for non-blocking UI feedback
 *
 * Features:
 * - Per-tab state tracking (allows other tabs to remain interactive during merge)
 * - Non-blocking overlay replaces input area instead of modal
 * - Toast notifications with click-to-navigate on completion
 *
 * State lives in operationStore (Zustand); this hook owns orchestration only.
 */

import { useCallback, useRef } from 'react';
import type { Session, AITab, LogEntry } from '../../types';
import type { MergeResult, GroomingProgress, MergeRequest } from '../../types/contextMerge';
import type { MergeOptions } from '../../components/MergeSessionModal';
import {
	ContextGroomingService,
	contextGroomingService,
	groomingIdentityOf,
} from '../../services/contextGroomer';
import { projectTabProvider } from '../../utils/providerTabSessions';
import { extractTabContext, formatLogsForContextInjection } from '../../utils/contextExtractor';
import { resolveContextWindow } from '../../utils/contextWindowPrecedence';
import { getContextWindowForAgent } from '../../../shared/agentConstants';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { createMergedSession, getActiveTab } from '../../utils/tabHelpers';
import { applyDefaultAgentTokenProxy } from '../../services/agentGateway';
import { generateId } from '../../utils/ids';
import { useOperationStore, selectIsAnyMerging } from '../../stores/operationStore';
import type { MergeState, TabMergeState } from '../../stores/operationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { estimateTokensFromLogs } from '../../../shared/formatters';
import { logger } from '../../utils/logger';

// Re-export types from the canonical store location
export type { MergeState, TabMergeState } from '../../stores/operationStore';

/**
 * Maximum recommended context tokens before warning the user
 * Default: 100,000 tokens (safe for most models)
 */
const MAX_CONTEXT_TOKENS_WARNING = 100000;

/**
 * Share of the target's context window merged-in context may take, leaving
 * room for the target's own conversation and the reply.
 */
const MERGE_CONTEXT_WINDOW_SHARE = 0.5;

/**
 * Token budget for context injected into a target tab. Uses the same window
 * ranking as the header gauge (model marker, user-edited, provider-reported,
 * stored, agent default). A provider with no known window (Grok until its
 * selected model reports one) gets the conservative fixed bound, never a
 * figure derived from cumulative usage totals.
 */
function resolveMergeContextBudget(
	targetAgent: Session,
	targetTab: AITab
): { maxTokens: number; windowKnown: boolean } {
	// The tab's own provider decides the window, not the agent's default one.
	const { agent: targetSession } = projectTabProvider(targetAgent, targetTab);
	const { window } = resolveContextWindow({
		customModel: targetTab.customModel ?? targetSession.customModel,
		customContextWindow: targetSession.customContextWindow,
		contextWindowSource: targetSession.contextWindowSource,
		reportedWindow: targetTab.usageStats?.contextWindow,
		reportedResolved: targetTab.usageStats?.contextWindowResolved,
		configuredWindow: getContextWindowForAgent(targetSession.toolType),
	});
	if (window > 0) {
		return { maxTokens: Math.floor(window * MERGE_CONTEXT_WINDOW_SHARE), windowKnown: true };
	}
	return { maxTokens: MAX_CONTEXT_TOKENS_WARNING, windowKnown: false };
}

/**
 * Combine two tabs' logs for a merged agent. Each side keeps its own order;
 * timestamps interleave them only when asked AND every timestamp is known
 * (a stored Grok projection carries NaN for an unknown time, which would make
 * a comparator sort inconsistent). Array.prototype.sort is stable.
 */
function orderMergedLogs(
	sourceLogs: LogEntry[],
	targetLogs: LogEntry[],
	preserveTimestamps: boolean | undefined
): LogEntry[] {
	const combined = [...sourceLogs, ...targetLogs];
	if (!preserveTimestamps || !combined.every((log) => Number.isFinite(log.timestamp))) {
		return combined;
	}
	return combined.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Identity a merged agent inherits from its source: the provider account
 * (custom env such as GROK_HOME), host, binary, model and working directory.
 * Without it a merged Grok agent would run under the process-global account
 * or locally instead of on the source's SSH remote.
 */
function mergedSessionIdentity(source: Session): Partial<Session> {
	const identity: Partial<Session> = { cwd: source.cwd };
	const keys = [
		'customPath',
		'customArgs',
		'customEnvVars',
		'customModel',
		'customEffort',
		'customContextWindow',
		'contextWindowSource',
		'sshRemoteId',
		'sessionSshRemoteConfig',
		'additionalDirectories',
	] as const;
	for (const key of keys) {
		if (source[key] !== undefined) {
			(identity as Record<string, unknown>)[key] = source[key];
		}
	}
	return identity;
}

/**
 * Request to merge two sessions/tabs
 */
export interface MergeSessionRequest {
	/** Source session containing context to merge */
	sourceSession: Session;
	/** Tab ID within source session */
	sourceTabId: string;
	/** Target session to merge with */
	targetSession: Session;
	/** Tab ID within target session (optional - uses active tab if not specified) */
	targetTabId?: string;
	/** Merge options from the modal */
	options: MergeOptions;
}

/**
 * Result returned by the useMergeSession hook
 */
export interface UseMergeSessionResult {
	/** Current state of the merge operation (for the active tab) */
	mergeState: MergeState;
	/** Progress information during merge (for the active tab) */
	progress: GroomingProgress | null;
	/** Error message if merge failed (for the active tab) */
	error: string | null;
	/** Whether a merge is currently in progress globally */
	isMergeInProgress: boolean;
	/** Start time for elapsed time display */
	startTime: number;
	/** Source display name for the active tab's merge */
	sourceName: string | undefined;
	/** Target display name for the active tab's merge */
	targetName: string | undefined;
	/** Get merge state for a specific source tab */
	getTabMergeState: (tabId: string) => TabMergeState | null;
	/** Check if any tab is currently merging */
	isAnyMerging: boolean;
	/** Start a merge operation */
	startMerge: (request: MergeSessionRequest) => Promise<MergeResult>;
	/** Cancel the merge operation for a specific source tab */
	cancelTab: (tabId: string) => void;
	/** Cancel an in-progress merge operation (all tabs) */
	cancelMerge: () => void;
	/** Clear the state for a specific source tab (call after handling completion) */
	clearTabState: (tabId: string) => void;
	/** Reset the hook state back to idle */
	reset: () => void;
}

/**
 * Default progress state at start of merge
 */
const INITIAL_PROGRESS: GroomingProgress = {
	stage: 'collecting',
	progress: 0,
	message: 'Preparing to merge contexts...',
};

/**
 * Get the display name for a session
 */
function getSessionDisplayName(session: Session): string {
	return session.name || session.projectRoot.split('/').pop() || 'Unnamed Session';
}

/**
 * Generate a name for the merged session
 */
function generateMergedSessionName(
	sourceSession: Session,
	_sourceTab: AITab,
	targetSession: Session,
	_targetTab: AITab
): string {
	const sourceName = getSessionDisplayName(sourceSession);
	const targetName = getSessionDisplayName(targetSession);

	// If merging tabs from same session, use single session name
	if (sourceSession.id === targetSession.id) {
		return `${sourceName} (Merged)`;
	}

	// Otherwise combine both session names
	return `Merged: ${sourceName} + ${targetName}`;
}

/**
 * Hook for managing session merge operations.
 *
 * Provides complete workflow management for merging two sessions/tabs,
 * including optional AI-powered context grooming to remove duplicates.
 * Tracks per-tab state to allow non-blocking operations.
 *
 * @param activeTabId - The currently active tab ID (for backwards compatibility)
 * @returns Object with merge state and control functions
 *
 * @example
 * const {
 *   mergeState,
 *   progress,
 *   error,
 *   startMerge,
 *   cancelTab,
 *   getTabMergeState,
 * } = useMergeSession(activeSession?.activeTabId);
 *
 * // Start a merge
 * const result = await startMerge({
 *   sourceSession,
 *   sourceTabId: activeTabId,
 *   targetSession,
 *   targetTabId,
 *   options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
 * });
 *
 * // Check if current tab is merging
 * const tabState = getTabMergeState(activeTabId);
 * const isTabMerging = tabState?.state === 'merging';
 */
export function useMergeSession(activeTabId?: string): UseMergeSessionResult {
	// Per-tab state lives in operationStore
	const tabStates = useOperationStore((s) => s.mergeStates);
	const globalMergeInProgress = useOperationStore((s) => s.globalMergeInProgress);
	const cancelRefs = useRef<Map<string, boolean>>(new Map());
	const groomingServiceRef = useRef<ContextGroomingService>(contextGroomingService);

	// Get state for the active tab (for backwards compatibility)
	const activeTabState = activeTabId ? tabStates.get(activeTabId) : null;

	// Selector: any tab currently merging?
	const isAnyMerging = useOperationStore(selectIsAnyMerging);

	/**
	 * Get merge state for a specific source tab
	 */
	const getTabMergeState = useCallback((tabId: string): TabMergeState | null => {
		return useOperationStore.getState().mergeStates.get(tabId) || null;
	}, []);

	/**
	 * Reset the hook state to idle
	 */
	const reset = useCallback(() => {
		useOperationStore.getState().clearAllMergeStates();
		cancelRefs.current = new Map();
		useOperationStore.getState().setGlobalMergeInProgress(false);
	}, []);

	/**
	 * Clear the state for a specific source tab (call after handling completion)
	 */
	const clearTabState = useCallback((tabId: string) => {
		useOperationStore.getState().clearMergeTabState(tabId);
		cancelRefs.current.delete(tabId);
	}, []);

	/**
	 * Cancel the merge operation for a specific source tab
	 */
	const cancelTab = useCallback((tabId: string) => {
		cancelRefs.current.set(tabId, true);
		groomingServiceRef.current.cancelGrooming();
		useOperationStore.getState().clearMergeTabState(tabId);
		useOperationStore.getState().setGlobalMergeInProgress(false);
	}, []);

	/**
	 * Cancel all in-progress merge operations
	 */
	const cancelMerge = useCallback(() => {
		const states = useOperationStore.getState().mergeStates;
		for (const tabId of states.keys()) {
			cancelRefs.current.set(tabId, true);
		}
		groomingServiceRef.current.cancelGrooming();
		useOperationStore.getState().clearAllMergeStates();
		useOperationStore.getState().setGlobalMergeInProgress(false);
	}, []);

	/**
	 * Execute the merge workflow
	 */
	const startMerge = useCallback(async (request: MergeSessionRequest): Promise<MergeResult> => {
		const { sourceSession, sourceTabId, targetSession, targetTabId, options } = request;

		// Edge case: Check for concurrent merge operations
		if (useOperationStore.getState().globalMergeInProgress) {
			return {
				success: false,
				error: 'A merge operation is already in progress. Please wait for it to complete.',
			};
		}

		// Check if this source tab is already merging
		const existingState = useOperationStore.getState().mergeStates.get(sourceTabId);
		if (existingState?.state === 'merging') {
			return {
				success: false,
				error: 'This tab is already being merged.',
			};
		}

		// Set global merge flag
		useOperationStore.getState().setGlobalMergeInProgress(true);

		const startTime = Date.now();
		const sourceDisplayName = getSessionDisplayName(sourceSession);
		const store = useOperationStore.getState();

		// Initialize tab state
		cancelRefs.current.set(sourceTabId, false);
		store.setMergeTabState(sourceTabId, {
			state: 'merging',
			progress: INITIAL_PROGRESS,
			result: null,
			error: null,
			startTime,
			sourceName: sourceDisplayName,
			targetName: undefined, // Will be set after we resolve the target tab
		});

		try {
			// Step 1: Validate inputs and get tabs
			const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
			if (!sourceTab) {
				throw new Error('Source tab not found');
			}

			const resolvedTargetTabId = targetTabId ?? getActiveTab(targetSession)?.id;
			const targetTab = resolvedTargetTabId
				? targetSession.aiTabs.find((t) => t.id === resolvedTargetTabId)
				: getActiveTab(targetSession);
			if (!targetTab) {
				throw new Error('Target tab not found');
			}

			// Update tab state with target name
			const targetDisplayName = getSessionDisplayName(targetSession);
			useOperationStore
				.getState()
				.updateMergeTabState(sourceTabId, { targetName: targetDisplayName });

			// Edge case: Check for self-merge attempt
			if (sourceSession.id === targetSession.id && sourceTabId === targetTab.id) {
				throw new Error('Cannot merge a tab with itself');
			}

			// Edge case: Check for empty context source
			if (sourceTab.logs.length === 0) {
				throw new Error('Cannot merge empty context - source tab has no conversation history');
			}

			// Edge case: Check for empty target context (just a warning, allow it)
			if (targetTab.logs.length === 0 && sourceTab.logs.length > 0) {
				console.info('Merging into empty target tab - will copy source context');
			}

			// Edge case: Check for context too large
			const sourceTokens = estimateTokensFromLogs(sourceTab.logs);
			const targetTokens = estimateTokensFromLogs(targetTab.logs);
			const estimatedMergedTokens = sourceTokens + targetTokens;

			if (estimatedMergedTokens > MAX_CONTEXT_TOKENS_WARNING) {
				logger.warn(
					`Large context merge: ~${estimatedMergedTokens.toLocaleString()} tokens. ` +
						`This may exceed some agents' context windows.`
				);
			}

			// Check for cancellation
			if (cancelRefs.current.get(sourceTabId)) {
				return { success: false, error: 'Merge cancelled' };
			}

			// Step 2: Extract contexts from both tabs
			useOperationStore.getState().updateMergeTabState(sourceTabId, {
				progress: {
					stage: 'collecting',
					progress: 10,
					message: 'Extracting source context...',
				},
			});

			const sourceContext = extractTabContext(sourceTab, sourceDisplayName, sourceSession);

			useOperationStore.getState().updateMergeTabState(sourceTabId, {
				progress: {
					stage: 'collecting',
					progress: 20,
					message: 'Extracting target context...',
				},
			});

			const targetContext = extractTabContext(targetTab, targetDisplayName, targetSession);

			// Check for cancellation
			if (cancelRefs.current.get(sourceTabId)) {
				return { success: false, error: 'Merge cancelled' };
			}

			// Step 3: Determine which logs to use (groomed or raw)
			let mergedLogs: LogEntry[];
			let tokensSaved = 0;
			let groomed = false;

			if (options.groomContext) {
				// Use AI grooming to consolidate and deduplicate
				useOperationStore.getState().updateMergeTabState(sourceTabId, {
					progress: {
						stage: 'grooming',
						progress: 30,
						message: 'Starting AI grooming...',
					},
				});

				// The provider the context is going to runs the turn, on that
				// agent's account, binary and host: the source agent for a new
				// merged agent, else the target tab's own provider (its projection
				// of the target agent). A merge into an existing tab grooms the
				// source alone: the target already holds its own history, and
				// grooming it too would paste it back (duplicate context).
				const groomingAgent = options.createNewSession
					? sourceSession
					: projectTabProvider(targetSession, targetTab).agent;
				const groomingRequest: MergeRequest = {
					sources: options.createNewSession ? [sourceContext, targetContext] : [sourceContext],
					targetAgent: groomingAgent.toolType,
					targetProjectRoot: groomingAgent.projectRoot,
					...groomingIdentityOf(groomingAgent),
				};

				const groomingResult = await groomingServiceRef.current.groomContexts(
					groomingRequest,
					(groomProgress) => {
						if (!cancelRefs.current.get(sourceTabId)) {
							useOperationStore
								.getState()
								.updateMergeTabState(sourceTabId, { progress: groomProgress });
						}
					}
				);

				// Check for cancellation
				if (cancelRefs.current.get(sourceTabId)) {
					return { success: false, error: 'Merge cancelled' };
				}

				if (!groomingResult.success) {
					throw new Error(groomingResult.error || 'Grooming failed');
				}

				mergedLogs = groomingResult.groomedLogs;
				tokensSaved = groomingResult.tokensSaved;
				groomed = true;
			} else {
				// Simply concatenate logs without grooming
				useOperationStore.getState().updateMergeTabState(sourceTabId, {
					progress: {
						stage: 'creating',
						progress: 60,
						message: 'Combining contexts...',
					},
				});

				// Merge logs maintaining chronological order
				mergedLogs = orderMergedLogs(
					sourceContext.logs,
					targetContext.logs,
					options.preserveTimestamps
				);
			}

			// Check for cancellation
			if (cancelRefs.current.get(sourceTabId)) {
				return { success: false, error: 'Merge cancelled' };
			}

			// Step 4: Create the merged result
			useOperationStore.getState().updateMergeTabState(sourceTabId, {
				progress: {
					stage: 'creating',
					progress: 90,
					message: 'Creating merged session...',
				},
			});

			// Generate merged session name
			const mergedName = generateMergedSessionName(
				sourceSession,
				sourceTab,
				targetSession,
				targetTab
			);

			let result: MergeResult;

			// Get estimated tokens for notification (display names already set above)
			const estimatedTokens = estimateTokensFromLogs(mergedLogs);

			if (options.createNewSession) {
				// Create a new session with merged context
				const { session: mergedSession, tabId: newTabId } = createMergedSession({
					name: mergedName,
					projectRoot: sourceSession.projectRoot,
					toolType: sourceSession.toolType,
					mergedLogs,
					groupId: sourceSession.groupId,
					saveToHistory: true,
				});

				result = {
					success: true,
					newSessionId: mergedSession.id,
					newTabId,
					tokensSaved,
					mergedLogs,
					groomed,
					sourceSessionName: sourceDisplayName,
					targetSessionName: targetDisplayName,
					estimatedTokens,
				};
			} else {
				// Merge into existing target tab - return merged logs for caller to apply
				result = {
					success: true,
					tokensSaved,
					mergedLogs,
					groomed,
					targetSessionId: targetSession.id,
					targetTabId: targetTab.id,
					sourceSessionName: sourceDisplayName,
					targetSessionName: targetDisplayName,
					estimatedTokens,
				};
			}

			// Complete!
			useOperationStore.getState().updateMergeTabState(sourceTabId, {
				state: 'complete',
				progress: {
					stage: 'complete',
					progress: 100,
					message: `Merge complete!${tokensSaved > 0 ? ` Saved ~${tokensSaved} tokens` : ''}`,
				},
				result,
			});

			return result;
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : 'Unknown error during merge';

			if (!cancelRefs.current.get(sourceTabId)) {
				const errorResult: MergeResult = {
					success: false,
					error: errorMessage,
				};

				useOperationStore.getState().updateMergeTabState(sourceTabId, {
					state: 'error',
					progress: null,
					result: errorResult,
					error: errorMessage,
				});
			}

			return {
				success: false,
				error: errorMessage,
			};
		} finally {
			// Always clear the global merge flag when done
			useOperationStore.getState().setGlobalMergeInProgress(false);
		}
	}, []);

	return {
		// Active tab state (backwards compatibility)
		mergeState: activeTabState?.state || 'idle',
		progress: activeTabState?.progress || null,
		error: activeTabState?.error || null,
		isMergeInProgress: globalMergeInProgress,
		startTime: activeTabState?.startTime || 0,
		sourceName: activeTabState?.sourceName,
		targetName: activeTabState?.targetName,
		// Per-tab state access
		getTabMergeState,
		isAnyMerging,
		// Actions
		startMerge,
		cancelTab,
		cancelMerge,
		clearTabState,
		reset,
	};
}

/**
 * Information passed to onSessionCreated callback
 */
export interface MergeSessionCreatedInfo {
	sessionId: string;
	sessionName: string;
	sourceSessionName?: string;
	targetSessionName?: string;
	estimatedTokens?: number;
	tokensSaved?: number;
}

/**
 * Where a merge's result may appear. `background` (`maestro-cli tab merge
 * --background`) asks the completion callbacks to leave the selected agent and
 * tab alone and to skip the success notices.
 */
export interface MergePlacement {
	background?: boolean;
}

/**
 * Dependencies for the useMergeSessionWithSessions hook variant
 */
export interface UseMergeSessionWithSessionsDeps {
	/** Session setter for updating app state */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Active tab ID for per-tab state tracking */
	activeTabId?: string;
	/** Callback after merge creates a new session. Receives session info for notification purposes. */
	onSessionCreated?: (info: MergeSessionCreatedInfo, placement?: MergePlacement) => void;
	/** Callback after merge completes successfully (for any merge type). Receives source tab ID and target info for state cleanup and toast display. */
	onMergeComplete?: (sourceTabId: string, result: MergeResult, placement?: MergePlacement) => void;
}

/**
 * Extended result type with session management
 */
export interface UseMergeSessionWithSessionsResult extends UseMergeSessionResult {
	/** Execute merge and update sessions state */
	executeMerge: (
		sourceSession: Session,
		sourceTabId: string,
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions,
		placement?: MergePlacement
	) => Promise<MergeResult>;
}

/**
 * Extended version of useMergeSession that integrates with app session state.
 *
 * This variant handles:
 * - Finding target session from session list
 * - Adding newly created sessions to app state
 * - Calling callbacks when sessions are created
 *
 * @param deps - Dependencies including sessions state and setter
 * @returns Extended merge session hook result
 *
 * @example
 * const {
 *   mergeState,
 *   progress,
 *   executeMerge,
 *   cancelMerge,
 * } = useMergeSessionWithSessions({
 *   setSessions,
 *   onSessionCreated: (id) => setActiveSessionId(id),
 * });
 */
export function useMergeSessionWithSessions(
	deps: UseMergeSessionWithSessionsDeps
): UseMergeSessionWithSessionsResult {
	const { setSessions, activeTabId, onSessionCreated, onMergeComplete } = deps;
	const baseHook = useMergeSession(activeTabId);

	/**
	 * Execute merge with session state management
	 */
	const executeMerge = useCallback(
		async (
			sourceSession: Session,
			sourceTabId: string,
			targetSessionId: string,
			targetTabId: string | undefined,
			options: MergeOptions,
			placement: MergePlacement = {}
		): Promise<MergeResult> => {
			// PERF: Resolve sessions at event time so App need not subscribe to the
			// full array (streaming rebuilds would otherwise wake the console shell).
			const targetSession = useSessionStore
				.getState()
				.sessions.find((s) => s.id === targetSessionId);
			if (!targetSession) {
				return {
					success: false,
					error: `Target session not found: ${targetSessionId}`,
				};
			}

			// Execute the merge
			const result = await baseHook.startMerge({
				sourceSession,
				sourceTabId,
				targetSession,
				targetTabId,
				options,
			});

			if (result.success) {
				if (options.createNewSession && result.newSessionId) {
					// If a new session was created, we need to actually create it in state
					// The createMergedSession in startMerge only creates the session object,
					// we need to spawn the agent process and add it to state

					// Get the source tab for merged logs
					const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
					const targetTab = targetTabId
						? targetSession.aiTabs.find((t) => t.id === targetTabId)
						: getActiveTab(targetSession);

					if (sourceTab && targetTab) {
						// Create merged session with proper initialization
						const mergedName = generateMergedSessionName(
							sourceSession,
							sourceTab,
							targetSession,
							targetTab
						);

						// The logs startMerge produced: the groomed output when grooming
						// ran, else both raw sides in order. Never a fresh raw
						// concatenation that would discard the grooming.
						const mergedLogs =
							result.mergedLogs ??
							orderMergedLogs(
								extractTabContext(sourceTab, getSessionDisplayName(sourceSession), sourceSession)
									.logs,
								extractTabContext(targetTab, getSessionDisplayName(targetSession), targetSession)
									.logs,
								options.preserveTimestamps
							);

						const { session: createdSession } = createMergedSession({
							name: mergedName,
							projectRoot: sourceSession.projectRoot,
							toolType: sourceSession.toolType,
							mergedLogs,
							groupId: sourceSession.groupId,
						});
						const newSession: Session = {
							...createdSession,
							...mergedSessionIdentity(sourceSession),
						};

						// Add new session to state
						setSessions((prev) => [...prev, newSession]);
						await applyDefaultAgentTokenProxy(newSession.id);

						// Log merge operation to history
						const sourceNames = [
							getSessionDisplayName(sourceSession),
							getSessionDisplayName(targetSession),
						].filter((name, i, arr) => arr.indexOf(name) === i); // Dedupe if same session

						try {
							await window.maestro.history.add({
								id: generateId(),
								type: 'AUTO',
								timestamp: Date.now(),
								summary: `Merged contexts from ${sourceNames.join(', ')}`,
								sessionId: newSession.id,
								projectPath: sourceSession.projectRoot,
								sessionName: mergedName,
							});
						} catch (historyError) {
							// Non-critical: log but don't fail the merge operation
							logger.warn('Failed to log merge operation to history:', undefined, historyError);
						}

						// Notify caller with session info for notification purposes
						if (onSessionCreated) {
							onSessionCreated(
								{
									sessionId: newSession.id,
									sessionName: mergedName,
									sourceSessionName: result.sourceSessionName,
									targetSessionName: result.targetSessionName,
									estimatedTokens: result.estimatedTokens,
									tokensSaved: result.tokensSaved,
								},
								placement
							);
						}

						// Return result with the actual new session ID
						return {
							...result,
							newSessionId: newSession.id,
							newTabId: newSession.activeTabId,
						};
					}
				} else if (result.targetSessionId && result.targetTabId) {
					// Merge into existing tab - inject SOURCE context only (not target's own logs)
					// Format the source context as a string to inject into the AI conversation
					// Filter out system messages (including system prompts) - only include user/assistant messages

					// Inject SOURCE context only. When grooming ran, startMerge groomed
					// the source alone, so its output is injected (and only then is it
					// called cleaned). Otherwise result.mergedLogs holds both sides, so
					// the source tab's own logs are injected.
					const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
					const injectGroomed = result.groomed === true && result.mergedLogs !== undefined;
					const logsToInject = injectGroomed ? result.mergedLogs! : (sourceTab?.logs ?? []);
					const injectTargetTab = targetSession.aiTabs.find((t) => t.id === result.targetTabId);
					const budget = injectTargetTab
						? resolveMergeContextBudget(targetSession, injectTargetTab)
						: { maxTokens: MAX_CONTEXT_TOKENS_WARNING, windowKnown: false };

					// Order, tools vs prose, notices, reasoning visibility, images and
					// the budget are the shared formatter's job, not an inline map.
					const injected = formatLogsForContextInjection(logsToInject, {
						sourceAgentType: sourceSession.toolType,
						maxTokens: budget.maxTokens,
					});

					const sourceName = getSessionDisplayName(sourceSession);
					const disclosures: string[] = [];
					if (injected.omittedForBudget > 0) {
						disclosures.push(
							budget.windowKnown
								? `Earlier entries were left out to fit this agent's context window.`
								: `Earlier entries were left out to fit a conservative bound; this agent's context window is unknown.`
						);
					}
					if (injected.omittedImages > 0) {
						disclosures.push(
							`${injected.omittedImages} image attachment(s) were not carried over.`
						);
					}
					// Provider and working directory let the target read relative paths
					// and tool evidence correctly. No account identifiers are included.
					const header = `Additional context from another agent (${sourceName}; ${getAgentDisplayName(
						sourceSession.toolType
					)}; working directory ${sourceSession.cwd || sourceSession.projectRoot}):`;
					const formattedMergedContext = injected.text
						? [header, ...disclosures, injected.text].join('\n\n')
						: undefined;

					// Create a log entry to show the context was merged
					const mergeLogEntry: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Context merged from "${sourceName}"${injectGroomed ? ' (cleaned to reduce size)' : ''}.`,
					};

					// Prepare an introductory message to send with the merged context
					const introMessage = `I'm merging context from another session ("${sourceName}") into this conversation. Please review the context below and let me know you're ready to continue.`;

					setSessions((prev) =>
						prev.map((session) => {
							if (session.id !== result.targetSessionId) return session;

							return {
								...session,
								aiTabs: session.aiTabs.map((tab) => {
									if (tab.id !== result.targetTabId) return tab;

									// Add a visible log entry, set pendingMergedContext to inject into the AI message,
									// and set autoSendOnActivate to immediately send the context to the agent
									return {
										...tab,
										logs: [...tab.logs, mergeLogEntry],
										pendingMergedContext: formattedMergedContext,
										inputValue: introMessage,
										autoSendOnActivate: true,
									};
								}),
							};
						})
					);

					// Log merge operation to history
					try {
						await window.maestro.history.add({
							id: generateId(),
							type: 'AUTO',
							timestamp: Date.now(),
							summary: `Merged context from ${getSessionDisplayName(sourceSession)} into ${getSessionDisplayName(targetSession)}`,
							sessionId: result.targetSessionId,
							projectPath: targetSession.projectRoot,
							sessionName: getSessionDisplayName(targetSession),
						});
					} catch (historyError) {
						logger.warn('Failed to log merge operation to history:', undefined, historyError);
					}

					logger.info('[MergeSession] Injected context into target tab:', undefined, {
						targetSessionId: result.targetSessionId,
						targetTabId: result.targetTabId,
						sourceSession: getSessionDisplayName(sourceSession),
					});

					// Notify caller that merge completed (for state cleanup and toast)
					if (onMergeComplete) {
						onMergeComplete(sourceTabId, result, placement);
					}
				}
			}

			return result;
		},
		[setSessions, onSessionCreated, onMergeComplete, baseHook]
	);

	return {
		...baseHook,
		executeMerge,
	};
}

export default useMergeSession;

// Testing utility to reset global state - only available in test environment
// istanbul ignore next
export const __resetMergeInProgress =
	process.env.NODE_ENV === 'test'
		? (): void => {
				useOperationStore.getState().setGlobalMergeInProgress(false);
			}
		: undefined;

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
 */

import { useState, useCallback, useRef, useMemo } from 'react';
import type { Session, AITab, LogEntry } from '../../types';
import type { MergeResult, GroomingProgress, MergeRequest } from '../../types/contextMerge';
import type { MergeOptions } from '../../components/MergeSessionModal';
import { ContextGroomingService, contextGroomingService } from '../../services/contextGroomer';
import { extractTabContext } from '../../utils/contextExtractor';
import { createMergedSession, getActiveTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';

/**
 * Maximum recommended context tokens before warning the user
 * Default: 100,000 tokens (safe for most models)
 */
const MAX_CONTEXT_TOKENS_WARNING = 100000;

/**
 * Estimate token count from log entries
 * Uses a simple heuristic: ~4 characters per token (average for English text)
 */
function estimateTokensFromLogs(logs: { text: string }[]): number {
	const totalChars = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
	return Math.round(totalChars / 4);
}

/**
 * Global flag to track if a merge is in progress.
 * Only one merge operation should run at a time.
 */
let globalMergeInProgress = false;

/**
 * State of the merge operation
 */
export type MergeState = 'idle' | 'merging' | 'complete' | 'error';

/**
 * Per-tab merge state for non-blocking UI
 * Tracks merge operations initiated FROM a specific source tab
 */
export interface TabMergeState {
	state: MergeState;
	progress: GroomingProgress | null;
	result: MergeResult | null;
	error: string | null;
	startTime: number;
	/** Display name of the source tab/session */
	sourceName?: string;
	/** Display name of the target tab/session */
	targetName?: string;
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
 * Get the display name for a tab
 */
function _getTabDisplayName(tab: AITab): string {
	if (tab.name) return tab.name;
	if (tab.agentSessionId) {
		return tab.agentSessionId.split('-')[0].toUpperCase();
	}
	return 'New Tab';
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
	// Per-tab state tracking: Map<sourceTabId, TabMergeState>
	const [tabStates, setTabStates] = useState<Map<string, TabMergeState>>(new Map());
	const cancelRefs = useRef<Map<string, boolean>>(new Map());
	const groomingServiceRef = useRef<ContextGroomingService>(contextGroomingService);

	// Get state for the active tab (for backwards compatibility)
	const activeTabState = activeTabId ? tabStates.get(activeTabId) : null;

	/**
	 * Get merge state for a specific source tab
	 */
	const getTabMergeState = useCallback(
		(tabId: string): TabMergeState | null => {
			return tabStates.get(tabId) || null;
		},
		[tabStates]
	);

	/**
	 * Check if any tab is currently merging
	 */
	const isAnyMerging = useMemo(() => {
		for (const state of tabStates.values()) {
			if (state.state === 'merging') return true;
		}
		return false;
	}, [tabStates]);

	/**
	 * Reset the hook state to idle
	 */
	const reset = useCallback(() => {
		setTabStates(new Map());
		cancelRefs.current = new Map();
		globalMergeInProgress = false;
	}, []);

	/**
	 * Clear the state for a specific source tab (call after handling completion)
	 */
	const clearTabState = useCallback((tabId: string) => {
		setTabStates((prev) => {
			const next = new Map(prev);
			next.delete(tabId);
			return next;
		});
		cancelRefs.current.delete(tabId);
	}, []);

	/**
	 * Cancel the merge operation for a specific source tab
	 */
	const cancelTab = useCallback((tabId: string) => {
		cancelRefs.current.set(tabId, true);
		groomingServiceRef.current.cancelGrooming();
		setTabStates((prev) => {
			const next = new Map(prev);
			next.delete(tabId);
			return next;
		});
		globalMergeInProgress = false;
	}, []);

	/**
	 * Cancel all in-progress merge operations
	 */
	const cancelMerge = useCallback(() => {
		for (const tabId of tabStates.keys()) {
			cancelRefs.current.set(tabId, true);
		}
		groomingServiceRef.current.cancelGrooming();
		setTabStates(new Map());
		globalMergeInProgress = false;
	}, [tabStates]);

	/**
	 * Helper to update tab state
	 */
	const updateTabState = useCallback((tabId: string, updates: Partial<TabMergeState>) => {
		setTabStates((prev) => {
			const next = new Map(prev);
			const existing = next.get(tabId);
			if (existing) {
				next.set(tabId, { ...existing, ...updates });
			}
			return next;
		});
	}, []);

	/**
	 * Execute the merge workflow
	 */
	const startMerge = useCallback(
		async (request: MergeSessionRequest): Promise<MergeResult> => {
			const { sourceSession, sourceTabId, targetSession, targetTabId, options } = request;

			// Edge case: Check for concurrent merge operations
			if (globalMergeInProgress) {
				return {
					success: false,
					error: 'A merge operation is already in progress. Please wait for it to complete.',
				};
			}

			// Check if this source tab is already merging
			const existingState = tabStates.get(sourceTabId);
			if (existingState?.state === 'merging') {
				return {
					success: false,
					error: 'This tab is already being merged.',
				};
			}

			// Set global merge flag
			globalMergeInProgress = true;

			const startTime = Date.now();
			const sourceDisplayName = getSessionDisplayName(sourceSession);

			// Initialize tab state
			cancelRefs.current.set(sourceTabId, false);
			setTabStates((prev) => {
				const next = new Map(prev);
				next.set(sourceTabId, {
					state: 'merging',
					progress: INITIAL_PROGRESS,
					result: null,
					error: null,
					startTime,
					sourceName: sourceDisplayName,
					targetName: undefined, // Will be set after we resolve the target tab
				});
				return next;
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
				updateTabState(sourceTabId, { targetName: targetDisplayName });

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
					console.warn(
						`Large context merge: ~${estimatedMergedTokens.toLocaleString()} tokens. ` +
							`This may exceed some agents' context windows.`
					);
				}

				// Check for cancellation
				if (cancelRefs.current.get(sourceTabId)) {
					return { success: false, error: 'Merge cancelled' };
				}

				// Step 2: Extract contexts from both tabs
				updateTabState(sourceTabId, {
					progress: {
						stage: 'collecting',
						progress: 10,
						message: 'Extracting source context...',
					},
				});

				const sourceContext = extractTabContext(sourceTab, sourceDisplayName, sourceSession);

				updateTabState(sourceTabId, {
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

				if (options.groomContext) {
					// Use AI grooming to consolidate and deduplicate
					updateTabState(sourceTabId, {
						progress: {
							stage: 'grooming',
							progress: 30,
							message: 'Starting AI grooming...',
						},
					});

					const groomingRequest: MergeRequest = {
						sources: [sourceContext, targetContext],
						targetAgent: sourceSession.toolType,
						targetProjectRoot: sourceSession.projectRoot,
					};

					const groomingResult = await groomingServiceRef.current.groomContexts(
						groomingRequest,
						(groomProgress) => {
							if (!cancelRefs.current.get(sourceTabId)) {
								updateTabState(sourceTabId, { progress: groomProgress });
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
				} else {
					// Simply concatenate logs without grooming
					updateTabState(sourceTabId, {
						progress: {
							stage: 'creating',
							progress: 60,
							message: 'Combining contexts...',
						},
					});

					// Merge logs maintaining chronological order
					mergedLogs = options.preserveTimestamps
						? [...sourceContext.logs, ...targetContext.logs].sort(
								(a, b) => a.timestamp - b.timestamp
							)
						: [...sourceContext.logs, ...targetContext.logs];
				}

				// Check for cancellation
				if (cancelRefs.current.get(sourceTabId)) {
					return { success: false, error: 'Merge cancelled' };
				}

				// Step 4: Create the merged result
				updateTabState(sourceTabId, {
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
						targetSessionId: targetSession.id,
						targetTabId: targetTab.id,
						sourceSessionName: sourceDisplayName,
						targetSessionName: targetDisplayName,
						estimatedTokens,
					};
				}

				// Complete!
				updateTabState(sourceTabId, {
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

					updateTabState(sourceTabId, {
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
				globalMergeInProgress = false;
			}
		},
		[tabStates, updateTabState]
	);

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
 * Dependencies for the useMergeSessionWithSessions hook variant
 */
export interface UseMergeSessionWithSessionsDeps {
	/** All sessions in the app */
	sessions: Session[];
	/** Session setter for updating app state */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Active tab ID for per-tab state tracking */
	activeTabId?: string;
	/** Callback after merge creates a new session. Receives session info for notification purposes. */
	onSessionCreated?: (info: MergeSessionCreatedInfo) => void;
	/** Callback after merge completes successfully (for any merge type). Receives source tab ID and target info for state cleanup and toast display. */
	onMergeComplete?: (sourceTabId: string, result: MergeResult) => void;
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
		options: MergeOptions
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
 *   sessions,
 *   setSessions,
 *   onSessionCreated: (id) => setActiveSessionId(id),
 * });
 */
export function useMergeSessionWithSessions(
	deps: UseMergeSessionWithSessionsDeps
): UseMergeSessionWithSessionsResult {
	const { sessions, setSessions, activeTabId, onSessionCreated, onMergeComplete } = deps;
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
			options: MergeOptions
		): Promise<MergeResult> => {
			// Find target session
			const targetSession = sessions.find((s) => s.id === targetSessionId);
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

						// Extract and merge logs (simplified - actual implementation uses groomed logs)
						const sourceContext = extractTabContext(
							sourceTab,
							getSessionDisplayName(sourceSession),
							sourceSession
						);
						const targetContext = extractTabContext(
							targetTab,
							getSessionDisplayName(targetSession),
							targetSession
						);
						const mergedLogs = [...sourceContext.logs, ...targetContext.logs].sort(
							(a, b) => a.timestamp - b.timestamp
						);

						const { session: newSession } = createMergedSession({
							name: mergedName,
							projectRoot: sourceSession.projectRoot,
							toolType: sourceSession.toolType,
							mergedLogs,
							groupId: sourceSession.groupId,
						});

						// Add new session to state
						setSessions((prev) => [...prev, newSession]);

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
							console.warn('Failed to log merge operation to history:', historyError);
						}

						// Notify caller with session info for notification purposes
						if (onSessionCreated) {
							onSessionCreated({
								sessionId: newSession.id,
								sessionName: mergedName,
								sourceSessionName: result.sourceSessionName,
								targetSessionName: result.targetSessionName,
								estimatedTokens: result.estimatedTokens,
								tokensSaved: result.tokensSaved,
							});
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

					// Always use the SOURCE tab's logs for injection - we're transferring source context to target
					// The result.mergedLogs contains both source AND target logs (for createNewSession=true case)
					// but when injecting into existing tab, we only want the source context
					const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
					const logsToInject = sourceTab?.logs ?? [];

					const sourceContext = logsToInject
						.filter((log) => log.text && log.text.trim() && log.source !== 'system')
						.map((log) => {
							const role = log.source === 'user' ? 'User' : 'Assistant';
							return `${role}: ${log.text}`;
						})
						.join('\n\n');

					const sourceName = getSessionDisplayName(sourceSession);
					const formattedMergedContext = sourceContext
						? `Additional context from another agent (${sourceName}):\n\n${sourceContext}`
						: undefined;

					// Create a log entry to show the context was merged
					const mergeLogEntry: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Context merged from "${sourceName}"${options.groomContext ? ' (cleaned to reduce size)' : ''}.`,
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
						console.warn('Failed to log merge operation to history:', historyError);
					}

					console.log('[MergeSession] Injected context into target tab:', {
						targetSessionId: result.targetSessionId,
						targetTabId: result.targetTabId,
						sourceSession: getSessionDisplayName(sourceSession),
					});

					// Notify caller that merge completed (for state cleanup and toast)
					if (onMergeComplete) {
						onMergeComplete(sourceTabId, result);
					}
				}
			}

			return result;
		},
		[sessions, setSessions, onSessionCreated, onMergeComplete, baseHook]
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
				globalMergeInProgress = false;
			}
		: undefined;

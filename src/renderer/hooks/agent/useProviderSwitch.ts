/**
 * useProviderSwitch Hook
 *
 * Orchestrates the provider switch workflow for Virtuosos vertical swapping.
 * Creates a new session with a different agent type while preserving:
 * - Session identity (name, cwd, group, bookmarks, SSH config, nudge, auto-run path)
 * - Conversation context (optionally groomed for the target provider)
 * - Provenance chain (migratedFromSessionId, migratedAt, migrationGeneration)
 *
 * Key differences from useSendToAgent:
 * - Session name is preserved (not "Source → Target")
 * - Full identity carry-over (not just groupId)
 * - Context is pre-loaded in tab logs (not auto-sent as first message)
 * - Source session can be archived with back-link
 * - Provenance fields are set on the new session
 *
 * State lives in operationStore (Zustand); this hook owns orchestration only.
 */

import { useCallback, useRef } from 'react';
import type { Session, LogEntry, ToolType } from '../../types';
import type { GroomingProgress, MergeRequest } from '../../types/contextMerge';
import type { TransferState, TransferLastRequest } from '../../stores/operationStore';
import {
	ContextGroomingService,
	contextGroomingService,
	buildContextTransferPrompt,
	getAgentDisplayName,
} from '../../services/contextGroomer';
import { extractTabContext } from '../../utils/contextExtractor';
import { createMergedSession } from '../../utils/tabHelpers';
import { classifyTransferError } from '../../components/TransferErrorModal';
import { useOperationStore } from '../../stores/operationStore';

// ============================================================================
// Types
// ============================================================================

export interface ProviderSwitchRequest {
	/** Source session to switch from */
	sourceSession: Session;
	/** Tab ID within source session (active tab) */
	sourceTabId: string;
	/** Target provider to switch to */
	targetProvider: ToolType;
	/** Whether to groom context for target provider */
	groomContext: boolean;
	/**
	 * When set, reactivate this archived session instead of creating a new one.
	 * The groomed context from the source is appended to the target session's logs.
	 * Mutually exclusive with createMergedSession — uses session mutation instead.
	 */
	mergeBackInto?: Session;
}

export interface ProviderSwitchResult {
	success: boolean;
	/** The complete new session object (caller adds to state) */
	newSession?: Session;
	/** New session ID (if successful) */
	newSessionId?: string;
	/** New tab ID within new session */
	newTabId?: string;
	/** Tokens saved via grooming */
	tokensSaved?: number;
	/** Whether this was a merge-back into an existing session */
	mergedBack?: boolean;
	/** Error message (if failed) */
	error?: string;
}

export interface UseProviderSwitchResult {
	switchProvider: (request: ProviderSwitchRequest) => Promise<ProviderSwitchResult>;
	transferState: TransferState;
	progress: GroomingProgress | null;
	error: string | null;
	cancelSwitch: () => void;
	reset: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Walk the provenance chain backwards from `currentSession` to find
 * an archived session running `targetProvider`.
 */
export function findArchivedPredecessor(
	sessions: Session[],
	currentSession: Session,
	targetProvider: ToolType
): Session | null {
	let cursor: Session | undefined = currentSession;
	const visited = new Set<string>();

	while (cursor) {
		if (visited.has(cursor.id)) break; // prevent cycles
		visited.add(cursor.id);

		if (
			cursor.archivedByMigration &&
			cursor.toolType === targetProvider &&
			cursor.id !== currentSession.id
		) {
			return cursor;
		}

		if (cursor.migratedFromSessionId) {
			cursor = sessions.find((s) => s.id === cursor!.migratedFromSessionId);
		} else {
			break;
		}
	}
	return null;
}

// ============================================================================
// Constants
// ============================================================================

const INITIAL_PROGRESS: GroomingProgress = {
	stage: 'collecting',
	progress: 0,
	message: 'Preparing provider switch...',
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing provider switch operations (Virtuosos vertical swapping).
 *
 * @example
 * const { switchProvider, transferState, progress, cancelSwitch } = useProviderSwitch();
 *
 * const result = await switchProvider({
 *   sourceSession,
 *   sourceTabId: activeTabId,
 *   targetProvider: 'codex',
 *   groomContext: true,
 * });
 *
 * if (result.success && result.newSession) {
 *   setSessions(prev => [...prev, result.newSession!]);
 *   setActiveSessionId(result.newSessionId);
 * }
 */
export function useProviderSwitch(): UseProviderSwitchResult {
	// State from operationStore (reuses transfer state)
	const transferState = useOperationStore((s) => s.transferState);
	const progress = useOperationStore((s) => s.transferProgress);
	const error = useOperationStore((s) => s.transferError);

	// Refs for cancellation
	const cancelledRef = useRef(false);
	const groomingServiceRef = useRef<ContextGroomingService>(contextGroomingService);
	const switchStartTimeRef = useRef<number>(0);

	/**
	 * Reset hook state to idle.
	 */
	const reset = useCallback(() => {
		useOperationStore.getState().resetTransferState();
		cancelledRef.current = false;
	}, []);

	/**
	 * Cancel an in-progress switch operation.
	 */
	const cancelSwitch = useCallback(() => {
		cancelledRef.current = true;
		groomingServiceRef.current.cancelGrooming();

		useOperationStore.getState().setTransferState({
			state: 'idle',
			progress: null,
			error: 'Provider switch cancelled by user',
			transferError: null,
		});
	}, []);

	/**
	 * Execute the provider switch workflow.
	 */
	const switchProvider = useCallback(
		async (request: ProviderSwitchRequest): Promise<ProviderSwitchResult> => {
			const { sourceSession, sourceTabId, targetProvider, groomContext, mergeBackInto } = request;

			const store = useOperationStore.getState();

			// Prevent concurrent operations
			if (store.globalTransferInProgress) {
				return {
					success: false,
					error: 'A transfer operation is already in progress. Please wait for it to complete.',
				};
			}

			// Set global flag
			store.setGlobalTransferInProgress(true);

			// Reset and start
			cancelledRef.current = false;
			switchStartTimeRef.current = Date.now();

			const minimalRequest: TransferLastRequest = {
				sourceSessionId: sourceSession.id,
				sourceTabId,
				targetAgent: targetProvider,
				skipGrooming: !groomContext,
			};

			store.setTransferState({
				state: 'grooming',
				progress: INITIAL_PROGRESS,
				error: null,
				transferError: null,
				lastRequest: minimalRequest,
			});

			try {
				// Step 1: Validate inputs
				const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
				if (!sourceTab) {
					throw new Error('Source tab not found');
				}

				if (sourceTab.logs.length === 0) {
					throw new Error(
						'Cannot switch provider with empty context - source tab has no conversation history'
					);
				}

				// Verify target agent is available
				try {
					const agentStatus = await window.maestro.agents.get(targetProvider);
					if (!agentStatus?.available) {
						throw new Error(
							`${getAgentDisplayName(targetProvider)} is not available. Please install and configure it first.`
						);
					}
				} catch (agentCheckError) {
					// If we can't check, log warning but continue
					console.warn('Could not verify agent availability:', agentCheckError);
				}

				if (cancelledRef.current) {
					return { success: false, error: 'Provider switch cancelled' };
				}

				// Step 2: Extract context from source tab
				useOperationStore.getState().setTransferState({
					progress: {
						stage: 'collecting',
						progress: 10,
						message: 'Extracting source context...',
					},
				});

				const sessionDisplayName =
					sourceSession.name || sourceSession.projectRoot.split('/').pop() || 'Unnamed Session';

				const sourceContext = extractTabContext(sourceTab, sessionDisplayName, sourceSession);

				if (cancelledRef.current) {
					return { success: false, error: 'Provider switch cancelled' };
				}

				// Step 3: Groom context if enabled
				let contextLogs: LogEntry[];
				let tokensSaved = 0;

				if (groomContext) {
					useOperationStore.getState().setTransferState({
						progress: {
							stage: 'grooming',
							progress: 20,
							message: `Grooming context for ${getAgentDisplayName(targetProvider)}...`,
						},
					});

					const transferPrompt = buildContextTransferPrompt(sourceSession.toolType, targetProvider);

					const groomingRequest: MergeRequest = {
						sources: [sourceContext],
						targetAgent: targetProvider,
						targetProjectRoot: sourceSession.projectRoot,
						groomingPrompt: transferPrompt,
					};

					const groomingResult = await groomingServiceRef.current.groomContexts(
						groomingRequest,
						(groomProgress) => {
							useOperationStore.getState().setTransferState({
								progress: {
									...groomProgress,
									message:
										groomProgress.stage === 'grooming'
											? `Grooming for ${getAgentDisplayName(targetProvider)}: ${groomProgress.message}`
											: groomProgress.message,
								},
							});
						}
					);

					if (cancelledRef.current) {
						return { success: false, error: 'Provider switch cancelled' };
					}

					if (!groomingResult.success) {
						throw new Error(groomingResult.error || 'Context grooming failed');
					}

					contextLogs = groomingResult.groomedLogs;
					tokensSaved = groomingResult.tokensSaved;
				} else {
					useOperationStore.getState().setTransferState({
						progress: {
							stage: 'grooming',
							progress: 50,
							message: 'Preparing context without grooming...',
						},
					});

					contextLogs = [...sourceContext.logs];
				}

				if (cancelledRef.current) {
					return { success: false, error: 'Provider switch cancelled' };
				}

				const sourceName = getAgentDisplayName(sourceSession.toolType);
				const targetName = getAgentDisplayName(targetProvider);
				const groomNote = groomContext
					? 'Context groomed and optimized.'
					: 'Context preserved as-is.';

				let resultSession: Session;
				let resultTabId: string;

				if (mergeBackInto) {
					// Step 4a: Merge-back mode — reactivate the archived session
					useOperationStore.getState().setTransferState({
						state: 'creating',
						progress: {
							stage: 'creating',
							progress: 80,
							message: `Reactivating ${targetName} session...`,
						},
					});

					// Reactivate the archived session by mutating its fields
					const reactivated: Session = {
						...mergeBackInto,
						archivedByMigration: false,
						migratedFromSessionId: sourceSession.id,
						migratedAt: Date.now(),
						migrationGeneration: (mergeBackInto.migrationGeneration || 0) + 1,
						migratedToSessionId: undefined,
						lastMergeBackAt: Date.now(),
					};

					// Append context logs to the reactivated session's active tab
					const mergeTab = reactivated.aiTabs[0];
					if (mergeTab) {
						const separator: LogEntry = {
							id: `merge-separator-${Date.now()}`,
							timestamp: Date.now(),
							source: 'system',
							text: `── Context merged from ${sourceName} session ──`,
						};

						const switchNotice: LogEntry = {
							id: `provider-switch-notice-${Date.now()}`,
							timestamp: Date.now(),
							source: 'system',
							text: `Provider switched back from ${sourceName} to ${targetName}. ${groomNote}`,
						};

						mergeTab.logs = [...mergeTab.logs, separator, switchNotice, ...contextLogs];
					}

					resultSession = reactivated;
					resultTabId = mergeTab?.id || reactivated.aiTabs[0]?.id || '';
				} else {
					// Step 4b: Create new session via extended createMergedSession
					useOperationStore.getState().setTransferState({
						state: 'creating',
						progress: {
							stage: 'creating',
							progress: 80,
							message: `Creating ${targetName} session...`,
						},
					});

					const { session: newSession, tabId: newTabId } = createMergedSession({
						name: sourceSession.name,
						projectRoot: sourceSession.projectRoot,
						toolType: targetProvider,
						mergedLogs: contextLogs,
						groupId: sourceSession.groupId,
						// Identity carry-over
						nudgeMessage: sourceSession.nudgeMessage,
						bookmarked: sourceSession.bookmarked,
						sessionSshRemoteConfig: sourceSession.sessionSshRemoteConfig,
						autoRunFolderPath: sourceSession.autoRunFolderPath,
						// Provenance
						migratedFromSessionId: sourceSession.id,
						migratedAt: Date.now(),
						migrationGeneration: (sourceSession.migrationGeneration || 0) + 1,
					});

					// Add transfer notice to new session tab
					const transferNotice: LogEntry = {
						id: `provider-switch-notice-${Date.now()}`,
						timestamp: Date.now(),
						source: 'system',
						text: `Provider switched from ${sourceName} to ${targetName}. ${groomNote}`,
					};

					const activeTab = newSession.aiTabs.find((t) => t.id === newTabId);
					if (activeTab) {
						activeTab.logs = [transferNotice, ...activeTab.logs];
					}

					resultSession = newSession;
					resultTabId = newTabId;
				}

				// Step 5: Complete
				useOperationStore.getState().setTransferState({
					state: 'complete',
					progress: {
						stage: 'complete',
						progress: 100,
						message: `Provider switch complete!${tokensSaved > 0 ? ` Saved ~${tokensSaved} tokens` : ''}`,
					},
				});

				return {
					success: true,
					newSession: resultSession,
					newSessionId: resultSession.id,
					newTabId: resultTabId,
					tokensSaved,
					mergedBack: !!mergeBackInto,
				};
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : 'Unknown error during provider switch';
				const elapsedTimeMs = Date.now() - switchStartTimeRef.current;

				const classifiedError = classifyTransferError(errorMessage, {
					sourceAgent: sourceSession.toolType,
					targetAgent: targetProvider,
					wasGrooming: groomContext,
					elapsedTimeMs,
				});

				useOperationStore.getState().setTransferState({
					state: 'error',
					error: errorMessage,
					transferError: classifiedError,
					progress: {
						stage: 'complete',
						progress: 100,
						message: `Provider switch failed: ${errorMessage}`,
					},
				});

				return {
					success: false,
					error: errorMessage,
				};
			} finally {
				useOperationStore.getState().setGlobalTransferInProgress(false);
			}
		},
		[]
	);

	return {
		switchProvider,
		transferState,
		progress,
		error,
		cancelSwitch,
		reset,
	};
}

export default useProviderSwitch;

/**
 * useSendToAgent Hook
 *
 * Manages the complete workflow for transferring session context to another agent:
 * 1. Extract context from source session/tab
 * 2. Groom context using AI to remove agent-specific artifacts
 * 3. Create a new session with the target agent
 * 4. Initialize the new session with the groomed context
 *
 * This hook coordinates between:
 * - ContextGroomingService for AI-powered context preparation
 * - buildContextTransferPrompt for agent-specific grooming
 * - tabHelpers for creating the new session
 *
 * Error Handling:
 * - Provides structured TransferError with type classification
 * - Supports retry with different options (with or without grooming)
 * - Tracks last request for easy retry functionality
 */

import { useState, useCallback, useRef } from 'react';
import type { Session, AITab, LogEntry, ToolType } from '../../types';
import type { MergeResult, GroomingProgress, MergeRequest } from '../../types/contextMerge';
import type { SendToAgentOptions } from '../../components/SendToAgentModal';
import type { TransferError } from '../../components/TransferErrorModal';
import {
	ContextGroomingService,
	contextGroomingService,
	buildContextTransferPrompt,
	getAgentDisplayName,
} from '../../services/contextGroomer';
import { extractTabContext } from '../../utils/contextExtractor';
import { createMergedSession } from '../../utils/tabHelpers';
import { classifyTransferError } from '../../components/TransferErrorModal';
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
 * Global flag to track if a transfer is in progress.
 * Only one transfer operation should run at a time.
 */
let globalTransferInProgress = false;

/**
 * State of the transfer operation
 */
export type TransferState = 'idle' | 'grooming' | 'creating' | 'complete' | 'error';

/**
 * Request to transfer context to another agent
 */
export interface TransferRequest {
	/** Source session containing context to transfer */
	sourceSession: Session;
	/** Tab ID within source session */
	sourceTabId: string;
	/** Target agent type to transfer to */
	targetAgent: ToolType;
	/** Transfer options from the modal */
	options: SendToAgentOptions;
}

/**
 * Result returned by the useSendToAgent hook
 */
export interface UseSendToAgentResult {
	/** Current state of the transfer operation */
	transferState: TransferState;
	/** Progress information during transfer */
	progress: GroomingProgress | null;
	/** Error message if transfer failed (simple string) */
	error: string | null;
	/** Structured transfer error for recovery UI */
	transferError: TransferError | null;
	/** Whether a transfer is currently in progress globally */
	isTransferInProgress: boolean;
	/** Start a transfer operation */
	startTransfer: (request: TransferRequest) => Promise<MergeResult>;
	/** Cancel an in-progress transfer operation */
	cancelTransfer: () => void;
	/** Reset the hook state back to idle */
	reset: () => void;
	/** Retry the last failed transfer */
	retryTransfer: () => Promise<MergeResult>;
	/** Retry the last failed transfer without grooming */
	retryWithoutGrooming: () => Promise<MergeResult>;
	/** The last request that was attempted (for retry purposes) */
	lastRequest: TransferRequest | null;
}

/**
 * Default progress state at start of transfer
 */
const INITIAL_PROGRESS: GroomingProgress = {
	stage: 'collecting',
	progress: 0,
	message: 'Preparing to transfer context...',
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
 * Generate a name for the transferred session
 */
function generateTransferredSessionName(
	sourceSession: Session,
	sourceTab: AITab,
	targetAgent: ToolType
): string {
	const sourceName = getSessionDisplayName(sourceSession);
	const targetName = getAgentDisplayName(targetAgent);

	return `${sourceName} → ${targetName}`;
}

/**
 * Hook for managing cross-agent context transfer operations.
 *
 * Provides complete workflow management for transferring context from one agent
 * to another, including AI-powered context grooming to remove agent-specific artifacts.
 *
 * @example
 * const {
 *   transferState,
 *   progress,
 *   error,
 *   startTransfer,
 *   cancelTransfer,
 * } = useSendToAgent();
 *
 * // Start a transfer
 * const result = await startTransfer({
 *   sourceSession,
 *   sourceTabId: activeTabId,
 *   targetAgent: 'gemini-cli',
 *   options: { groomContext: true, createNewSession: true },
 * });
 *
 * if (result.success) {
 *   // Navigate to new session
 *   setActiveSessionId(result.newSessionId);
 * }
 */
export function useSendToAgent(): UseSendToAgentResult {
	// State
	const [transferState, setTransferState] = useState<TransferState>('idle');
	const [progress, setProgress] = useState<GroomingProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [transferError, setTransferError] = useState<TransferError | null>(null);
	const [lastRequest, setLastRequest] = useState<TransferRequest | null>(null);

	// Refs for cancellation and timing
	const cancelledRef = useRef(false);
	const groomingServiceRef = useRef<ContextGroomingService>(contextGroomingService);
	const transferStartTimeRef = useRef<number>(0);

	/**
	 * Reset the hook state to idle
	 */
	const reset = useCallback(() => {
		setTransferState('idle');
		setProgress(null);
		setError(null);
		setTransferError(null);
		cancelledRef.current = false;
	}, []);

	/**
	 * Cancel an in-progress transfer operation
	 */
	const cancelTransfer = useCallback(() => {
		cancelledRef.current = true;

		// Cancel any active grooming operation
		groomingServiceRef.current.cancelGrooming();

		// Update state
		setTransferState('idle');
		setProgress(null);
		setError('Transfer cancelled by user');
		setTransferError(null);
	}, []);

	/**
	 * Execute the transfer workflow
	 */
	const startTransfer = useCallback(async (request: TransferRequest): Promise<MergeResult> => {
		const { sourceSession, sourceTabId, targetAgent, options } = request;

		// Edge case: Check for concurrent transfer operations
		if (globalTransferInProgress) {
			return {
				success: false,
				error: 'A transfer operation is already in progress. Please wait for it to complete.',
			};
		}

		// Set global transfer flag
		globalTransferInProgress = true;

		// Store the request for retry purposes
		setLastRequest(request);

		// Reset state
		cancelledRef.current = false;
		setError(null);
		setTransferError(null);
		setTransferState('grooming');
		setProgress(INITIAL_PROGRESS);
		transferStartTimeRef.current = Date.now();

		try {
			// Step 1: Validate inputs and get source tab
			const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
			if (!sourceTab) {
				throw new Error('Source tab not found');
			}

			// Edge case: Check for empty context source
			if (sourceTab.logs.length === 0) {
				throw new Error('Cannot transfer empty context - source tab has no conversation history');
			}

			// Edge case: Check for context too large
			const sourceTokens = estimateTokensFromLogs(sourceTab.logs);
			if (sourceTokens > MAX_CONTEXT_TOKENS_WARNING) {
				// Log a warning but continue - the modal should have already warned the user
				console.warn(
					`Large context transfer: ~${sourceTokens.toLocaleString()} tokens. ` +
						`This may exceed the target agent's context window.`
				);
			}

			// Edge case: Check if target agent is available
			// This is done at the modal level, but we do a final check here
			try {
				const agentStatus = await window.maestro.agents.get(targetAgent);
				if (!agentStatus?.available) {
					throw new Error(
						`${getAgentDisplayName(targetAgent)} is not available. Please install and configure it first.`
					);
				}
			} catch (agentCheckError) {
				// If we can't check agent status, log warning but continue
				// The agent detection may not be available in all contexts
				console.warn('Could not verify agent availability:', agentCheckError);
			}

			// Check for cancellation
			if (cancelledRef.current) {
				return { success: false, error: 'Transfer cancelled' };
			}

			// Step 2: Extract context from source tab
			setProgress({
				stage: 'collecting',
				progress: 10,
				message: 'Extracting source context...',
			});

			const sourceContext = extractTabContext(
				sourceTab,
				getSessionDisplayName(sourceSession),
				sourceSession
			);

			// Check for cancellation
			if (cancelledRef.current) {
				return { success: false, error: 'Transfer cancelled' };
			}

			// Step 3: Groom context if enabled
			let contextLogs: LogEntry[];
			let tokensSaved = 0;

			if (options.groomContext) {
				// Use AI grooming to prepare context for target agent
				setProgress({
					stage: 'grooming',
					progress: 20,
					message: `Grooming context for ${getAgentDisplayName(targetAgent)}...`,
				});

				// Build agent-specific transfer prompt
				const transferPrompt = buildContextTransferPrompt(sourceSession.toolType, targetAgent);

				const groomingRequest: MergeRequest = {
					sources: [sourceContext],
					targetAgent,
					targetProjectRoot: sourceSession.projectRoot,
					groomingPrompt: transferPrompt,
				};

				const groomingResult = await groomingServiceRef.current.groomContexts(
					groomingRequest,
					(groomProgress) => {
						// Transform progress to our format with agent-specific messaging
						setProgress({
							...groomProgress,
							message:
								groomProgress.stage === 'grooming'
									? `Grooming for ${getAgentDisplayName(targetAgent)}: ${groomProgress.message}`
									: groomProgress.message,
						});
					}
				);

				// Check for cancellation
				if (cancelledRef.current) {
					return { success: false, error: 'Transfer cancelled' };
				}

				if (!groomingResult.success) {
					throw new Error(groomingResult.error || 'Context grooming failed');
				}

				contextLogs = groomingResult.groomedLogs;
				tokensSaved = groomingResult.tokensSaved;
			} else {
				// Use raw logs without grooming
				setProgress({
					stage: 'grooming',
					progress: 50,
					message: 'Preparing context without grooming...',
				});

				contextLogs = [...sourceContext.logs];
			}

			// Check for cancellation
			if (cancelledRef.current) {
				return { success: false, error: 'Transfer cancelled' };
			}

			// Step 4: Create new session with target agent
			setTransferState('creating');
			setProgress({
				stage: 'creating',
				progress: 80,
				message: `Creating ${getAgentDisplayName(targetAgent)} session...`,
			});

			// Generate name for the transferred session
			const sessionName = generateTransferredSessionName(sourceSession, sourceTab, targetAgent);

			// Create the new session structure
			const { session: newSession, tabId: newTabId } = createMergedSession({
				name: sessionName,
				projectRoot: sourceSession.projectRoot,
				toolType: targetAgent,
				mergedLogs: contextLogs,
				groupId: sourceSession.groupId,
				saveToHistory: true,
			});

			// Add a system message indicating this is a transferred context
			const transferNotice: LogEntry = {
				id: `transfer-notice-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text: `Context transferred from ${getAgentDisplayName(sourceSession.toolType)}. ${
					options.groomContext
						? `Groomed and optimized for ${getAgentDisplayName(targetAgent)}.`
						: 'Original context preserved.'
				}`,
			};

			// Prepend the transfer notice to the new session's logs
			const activeTab = newSession.aiTabs.find((t) => t.id === newTabId);
			if (activeTab) {
				activeTab.logs = [transferNotice, ...activeTab.logs];
			}

			// Step 5: Complete!
			setProgress({
				stage: 'complete',
				progress: 100,
				message: `Transfer complete! ${tokensSaved > 0 ? `Saved ~${tokensSaved} tokens` : ''}`,
			});
			setTransferState('complete');

			return {
				success: true,
				newSessionId: newSession.id,
				newTabId,
				tokensSaved,
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : 'Unknown error during transfer';
			const elapsedTimeMs = Date.now() - transferStartTimeRef.current;

			// Classify the error for structured handling
			const classifiedError = classifyTransferError(errorMessage, {
				sourceAgent: sourceSession.toolType,
				targetAgent,
				wasGrooming: options.groomContext,
				elapsedTimeMs,
			});

			setError(errorMessage);
			setTransferError(classifiedError);
			setTransferState('error');
			setProgress({
				stage: 'complete',
				progress: 100,
				message: `Transfer failed: ${errorMessage}`,
			});

			return {
				success: false,
				error: errorMessage,
			};
		} finally {
			// Always clear the global transfer flag when done
			globalTransferInProgress = false;
		}
	}, []);

	/**
	 * Retry the last failed transfer with the same options
	 */
	const retryTransfer = useCallback(async (): Promise<MergeResult> => {
		if (!lastRequest) {
			return {
				success: false,
				error: 'No previous transfer to retry',
			};
		}

		return startTransfer(lastRequest);
	}, [lastRequest, startTransfer]);

	/**
	 * Retry the last failed transfer without grooming
	 * (useful when grooming failed or timed out)
	 */
	const retryWithoutGrooming = useCallback(async (): Promise<MergeResult> => {
		if (!lastRequest) {
			return {
				success: false,
				error: 'No previous transfer to retry',
			};
		}

		// Create a modified request with grooming disabled
		const modifiedRequest: TransferRequest = {
			...lastRequest,
			options: {
				...lastRequest.options,
				groomContext: false,
			},
		};

		return startTransfer(modifiedRequest);
	}, [lastRequest, startTransfer]);

	return {
		transferState,
		progress,
		error,
		transferError,
		isTransferInProgress: globalTransferInProgress,
		startTransfer,
		cancelTransfer,
		reset,
		retryTransfer,
		retryWithoutGrooming,
		lastRequest,
	};
}

/**
 * Dependencies for the useSendToAgentWithSessions hook variant
 */
export interface UseSendToAgentWithSessionsDeps {
	/** All sessions in the app */
	sessions: Session[];
	/** Session setter for updating app state */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Callback after transfer creates a new session. Receives session ID and name for notification purposes. */
	onSessionCreated?: (sessionId: string, sessionName: string) => void;
	/** Callback to switch to the new session after transfer */
	onNavigateToSession?: (sessionId: string) => void;
}

/**
 * Extended result type with session management
 */
export interface UseSendToAgentWithSessionsResult extends UseSendToAgentResult {
	/** Execute transfer and update sessions state */
	executeTransfer: (
		sourceSession: Session,
		sourceTabId: string,
		targetAgent: ToolType,
		options: SendToAgentOptions
	) => Promise<MergeResult>;
}

/**
 * Extended version of useSendToAgent that integrates with app session state.
 *
 * This variant handles:
 * - Adding newly created sessions to app state
 * - Calling callbacks when sessions are created
 * - Optionally navigating to the new session
 *
 * @param deps - Dependencies including sessions state and setter
 * @returns Extended send-to-agent hook result
 *
 * @example
 * const {
 *   transferState,
 *   progress,
 *   executeTransfer,
 *   cancelTransfer,
 * } = useSendToAgentWithSessions({
 *   sessions,
 *   setSessions,
 *   onSessionCreated: (id, name) => toast(`Created ${name}`),
 *   onNavigateToSession: (id) => setActiveSessionId(id),
 * });
 */
export function useSendToAgentWithSessions(
	deps: UseSendToAgentWithSessionsDeps
): UseSendToAgentWithSessionsResult {
	const { sessions, setSessions, onSessionCreated, onNavigateToSession } = deps;
	const baseHook = useSendToAgent();

	/**
	 * Execute transfer with session state management
	 */
	const executeTransfer = useCallback(
		async (
			sourceSession: Session,
			sourceTabId: string,
			targetAgent: ToolType,
			options: SendToAgentOptions
		): Promise<MergeResult> => {
			// Get source tab for name generation
			const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
			if (!sourceTab) {
				return {
					success: false,
					error: 'Source tab not found',
				};
			}

			// Execute the transfer
			const result = await baseHook.startTransfer({
				sourceSession,
				sourceTabId,
				targetAgent,
				options,
			});

			if (result.success && result.newSessionId && options.createNewSession !== false) {
				// Create the session structure again to add to state
				// (The hook only creates the structure, we need to add it to app state)
				const sessionName = generateTransferredSessionName(sourceSession, sourceTab, targetAgent);

				const sourceContext = extractTabContext(
					sourceTab,
					getSessionDisplayName(sourceSession),
					sourceSession
				);

				// Format the context as text to be sent to the agent
				// This will be injected into the first message via pendingMergedContext
				const formattedContext = sourceContext.logs
					.filter((log) => log.text && log.text.trim() && log.source !== 'system')
					.map((log) => {
						const role = log.source === 'user' ? 'User' : 'Assistant';
						return `${role}: ${log.text}`;
					})
					.join('\n\n');

				const sourceName = getSessionDisplayName(sourceSession);
				const sourceAgentName = getAgentDisplayName(sourceSession.toolType);

				// Create the pending context with a clear header explaining what this is
				const pendingMergedContext = formattedContext
					? `# Context from Previous Session

The following is a conversation from another session ("${sourceName}" using ${sourceAgentName}). Please review this context to understand the prior work and decisions made:

---

${formattedContext}

---

Please confirm you've reviewed this context and let me know you're ready to continue.`
					: undefined;

				// Create session with empty logs - context will be sent via pendingMergedContext
				const { session: newSession } = createMergedSession({
					name: sessionName,
					projectRoot: sourceSession.projectRoot,
					toolType: targetAgent,
					mergedLogs: [], // Empty - context is sent as message, not pre-populated logs
					groupId: sourceSession.groupId,
				});

				// Add transfer notice and set pendingMergedContext on the active tab
				const transferNotice: LogEntry = {
					id: `transfer-notice-${Date.now()}`,
					timestamp: Date.now(),
					source: 'system',
					text: `Context transferred from "${sourceName}" (${sourceAgentName}).${
						options.groomContext
							? ` Groomed and optimized for ${getAgentDisplayName(targetAgent)}.`
							: ''
					}`,
				};

				const activeTab = newSession.aiTabs[0];
				if (activeTab) {
					activeTab.logs = [transferNotice];
					// Set pendingMergedContext so it gets injected into the first message
					activeTab.pendingMergedContext = pendingMergedContext;
					// Pre-populate the input field with the context introduction message
					activeTab.inputValue =
						"I'm transferring context from another session. Please review it and let me know when you're ready to continue.";
					// Set flag to auto-send this message when the tab becomes active
					// This ensures the context is actually sent to the agent immediately
					activeTab.autoSendOnActivate = true;
				}

				// Add new session to state
				setSessions((prev) => [...prev, newSession]);

				// Log transfer operation to history
				const targetAgentName = getAgentDisplayName(targetAgent);

				try {
					await window.maestro.history.add({
						id: generateId(),
						type: 'AUTO',
						timestamp: Date.now(),
						summary: `Transferred context from ${sourceAgentName} to ${targetAgentName}`,
						sessionId: newSession.id,
						projectPath: sourceSession.projectRoot,
						sessionName: sessionName,
					});
				} catch (historyError) {
					// Non-critical: log but don't fail the transfer operation
					console.warn('Failed to log transfer operation to history:', historyError);
				}

				// Notify caller with session ID and name
				if (onSessionCreated) {
					onSessionCreated(newSession.id, sessionName);
				}

				// Navigate to the new session if callback provided
				if (onNavigateToSession) {
					onNavigateToSession(newSession.id);
				}

				// Return result with the actual new session ID
				return {
					...result,
					newSessionId: newSession.id,
					newTabId: newSession.activeTabId,
				};
			}

			return result;
		},
		[sessions, setSessions, onSessionCreated, onNavigateToSession, baseHook]
	);

	return {
		...baseHook,
		executeTransfer,
	};
}

export default useSendToAgent;

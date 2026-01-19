/**
 * Batch state reducer for useBatchProcessor
 *
 * This module provides a reducer-based state management pattern for batch processing.
 * It defines all possible actions and ensures type-safe state transitions.
 *
 * Phase 11: Integrated with the batch state machine for explicit state tracking.
 * The processingState field mirrors the state machine's state, providing:
 * - Clear visibility into the current processing phase
 * - Invariant checking on state transitions
 * - Debug logging for state transition auditing
 */

import type { BatchRunState, AgentError } from '../../types';
import {
	transition,
	canTransition,
	type BatchProcessingState,
	type BatchEvent,
	DEFAULT_MACHINE_CONTEXT,
} from './batchStateMachine';

/**
 * Log state machine transitions for debugging (disabled in production for performance)
 */
function logTransition(
	_sessionId: string,
	_fromState: BatchProcessingState | undefined,
	_event: BatchEvent['type'],
	_toState: BatchProcessingState,
	_valid: boolean
): void {
	// PERFORMANCE: Debug logging disabled - was causing I/O overhead during batch runs
	// Uncomment for debugging state transitions:
	// const stateFrom = _fromState ?? 'IDLE';
	// if (_valid) {
	//   console.log(`[BatchStateMachine] ${_sessionId}: ${stateFrom} -> ${_toState} (${_event})`);
	// } else {
	//   console.warn(`[BatchStateMachine] ${_sessionId}: INVALID transition ${stateFrom} + ${_event} (staying in ${stateFrom})`);
	// }
}

/**
 * Check if a transition is valid and log the result
 * Returns the new state if valid, or the current state if invalid
 */
function validateAndTransition(
	sessionId: string,
	currentState: BatchProcessingState | undefined,
	eventType: BatchEvent['type']
): { newState: BatchProcessingState; valid: boolean } {
	const fromState: BatchProcessingState = currentState ?? 'IDLE';
	const valid = canTransition(fromState, eventType);

	// Create minimal event for transition function
	// Most events don't need payload for state determination
	let event: BatchEvent;
	switch (eventType) {
		case 'START_BATCH':
			// START_BATCH requires payload, but we just need the state change
			event = {
				type: 'START_BATCH',
				payload: {
					sessionId,
					documents: [],
					totalTasks: 0,
					loopEnabled: false,
					maxLoops: null,
					worktreeActive: false,
					worktreePath: null,
					worktreeBranch: null,
				},
			};
			break;
		case 'TASK_COMPLETED':
			event = { type: 'TASK_COMPLETED', payload: { newCompletedCount: 0 } };
			break;
		case 'DOCUMENT_ADVANCED':
			event = { type: 'DOCUMENT_ADVANCED', documentIndex: 0 };
			break;
		case 'LOOP_COMPLETED':
			event = { type: 'LOOP_COMPLETED', payload: { newTotalTasks: 0 } };
			break;
		case 'ERROR_OCCURRED':
			event = {
				type: 'ERROR_OCCURRED',
				payload: {
					error: { type: 'unknown', message: '', recoverable: false, agentId: '', timestamp: 0 },
					documentIndex: 0,
				},
			};
			break;
		default:
			// Simple events without payload
			event = { type: eventType } as BatchEvent;
	}

	// Get the new state from the transition function
	const machineContext = { ...DEFAULT_MACHINE_CONTEXT, state: fromState };
	const newContext = transition(machineContext, event);
	const newState = newContext.state;

	logTransition(sessionId, currentState, eventType, newState, valid);

	return { newState: valid ? newState : fromState, valid };
}

/**
 * Default empty batch state for initializing new sessions
 */
export const DEFAULT_BATCH_STATE: BatchRunState = {
	isRunning: false,
	isStopping: false,
	// State machine integration (Phase 11)
	processingState: 'IDLE',
	// Multi-document progress
	documents: [],
	lockedDocuments: [],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 0,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 0,
	completedTasksAcrossAllDocs: 0,
	// Loop mode
	loopEnabled: false,
	loopIteration: 0,
	// Folder path for file operations
	folderPath: '',
	// Worktree tracking
	worktreeActive: false,
	worktreePath: undefined,
	worktreeBranch: undefined,
	// Legacy fields (kept for backwards compatibility)
	totalTasks: 0,
	completedTasks: 0,
	currentTaskIndex: 0,
	originalContent: '',
	sessionIds: [],
	// Time tracking (excludes sleep/suspend time)
	accumulatedElapsedMs: 0,
	lastActiveTimestamp: undefined,
	// Error handling state
	error: undefined,
	errorPaused: false,
	errorDocumentIndex: undefined,
	errorTaskDescription: undefined,
};

/**
 * Batch state stored per-session
 */
export type BatchState = Record<string, BatchRunState>;

/**
 * Payload for starting a batch run
 */
export interface StartBatchPayload {
	documents: string[];
	lockedDocuments: string[];
	totalTasksAcrossAllDocs: number;
	loopEnabled: boolean;
	maxLoops?: number | null;
	folderPath: string;
	worktreeActive: boolean;
	worktreePath?: string;
	worktreeBranch?: string;
	customPrompt?: string;
	startTime: number;
	// Time tracking
	cumulativeTaskTimeMs: number;
	accumulatedElapsedMs: number;
	lastActiveTimestamp: number;
}

/**
 * Payload for updating progress
 */
export interface UpdateProgressPayload {
	currentDocumentIndex?: number;
	currentDocTasksTotal?: number;
	currentDocTasksCompleted?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
	// Legacy fields
	totalTasks?: number;
	completedTasks?: number;
	currentTaskIndex?: number;
	sessionIds?: string[];
	// Time tracking
	accumulatedElapsedMs?: number;
	lastActiveTimestamp?: number;
	// Loop mode
	loopIteration?: number;
}

/**
 * Payload for setting an error state
 */
export interface SetErrorPayload {
	error: AgentError;
	documentIndex: number;
	taskDescription?: string;
}

/**
 * Union type of all batch actions
 *
 * Phase 11: Actions are mapped to state machine events:
 * - START_BATCH -> START_BATCH (IDLE -> INITIALIZING)
 * - SET_RUNNING -> INITIALIZATION_COMPLETE (INITIALIZING -> RUNNING)
 * - UPDATE_PROGRESS -> TASK_COMPLETED/DOCUMENT_ADVANCED (RUNNING -> RUNNING)
 * - SET_STOPPING -> STOP_REQUESTED (RUNNING -> STOPPING)
 * - SET_ERROR -> ERROR_OCCURRED (RUNNING -> PAUSED_ERROR)
 * - CLEAR_ERROR -> ERROR_RESOLVED (PAUSED_ERROR -> RUNNING)
 * - SET_COMPLETING -> ALL_TASKS_DONE (RUNNING -> COMPLETING)
 * - COMPLETE_BATCH -> BATCH_FINALIZED (COMPLETING -> IDLE)
 * - INCREMENT_LOOP -> LOOP_COMPLETED (RUNNING -> RUNNING)
 */
export type BatchAction =
	| { type: 'START_BATCH'; sessionId: string; payload: StartBatchPayload }
	| { type: 'SET_RUNNING'; sessionId: string } // INITIALIZING -> RUNNING
	| { type: 'UPDATE_PROGRESS'; sessionId: string; payload: UpdateProgressPayload }
	| { type: 'SET_STOPPING'; sessionId: string }
	| { type: 'SET_ERROR'; sessionId: string; payload: SetErrorPayload }
	| { type: 'CLEAR_ERROR'; sessionId: string }
	| { type: 'SET_COMPLETING'; sessionId: string } // RUNNING -> COMPLETING
	| { type: 'COMPLETE_BATCH'; sessionId: string; finalSessionIds?: string[] }
	| { type: 'INCREMENT_LOOP'; sessionId: string; newTotalTasks: number };

/**
 * Batch state reducer
 *
 * Handles all state transitions for batch processing. Each action type
 * represents a distinct operation that can be performed on the batch state.
 *
 * @param state - Current batch state for all sessions
 * @param action - The action to perform
 * @returns New batch state
 */
export function batchReducer(state: BatchState, action: BatchAction): BatchState {
	switch (action.type) {
		case 'START_BATCH': {
			const { sessionId, payload } = action;
			const currentState = state[sessionId];

			// State machine: IDLE -> INITIALIZING (START_BATCH)
			// Note: We start in INITIALIZING and transition to RUNNING once setup is complete
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState?.processingState,
				'START_BATCH'
			);

			return {
				...state,
				[sessionId]: {
					isRunning: true,
					isStopping: false,
					// State machine integration
					processingState,
					// Multi-document progress
					documents: payload.documents,
					lockedDocuments: payload.lockedDocuments,
					currentDocumentIndex: 0,
					currentDocTasksTotal: 0,
					currentDocTasksCompleted: 0,
					totalTasksAcrossAllDocs: payload.totalTasksAcrossAllDocs,
					completedTasksAcrossAllDocs: 0,
					// Loop mode
					loopEnabled: payload.loopEnabled,
					loopIteration: 0,
					maxLoops: payload.maxLoops,
					// Folder path
					folderPath: payload.folderPath,
					// Worktree tracking
					worktreeActive: payload.worktreeActive,
					worktreePath: payload.worktreePath,
					worktreeBranch: payload.worktreeBranch,
					// Legacy fields
					totalTasks: payload.totalTasksAcrossAllDocs,
					completedTasks: 0,
					currentTaskIndex: 0,
					originalContent: '',
					customPrompt: payload.customPrompt,
					sessionIds: [],
					startTime: payload.startTime,
					// Time tracking
					cumulativeTaskTimeMs: payload.cumulativeTaskTimeMs,
					accumulatedElapsedMs: payload.accumulatedElapsedMs,
					lastActiveTimestamp: payload.lastActiveTimestamp,
					// Error handling - cleared on start
					error: undefined,
					errorPaused: false,
					errorDocumentIndex: undefined,
					errorTaskDescription: undefined,
				},
			};
		}

		case 'SET_RUNNING': {
			const { sessionId } = action;
			const currentState = state[sessionId];
			if (!currentState) return state;

			// State machine: INITIALIZING -> RUNNING (INITIALIZATION_COMPLETE)
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				'INITIALIZATION_COMPLETE'
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					processingState,
				},
			};
		}

		case 'UPDATE_PROGRESS': {
			const { sessionId, payload } = action;
			const currentState = state[sessionId];
			if (!currentState) return state;

			return {
				...state,
				[sessionId]: {
					...currentState,
					// Only update fields that are provided in the payload
					...(payload.currentDocumentIndex !== undefined && {
						currentDocumentIndex: payload.currentDocumentIndex,
					}),
					...(payload.currentDocTasksTotal !== undefined && {
						currentDocTasksTotal: payload.currentDocTasksTotal,
					}),
					...(payload.currentDocTasksCompleted !== undefined && {
						currentDocTasksCompleted: payload.currentDocTasksCompleted,
					}),
					...(payload.totalTasksAcrossAllDocs !== undefined && {
						totalTasksAcrossAllDocs: payload.totalTasksAcrossAllDocs,
					}),
					...(payload.completedTasksAcrossAllDocs !== undefined && {
						completedTasksAcrossAllDocs: payload.completedTasksAcrossAllDocs,
					}),
					// Legacy fields
					...(payload.totalTasks !== undefined && { totalTasks: payload.totalTasks }),
					...(payload.completedTasks !== undefined && { completedTasks: payload.completedTasks }),
					...(payload.currentTaskIndex !== undefined && {
						currentTaskIndex: payload.currentTaskIndex,
					}),
					...(payload.sessionIds !== undefined && { sessionIds: payload.sessionIds }),
					// Time tracking
					...(payload.accumulatedElapsedMs !== undefined && {
						accumulatedElapsedMs: payload.accumulatedElapsedMs,
					}),
					...(payload.lastActiveTimestamp !== undefined && {
						lastActiveTimestamp: payload.lastActiveTimestamp,
					}),
					// Loop iteration
					...(payload.loopIteration !== undefined && { loopIteration: payload.loopIteration }),
				},
			};
		}

		case 'SET_STOPPING': {
			const { sessionId } = action;
			const currentState = state[sessionId] || DEFAULT_BATCH_STATE;

			// State machine transition depends on current state:
			// - RUNNING -> STOPPING (STOP_REQUESTED)
			// - PAUSED_ERROR -> STOPPING (ABORT_REQUESTED)
			const eventType =
				currentState.processingState === 'PAUSED_ERROR' ? 'ABORT_REQUESTED' : 'STOP_REQUESTED';

			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				eventType
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					isStopping: true,
					processingState,
					// Clear error state when aborting from PAUSED_ERROR
					...(currentState.processingState === 'PAUSED_ERROR' && {
						error: undefined,
						errorPaused: false,
						errorDocumentIndex: undefined,
						errorTaskDescription: undefined,
					}),
				},
			};
		}

		case 'SET_ERROR': {
			const { sessionId, payload } = action;
			const currentState = state[sessionId];
			if (!currentState || !currentState.isRunning) return state;

			// State machine: RUNNING -> PAUSED_ERROR (ERROR_OCCURRED)
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				'ERROR_OCCURRED'
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					error: payload.error,
					errorPaused: true,
					errorDocumentIndex: payload.documentIndex,
					errorTaskDescription: payload.taskDescription,
					processingState,
				},
			};
		}

		case 'CLEAR_ERROR': {
			const { sessionId } = action;
			const currentState = state[sessionId];
			if (!currentState) return state;

			// State machine: PAUSED_ERROR -> RUNNING (ERROR_RESOLVED)
			// Note: This handles both resume and skip-document cases
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				'ERROR_RESOLVED'
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					error: undefined,
					errorPaused: false,
					errorDocumentIndex: undefined,
					errorTaskDescription: undefined,
					processingState,
				},
			};
		}

		case 'SET_COMPLETING': {
			const { sessionId } = action;
			const currentState = state[sessionId];
			if (!currentState) return state;

			// State machine: RUNNING -> COMPLETING (ALL_TASKS_DONE)
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				'ALL_TASKS_DONE'
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					processingState,
				},
			};
		}

		case 'COMPLETE_BATCH': {
			const { sessionId, finalSessionIds } = action;
			const currentState = state[sessionId];
			// Keep sessionIds if we have them, for session linking after completion
			const sessionIds = finalSessionIds ?? currentState?.sessionIds ?? [];

			// State machine: COMPLETING -> IDLE (BATCH_FINALIZED)
			// Note: We may be coming from RUNNING, STOPPING, or COMPLETING states
			// First try BATCH_FINALIZED for clean completion, fall back to direct IDLE
			let processingState: BatchProcessingState = 'IDLE';
			if (currentState?.processingState === 'COMPLETING') {
				const result = validateAndTransition(
					sessionId,
					currentState.processingState,
					'BATCH_FINALIZED'
				);
				processingState = result.newState;
			} else if (currentState?.processingState === 'STOPPING') {
				// STOPPING -> COMPLETING -> IDLE (two-step finalization)
				validateAndTransition(sessionId, currentState.processingState, 'CURRENT_TASK_DONE');
				const result = validateAndTransition(sessionId, 'COMPLETING', 'BATCH_FINALIZED');
				processingState = result.newState;
			} else if (currentState?.processingState === 'RUNNING') {
				// RUNNING -> COMPLETING -> IDLE (natural completion)
				validateAndTransition(sessionId, currentState.processingState, 'ALL_TASKS_DONE');
				const result = validateAndTransition(sessionId, 'COMPLETING', 'BATCH_FINALIZED');
				processingState = result.newState;
			} else {
				// Direct reset to IDLE (e.g., on error or abort)
				logTransition(sessionId, currentState?.processingState, 'BATCH_FINALIZED', 'IDLE', false);
				processingState = 'IDLE';
			}

			return {
				...state,
				[sessionId]: {
					isRunning: false,
					isStopping: false,
					processingState,
					documents: [],
					lockedDocuments: [],
					currentDocumentIndex: 0,
					currentDocTasksTotal: 0,
					currentDocTasksCompleted: 0,
					totalTasksAcrossAllDocs: 0,
					completedTasksAcrossAllDocs: 0,
					loopEnabled: false,
					loopIteration: 0,
					folderPath: '',
					// Clear worktree tracking
					worktreeActive: false,
					worktreePath: undefined,
					worktreeBranch: undefined,
					// Legacy fields
					totalTasks: 0,
					completedTasks: 0,
					currentTaskIndex: 0,
					originalContent: '',
					sessionIds,
					// Clear error state
					error: undefined,
					errorPaused: false,
					errorDocumentIndex: undefined,
					errorTaskDescription: undefined,
				},
			};
		}

		case 'INCREMENT_LOOP': {
			const { sessionId, newTotalTasks } = action;
			const currentState = state[sessionId];
			if (!currentState) return state;

			const nextLoopIteration = currentState.loopIteration + 1;

			// State machine: RUNNING -> RUNNING (LOOP_COMPLETED)
			// Loop completion stays in RUNNING state but resets document index
			const { newState: processingState } = validateAndTransition(
				sessionId,
				currentState.processingState,
				'LOOP_COMPLETED'
			);

			return {
				...state,
				[sessionId]: {
					...currentState,
					loopIteration: nextLoopIteration,
					totalTasksAcrossAllDocs: newTotalTasks + currentState.completedTasksAcrossAllDocs,
					totalTasks: newTotalTasks + currentState.completedTasks,
					processingState,
				},
			};
		}

		default:
			return state;
	}
}

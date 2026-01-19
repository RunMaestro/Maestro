/**
 * Batch Processing State Machine
 *
 * This module defines an explicit state machine for batch processing operations.
 * It provides type-safe state transitions and ensures that invalid transitions
 * are caught at compile-time or runtime.
 *
 * The state machine pattern ensures predictable behavior by:
 * 1. Defining all possible states explicitly
 * 2. Defining all valid transitions between states
 * 3. Preventing invalid state transitions
 * 4. Making the current state and available actions clear at any point
 */

import type { AgentError } from '../../types';

/**
 * Explicit batch processing states.
 *
 * State diagram:
 * ```
 *                     ┌─────────────────────────────────────────────────┐
 *                     │                                                 │
 *                     ▼                                                 │
 *   ┌─────────┐   ┌────────────┐   ┌─────────┐   ┌────────────┐   ┌───────────┐
 *   │  IDLE   │──▶│INITIALIZING│──▶│ RUNNING │──▶│ COMPLETING │──▶│   IDLE    │
 *   └─────────┘   └────────────┘   └─────────┘   └────────────┘   └───────────┘
 *                                       │              ▲
 *                     ┌─────────────────┴──────────────┘
 *                     │                 │
 *                     ▼                 │
 *              ┌─────────────┐          │
 *              │PAUSED_ERROR │──────────┤
 *              └─────────────┘          │
 *                     │                 │
 *                     ▼                 │
 *              ┌───────────┐            │
 *              │  STOPPING │────────────┘
 *              └───────────┘
 * ```
 */
export type BatchProcessingState =
	| 'IDLE' // No batch is running
	| 'INITIALIZING' // Setting up worktree, counting tasks, preparing documents
	| 'RUNNING' // Actively processing tasks
	| 'PAUSED_ERROR' // Paused due to an error, awaiting user action
	| 'STOPPING' // Stop requested, finishing current task
	| 'COMPLETING'; // Finalizing batch (creating PR, cleanup, history)

/**
 * Context maintained by the state machine.
 * This represents the data associated with the current batch processing operation.
 */
export interface BatchMachineContext {
	/** Current state of the batch processor */
	state: BatchProcessingState;
	/** Session ID this batch is running for */
	sessionId: string | null;
	/** List of document filenames being processed */
	documents: string[];
	/** Index of the currently processing document */
	currentDocIndex: number;
	/** Number of tasks completed so far */
	completedTasks: number;
	/** Total number of tasks across all documents */
	totalTasks: number;
	/** Current loop iteration (0-indexed) */
	loopIteration: number;
	/** Error that caused the pause (if in PAUSED_ERROR state) */
	error: AgentError | null;
	/** Document index where the error occurred */
	errorDocumentIndex: number | null;
	/** Description of the task that caused the error */
	errorTaskDescription: string | null;
	/** Timestamp when the batch started */
	startTime: number | null;
	/** Whether loop mode is enabled */
	loopEnabled: boolean;
	/** Maximum number of loops (null = unlimited) */
	maxLoops: number | null;
	/** Whether a worktree is being used */
	worktreeActive: boolean;
	/** Path to the worktree (if active) */
	worktreePath: string | null;
	/** Branch name in the worktree */
	worktreeBranch: string | null;
}

/**
 * Event payloads for state transitions
 */
export interface InitializePayload {
	sessionId: string;
	documents: string[];
	totalTasks: number;
	loopEnabled: boolean;
	maxLoops: number | null;
	worktreeActive: boolean;
	worktreePath: string | null;
	worktreeBranch: string | null;
}

export interface TaskCompletedPayload {
	newCompletedCount: number;
	newTotalTasks?: number;
}

export interface ErrorOccurredPayload {
	error: AgentError;
	documentIndex: number;
	taskDescription?: string;
}

export interface LoopCompletedPayload {
	newTotalTasks: number;
}

/**
 * Union type of all events that can trigger state transitions.
 *
 * Valid transitions:
 * - IDLE -> INITIALIZING: START_BATCH
 * - INITIALIZING -> RUNNING: INITIALIZATION_COMPLETE
 * - INITIALIZING -> IDLE: INITIALIZATION_FAILED
 * - RUNNING -> PAUSED_ERROR: ERROR_OCCURRED
 * - RUNNING -> STOPPING: STOP_REQUESTED
 * - RUNNING -> COMPLETING: ALL_TASKS_DONE
 * - RUNNING -> RUNNING: TASK_COMPLETED, LOOP_COMPLETED, DOCUMENT_ADVANCED
 * - PAUSED_ERROR -> RUNNING: ERROR_RESOLVED (resume)
 * - PAUSED_ERROR -> RUNNING: DOCUMENT_SKIPPED (skip current document)
 * - PAUSED_ERROR -> STOPPING: ABORT_REQUESTED
 * - STOPPING -> COMPLETING: CURRENT_TASK_DONE
 * - COMPLETING -> IDLE: BATCH_FINALIZED
 */
export type BatchEvent =
	| { type: 'START_BATCH'; payload: InitializePayload }
	| { type: 'INITIALIZATION_COMPLETE' }
	| { type: 'INITIALIZATION_FAILED' }
	| { type: 'TASK_COMPLETED'; payload: TaskCompletedPayload }
	| { type: 'DOCUMENT_ADVANCED'; documentIndex: number }
	| { type: 'LOOP_COMPLETED'; payload: LoopCompletedPayload }
	| { type: 'ERROR_OCCURRED'; payload: ErrorOccurredPayload }
	| { type: 'ERROR_RESOLVED' }
	| { type: 'DOCUMENT_SKIPPED' }
	| { type: 'STOP_REQUESTED' }
	| { type: 'ABORT_REQUESTED' }
	| { type: 'ALL_TASKS_DONE' }
	| { type: 'CURRENT_TASK_DONE' }
	| { type: 'BATCH_FINALIZED' };

/**
 * Default/initial context for a new batch processor
 */
export const DEFAULT_MACHINE_CONTEXT: BatchMachineContext = {
	state: 'IDLE',
	sessionId: null,
	documents: [],
	currentDocIndex: 0,
	completedTasks: 0,
	totalTasks: 0,
	loopIteration: 0,
	error: null,
	errorDocumentIndex: null,
	errorTaskDescription: null,
	startTime: null,
	loopEnabled: false,
	maxLoops: null,
	worktreeActive: false,
	worktreePath: null,
	worktreeBranch: null,
};

/**
 * Transition function that returns a new context based on the current state and event.
 *
 * This is a pure function - it does not mutate the input context.
 * Invalid transitions return the original context unchanged (or could throw if strict mode is desired).
 *
 * @param context - Current state machine context
 * @param event - Event to process
 * @returns New context after applying the transition, or original context if transition is invalid
 */
export function transition(context: BatchMachineContext, event: BatchEvent): BatchMachineContext {
	const { state } = context;

	switch (event.type) {
		// IDLE -> INITIALIZING: Start a new batch
		case 'START_BATCH': {
			if (state !== 'IDLE') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + START_BATCH`);
				return context;
			}
			const { payload } = event;
			return {
				...DEFAULT_MACHINE_CONTEXT,
				state: 'INITIALIZING',
				sessionId: payload.sessionId,
				documents: payload.documents,
				totalTasks: payload.totalTasks,
				loopEnabled: payload.loopEnabled,
				maxLoops: payload.maxLoops,
				worktreeActive: payload.worktreeActive,
				worktreePath: payload.worktreePath,
				worktreeBranch: payload.worktreeBranch,
				startTime: Date.now(),
			};
		}

		// INITIALIZING -> RUNNING: Initialization complete, start processing
		case 'INITIALIZATION_COMPLETE': {
			if (state !== 'INITIALIZING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + INITIALIZATION_COMPLETE`);
				return context;
			}
			return {
				...context,
				state: 'RUNNING',
			};
		}

		// INITIALIZING -> IDLE: Initialization failed
		case 'INITIALIZATION_FAILED': {
			if (state !== 'INITIALIZING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + INITIALIZATION_FAILED`);
				return context;
			}
			return {
				...DEFAULT_MACHINE_CONTEXT,
			};
		}

		// RUNNING -> RUNNING: Task completed, update progress
		case 'TASK_COMPLETED': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + TASK_COMPLETED`);
				return context;
			}
			const { payload } = event;
			return {
				...context,
				completedTasks: payload.newCompletedCount,
				totalTasks: payload.newTotalTasks ?? context.totalTasks,
			};
		}

		// RUNNING -> RUNNING: Move to next document
		case 'DOCUMENT_ADVANCED': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + DOCUMENT_ADVANCED`);
				return context;
			}
			return {
				...context,
				currentDocIndex: event.documentIndex,
			};
		}

		// RUNNING -> RUNNING: Loop completed, start next iteration
		case 'LOOP_COMPLETED': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + LOOP_COMPLETED`);
				return context;
			}
			const { payload } = event;
			return {
				...context,
				loopIteration: context.loopIteration + 1,
				currentDocIndex: 0,
				totalTasks: context.completedTasks + payload.newTotalTasks,
			};
		}

		// RUNNING -> PAUSED_ERROR: Error occurred during processing
		case 'ERROR_OCCURRED': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + ERROR_OCCURRED`);
				return context;
			}
			const { payload } = event;
			return {
				...context,
				state: 'PAUSED_ERROR',
				error: payload.error,
				errorDocumentIndex: payload.documentIndex,
				errorTaskDescription: payload.taskDescription ?? null,
			};
		}

		// PAUSED_ERROR -> RUNNING: Error resolved, resume processing
		case 'ERROR_RESOLVED': {
			if (state !== 'PAUSED_ERROR') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + ERROR_RESOLVED`);
				return context;
			}
			return {
				...context,
				state: 'RUNNING',
				error: null,
				errorDocumentIndex: null,
				errorTaskDescription: null,
			};
		}

		// PAUSED_ERROR -> RUNNING: Skip the errored document, continue with next
		case 'DOCUMENT_SKIPPED': {
			if (state !== 'PAUSED_ERROR') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + DOCUMENT_SKIPPED`);
				return context;
			}
			// Move to next document (caller should handle bounds checking)
			return {
				...context,
				state: 'RUNNING',
				currentDocIndex: context.currentDocIndex + 1,
				error: null,
				errorDocumentIndex: null,
				errorTaskDescription: null,
			};
		}

		// RUNNING -> STOPPING: User requested stop
		case 'STOP_REQUESTED': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + STOP_REQUESTED`);
				return context;
			}
			return {
				...context,
				state: 'STOPPING',
			};
		}

		// PAUSED_ERROR -> STOPPING: User aborted due to error
		case 'ABORT_REQUESTED': {
			if (state !== 'PAUSED_ERROR') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + ABORT_REQUESTED`);
				return context;
			}
			return {
				...context,
				state: 'STOPPING',
				error: null,
				errorDocumentIndex: null,
				errorTaskDescription: null,
			};
		}

		// RUNNING -> COMPLETING: All tasks finished naturally
		case 'ALL_TASKS_DONE': {
			if (state !== 'RUNNING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + ALL_TASKS_DONE`);
				return context;
			}
			return {
				...context,
				state: 'COMPLETING',
			};
		}

		// STOPPING -> COMPLETING: Current task finished, ready for cleanup
		case 'CURRENT_TASK_DONE': {
			if (state !== 'STOPPING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + CURRENT_TASK_DONE`);
				return context;
			}
			return {
				...context,
				state: 'COMPLETING',
			};
		}

		// COMPLETING -> IDLE: Batch fully finalized
		case 'BATCH_FINALIZED': {
			if (state !== 'COMPLETING') {
				console.warn(`[BatchStateMachine] Invalid transition: ${state} + BATCH_FINALIZED`);
				return context;
			}
			return {
				...DEFAULT_MACHINE_CONTEXT,
			};
		}

		default: {
			// TypeScript exhaustiveness check
			const _exhaustive: never = event;
			console.warn(`[BatchStateMachine] Unknown event type: ${(_exhaustive as BatchEvent).type}`);
			return context;
		}
	}
}

/**
 * Check if a transition is valid from the current state.
 *
 * @param currentState - The current state
 * @param eventType - The event type to check
 * @returns true if the transition is valid, false otherwise
 */
export function canTransition(
	currentState: BatchProcessingState,
	eventType: BatchEvent['type']
): boolean {
	const validTransitions: Record<BatchProcessingState, BatchEvent['type'][]> = {
		IDLE: ['START_BATCH'],
		INITIALIZING: ['INITIALIZATION_COMPLETE', 'INITIALIZATION_FAILED'],
		RUNNING: [
			'TASK_COMPLETED',
			'DOCUMENT_ADVANCED',
			'LOOP_COMPLETED',
			'ERROR_OCCURRED',
			'STOP_REQUESTED',
			'ALL_TASKS_DONE',
		],
		PAUSED_ERROR: ['ERROR_RESOLVED', 'DOCUMENT_SKIPPED', 'ABORT_REQUESTED'],
		STOPPING: ['CURRENT_TASK_DONE'],
		COMPLETING: ['BATCH_FINALIZED'],
	};

	return validTransitions[currentState].includes(eventType);
}

/**
 * Get the list of valid events that can be triggered from the current state.
 *
 * @param currentState - The current state
 * @returns Array of valid event types
 */
export function getValidEvents(currentState: BatchProcessingState): BatchEvent['type'][] {
	const validTransitions: Record<BatchProcessingState, BatchEvent['type'][]> = {
		IDLE: ['START_BATCH'],
		INITIALIZING: ['INITIALIZATION_COMPLETE', 'INITIALIZATION_FAILED'],
		RUNNING: [
			'TASK_COMPLETED',
			'DOCUMENT_ADVANCED',
			'LOOP_COMPLETED',
			'ERROR_OCCURRED',
			'STOP_REQUESTED',
			'ALL_TASKS_DONE',
		],
		PAUSED_ERROR: ['ERROR_RESOLVED', 'DOCUMENT_SKIPPED', 'ABORT_REQUESTED'],
		STOPPING: ['CURRENT_TASK_DONE'],
		COMPLETING: ['BATCH_FINALIZED'],
	};

	return validTransitions[currentState];
}

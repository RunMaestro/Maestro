import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MACHINE_CONTEXT,
	canTransition,
	getValidEvents,
	transition,
	type BatchEvent,
	type BatchMachineContext,
	type BatchProcessingState,
} from '../../renderer/hooks/batch/batchStateMachine';
import { logger } from '../../renderer/utils/logger';
import type { AgentError } from '../../renderer/types';

const startPayload = {
	sessionId: 'session-1',
	documents: ['phase-1.md', 'phase-2.md'],
	totalTasks: 7,
	loopEnabled: true,
	maxLoops: 3,
	worktreeActive: true,
	worktreePath: '/repo-worktree',
	worktreeBranch: 'feature/tests',
};

const agentError: AgentError = {
	type: 'network_error',
	message: 'Connection dropped',
	recoverable: true,
	agentId: 'claude-code',
	sessionId: 'session-1',
	timestamp: 1000,
};

function contextInState(
	state: BatchProcessingState,
	overrides: Partial<BatchMachineContext> = {}
): BatchMachineContext {
	return {
		...DEFAULT_MACHINE_CONTEXT,
		state,
		sessionId: 'session-1',
		documents: ['phase-1.md', 'phase-2.md'],
		totalTasks: 7,
		...overrides,
	};
}

describe('batchStateMachine', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('starts a new batch from idle and resets stale context fields', () => {
		const staleIdleContext = contextInState('IDLE', {
			completedTasks: 99,
			error: agentError,
			currentDocIndex: 4,
		});

		const result = transition(staleIdleContext, {
			type: 'START_BATCH',
			payload: startPayload,
		});

		expect(result).toMatchObject({
			state: 'INITIALIZING',
			sessionId: 'session-1',
			documents: ['phase-1.md', 'phase-2.md'],
			totalTasks: 7,
			completedTasks: 0,
			currentDocIndex: 0,
			loopEnabled: true,
			maxLoops: 3,
			worktreeActive: true,
			worktreePath: '/repo-worktree',
			worktreeBranch: 'feature/tests',
			error: null,
		});
		expect(result.startTime).toBe(new Date('2026-01-02T03:04:05.000Z').getTime());
		expect(staleIdleContext.completedTasks).toBe(99);
	});

	it('moves through initialization success and failure paths', () => {
		const initializing = transition(DEFAULT_MACHINE_CONTEXT, {
			type: 'START_BATCH',
			payload: startPayload,
		});

		expect(transition(initializing, { type: 'INITIALIZATION_COMPLETE' }).state).toBe('RUNNING');
		expect(transition(initializing, { type: 'INITIALIZATION_FAILED' })).toEqual(
			DEFAULT_MACHINE_CONTEXT
		);
	});

	it('updates running progress, document position, and loop totals', () => {
		const running = contextInState('RUNNING', {
			completedTasks: 2,
			totalTasks: 7,
			currentDocIndex: 1,
			loopIteration: 1,
		});

		expect(
			transition(running, {
				type: 'TASK_COMPLETED',
				payload: { newCompletedCount: 3 },
			})
		).toMatchObject({ completedTasks: 3, totalTasks: 7 });

		expect(
			transition(running, {
				type: 'TASK_COMPLETED',
				payload: { newCompletedCount: 4, newTotalTasks: 9 },
			})
		).toMatchObject({ completedTasks: 4, totalTasks: 9 });

		expect(transition(running, { type: 'DOCUMENT_ADVANCED', documentIndex: 2 })).toMatchObject({
			currentDocIndex: 2,
		});

		expect(
			transition(running, {
				type: 'LOOP_COMPLETED',
				payload: { newTotalTasks: 5 },
			})
		).toMatchObject({
			loopIteration: 2,
			currentDocIndex: 0,
			totalTasks: 7,
		});
	});

	it('pauses for errors and resumes or skips with error metadata cleared', () => {
		const running = contextInState('RUNNING', { currentDocIndex: 1 });

		const paused = transition(running, {
			type: 'ERROR_OCCURRED',
			payload: {
				error: agentError,
				documentIndex: 1,
				taskDescription: 'Update the audit',
			},
		});
		expect(paused).toMatchObject({
			state: 'PAUSED_ERROR',
			error: agentError,
			errorDocumentIndex: 1,
			errorTaskDescription: 'Update the audit',
		});

		expect(transition(paused, { type: 'ERROR_RESOLVED' })).toMatchObject({
			state: 'RUNNING',
			error: null,
			errorDocumentIndex: null,
			errorTaskDescription: null,
		});

		const pausedWithoutDescription = transition(running, {
			type: 'ERROR_OCCURRED',
			payload: {
				error: agentError,
				documentIndex: 1,
			},
		});
		expect(pausedWithoutDescription.errorTaskDescription).toBeNull();

		expect(transition(pausedWithoutDescription, { type: 'DOCUMENT_SKIPPED' })).toMatchObject({
			state: 'RUNNING',
			currentDocIndex: 2,
			error: null,
			errorDocumentIndex: null,
			errorTaskDescription: null,
		});
	});

	it('handles stop, abort, completion, and finalization paths', () => {
		const running = contextInState('RUNNING');

		expect(transition(running, { type: 'ALL_TASKS_DONE' }).state).toBe('COMPLETING');

		const stopping = transition(running, { type: 'STOP_REQUESTED' });
		expect(stopping.state).toBe('STOPPING');
		expect(transition(stopping, { type: 'CURRENT_TASK_DONE' }).state).toBe('COMPLETING');

		const paused = contextInState('PAUSED_ERROR', {
			error: agentError,
			errorDocumentIndex: 0,
			errorTaskDescription: 'Fix failing task',
		});
		expect(transition(paused, { type: 'ABORT_REQUESTED' })).toMatchObject({
			state: 'STOPPING',
			error: null,
			errorDocumentIndex: null,
			errorTaskDescription: null,
		});

		expect(transition(contextInState('COMPLETING'), { type: 'BATCH_FINALIZED' })).toEqual(
			DEFAULT_MACHINE_CONTEXT
		);
	});

	it('returns the same context and warns for invalid transitions', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
		const cases: Array<{ context: BatchMachineContext; event: BatchEvent }> = [
			{ context: contextInState('RUNNING'), event: { type: 'START_BATCH', payload: startPayload } },
			{ context: contextInState('IDLE'), event: { type: 'INITIALIZATION_COMPLETE' } },
			{ context: contextInState('RUNNING'), event: { type: 'INITIALIZATION_FAILED' } },
			{
				context: contextInState('PAUSED_ERROR'),
				event: { type: 'TASK_COMPLETED', payload: { newCompletedCount: 1 } },
			},
			{ context: contextInState('IDLE'), event: { type: 'DOCUMENT_ADVANCED', documentIndex: 1 } },
			{
				context: contextInState('IDLE'),
				event: { type: 'LOOP_COMPLETED', payload: { newTotalTasks: 2 } },
			},
			{
				context: contextInState('IDLE'),
				event: { type: 'ERROR_OCCURRED', payload: { error: agentError, documentIndex: 0 } },
			},
			{ context: contextInState('RUNNING'), event: { type: 'ERROR_RESOLVED' } },
			{ context: contextInState('RUNNING'), event: { type: 'DOCUMENT_SKIPPED' } },
			{ context: contextInState('IDLE'), event: { type: 'STOP_REQUESTED' } },
			{ context: contextInState('RUNNING'), event: { type: 'ABORT_REQUESTED' } },
			{ context: contextInState('IDLE'), event: { type: 'ALL_TASKS_DONE' } },
			{ context: contextInState('RUNNING'), event: { type: 'CURRENT_TASK_DONE' } },
			{ context: contextInState('RUNNING'), event: { type: 'BATCH_FINALIZED' } },
		];

		for (const { context, event } of cases) {
			expect(transition(context, event)).toBe(context);
		}

		expect(warn).toHaveBeenCalledTimes(cases.length);
		expect(warn).toHaveBeenCalledWith(
			'[BatchStateMachine] Invalid transition: RUNNING + START_BATCH'
		);
	});

	it('warns and preserves context for unknown runtime events', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
		const running = contextInState('RUNNING');

		expect(transition(running, { type: 'UNKNOWN_EVENT' } as unknown as BatchEvent)).toBe(running);
		expect(warn).toHaveBeenCalledWith('[BatchStateMachine] Unknown event type: UNKNOWN_EVENT');
	});

	it('reports valid transition availability for each state', () => {
		expect(canTransition('IDLE', 'START_BATCH')).toBe(true);
		expect(canTransition('IDLE', 'STOP_REQUESTED')).toBe(false);

		expect(getValidEvents('IDLE')).toEqual(['START_BATCH']);
		expect(getValidEvents('INITIALIZING')).toEqual([
			'INITIALIZATION_COMPLETE',
			'INITIALIZATION_FAILED',
		]);
		expect(getValidEvents('RUNNING')).toEqual([
			'TASK_COMPLETED',
			'DOCUMENT_ADVANCED',
			'LOOP_COMPLETED',
			'ERROR_OCCURRED',
			'STOP_REQUESTED',
			'ALL_TASKS_DONE',
		]);
		expect(getValidEvents('PAUSED_ERROR')).toEqual([
			'ERROR_RESOLVED',
			'DOCUMENT_SKIPPED',
			'ABORT_REQUESTED',
		]);
		expect(getValidEvents('STOPPING')).toEqual(['CURRENT_TASK_DONE']);
		expect(getValidEvents('COMPLETING')).toEqual(['BATCH_FINALIZED']);
	});
});

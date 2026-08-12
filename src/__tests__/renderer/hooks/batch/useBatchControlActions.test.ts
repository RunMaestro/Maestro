import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useBatchControlActions,
	type ErrorResolutionEntry,
} from '../../../../renderer/hooks/batch/internal/useBatchControlActions';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { AgentError, BatchRunState } from '../../../../renderer/types';

const autorunLog = vi.fn();

beforeEach(() => {
	autorunLog.mockReset();
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	(window as unknown as { maestro: unknown }).maestro = {
		logger: { autorun: autorunLog, log: vi.fn() },
	};
});

const setupHook = () => {
	const broadcastAutoRunState = vi.fn();
	const dispatch = vi.fn();
	const errorResolutionRefs = { current: {} as Record<string, ErrorResolutionEntry> };
	const stopRequestedRefs = { current: {} as Record<string, boolean> };
	const isMountedRef = { current: true };

	const hook = renderHook(() =>
		useBatchControlActions({
			broadcastAutoRunState,
			dispatch,
			errorResolutionRefs,
			stopRequestedRefs,
			isMountedRef,
		})
	);

	return {
		hook,
		broadcastAutoRunState,
		dispatch,
		errorResolutionRefs,
		stopRequestedRefs,
		isMountedRef,
	};
};

const mkRunningState = (over: Partial<BatchRunState> = {}): BatchRunState => ({
	...DEFAULT_BATCH_STATE,
	isRunning: true,
	...over,
});

const mkError = (over: Partial<AgentError> = {}): AgentError => ({
	type: 'context-window' as never,
	message: 'context limit',
	recoverable: true,
	raw: 'raw',
	...over,
});

describe('useBatchControlActions', () => {
	it('stopBatchRun sets stopRequestedRefs, resolves any pending error, dispatches SET_STOPPING and broadcasts', () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });

		const { hook, dispatch, broadcastAutoRunState, errorResolutionRefs, stopRequestedRefs } =
			setupHook();
		const resolve = vi.fn();
		errorResolutionRefs.current.sess = {
			promise: new Promise(() => {}) as never,
			resolve,
		};

		act(() => hook.result.current.stopBatchRun('sess'));

		expect(stopRequestedRefs.current.sess).toBe(true);
		expect(resolve).toHaveBeenCalledWith('abort');
		expect(errorResolutionRefs.current.sess).toBeUndefined();
		expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'sess',
			expect.objectContaining({ isStopping: true })
		);
	});

	it('stopBatchRun is a no-op for the broadcast when no batch state exists', () => {
		const { hook, broadcastAutoRunState } = setupHook();

		act(() => hook.result.current.stopBatchRun('sess'));

		expect(broadcastAutoRunState).not.toHaveBeenCalled();
	});

	it('pauseBatchOnError dispatches SET_ERROR with payload and creates an error-resolution promise', () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
		const { hook, dispatch, broadcastAutoRunState, errorResolutionRefs } = setupHook();
		const error = mkError();

		act(() => hook.result.current.pauseBatchOnError('sess', error, 0, 'task'));

		expect(dispatch).toHaveBeenCalledWith({
			type: 'SET_ERROR',
			sessionId: 'sess',
			payload: { error, documentIndex: 0, taskDescription: 'task' },
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'sess',
			expect.objectContaining({ errorPaused: true, errorDocumentIndex: 0 })
		);
		expect(errorResolutionRefs.current.sess).toBeDefined();
		expect(autorunLog).toHaveBeenCalled();
	});

	it('pauseBatchOnError is idempotent - does not replace an existing resolution promise', () => {
		const { hook, errorResolutionRefs } = setupHook();
		const error = mkError();

		act(() => hook.result.current.pauseBatchOnError('sess', error, 0));
		const first = errorResolutionRefs.current.sess;
		act(() => hook.result.current.pauseBatchOnError('sess', error, 0));
		expect(errorResolutionRefs.current.sess).toBe(first);
	});

	it('skipCurrentDocument dispatches CLEAR_ERROR and resolves the promise with skip-document', async () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
		const { hook, dispatch, errorResolutionRefs } = setupHook();

		act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
		const entry = errorResolutionRefs.current.sess;
		expect(entry).toBeDefined();

		act(() => hook.result.current.skipCurrentDocument('sess'));

		expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR', sessionId: 'sess' });
		await expect(entry!.promise).resolves.toBe('skip-document');
		expect(errorResolutionRefs.current.sess).toBeUndefined();
	});

	it('resumeAfterError dispatches CLEAR_ERROR and resolves with resume', async () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
		const { hook, dispatch, errorResolutionRefs } = setupHook();

		act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
		const entry = errorResolutionRefs.current.sess;

		act(() => hook.result.current.resumeAfterError('sess'));

		expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR', sessionId: 'sess' });
		await expect(entry!.promise).resolves.toBe('resume');
	});

	it('abortBatchOnError dispatches SET_STOPPING, sets stopRequestedRefs, and resolves with abort', async () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
		const { hook, dispatch, errorResolutionRefs, stopRequestedRefs } = setupHook();

		act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
		const entry = errorResolutionRefs.current.sess;

		act(() => hook.result.current.abortBatchOnError('sess'));

		expect(stopRequestedRefs.current.sess).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
		await expect(entry!.promise).resolves.toBe('abort');
	});

	it('isMountedRef=false short-circuits pause/skip/resume/abort (but stopBatchRun still runs)', () => {
		useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
		const broadcastAutoRunState = vi.fn();
		const dispatch = vi.fn();
		const errorResolutionRefs = { current: {} as Record<string, ErrorResolutionEntry> };
		const stopRequestedRefs = { current: {} as Record<string, boolean> };
		const isMountedRef = { current: false };

		const { result } = renderHook(() =>
			useBatchControlActions({
				broadcastAutoRunState,
				dispatch,
				errorResolutionRefs,
				stopRequestedRefs,
				isMountedRef,
			})
		);

		act(() => result.current.pauseBatchOnError('sess', mkError(), 0));
		act(() => result.current.skipCurrentDocument('sess'));
		act(() => result.current.resumeAfterError('sess'));
		act(() => result.current.abortBatchOnError('sess'));
		expect(dispatch).not.toHaveBeenCalled();

		// stopBatchRun bypasses isMountedRef.
		act(() => result.current.stopBatchRun('sess'));
		expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
	});

	it('logs an autorun message for each control action', () => {
		const { hook } = setupHook();
		act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
		act(() => hook.result.current.skipCurrentDocument('sess'));
		act(() => hook.result.current.resumeAfterError('sess'));
		act(() => hook.result.current.abortBatchOnError('sess'));
		expect(autorunLog.mock.calls.length).toBeGreaterThanOrEqual(4);
	});
});

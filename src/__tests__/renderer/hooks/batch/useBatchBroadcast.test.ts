import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchBroadcast } from '../../../../renderer/hooks/batch/internal/useBatchBroadcast';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState } from '../../../../renderer/types';

const broadcastMock = vi.fn();

beforeEach(() => {
	broadcastMock.mockReset();
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	(window as unknown as { maestro: unknown }).maestro = {
		web: { broadcastAutoRunState: broadcastMock },
	};
});

const mkState = (over: Partial<BatchRunState> = {}): BatchRunState => ({
	...DEFAULT_BATCH_STATE,
	isRunning: true,
	...over,
});

describe('useBatchBroadcast', () => {
	it('broadcasts a populated payload when state is running', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		act(() => {
			result.current.broadcastAutoRunState(
				'sess',
				mkState({ totalTasks: 5, completedTasks: 2, currentTaskIndex: 2 })
			);
		});

		expect(broadcastMock).toHaveBeenCalledWith(
			'sess',
			expect.objectContaining({
				isRunning: true,
				totalTasks: 5,
				completedTasks: 2,
				currentTaskIndex: 2,
			})
		);
	});

	it('broadcasts null when state is null', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		act(() => result.current.broadcastAutoRunState('sess', null));

		expect(broadcastMock).toHaveBeenCalledWith('sess', null);
	});

	it('broadcasts null when state is not running and has no completed work', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		act(() => {
			result.current.broadcastAutoRunState(
				'sess',
				mkState({ isRunning: false, completedTasks: 0, completedTasksAcrossAllDocs: 0 })
			);
		});

		expect(broadcastMock).toHaveBeenCalledWith('sess', null);
	});

	it('broadcasts a populated payload when state has completed tasks even if not running', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		act(() => {
			result.current.broadcastAutoRunState(
				'sess',
				mkState({ isRunning: false, completedTasks: 3 })
			);
		});

		expect(broadcastMock).toHaveBeenCalledWith(
			'sess',
			expect.objectContaining({ isRunning: false, completedTasks: 3 })
		);
	});

	it('omits error fields when no error is present in state', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		act(() => {
			result.current.broadcastAutoRunState('sess', mkState());
		});

		const payload = broadcastMock.mock.calls[0][1];
		expect(payload.errorMessage).toBeUndefined();
		expect(payload.errorType).toBeUndefined();
		expect(payload.errorRecoverable).toBeUndefined();
	});

	it('flushDebouncedUpdate triggers any queued update synchronously', async () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		// Seed the store so the diffing path emits a non-undefined field.
		useBatchStore.setState({ batchRunStates: { sess: mkState({ completedTasks: 0 }) } });

		act(() => {
			result.current.updateBatchStateAndBroadcast('sess', (prev) => ({
				...prev,
				sess: { ...prev.sess, completedTasks: 7 },
			}));
		});

		// Nothing dispatched yet (debounced).
		expect(dispatch).not.toHaveBeenCalled();

		act(() => {
			result.current.flushDebouncedUpdate('sess');
		});

		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess',
				payload: expect.objectContaining({ completedTasks: 7 }),
			})
		);
	});

	it('immediate=true bypasses the debounce', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		useBatchStore.setState({ batchRunStates: { sess: mkState({ completedTasks: 0 }) } });

		act(() => {
			result.current.updateBatchStateAndBroadcast(
				'sess',
				(prev) => ({ ...prev, sess: { ...prev.sess, completedTasks: 9 } }),
				true
			);
		});

		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess',
				payload: expect.objectContaining({ completedTasks: 9 }),
			})
		);
	});

	it('only dispatches diff fields that actually changed', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		useBatchStore.setState({
			batchRunStates: { sess: mkState({ completedTasks: 5, totalTasks: 10 }) },
		});

		act(() => {
			result.current.updateBatchStateAndBroadcast(
				'sess',
				(prev) => ({
					...prev,
					sess: { ...prev.sess, completedTasks: 6 },
				}),
				true
			);
		});

		const payload = (dispatch.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
		expect(payload.completedTasks).toBe(6);
		// totalTasks didn't change → omitted
		expect(payload.totalTasks).toBeUndefined();
	});

	it('multi-session debounce isolation: flushing one session does not flush another', () => {
		const dispatch = vi.fn();
		const { result } = renderHook(() => useBatchBroadcast({ dispatch }));

		useBatchStore.setState({
			batchRunStates: { a: mkState({ completedTasks: 0 }), b: mkState({ completedTasks: 0 }) },
		});

		act(() => {
			result.current.updateBatchStateAndBroadcast('a', (prev) => ({
				...prev,
				a: { ...prev.a, completedTasks: 1 },
			}));
			result.current.updateBatchStateAndBroadcast('b', (prev) => ({
				...prev,
				b: { ...prev.b, completedTasks: 2 },
			}));
		});

		expect(dispatch).not.toHaveBeenCalled();

		act(() => result.current.flushDebouncedUpdate('a'));

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0][0].sessionId).toBe('a');
	});
});

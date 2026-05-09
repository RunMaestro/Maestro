import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBatchSelectors } from '../../../../renderer/hooks/batch/internal/useBatchSelectors';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState } from '../../../../renderer/types';

const mkState = (over: Partial<BatchRunState> = {}): BatchRunState => ({
	...DEFAULT_BATCH_STATE,
	isRunning: true,
	...over,
});

describe('useBatchSelectors', () => {
	beforeEach(() => {
		useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	});

	it('returns DEFAULT_BATCH_STATE for unknown sessions', () => {
		const { result } = renderHook(() => useBatchSelectors());
		expect(result.current.getBatchState('nope')).toEqual(DEFAULT_BATCH_STATE);
	});

	it('exposes batchRunStates from the store reactively', () => {
		const { result } = renderHook(() => useBatchSelectors());
		expect(result.current.batchRunStates).toEqual({});

		act(() => {
			useBatchStore.setState({ batchRunStates: { a: mkState() } });
		});

		expect(result.current.batchRunStates.a?.isRunning).toBe(true);
	});

	it('hasAnyActiveBatch flips true when a session is running', () => {
		const { result } = renderHook(() => useBatchSelectors());
		expect(result.current.hasAnyActiveBatch).toBe(false);

		act(() => {
			useBatchStore.setState({ batchRunStates: { a: mkState() } });
		});

		expect(result.current.hasAnyActiveBatch).toBe(true);
	});

	it('activeBatchSessionIds excludes sessions with errorPaused=true', () => {
		const { result } = renderHook(() => useBatchSelectors());

		act(() => {
			useBatchStore.setState({
				batchRunStates: {
					a: mkState(),
					b: mkState({ errorPaused: true }),
					c: mkState({ isRunning: false }),
				},
			});
		});

		expect(result.current.activeBatchSessionIds).toEqual(['a']);
	});

	it('stoppingBatchSessionIds is the subset of running sessions with isStopping=true', () => {
		const { result } = renderHook(() => useBatchSelectors());

		act(() => {
			useBatchStore.setState({
				batchRunStates: {
					a: mkState(),
					b: mkState({ isStopping: true }),
					c: mkState({ isStopping: true, isRunning: false }),
				},
			});
		});

		expect(result.current.stoppingBatchSessionIds).toEqual(['b']);
	});

	it('customPrompts is reactive to store updates', () => {
		const { result } = renderHook(() => useBatchSelectors());
		expect(result.current.customPrompts).toEqual({});

		act(() => {
			useBatchStore.setState({ customPrompts: { x: 'hello' } });
		});

		expect(result.current.customPrompts.x).toBe('hello');
	});

	it('setCustomPrompt round-trips through the store', () => {
		const { result } = renderHook(() => useBatchSelectors());

		act(() => {
			result.current.setCustomPrompt('s1', 'do the thing');
		});

		expect(useBatchStore.getState().customPrompts.s1).toBe('do the thing');
	});

	it('isolates per-session state across the active/stopping selectors', () => {
		const { result } = renderHook(() => useBatchSelectors());

		act(() => {
			useBatchStore.setState({
				batchRunStates: {
					alpha: mkState(),
					beta: mkState({ isStopping: true }),
					gamma: mkState({ errorPaused: true }),
				},
			});
		});

		expect(result.current.activeBatchSessionIds.sort()).toEqual(['alpha', 'beta']);
		expect(result.current.stoppingBatchSessionIds).toEqual(['beta']);
	});
});

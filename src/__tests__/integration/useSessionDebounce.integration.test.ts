import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionDebounce } from '../../renderer/hooks/batch/useSessionDebounce';

interface CounterState {
	count: number;
	labels: string[];
}

const baseState: CounterState = {
	count: 2,
	labels: [],
};

describe('useSessionDebounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('composes rapid updates per session and waits for the latest debounce window', () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				count: prev.count + 1,
				labels: [...prev.labels, 'first'],
			}));
			vi.advanceTimersByTime(50);
			result.current.scheduleUpdate('session-1', (prev) => ({
				count: prev.count * 2,
				labels: [...prev.labels, 'second'],
			}));
			vi.advanceTimersByTime(99);
		});

		expect(onUpdate).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith('session-1', expect.any(Function));
		const composedUpdater = onUpdate.mock.calls[0][1] as (prev: CounterState) => CounterState;
		expect(composedUpdater(baseState)).toEqual({
			count: 6,
			labels: ['first', 'second'],
		});
	});

	it('tracks independent session timers without merging their pending updates', () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				...prev,
				count: prev.count + 1,
			}));
			vi.advanceTimersByTime(25);
			result.current.scheduleUpdate('session-2', (prev) => ({
				...prev,
				count: prev.count + 10,
			}));
			vi.advanceTimersByTime(75);
		});

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate.mock.calls[0][0]).toBe('session-1');

		act(() => {
			vi.advanceTimersByTime(25);
		});

		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(onUpdate.mock.calls[1][0]).toBe('session-2');
	});

	it('bypasses debouncing for immediate updates and clears prior pending work', () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				...prev,
				count: prev.count + 1,
			}));
			result.current.scheduleUpdate(
				'session-1',
				(prev) => ({
					...prev,
					count: prev.count + 100,
				}),
				true
			);
			result.current.scheduleUpdate(
				'session-2',
				(prev) => ({
					...prev,
					count: prev.count + 200,
				}),
				true
			);
		});

		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(onUpdate.mock.calls.map(([sessionId]) => sessionId)).toEqual(['session-1', 'session-2']);

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(onUpdate).toHaveBeenCalledTimes(2);
	});

	it('cancels and flushes pending updates by session id', () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				...prev,
				count: prev.count + 1,
			}));
			result.current.scheduleUpdate('session-2', (prev) => ({
				...prev,
				count: prev.count + 2,
			}));
			result.current.cancelUpdate('session-1');
			result.current.cancelUpdate('missing-session');
			result.current.flushUpdate('session-2');
			result.current.flushUpdate('missing-session');
		});

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith('session-2', expect.any(Function));
		const flushedUpdater = onUpdate.mock.calls[0][1] as (prev: CounterState) => CounterState;
		expect(flushedUpdater(baseState).count).toBe(4);

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it('ignores stale timer callbacks after pending work has already been removed', () => {
		const onUpdate = vi.fn();
		const { result } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);
		const clearTimeoutSpy = vi
			.spyOn(globalThis, 'clearTimeout')
			.mockImplementation(() => undefined);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				...prev,
				count: prev.count + 1,
			}));
			result.current.cancelUpdate('session-1');
		});
		clearTimeoutSpy.mockRestore();

		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(onUpdate).not.toHaveBeenCalled();
	});

	it('clears timers and pending updates on unmount', () => {
		const onUpdate = vi.fn();
		const { result, unmount } = renderHook(() =>
			useSessionDebounce<CounterState>({ delayMs: 100, onUpdate })
		);

		expect(result.current.isMounted()).toBe(true);

		act(() => {
			result.current.scheduleUpdate('session-1', (prev) => ({
				...prev,
				count: prev.count + 1,
			}));
		});

		unmount();

		expect(result.current.isMounted()).toBe(false);

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(onUpdate).not.toHaveBeenCalled();
	});
});

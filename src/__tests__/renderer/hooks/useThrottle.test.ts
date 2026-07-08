import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedCallback, useThrottledCallback } from '../../../renderer/hooks';

describe('useThrottle utilities', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs throttled callbacks immediately, then schedules one trailing call', () => {
		const callback = vi.fn();
		const { result } = renderHook(() => useThrottledCallback(callback, 100));

		act(() => {
			result.current('first');
		});

		expect(callback).toHaveBeenCalledWith('first');

		vi.setSystemTime(1030);

		act(() => {
			result.current('second');
			result.current('third');
		});

		expect(callback).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(69);
		});

		expect(callback).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(1);
		});

		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback).toHaveBeenLastCalledWith('second');
	});

	it('clears pending throttled callbacks on unmount', () => {
		const callback = vi.fn();
		const { result, unmount } = renderHook(() => useThrottledCallback(callback, 100));

		act(() => {
			result.current('first');
		});

		vi.setSystemTime(1050);

		act(() => {
			result.current('second');
		});

		unmount();

		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith('first');
	});

	it('flushes and cancels debounced callbacks explicitly', () => {
		const callback = vi.fn();
		const { result } = renderHook(() => useDebouncedCallback(callback, 100));

		act(() => {
			result.current.debouncedCallback('first');
			result.current.flush();
		});

		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith('first');

		act(() => {
			result.current.flush();
			vi.advanceTimersByTime(100);
		});

		expect(callback).toHaveBeenCalledOnce();

		act(() => {
			result.current.debouncedCallback('second');
			result.current.cancel();
			vi.advanceTimersByTime(100);
		});

		expect(callback).toHaveBeenCalledOnce();
	});
});

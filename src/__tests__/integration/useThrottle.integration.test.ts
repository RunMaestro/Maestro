import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	useDebouncedCallback,
	useDebouncedValue,
	useThrottledCallback,
} from '../../renderer/hooks';

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

	it('updates debounced values after the delay and clears superseded timers', () => {
		const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
			initialProps: { value: 'first' },
		});

		expect(result.current).toBe('first');

		rerender({ value: 'second' });
		rerender({ value: 'third' });

		act(() => {
			vi.advanceTimersByTime(99);
		});

		expect(result.current).toBe('first');

		act(() => {
			vi.advanceTimersByTime(1);
		});

		expect(result.current).toBe('third');
	});

	it('runs pending debounced callbacks after the delay and clears them on unmount', () => {
		const callback = vi.fn();
		const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 100));

		act(() => {
			result.current.cancel();
			result.current.debouncedCallback('first');
			result.current.debouncedCallback('second');
		});

		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith('second');

		act(() => {
			result.current.debouncedCallback('third');
		});
		unmount();
		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(callback).toHaveBeenCalledOnce();
	});
});

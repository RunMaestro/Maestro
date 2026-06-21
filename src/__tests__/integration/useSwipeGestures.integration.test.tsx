import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	useSwipeGestures,
	type UseSwipeGesturesOptions,
	type UseSwipeGesturesReturn,
} from '../../web/hooks/useSwipeGestures';

const touchEvent = (
	type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
	x: number,
	y: number
): React.TouchEvent => {
	const touch = {
		clientX: x,
		clientY: y,
		identifier: 0,
		screenX: x,
		screenY: y,
		pageX: x,
		pageY: y,
		target: document.createElement('div'),
	} as unknown as React.Touch;

	return {
		type,
		touches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
		changedTouches: [touch],
		targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		currentTarget: document.createElement('div'),
		target: document.createElement('div'),
		nativeEvent: {} as TouchEvent,
		timeStamp: Date.now(),
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
		persist: () => undefined,
	} as unknown as React.TouchEvent;
};

const timedSwipe = (
	handlers: UseSwipeGesturesReturn['handlers'],
	start: [number, number],
	move: [number, number],
	end: [number, number],
	duration = 100
) => {
	vi.setSystemTime(1_000);
	handlers.onTouchStart(touchEvent('touchstart', ...start));
	handlers.onTouchMove(touchEvent('touchmove', ...move));
	vi.setSystemTime(1_000 + duration);
	handlers.onTouchEnd(touchEvent('touchend', ...end));
};

describe('useSwipeGestures integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('ignores disabled gestures and move events that start without tracking', () => {
		const onSwipeLeft = vi.fn();
		const { result } = renderHook(() =>
			useSwipeGestures({ enabled: false, trackOffset: true, onSwipeLeft })
		);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 30, 100));
			result.current.handlers.onTouchEnd(touchEvent('touchend', 20, 100));
		});

		expect(onSwipeLeft).not.toHaveBeenCalled();
		expect(result.current.isSwiping).toBe(false);
		expect(result.current.offsetX).toBe(0);

		const enabledHook = renderHook(() => useSwipeGestures({ trackOffset: true }));
		act(() => {
			enabledHook.result.current.handlers.onTouchMove(touchEvent('touchmove', 130, 100));
		});

		expect(enabledHook.result.current.isSwiping).toBe(false);
	});

	it('clamps horizontal offsets when the locked direction has no matching callback', () => {
		const { result, rerender } = renderHook(
			(options: UseSwipeGesturesOptions) => useSwipeGestures(options),
			{
				initialProps: {
					trackOffset: true,
					onSwipeRight: vi.fn(),
				},
			}
		);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 60, 102));
		});

		expect(result.current.swipeDirection).toBe('left');
		expect(result.current.offsetX).toBe(0);

		act(() => {
			result.current.handlers.onTouchCancel(touchEvent('touchcancel', 60, 102));
		});

		rerender({
			trackOffset: true,
			onSwipeLeft: vi.fn(),
		});

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 140, 98));
		});

		expect(result.current.swipeDirection).toBe('right');
		expect(result.current.offsetX).toBe(0);
	});

	it('tracks vertical and unlocked offsets while respecting unsupported vertical directions', () => {
		const { result, rerender } = renderHook(
			(options: UseSwipeGesturesOptions) => useSwipeGestures(options),
			{
				initialProps: {
					trackOffset: true,
					onSwipeDown: vi.fn(),
				},
			}
		);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 102, 60));
		});

		expect(result.current.swipeDirection).toBe('up');
		expect(result.current.offsetY).toBe(0);

		act(() => {
			result.current.handlers.onTouchCancel(touchEvent('touchcancel', 102, 60));
		});

		rerender({
			trackOffset: true,
			onSwipeUp: vi.fn(),
		});

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 98, 140));
		});

		expect(result.current.swipeDirection).toBe('down');
		expect(result.current.offsetY).toBe(0);

		act(() => {
			result.current.handlers.onTouchCancel(touchEvent('touchcancel', 98, 140));
		});

		rerender({
			trackOffset: true,
			lockDirection: false,
		});

		act(() => {
			result.current.handlers.onTouchStart(touchEvent('touchstart', 100, 100));
			result.current.handlers.onTouchMove(touchEvent('touchmove', 130, 140));
		});

		expect(result.current.offsetX).toBeGreaterThan(0);
		expect(result.current.offsetY).toBeGreaterThan(0);
	});

	it('fires vertical swipe callbacks and auto-resets tracked offsets', () => {
		const onSwipeUp = vi.fn();
		const onSwipeDown = vi.fn();
		const { result } = renderHook(() =>
			useSwipeGestures({
				trackOffset: true,
				threshold: 30,
				maxTime: 300,
				onSwipeUp,
				onSwipeDown,
			})
		);

		act(() => {
			timedSwipe(result.current.handlers, [100, 100], [100, 40], [100, 20]);
		});
		expect(onSwipeUp).toHaveBeenCalledTimes(1);
		expect(onSwipeDown).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(result.current.offsetY).toBe(0);

		act(() => {
			timedSwipe(result.current.handlers, [100, 100], [100, 140], [100, 180]);
		});

		expect(onSwipeDown).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(result.current.offsetY).toBe(0);
	});

	it('fires horizontal swipe callbacks and immediately resets untracked offsets', () => {
		const onSwipeLeft = vi.fn();
		const onSwipeRight = vi.fn();
		const { result } = renderHook(() =>
			useSwipeGestures({
				threshold: 30,
				maxTime: 300,
				onSwipeLeft,
				onSwipeRight,
			})
		);

		act(() => {
			timedSwipe(result.current.handlers, [100, 100], [60, 100], [40, 100]);
		});

		expect(onSwipeLeft).toHaveBeenCalledTimes(1);
		expect(onSwipeRight).not.toHaveBeenCalled();
		expect(result.current.offsetX).toBe(0);
		expect(result.current.offsetY).toBe(0);

		act(() => {
			timedSwipe(result.current.handlers, [100, 100], [140, 100], [160, 100]);
		});

		expect(onSwipeRight).toHaveBeenCalledTimes(1);
	});
});

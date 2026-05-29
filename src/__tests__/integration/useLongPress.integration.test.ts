import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLongPress } from '../../web/hooks/useLongPress';

function createRect(): DOMRect {
	return {
		x: 10,
		y: 20,
		left: 10,
		top: 20,
		right: 60,
		bottom: 80,
		width: 50,
		height: 60,
		toJSON: () => ({}),
	} as DOMRect;
}

function createTouchEvent(x: number, y: number): React.TouchEvent {
	return {
		touches: [{ clientX: x, clientY: y }],
	} as unknown as React.TouchEvent;
}

describe('useLongPress', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vi.fn(),
		});
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete (window as { ontouchstart?: unknown }).ontouchstart;
	});

	it('fires onLongPress with the element rect after the long-press duration', () => {
		const rect = createRect();
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const element = document.createElement('button');
		element.getBoundingClientRect = vi.fn(() => rect);

		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			(result.current.elementRef as React.MutableRefObject<HTMLElement | null>).current = element;
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).toHaveBeenCalledWith(rect);
		expect(onTap).not.toHaveBeenCalled();
		expect(navigator.vibrate).toHaveBeenCalledWith([10, 50, 20]);
	});

	it('does not fire onLongPress when the long-pressed element is unavailable', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			vi.advanceTimersByTime(500);
			result.current.handlers.onTouchEnd();
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
		expect(navigator.vibrate).toHaveBeenCalledWith([10, 50, 20]);
	});

	it('fires onTap for a touch that ends before long press triggers', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			vi.advanceTimersByTime(499);
			result.current.handlers.onTouchEnd();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
		expect(navigator.vibrate).toHaveBeenCalledWith(10);
	});

	it('cancels long press and tap when movement exceeds the scroll threshold', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			result.current.handlers.onTouchMove(createTouchEvent(11, 0));
			vi.advanceTimersByTime(500);
			result.current.handlers.onTouchEnd();
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
		expect(navigator.vibrate).not.toHaveBeenCalled();
	});

	it('does not cancel tap when movement stays within the scroll threshold', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			result.current.handlers.onTouchMove(createTouchEvent(10, 10));
			result.current.handlers.onTouchEnd();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
		expect(navigator.vibrate).toHaveBeenCalledWith(10);
	});

	it('keeps long press canceled if the timer callback runs after scrolling starts', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const clearTimeoutSpy = vi
			.spyOn(globalThis, 'clearTimeout')
			.mockImplementation(() => undefined);
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			result.current.handlers.onTouchMove(createTouchEvent(0, 11));
			vi.advanceTimersByTime(500);
			result.current.handlers.onTouchEnd();
		});

		clearTimeoutSpy.mockRestore();
		expect(onLongPress).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();
		expect(navigator.vibrate).not.toHaveBeenCalled();
	});

	it('ignores touch move before a touch start is recorded', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchMove(createTouchEvent(20, 20));
			result.current.handlers.onTouchEnd();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('clears pending long press on touch cancel and unmount', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result, unmount } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			result.current.handlers.onTouchCancel();
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).not.toHaveBeenCalled();
		expect(onTap).not.toHaveBeenCalled();

		act(() => {
			result.current.handlers.onTouchStart(createTouchEvent(0, 0));
			unmount();
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('fires onTap from click only when touch events are unavailable', () => {
		const onTap = vi.fn();
		const { result, rerender } = renderHook(() => useLongPress({ onLongPress: vi.fn(), onTap }));

		act(() => {
			result.current.handleClick();
		});

		expect(onTap).toHaveBeenCalledTimes(1);

		Object.defineProperty(window, 'ontouchstart', {
			configurable: true,
			value: null,
		});
		rerender();

		act(() => {
			result.current.handleClick();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
	});

	it('fires long press from context menu and prevents the native menu', () => {
		const rect = createRect();
		const onLongPress = vi.fn();
		const element = document.createElement('button');
		const preventDefault = vi.fn();
		element.getBoundingClientRect = vi.fn(() => rect);

		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => {
			(result.current.elementRef as React.MutableRefObject<HTMLElement | null>).current = element;
			result.current.handleContextMenu({ preventDefault } as unknown as React.MouseEvent);
		});

		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(onLongPress).toHaveBeenCalledWith(rect);
	});

	it('prevents context menu without firing long press when the element is unavailable', () => {
		const onLongPress = vi.fn();
		const preventDefault = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		act(() => {
			result.current.handleContextMenu({ preventDefault } as unknown as React.MouseEvent);
		});

		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});
});

/**
 * Tests for the hoisted `useLongPress` gesture hook
 * (`src/renderer/hooks/utils/useLongPress.ts`). Covers long-press firing,
 * scroll-cancellation, tap passthrough, and right-click passthrough.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress } from '../../../../renderer/hooks/utils/useLongPress';

/** Build a minimal React.TouchEvent-like object with a single touch point. */
function touchEvent(x: number, y: number): React.TouchEvent {
	return {
		touches: [{ clientX: x, clientY: y }],
	} as unknown as React.TouchEvent;
}

/** Assign a stub element to a (readonly-typed) ref for the hook to measure. */
function setRef(ref: React.RefObject<HTMLElement | null>, el: HTMLElement): void {
	(ref as { current: HTMLElement | null }).current = el;
}

describe('useLongPress', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('fires onLongPress with the element rect after the press duration', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));

		const rect = { x: 5, y: 10, width: 100, height: 20 } as DOMRect;
		const el = { getBoundingClientRect: () => rect } as HTMLElement;
		setRef(result.current.elementRef, el);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent(0, 0));
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onLongPress).toHaveBeenCalledWith(rect);
	});

	it('does not fire onLongPress when the touch scrolls past the threshold', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => ({}) as DOMRect,
		} as HTMLElement);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent(0, 0));
			// Move well beyond the 10px scroll threshold.
			result.current.handlers.onTouchMove(touchEvent(0, 40));
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('fires onTap for a short press without scroll', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));

		act(() => {
			result.current.handlers.onTouchStart(touchEvent(0, 0));
		});
		act(() => {
			// Release before the long-press timer elapses.
			vi.advanceTimersByTime(100);
			result.current.handlers.onTouchEnd();
		});

		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('does not fire onTap after a long-press has triggered', () => {
		const onLongPress = vi.fn();
		const onTap = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress, onTap }));
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => ({}) as DOMRect,
		} as HTMLElement);

		act(() => {
			result.current.handlers.onTouchStart(touchEvent(0, 0));
		});
		act(() => {
			vi.advanceTimersByTime(500);
			result.current.handlers.onTouchEnd();
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onTap).not.toHaveBeenCalled();
	});

	it('fires onLongPress immediately on right-click (context menu)', () => {
		const onLongPress = vi.fn();
		const { result } = renderHook(() => useLongPress({ onLongPress }));
		const rect = { x: 1, y: 2 } as DOMRect;
		setRef(result.current.elementRef, {
			getBoundingClientRect: () => rect,
		} as HTMLElement);

		const preventDefault = vi.fn();
		act(() => {
			result.current.handleContextMenu({ preventDefault } as unknown as React.MouseEvent);
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(onLongPress).toHaveBeenCalledWith(rect);
	});
});

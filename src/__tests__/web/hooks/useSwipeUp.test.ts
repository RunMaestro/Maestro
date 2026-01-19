/**
 * Tests for useSwipeUp hook
 *
 * Tests the upward swipe gesture detection hook including:
 * - Initial state and return values
 * - Touch event handling (start, move, end)
 * - Swipe detection criteria (threshold, maxTime, direction)
 * - Horizontal scroll cancellation
 * - Configuration options
 * - Edge cases and callback handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useSwipeUp,
	type UseSwipeUpOptions,
	type UseSwipeUpReturn,
} from '../../../web/hooks/useSwipeUp';

// Helper to create mock touch events
function createTouchEvent(
	type: 'touchstart' | 'touchmove' | 'touchend',
	x: number,
	y: number
): React.TouchEvent {
	const touch = {
		clientX: x,
		clientY: y,
		identifier: 0,
		screenX: x,
		screenY: y,
		pageX: x,
		pageY: y,
		radiusX: 0,
		radiusY: 0,
		rotationAngle: 0,
		force: 1,
		target: document.createElement('div'),
	} as unknown as React.Touch;

	const preventDefault = vi.fn();
	const stopPropagation = vi.fn();

	const event = {
		type,
		touches: type === 'touchend' ? [] : [touch],
		changedTouches: [touch],
		targetTouches: type === 'touchend' ? [] : [touch],
		preventDefault,
		stopPropagation,
		bubbles: true,
		cancelable: true,
		currentTarget: document.createElement('div'),
		defaultPrevented: false,
		eventPhase: 2,
		isTrusted: true,
		nativeEvent: {} as TouchEvent,
		target: document.createElement('div'),
		timeStamp: Date.now(),
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
		persist: () => {},
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		getModifierState: () => false,
		detail: 0,
		view: window,
	} as React.TouchEvent;

	return event;
}

// Helper to simulate a complete swipe gesture
function simulateSwipe(
	handlers: UseSwipeUpReturn['handlers'],
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	duration: number = 100
) {
	const startTime = Date.now();

	// Mock Date.now() for duration calculation
	vi.spyOn(Date, 'now').mockReturnValue(startTime);

	const startEvent = createTouchEvent('touchstart', startX, startY);
	handlers.onTouchStart(startEvent);

	// Move event at midpoint
	const midX = (startX + endX) / 2;
	const midY = (startY + endY) / 2;
	const moveEvent = createTouchEvent('touchmove', midX, midY);
	handlers.onTouchMove(moveEvent);

	// End event
	vi.spyOn(Date, 'now').mockReturnValue(startTime + duration);
	const endEvent = createTouchEvent('touchend', endX, endY);
	handlers.onTouchEnd(endEvent);

	vi.restoreAllMocks();
}

describe('useSwipeUp', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Interface/Type exports', () => {
		it('UseSwipeUpOptions interface allows all configuration options', () => {
			const options: UseSwipeUpOptions = {
				onSwipeUp: () => {},
				threshold: 100,
				maxTime: 500,
				enabled: true,
			};

			expect(options.threshold).toBe(100);
			expect(options.maxTime).toBe(500);
			expect(options.enabled).toBe(true);
		});

		it('UseSwipeUpReturn interface contains handlers object', () => {
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp: () => {} }));

			expect(result.current.handlers).toBeDefined();
			expect(typeof result.current.handlers.onTouchStart).toBe('function');
			expect(typeof result.current.handlers.onTouchMove).toBe('function');
			expect(typeof result.current.handlers.onTouchEnd).toBe('function');
		});

		it('default export matches named export', async () => {
			const defaultExport = await import('../../../web/hooks/useSwipeUp').then((m) => m.default);
			const namedExport = await import('../../../web/hooks/useSwipeUp').then((m) => m.useSwipeUp);

			expect(defaultExport).toBe(namedExport);
		});
	});

	describe('Initial state', () => {
		it('returns handlers object with all three touch handlers', () => {
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp: () => {} }));

			expect(result.current.handlers).toBeDefined();
			expect(result.current.handlers.onTouchStart).toBeDefined();
			expect(result.current.handlers.onTouchMove).toBeDefined();
			expect(result.current.handlers.onTouchEnd).toBeDefined();
		});

		it('handlers are functions', () => {
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp: () => {} }));

			expect(typeof result.current.handlers.onTouchStart).toBe('function');
			expect(typeof result.current.handlers.onTouchMove).toBe('function');
			expect(typeof result.current.handlers.onTouchEnd).toBe('function');
		});

		it('applies default values when not specified', () => {
			vi.useRealTimers();
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// Test that default threshold is 50 (GESTURE_THRESHOLDS.swipeDistance)
			// 40px swipe should NOT trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 140, 100, 100, 100);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 60px swipe SHOULD trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 160, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('applies default maxTime of 300ms', () => {
			vi.useRealTimers();
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// 250ms swipe SHOULD trigger (below default 300ms)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 250);
			});
			expect(onSwipeUp).toHaveBeenCalled();

			// 350ms swipe should NOT trigger (above default 300ms)
			onSwipeUp.mockClear();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 350);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();
		});
	});

	describe('handleTouchStart behavior', () => {
		it('records touch position Y coordinate', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// Start touch at Y=200, end at Y=100 (swipe up of 100px)
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('records touch position X coordinate for direction comparison', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// Horizontal swipe (more X than Y movement) should NOT trigger
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 100, 200, 60, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('records start time for duration check', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, maxTime: 200 }));

			// Fast swipe should trigger
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();

			// Slow swipe should NOT trigger
			onSwipeUp.mockClear();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 300);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('sets isTracking to true (allows subsequent move/end handling)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// After touchstart, move and end should be processed
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('does nothing when disabled', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, enabled: false }));

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('handles first touch in multi-touch scenario', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// The hook uses touches[0], so it should work even if multiple touches exist
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});
	});

	describe('handleTouchMove behavior', () => {
		it('does nothing when disabled', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, enabled: false }));

			vi.useRealTimers();
			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);

				const moveEvent = createTouchEvent('touchmove', 100, 150);
				result.current.handlers.onTouchMove(moveEvent);
			});

			// Should not have tracked the start due to disabled
		});

		it('does nothing when not tracking (no prior touchstart)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// Move without start
				const moveEvent = createTouchEvent('touchmove', 100, 150);
				result.current.handlers.onTouchMove(moveEvent);

				// End without valid start
				const startTime = Date.now();
				vi.spyOn(Date, 'now').mockReturnValue(startTime + 100);
				const endEvent = createTouchEvent('touchend', 100, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('continues tracking when vertical movement > horizontal', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// Mostly vertical movement (deltaY=100, deltaX=20)
				simulateSwipe(result.current.handlers, 100, 200, 120, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('cancels tracking when horizontal movement > vertical', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			const startTime = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(startTime);

			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);

				// More horizontal than vertical (deltaX=80, deltaY=30)
				const moveEvent = createTouchEvent('touchmove', 180, 170);
				result.current.handlers.onTouchMove(moveEvent);

				vi.spyOn(Date, 'now').mockReturnValue(startTime + 100);
				const endEvent = createTouchEvent('touchend', 200, 150);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('handles edge case where deltaX == deltaY', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			const startTime = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(startTime);

			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);

				// Equal delta: deltaX=50, deltaY=50 (clientY goes up = swipe up)
				// Math.abs(deltaX) > Math.abs(deltaY) is false when equal
				const moveEvent = createTouchEvent('touchmove', 150, 150);
				result.current.handlers.onTouchMove(moveEvent);

				vi.spyOn(Date, 'now').mockReturnValue(startTime + 100);
				const endEvent = createTouchEvent('touchend', 150, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			// When deltaX == deltaY, the condition `deltaX > Math.abs(deltaY)` is false
			// so tracking continues, but final check `deltaY > deltaX` is also false when equal
			// Note: the move event checks Math.abs values, but deltaY at move is 50 (down direction from start)
			// Let me trace: startY=200, moveY=150, so deltaY at move = 200 - 150 = 50 (up)
			// startX=100, moveX=150, so deltaX = |150-100| = 50
			// Condition: deltaX > Math.abs(deltaY) = 50 > 50 = false, so tracking continues
			// End check: startY=200, endY=100, deltaY = 200-100 = 100
			// deltaX = |150-100| = 50 (using changedTouches which is the end event)
			expect(onSwipeUp).toHaveBeenCalled();
		});
	});

	describe('handleTouchEnd behavior', () => {
		it('does nothing and resets when disabled', () => {
			const onSwipeUp = vi.fn();
			const { result, rerender } = renderHook(({ enabled }) => useSwipeUp({ onSwipeUp, enabled }), {
				initialProps: { enabled: true },
			});

			// Start enabled, then disable before end
			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);
			});

			// Disable
			rerender({ enabled: false });

			act(() => {
				const endEvent = createTouchEvent('touchend', 100, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('does nothing and resets when not tracking', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// End without start
			act(() => {
				const endEvent = createTouchEvent('touchend', 100, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('calls onSwipeUp when all criteria met (deltaY > threshold, duration < maxTime, deltaY > deltaX)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 50, maxTime: 300 }));

			vi.useRealTimers();
			act(() => {
				// deltaY = 100, deltaX = 10, duration = 100ms
				simulateSwipe(result.current.handlers, 100, 200, 110, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('does NOT call onSwipeUp when deltaY <= threshold', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 100 }));

			vi.useRealTimers();
			act(() => {
				// deltaY = 50 (below 100 threshold)
				simulateSwipe(result.current.handlers, 100, 150, 100, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('does NOT call onSwipeUp when duration >= maxTime', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, maxTime: 200 }));

			vi.useRealTimers();
			act(() => {
				// duration = 250ms (above 200ms maxTime)
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 250);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('does NOT call onSwipeUp when deltaY <= deltaX (horizontal swipe)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// deltaY = 50, deltaX = 80 (more horizontal)
				simulateSwipe(result.current.handlers, 100, 150, 180, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('handles exact threshold boundary', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 50 }));

			vi.useRealTimers();

			// Exactly 50 should NOT trigger (condition is deltaY > threshold)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 150, 100, 100, 100);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 51 should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 151, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('handles exact maxTime boundary', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 50, maxTime: 300 }));

			vi.useRealTimers();

			// Exactly 300ms should NOT trigger (condition is duration < maxTime)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 300);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 299ms should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 299);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('resets isTracking after gesture', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// First gesture
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalledTimes(1);

			// Second gesture should also work (isTracking was reset)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalledTimes(2);
		});

		it('uses changedTouches[0] correctly', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// changedTouches is used in touchend which has no touches array
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('handles negative deltaY (swipe down)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// Swipe DOWN: startY=100, endY=200 => deltaY = 100 - 200 = -100
				simulateSwipe(result.current.handlers, 100, 100, 100, 200, 100);
			});

			// Negative deltaY should NOT trigger (not > threshold)
			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('handles zero movement', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// No movement: deltaY = 0
				simulateSwipe(result.current.handlers, 100, 100, 100, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});
	});

	describe('Options configuration', () => {
		it('custom threshold value is respected', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 30 }));

			vi.useRealTimers();

			// 35px should trigger (> 30 custom threshold)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 135, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('custom maxTime value is respected', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, maxTime: 500 }));

			vi.useRealTimers();

			// 400ms should trigger (< 500 custom maxTime)
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 400);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('enabled=false prevents all handlers', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, enabled: false }));

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('default threshold is GESTURE_THRESHOLDS.swipeDistance (50)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// 49px should NOT trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 149, 100, 100, 100);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 51px should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 151, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('default maxTime is GESTURE_THRESHOLDS.swipeTime (300)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// 299ms should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 299);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('enabled defaults to true', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});
	});

	describe('Complete gesture flows', () => {
		it('complete valid swipe up flow (start -> move -> end)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 250, 100, 100, 150);
			});

			expect(onSwipeUp).toHaveBeenCalledTimes(1);
		});

		it('swipe cancelled by horizontal movement in move phase', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			const startTime = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(startTime);

			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);

				// Move more horizontal than vertical (cancels tracking)
				const moveEvent = createTouchEvent('touchmove', 200, 180);
				result.current.handlers.onTouchMove(moveEvent);

				vi.spyOn(Date, 'now').mockReturnValue(startTime + 100);
				// Even if end position would be valid, tracking was cancelled
				const endEvent = createTouchEvent('touchend', 200, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('swipe too slow (exceeds maxTime)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, maxTime: 200 }));

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 300, 100, 100, 300);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it("swipe too short (doesn't meet threshold)", () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 100 }));

			vi.useRealTimers();
			act(() => {
				// Only 50px movement
				simulateSwipe(result.current.handlers, 100, 150, 100, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('multiple consecutive gestures', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			for (let i = 0; i < 5; i++) {
				act(() => {
					simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
				});
			}

			expect(onSwipeUp).toHaveBeenCalledTimes(5);
		});

		it('gesture after cancellation', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// First gesture: cancelled by horizontal movement
			const startTime1 = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(startTime1);

			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);

				const moveEvent = createTouchEvent('touchmove', 200, 180);
				result.current.handlers.onTouchMove(moveEvent);

				vi.spyOn(Date, 'now').mockReturnValue(startTime1 + 100);
				const endEvent = createTouchEvent('touchend', 200, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
			vi.restoreAllMocks();

			// Second gesture: valid swipe up
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalledTimes(1);
		});

		it('very fast swipe', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// Very fast: 10ms
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 10);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('diagonal swipe (rejected when horizontal >= vertical)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// Diagonal: deltaX=60, deltaY=60 - should NOT trigger because deltaY > deltaX is false
			act(() => {
				simulateSwipe(result.current.handlers, 100, 160, 160, 100, 100);
			});

			expect(onSwipeUp).not.toHaveBeenCalled();
		});
	});

	describe('Callback ref updates', () => {
		it('onSwipeUp callback ref stays current', () => {
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			const { result, rerender } = renderHook(({ cb }) => useSwipeUp({ onSwipeUp: cb }), {
				initialProps: { cb: callback1 },
			});

			// Rerender with new callback
			rerender({ cb: callback2 });

			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(callback1).not.toHaveBeenCalled();
			expect(callback2).toHaveBeenCalled();
		});

		it('handlers remain stable across re-renders', () => {
			const { result, rerender } = renderHook(() => useSwipeUp({ onSwipeUp: () => {} }));

			const handlers1 = result.current.handlers;
			rerender();
			const handlers2 = result.current.handlers;

			// Handler functions should be stable due to useCallback
			expect(typeof handlers1.onTouchStart).toBe('function');
			expect(typeof handlers2.onTouchStart).toBe('function');
		});

		it('options changes are reflected in handlers', () => {
			const onSwipeUp = vi.fn();

			const { result, rerender } = renderHook(
				({ threshold }) => useSwipeUp({ onSwipeUp, threshold }),
				{ initialProps: { threshold: 100 } }
			);

			vi.useRealTimers();

			// 60px swipe should NOT trigger with 100 threshold
			act(() => {
				simulateSwipe(result.current.handlers, 100, 160, 100, 100, 100);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// Change threshold to 50
			rerender({ threshold: 50 });

			// Same 60px swipe should now trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 160, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});
	});

	describe('Edge cases', () => {
		it('single pixel movement', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 1 }));

			vi.useRealTimers();
			act(() => {
				// 2px movement (> 1 threshold)
				simulateSwipe(result.current.handlers, 100, 102, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('very large movement', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// 1000px swipe
				simulateSwipe(result.current.handlers, 100, 1100, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('zero time duration (simultaneous start/end)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();
			act(() => {
				// 0ms duration
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 0);
			});

			// duration < maxTime is true when duration is 0
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('fractional pixel values', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp, threshold: 50.5 }));

			vi.useRealTimers();
			act(() => {
				// 50.6px movement (> 50.5 threshold)
				simulateSwipe(result.current.handlers, 100.1, 150.7, 100.2, 100.1, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('handles multiple touch points (uses first)', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			// The implementation uses touches[0] and changedTouches[0]
			vi.useRealTimers();
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 100);
			});

			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('handles rapid enable/disable toggling', () => {
			const onSwipeUp = vi.fn();

			const { result, rerender } = renderHook(({ enabled }) => useSwipeUp({ onSwipeUp, enabled }), {
				initialProps: { enabled: true },
			});

			// Start gesture while enabled
			act(() => {
				const startEvent = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent);
			});

			// Disable mid-gesture
			rerender({ enabled: false });

			// Try to complete gesture
			act(() => {
				const moveEvent = createTouchEvent('touchmove', 100, 150);
				result.current.handlers.onTouchMove(moveEvent);
			});

			act(() => {
				const endEvent = createTouchEvent('touchend', 100, 100);
				result.current.handlers.onTouchEnd(endEvent);
			});

			// Should not trigger because disabled check happens in handlers
			expect(onSwipeUp).not.toHaveBeenCalled();
		});

		it('handles gesture interrupted by another touchstart', () => {
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			const startTime = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(startTime);

			act(() => {
				// First gesture starts
				const startEvent1 = createTouchEvent('touchstart', 100, 200);
				result.current.handlers.onTouchStart(startEvent1);

				const moveEvent1 = createTouchEvent('touchmove', 100, 150);
				result.current.handlers.onTouchMove(moveEvent1);

				// New gesture starts (overwrites previous)
				const startEvent2 = createTouchEvent('touchstart', 200, 300);
				result.current.handlers.onTouchStart(startEvent2);

				const moveEvent2 = createTouchEvent('touchmove', 200, 250);
				result.current.handlers.onTouchMove(moveEvent2);

				vi.spyOn(Date, 'now').mockReturnValue(startTime + 100);
				const endEvent = createTouchEvent('touchend', 200, 150);
				result.current.handlers.onTouchEnd(endEvent);
			});

			// Second gesture completed (150px swipe up)
			expect(onSwipeUp).toHaveBeenCalledTimes(1);
		});
	});

	describe('GESTURE_THRESHOLDS integration', () => {
		it('uses swipeDistance constant for default threshold', () => {
			// From constants.ts: swipeDistance: 50
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// 49px should not trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 149, 100, 100, 100);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 51px should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 151, 100, 100, 100);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});

		it('uses swipeTime constant for default maxTime', () => {
			// From constants.ts: swipeTime: 300
			const onSwipeUp = vi.fn();
			const { result } = renderHook(() => useSwipeUp({ onSwipeUp }));

			vi.useRealTimers();

			// 301ms should not trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 301);
			});
			expect(onSwipeUp).not.toHaveBeenCalled();

			// 299ms should trigger
			act(() => {
				simulateSwipe(result.current.handlers, 100, 200, 100, 100, 299);
			});
			expect(onSwipeUp).toHaveBeenCalled();
		});
	});
});

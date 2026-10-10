/**
 * Tests for useSwipeGestures.ts (renderer port)
 *
 * The gesture mechanics are covered exhaustively for the legacy hook in
 * src/__tests__/web/hooks/useSwipeGestures.test.ts; this port is behavior-
 * identical (only the GESTURE_THRESHOLDS import moved to renderer touch.ts). So
 * these tests focus on:
 * - the port picking up the shared touch-primitive thresholds (default 50px)
 * - the gesture-to-drawer-state wiring App.tsx builds on top of the hook
 *   (edge swipe opens a drawer, backdrop swipe closes it)
 * - the disabled / below-threshold guards that keep accidental drags inert
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useSwipeGestures,
	type UseSwipeGesturesReturn,
} from '../../../../renderer/hooks/utils/useSwipeGestures';

function createTouchEvent(
	type: 'touchstart' | 'touchmove' | 'touchend',
	x: number,
	y: number
): React.TouchEvent {
	const touch = { clientX: x, clientY: y } as unknown as React.Touch;
	return {
		type,
		touches: type === 'touchend' ? [] : [touch],
		changedTouches: [touch],
		preventDefault: vi.fn(),
	} as unknown as React.TouchEvent;
}

/** Drive a full start -> move -> end swipe with a controlled duration. */
function simulateSwipe(
	handlers: UseSwipeGesturesReturn['handlers'],
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	duration = 100
) {
	const startTime = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(startTime);
	handlers.onTouchStart(createTouchEvent('touchstart', startX, startY));
	handlers.onTouchMove(createTouchEvent('touchmove', (startX + endX) / 2, (startY + endY) / 2));
	vi.spyOn(Date, 'now').mockReturnValue(startTime + duration);
	handlers.onTouchEnd(createTouchEvent('touchend', endX, endY));
	vi.restoreAllMocks();
}

describe('useSwipeGestures (renderer)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses the shared GESTURE_THRESHOLDS default of 50px', () => {
		const onSwipeLeft = vi.fn();
		const { result } = renderHook(() => useSwipeGestures({ onSwipeLeft }));

		// 40px is below the 50px default: no swipe.
		act(() => {
			simulateSwipe(result.current.handlers, 140, 100, 100, 100, 100);
		});
		expect(onSwipeLeft).not.toHaveBeenCalled();

		// 60px clears the default threshold.
		act(() => {
			simulateSwipe(result.current.handlers, 160, 100, 100, 100, 100);
		});
		expect(onSwipeLeft).toHaveBeenCalled();
	});

	it('preventDefaults a locked horizontal swipe (blocks native scroll in the zone)', () => {
		const { result } = renderHook(() => useSwipeGestures({ onSwipeRight: () => {} }));

		const start = createTouchEvent('touchstart', 5, 100);
		const move = createTouchEvent('touchmove', 60, 100);
		act(() => {
			result.current.handlers.onTouchStart(start);
			result.current.handlers.onTouchMove(move);
		});

		expect(move.preventDefault).toHaveBeenCalled();
	});

	describe('drawer gesture-to-state wiring (mirrors App.tsx)', () => {
		function makeDrawers() {
			const state = { leftOpen: false, rightOpen: false };
			return {
				state,
				setLeftSidebarOpen: (v: boolean) => {
					state.leftOpen = v;
				},
				setRightPanelOpen: (v: boolean) => {
					state.rightOpen = v;
				},
			};
		}

		it('rightward edge swipe opens the left drawer', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true) })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 5, 200, 130, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(true);
			expect(drawers.state.rightOpen).toBe(false);
		});

		it('leftward edge swipe opens the right drawer', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeLeft: () => drawers.setRightPanelOpen(true) })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 380, 200, 250, 200, 100);
			});

			expect(drawers.state.rightOpen).toBe(true);
			expect(drawers.state.leftOpen).toBe(false);
		});

		it('leftward backdrop swipe closes the open left drawer', () => {
			const drawers = makeDrawers();
			drawers.state.leftOpen = true;
			const { result } = renderHook(() =>
				useSwipeGestures({
					onSwipeLeft: () => drawers.setLeftSidebarOpen(false),
					onSwipeRight: () => drawers.setRightPanelOpen(false),
				})
			);

			act(() => {
				simulateSwipe(result.current.handlers, 200, 200, 80, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});

		it('rightward backdrop swipe closes the open right drawer', () => {
			const drawers = makeDrawers();
			drawers.state.rightOpen = true;
			const { result } = renderHook(() =>
				useSwipeGestures({
					onSwipeLeft: () => drawers.setLeftSidebarOpen(false),
					onSwipeRight: () => drawers.setRightPanelOpen(false),
				})
			);

			act(() => {
				simulateSwipe(result.current.handlers, 200, 200, 320, 200, 100);
			});

			expect(drawers.state.rightOpen).toBe(false);
		});

		it('does not open a drawer when disabled (non-narrow / desktop / mouse)', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true), enabled: false })
			);

			act(() => {
				simulateSwipe(result.current.handlers, 5, 200, 130, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});

		it('does not open a drawer on a below-threshold drag', () => {
			const drawers = makeDrawers();
			const { result } = renderHook(() =>
				useSwipeGestures({ onSwipeRight: () => drawers.setLeftSidebarOpen(true) })
			);

			act(() => {
				// 20px < 50px threshold.
				simulateSwipe(result.current.handlers, 5, 200, 25, 200, 100);
			});

			expect(drawers.state.leftOpen).toBe(false);
		});
	});
});

/**
 * Tests for useEdgeSwipeHandlers - drawer-opening swipes that only START at a
 * screen edge, composed onto the app shell in place of the invisible fixed
 * strips that used to swallow taps on the tab bar.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	EDGE_SWIPE_ZONE_PX,
	useEdgeSwipeHandlers,
	type TouchHandlers,
} from '../../../../renderer/hooks/utils/useEdgeSwipeHandlers';

function fakeHandlers(): TouchHandlers & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		onTouchStart: () => calls.push('start'),
		onTouchMove: () => calls.push('move'),
		onTouchEnd: () => calls.push('end'),
		onTouchCancel: () => calls.push('cancel'),
	};
}

function touchEvent(clientX: number, count = 1): React.TouchEvent {
	return {
		touches: Array.from({ length: count }, () => ({ clientX })),
	} as unknown as React.TouchEvent;
}

describe('useEdgeSwipeHandlers', () => {
	beforeEach(() => {
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
	});

	it('spreads nothing while disabled', () => {
		const { result } = renderHook(() =>
			useEdgeSwipeHandlers(fakeHandlers(), fakeHandlers(), false)
		);
		expect(result.current).toEqual({});
	});

	it('forwards a touch that starts at the left edge to the left gesture only', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(EDGE_SWIPE_ZONE_PX));
		h.onTouchMove(touchEvent(120));
		h.onTouchEnd(touchEvent(200));

		expect(left.calls).toEqual(['start', 'move', 'end']);
		expect(right.calls).toEqual([]);
	});

	it('forwards a touch that starts at the right edge to the right gesture only', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(390 - EDGE_SWIPE_ZONE_PX));
		h.onTouchMove(touchEvent(250));
		h.onTouchCancel(touchEvent(250));

		expect(right.calls).toEqual(['start', 'move', 'cancel']);
		expect(left.calls).toEqual([]);
	});

	it('never forwards a touch that starts away from the edges (a tap or a scroll)', () => {
		const left = fakeHandlers();
		const right = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, right, true));
		const h = result.current as TouchHandlers;

		h.onTouchStart(touchEvent(EDGE_SWIPE_ZONE_PX + 1));
		h.onTouchMove(touchEvent(300));
		h.onTouchEnd(touchEvent(300));
		h.onTouchStart(touchEvent(390 - EDGE_SWIPE_ZONE_PX - 1));
		h.onTouchEnd(touchEvent(10));

		expect(left.calls).toEqual([]);
		expect(right.calls).toEqual([]);
	});

	it('ignores multi-finger touches', () => {
		const left = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, fakeHandlers(), true));
		const h = result.current as TouchHandlers;
		h.onTouchStart(touchEvent(4, 2));
		h.onTouchEnd(touchEvent(200));
		expect(left.calls).toEqual([]);
	});

	it('disarms after the gesture ends so a later move is not forwarded', () => {
		const left = fakeHandlers();
		const { result } = renderHook(() => useEdgeSwipeHandlers(left, fakeHandlers(), true));
		const h = result.current as TouchHandlers;
		h.onTouchStart(touchEvent(2));
		h.onTouchEnd(touchEvent(200));
		h.onTouchMove(touchEvent(250));
		expect(left.calls).toEqual(['start', 'end']);
	});
});

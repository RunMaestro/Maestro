/**
 * useEdgeSwipeHandlers - drawer-opening swipes that only START at a screen edge.
 *
 * The phone drawers open on a swipe in from the left or right edge. This used
 * to be done with two invisible `position: fixed` strips pinned to the edges,
 * each carrying a `useSwipeGestures` handler set. A strip is a real element in
 * the hit-test order, so it also swallowed every TAP in the outer 24px: the tab
 * bar's magnifier and the first chip sat under the left strip and could not be
 * pressed (`elementFromPoint` returned the strip). The strips also needed a
 * `top` that guessed the header height to stay off the hamburger.
 *
 * This composes the same two handler sets into ONE set for the app shell,
 * gated on where the touch begins. A touch that starts away from the edges is
 * never forwarded, so nothing changes for a tap or a scroll anywhere in the
 * app; a touch that starts at an edge is handed to that edge's gesture and
 * followed until it ends. No element, no hit-testing, nothing to keep clear of.
 */

import { useMemo, useRef } from 'react';
import type { UseSwipeGesturesReturn } from './useSwipeGestures';

/** Width of the strip along each screen edge where a drawer swipe may begin. */
export const EDGE_SWIPE_ZONE_PX = 24;

export type TouchHandlers = UseSwipeGesturesReturn['handlers'];

/**
 * @param left     Handlers of the `useSwipeGestures` that opens the LEFT drawer (onSwipeRight).
 * @param right    Handlers of the `useSwipeGestures` that opens the RIGHT drawer (onSwipeLeft).
 * @param enabled  False returns an empty object, so the host spreads nothing.
 */
export function useEdgeSwipeHandlers(
	left: TouchHandlers,
	right: TouchHandlers,
	enabled: boolean
): Partial<TouchHandlers> {
	const armedRef = useRef<'left' | 'right' | null>(null);

	return useMemo(() => {
		if (!enabled) return {};
		return {
			onTouchStart: (e: React.TouchEvent) => {
				armedRef.current = null;
				if (e.touches.length !== 1) return;
				const touch = e.touches[0];
				if (touch.clientX <= EDGE_SWIPE_ZONE_PX) {
					armedRef.current = 'left';
					left.onTouchStart(e);
				} else if (touch.clientX >= window.innerWidth - EDGE_SWIPE_ZONE_PX) {
					armedRef.current = 'right';
					right.onTouchStart(e);
				}
			},
			onTouchMove: (e: React.TouchEvent) => {
				if (armedRef.current === 'left') left.onTouchMove(e);
				else if (armedRef.current === 'right') right.onTouchMove(e);
			},
			onTouchEnd: (e: React.TouchEvent) => {
				const armed = armedRef.current;
				armedRef.current = null;
				if (armed === 'left') left.onTouchEnd(e);
				else if (armed === 'right') right.onTouchEnd(e);
			},
			onTouchCancel: (e: React.TouchEvent) => {
				const armed = armedRef.current;
				armedRef.current = null;
				if (armed === 'left') left.onTouchCancel(e);
				else if (armed === 'right') right.onTouchCancel(e);
			},
		};
	}, [enabled, left, right]);
}

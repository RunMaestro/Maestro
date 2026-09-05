/**
 * useLayerSwipeDismiss - swipe down from the top of the screen to close the
 * topmost modal layer, on a phone.
 *
 * Every modal has a keyboard exit (Escape, via the layer stack) and is supposed
 * to have a graphical one (EscCloseButton / the Modal X). On a phone the first
 * does not exist and the second has failed in practice - a header that overflows
 * a 390px screen pushes its close button off the right edge, and the user's
 * only way out was to reload the page. This is the safety net: the gesture a
 * phone user reaches for anyway, wired to the same `closeTopLayer` Escape uses,
 * so dirty-state confirmation and nested layers behave exactly as they do for
 * the key.
 *
 * It is deliberately conservative so it cannot fire by accident:
 *
 *   - Only on the web-desktop bundle with a coarse pointer. A mouse never
 *     produces touch events, and the Electron app has an Escape key.
 *   - Only while a layer is open. With nothing to close there is nothing to do.
 *   - The gesture must START in the top band of the viewport (25%), where a
 *     full-screen modal's header lives. A swipe that starts lower is scrolling.
 *   - Not from a form control, and not from inside a region that is already
 *     scrolled down: pulling a list back toward its top is a scroll, and iOS
 *     sheets follow the same rule. A surface that pans on drag (a canvas, a
 *     graph) opts out with `data-no-swipe-dismiss` on its root.
 *   - It must be a swipe, not a drift: at least 80px down, mostly vertical,
 *     within half a second.
 */

import { useEffect } from 'react';
import { isCoarsePointer } from '../../utils/touch';
import { isWebDesktop } from '../../utils/runtimeContext';

export const LAYER_SWIPE_DISMISS = {
	/** Fraction of the viewport height, from the top, where a dismissing swipe may start. */
	startBandFraction: 0.25,
	/** Minimum downward travel, in px. */
	minDistance: 80,
	/** Horizontal travel allowed, as a fraction of the vertical travel. */
	maxHorizontalRatio: 0.6,
	/** Longest gesture that still counts as a swipe, in ms. */
	maxDurationMs: 500,
} as const;

/** Elements a dismissing swipe never starts from. */
export const LAYER_SWIPE_DISMISS_IGNORED_SELECTOR =
	'input, textarea, select, [contenteditable="true"], [data-no-swipe-dismiss]';

export interface LayerSwipeDismissApi {
	/** Whether any layer is open right now. */
	hasTopLayer: () => boolean;
	/** Close the topmost layer the way Escape would. */
	closeTopLayer: () => unknown;
}

/**
 * True when some ancestor of `target` (up to, not including, the body) has been
 * scrolled down. A downward swipe there is the user scrolling back up.
 */
export function startsInsideScrolledRegion(target: Element | null): boolean {
	for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
		if (el.scrollTop > 0) return true;
	}
	return false;
}

/**
 * @param api      Stable object (memoize it) exposing the layer stack.
 * @param enabled  Override the runtime gate; defaults to web-desktop + coarse pointer.
 */
export function useLayerSwipeDismiss(api: LayerSwipeDismissApi, enabled?: boolean): void {
	useEffect(() => {
		if (typeof window === 'undefined') return;

		let start: { x: number; y: number; at: number } | null = null;

		const onTouchStart = (e: TouchEvent) => {
			start = null;
			const active = enabled ?? (isWebDesktop() && isCoarsePointer());
			if (!active || !api.hasTopLayer()) return;
			if (e.touches.length !== 1) return;
			const touch = e.touches[0];
			if (touch.clientY > window.innerHeight * LAYER_SWIPE_DISMISS.startBandFraction) return;
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(LAYER_SWIPE_DISMISS_IGNORED_SELECTOR)) return;
			if (startsInsideScrolledRegion(target)) return;
			start = { x: touch.clientX, y: touch.clientY, at: Date.now() };
		};

		const onTouchEnd = (e: TouchEvent) => {
			if (!start) return;
			const from = start;
			start = null;
			const touch = e.changedTouches[0];
			if (!touch) return;
			if (Date.now() - from.at > LAYER_SWIPE_DISMISS.maxDurationMs) return;
			const dx = touch.clientX - from.x;
			const dy = touch.clientY - from.y;
			if (dy < LAYER_SWIPE_DISMISS.minDistance) return;
			if (Math.abs(dx) > dy * LAYER_SWIPE_DISMISS.maxHorizontalRatio) return;
			// Re-check: the layer may have closed itself during the gesture.
			if (!api.hasTopLayer()) return;
			void api.closeTopLayer();
		};

		const onTouchCancel = () => {
			start = null;
		};

		window.addEventListener('touchstart', onTouchStart, { passive: true });
		window.addEventListener('touchend', onTouchEnd, { passive: true });
		window.addEventListener('touchcancel', onTouchCancel, { passive: true });
		return () => {
			window.removeEventListener('touchstart', onTouchStart);
			window.removeEventListener('touchend', onTouchEnd);
			window.removeEventListener('touchcancel', onTouchCancel);
		};
	}, [api, enabled]);
}

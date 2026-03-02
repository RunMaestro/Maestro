/**
 * useLongPress - Generic long-press gesture hook for mobile touch interactions
 *
 * Provides long-press detection with scroll awareness, suitable for any
 * touchable element that needs to differentiate tap, scroll, and long-press.
 *
 * Used by SessionPill (session info popover) and Tab (tab actions popover).
 */

import { useRef, useCallback, useEffect } from 'react';
import { triggerHaptic, HAPTIC_PATTERNS } from '../mobile/constants';

/** Duration in ms to trigger long-press */
const LONG_PRESS_DURATION = 500;

/** Minimum touch movement (in pixels) to cancel tap and consider it a scroll */
const SCROLL_THRESHOLD = 10;

export interface UseLongPressOptions {
	/** Callback fired on long-press with the element's bounding rect */
	onLongPress: (rect: DOMRect) => void;
	/** Callback fired on normal tap (short press without scroll) */
	onTap?: () => void;
}

export interface UseLongPressReturn {
	/** Ref to attach to the pressable element */
	elementRef: React.RefObject<HTMLElement | null>;
	/** Touch event handlers to spread onto the element */
	handlers: {
		onTouchStart: (e: React.TouchEvent) => void;
		onTouchMove: (e: React.TouchEvent) => void;
		onTouchEnd: () => void;
		onTouchCancel: () => void;
	};
	/** onClick handler that guards against long-press and scroll (for non-touch devices, fires onTap) */
	handleClick: () => void;
	/** onContextMenu handler that triggers long-press on right-click (desktop) */
	handleContextMenu: (e: React.MouseEvent) => void;
}

export function useLongPress({ onLongPress, onTap }: UseLongPressOptions): UseLongPressReturn {
	const elementRef = useRef<HTMLElement | null>(null);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isLongPressTriggeredRef = useRef(false);
	const touchStartRef = useRef<{ x: number; y: number } | null>(null);
	const isScrollingRef = useRef(false);

	const clearTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	const startTimer = useCallback(() => {
		isLongPressTriggeredRef.current = false;
		longPressTimerRef.current = setTimeout(() => {
			if (!isScrollingRef.current) {
				isLongPressTriggeredRef.current = true;
				triggerHaptic(HAPTIC_PATTERNS.success);
				if (elementRef.current) {
					onLongPress(elementRef.current.getBoundingClientRect());
				}
			}
		}, LONG_PRESS_DURATION);
	}, [onLongPress]);

	const onTouchStart = useCallback(
		(e: React.TouchEvent) => {
			const touch = e.touches[0];
			touchStartRef.current = { x: touch.clientX, y: touch.clientY };
			isScrollingRef.current = false;
			startTimer();
		},
		[startTimer]
	);

	const onTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!touchStartRef.current) return;
			const touch = e.touches[0];
			const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
			const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);
			if (deltaX > SCROLL_THRESHOLD || deltaY > SCROLL_THRESHOLD) {
				isScrollingRef.current = true;
				clearTimer();
			}
		},
		[clearTimer]
	);

	const onTouchEnd = useCallback(() => {
		clearTimer();
		if (!isScrollingRef.current && !isLongPressTriggeredRef.current) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onTap?.();
		}
		touchStartRef.current = null;
		isScrollingRef.current = false;
		isLongPressTriggeredRef.current = false;
	}, [clearTimer, onTap]);

	const onTouchCancel = useCallback(() => {
		clearTimer();
		touchStartRef.current = null;
		isScrollingRef.current = false;
		isLongPressTriggeredRef.current = false;
	}, [clearTimer]);

	const handleClick = useCallback(() => {
		// For non-touch devices only
		if (!('ontouchstart' in window)) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onTap?.();
		}
	}, [onTap]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			if (elementRef.current) {
				onLongPress(elementRef.current.getBoundingClientRect());
			}
		},
		[onLongPress]
	);

	useEffect(() => {
		return () => clearTimer();
	}, [clearTimer]);

	return {
		elementRef,
		handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
		handleClick,
		handleContextMenu,
	};
}

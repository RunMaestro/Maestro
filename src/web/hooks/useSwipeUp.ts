/**
 * useSwipeUp hook for Maestro mobile web interface
 *
 * Detects upward swipe gestures for triggering actions like opening drawers.
 * Used primarily for the command history drawer swipe-up interaction.
 */

import { useCallback, useRef } from 'react';
// Import from constants directly to avoid circular dependency with mobile/index.tsx
import { GESTURE_THRESHOLDS } from '../mobile/constants';

export interface UseSwipeUpOptions {
	/** Called when swipe up is detected */
	onSwipeUp: () => void;
	/** Minimum distance to trigger swipe (default: 50px) */
	threshold?: number;
	/** Maximum time for swipe gesture (default: 300ms) */
	maxTime?: number;
	/** Whether swipe detection is enabled (default: true) */
	enabled?: boolean;
}

export interface UseSwipeUpReturn {
	/** Props to spread on the target element */
	handlers: {
		onTouchStart: (e: React.TouchEvent) => void;
		onTouchMove: (e: React.TouchEvent) => void;
		onTouchEnd: (e: React.TouchEvent) => void;
	};
}

/**
 * Custom hook for detecting upward swipe gestures
 *
 * @example
 * ```tsx
 * function InputBar() {
 *   const { handlers } = useSwipeUp({
 *     onSwipeUp: () => setHistoryOpen(true),
 *   });
 *
 *   return (
 *     <div {...handlers}>
 *       <input />
 *     </div>
 *   );
 * }
 * ```
 */
export function useSwipeUp(options: UseSwipeUpOptions): UseSwipeUpReturn {
	const {
		onSwipeUp,
		threshold = GESTURE_THRESHOLDS.swipeDistance,
		maxTime = GESTURE_THRESHOLDS.swipeTime,
		enabled = true,
	} = options;

	// Track touch state
	const touchStartY = useRef<number>(0);
	const touchStartX = useRef<number>(0);
	const touchStartTime = useRef<number>(0);
	const isTracking = useRef<boolean>(false);

	/**
	 * Handle touch start
	 */
	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled) return;

			const touch = e.touches[0];
			touchStartY.current = touch.clientY;
			touchStartX.current = touch.clientX;
			touchStartTime.current = Date.now();
			isTracking.current = true;
		},
		[enabled]
	);

	/**
	 * Handle touch move - track if we should continue detecting
	 */
	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || !isTracking.current) return;

			const touch = e.touches[0];
			const deltaX = Math.abs(touch.clientX - touchStartX.current);
			const deltaY = touchStartY.current - touch.clientY; // Positive = up

			// Cancel tracking if horizontal movement exceeds vertical (scrolling)
			if (deltaX > Math.abs(deltaY)) {
				isTracking.current = false;
			}
		},
		[enabled]
	);

	/**
	 * Handle touch end - check if swipe up criteria met
	 */
	const handleTouchEnd = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || !isTracking.current) {
				isTracking.current = false;
				return;
			}

			isTracking.current = false;

			const touch = e.changedTouches[0];
			const deltaY = touchStartY.current - touch.clientY; // Positive = up
			const deltaX = Math.abs(touch.clientX - touchStartX.current);
			const duration = Date.now() - touchStartTime.current;

			// Check if this is a valid swipe up:
			// 1. Moved up more than threshold
			// 2. Completed within max time
			// 3. More vertical than horizontal
			if (deltaY > threshold && duration < maxTime && deltaY > deltaX) {
				onSwipeUp();
			}
		},
		[enabled, threshold, maxTime, onSwipeUp]
	);

	return {
		handlers: {
			onTouchStart: handleTouchStart,
			onTouchMove: handleTouchMove,
			onTouchEnd: handleTouchEnd,
		},
	};
}

export default useSwipeUp;

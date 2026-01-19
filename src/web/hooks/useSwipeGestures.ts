/**
 * useSwipeGestures hook for Maestro mobile web interface
 *
 * A comprehensive swipe gesture detection hook that supports
 * horizontal and vertical swipe gestures with configurable thresholds.
 *
 * Common actions:
 * - Swipe left: Delete item, dismiss action
 * - Swipe right: Archive, mark as read, reveal actions
 * - Swipe up: Open drawer, show more options
 * - Swipe down: Dismiss modal, close panel
 *
 * Features:
 * - Detects swipe direction (left, right, up, down)
 * - Configurable distance and velocity thresholds
 * - Support for revealing action buttons (like iOS swipe-to-delete)
 * - Visual offset tracking for animations
 * - Haptic feedback triggers
 */

import { useCallback, useRef, useState } from 'react';
// Import from constants directly to avoid circular dependency with mobile/index.tsx
import { GESTURE_THRESHOLDS } from '../mobile/constants';

/**
 * Swipe direction enum
 */
export type SwipeDirection = 'left' | 'right' | 'up' | 'down' | null;

/**
 * Configuration options for swipe gesture detection
 */
export interface UseSwipeGesturesOptions {
	/** Callback when swipe left is detected */
	onSwipeLeft?: () => void;
	/** Callback when swipe right is detected */
	onSwipeRight?: () => void;
	/** Callback when swipe up is detected */
	onSwipeUp?: () => void;
	/** Callback when swipe down is detected */
	onSwipeDown?: () => void;
	/** Minimum distance to trigger swipe (default: 50px) */
	threshold?: number;
	/** Maximum time for swipe gesture in ms (default: 300ms) */
	maxTime?: number;
	/** Whether swipe detection is enabled (default: true) */
	enabled?: boolean;
	/** Whether to track offset for animations (enables drag feedback) */
	trackOffset?: boolean;
	/** Maximum offset when tracking (default: 100px) - for elastic effect */
	maxOffset?: number;
	/** Horizontal resistance factor when dragging (0-1, lower = more resistance) */
	resistanceFactor?: number;
	/** Velocity threshold for quick flick gestures (px/ms) */
	velocityThreshold?: number;
	/** Lock to a single direction once determined */
	lockDirection?: boolean;
}

/**
 * Return type for useSwipeGestures hook
 */
export interface UseSwipeGesturesReturn {
	/** Props to spread on the target element */
	handlers: {
		onTouchStart: (e: React.TouchEvent) => void;
		onTouchMove: (e: React.TouchEvent) => void;
		onTouchEnd: (e: React.TouchEvent) => void;
		onTouchCancel: (e: React.TouchEvent) => void;
	};
	/** Current horizontal swipe offset in pixels (for animations) */
	offsetX: number;
	/** Current vertical swipe offset in pixels (for animations) */
	offsetY: number;
	/** Whether currently swiping */
	isSwiping: boolean;
	/** Current detected swipe direction (during gesture) */
	swipeDirection: SwipeDirection;
	/** Reset the offset state (useful after action completes) */
	resetOffset: () => void;
}

/**
 * Custom hook for detecting multi-directional swipe gestures
 *
 * @example
 * ```tsx
 * // Basic swipe detection
 * function SwipeableItem({ onDelete }) {
 *   const { handlers, offsetX } = useSwipeGestures({
 *     onSwipeLeft: () => onDelete(),
 *     threshold: 80,
 *   });
 *
 *   return (
 *     <div
 *       {...handlers}
 *       style={{ transform: `translateX(${offsetX}px)` }}
 *     >
 *       Item content
 *     </div>
 *   );
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Swipe with action reveal
 * function SwipeToDeleteItem({ item, onDelete }) {
 *   const { handlers, offsetX, isSwiping, resetOffset } = useSwipeGestures({
 *     onSwipeLeft: () => {
 *       onDelete(item.id);
 *       resetOffset();
 *     },
 *     trackOffset: true,
 *     maxOffset: 100,
 *   });
 *
 *   const showDeleteButton = offsetX < -50;
 *
 *   return (
 *     <div style={{ position: 'relative', overflow: 'hidden' }}>
 *       {showDeleteButton && (
 *         <div style={{ position: 'absolute', right: 0 }}>Delete</div>
 *       )}
 *       <div
 *         {...handlers}
 *         style={{
 *           transform: `translateX(${offsetX}px)`,
 *           transition: isSwiping ? 'none' : 'transform 0.3s ease',
 *         }}
 *       >
 *         {item.content}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useSwipeGestures(options: UseSwipeGesturesOptions = {}): UseSwipeGesturesReturn {
	const {
		onSwipeLeft,
		onSwipeRight,
		onSwipeUp,
		onSwipeDown,
		threshold = GESTURE_THRESHOLDS.swipeDistance,
		maxTime = GESTURE_THRESHOLDS.swipeTime,
		enabled = true,
		trackOffset = false,
		maxOffset = 100,
		resistanceFactor = 0.5,
		velocityThreshold = 0.5,
		lockDirection = true,
	} = options;

	// Touch state tracking
	const touchStartX = useRef<number>(0);
	const touchStartY = useRef<number>(0);
	const touchStartTime = useRef<number>(0);
	const isTracking = useRef<boolean>(false);
	const lockedDirection = useRef<'horizontal' | 'vertical' | null>(null);

	// Visual feedback state
	const [offsetX, setOffsetX] = useState(0);
	const [offsetY, setOffsetY] = useState(0);
	const [isSwiping, setIsSwiping] = useState(false);
	const [swipeDirection, setSwipeDirection] = useState<SwipeDirection>(null);

	/**
	 * Reset offset state
	 */
	const resetOffset = useCallback(() => {
		setOffsetX(0);
		setOffsetY(0);
		setIsSwiping(false);
		setSwipeDirection(null);
		lockedDirection.current = null;
	}, []);

	/**
	 * Apply resistance to offset (diminishing returns as you drag further)
	 */
	const applyResistance = useCallback(
		(delta: number, max: number): number => {
			const sign = delta >= 0 ? 1 : -1;
			const absDelta = Math.abs(delta);
			// Apply resistance using asymptotic curve
			const resisted = max * (1 - Math.exp((-absDelta * resistanceFactor) / max));
			return sign * Math.min(resisted, max);
		},
		[resistanceFactor]
	);

	/**
	 * Handle touch start
	 */
	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled) return;

			const touch = e.touches[0];
			touchStartX.current = touch.clientX;
			touchStartY.current = touch.clientY;
			touchStartTime.current = Date.now();
			isTracking.current = true;
			lockedDirection.current = null;
			setIsSwiping(true);
			setSwipeDirection(null);
		},
		[enabled]
	);

	/**
	 * Handle touch move - track movement and update offset
	 */
	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || !isTracking.current) return;

			const touch = e.touches[0];
			const deltaX = touch.clientX - touchStartX.current;
			const deltaY = touch.clientY - touchStartY.current;
			const absDeltaX = Math.abs(deltaX);
			const absDeltaY = Math.abs(deltaY);

			// Determine and lock direction if not already locked
			if (lockDirection && !lockedDirection.current && (absDeltaX > 10 || absDeltaY > 10)) {
				lockedDirection.current = absDeltaX > absDeltaY ? 'horizontal' : 'vertical';
			}

			// Determine current swipe direction
			let currentDirection: SwipeDirection = null;
			if (absDeltaX > absDeltaY) {
				currentDirection = deltaX < 0 ? 'left' : 'right';
			} else {
				currentDirection = deltaY < 0 ? 'up' : 'down';
			}
			setSwipeDirection(currentDirection);

			// Update offsets if tracking is enabled
			if (trackOffset) {
				// Apply direction lock if enabled
				if (lockDirection && lockedDirection.current === 'horizontal') {
					// Only allow left swipe if handler exists, otherwise allow right
					const allowLeft = onSwipeLeft !== undefined;
					const allowRight = onSwipeRight !== undefined;

					let adjustedX = deltaX;
					if (deltaX < 0 && !allowLeft) {
						adjustedX = 0;
					} else if (deltaX > 0 && !allowRight) {
						adjustedX = 0;
					}

					setOffsetX(applyResistance(adjustedX, maxOffset));
					setOffsetY(0);
				} else if (lockDirection && lockedDirection.current === 'vertical') {
					const allowUp = onSwipeUp !== undefined;
					const allowDown = onSwipeDown !== undefined;

					let adjustedY = deltaY;
					if (deltaY < 0 && !allowUp) {
						adjustedY = 0;
					} else if (deltaY > 0 && !allowDown) {
						adjustedY = 0;
					}

					setOffsetX(0);
					setOffsetY(applyResistance(adjustedY, maxOffset));
				} else if (!lockDirection) {
					setOffsetX(applyResistance(deltaX, maxOffset));
					setOffsetY(applyResistance(deltaY, maxOffset));
				}
			}

			// Prevent scrolling if we've locked to horizontal swipe
			if (lockDirection && lockedDirection.current === 'horizontal' && absDeltaX > 10) {
				e.preventDefault();
			}
		},
		[
			enabled,
			trackOffset,
			maxOffset,
			applyResistance,
			lockDirection,
			onSwipeLeft,
			onSwipeRight,
			onSwipeUp,
			onSwipeDown,
		]
	);

	/**
	 * Handle touch end - determine if swipe criteria met
	 */
	const handleTouchEnd = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || !isTracking.current) {
				resetOffset();
				return;
			}

			isTracking.current = false;

			const touch = e.changedTouches[0];
			const deltaX = touch.clientX - touchStartX.current;
			const deltaY = touch.clientY - touchStartY.current;
			const absDeltaX = Math.abs(deltaX);
			const absDeltaY = Math.abs(deltaY);
			const duration = Date.now() - touchStartTime.current;

			// Calculate velocity (px/ms)
			const velocityX = absDeltaX / duration;
			const velocityY = absDeltaY / duration;

			// Check for valid swipe gesture
			const isQuickSwipe = duration < maxTime;
			const isHighVelocity = Math.max(velocityX, velocityY) > velocityThreshold;
			const meetsThreshold = absDeltaX > threshold || absDeltaY > threshold;

			// Only trigger if it's a quick swipe or high velocity, and meets threshold
			if ((isQuickSwipe || isHighVelocity) && meetsThreshold) {
				// Determine direction and trigger callback
				if (absDeltaX > absDeltaY) {
					// Horizontal swipe
					if (deltaX < 0 && onSwipeLeft) {
						onSwipeLeft();
					} else if (deltaX > 0 && onSwipeRight) {
						onSwipeRight();
					}
				} else {
					// Vertical swipe
					if (deltaY < 0 && onSwipeUp) {
						onSwipeUp();
					} else if (deltaY > 0 && onSwipeDown) {
						onSwipeDown();
					}
				}
			}

			// Reset offset state (with animation via CSS transition)
			setIsSwiping(false);
			setSwipeDirection(null);

			// Don't reset offset immediately if trackOffset is enabled
			// This allows the consumer to animate back or take action first
			if (!trackOffset) {
				setOffsetX(0);
				setOffsetY(0);
			} else {
				// Auto-reset after a short delay if no action taken
				setTimeout(() => {
					setOffsetX(0);
					setOffsetY(0);
				}, 50);
			}

			lockedDirection.current = null;
		},
		[
			enabled,
			threshold,
			maxTime,
			velocityThreshold,
			onSwipeLeft,
			onSwipeRight,
			onSwipeUp,
			onSwipeDown,
			trackOffset,
			resetOffset,
		]
	);

	/**
	 * Handle touch cancel
	 */
	const handleTouchCancel = useCallback(() => {
		resetOffset();
		isTracking.current = false;
	}, [resetOffset]);

	return {
		handlers: {
			onTouchStart: handleTouchStart,
			onTouchMove: handleTouchMove,
			onTouchEnd: handleTouchEnd,
			onTouchCancel: handleTouchCancel,
		},
		offsetX,
		offsetY,
		isSwiping,
		swipeDirection,
		resetOffset,
	};
}

export default useSwipeGestures;

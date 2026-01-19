/**
 * usePullToRefresh hook for Maestro mobile web interface
 *
 * Provides touch gesture handling for pull-to-refresh functionality.
 * Tracks touch events and determines when to trigger a refresh.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
// Import from constants directly to avoid circular dependency with mobile/index.tsx
import { GESTURE_THRESHOLDS } from '../mobile/constants';
import { webLogger } from '../utils/logger';

export interface UsePullToRefreshOptions {
	/** Called when pull-to-refresh is triggered */
	onRefresh: () => Promise<void> | void;
	/** Distance in pixels required to trigger refresh (default: 80) */
	threshold?: number;
	/** Maximum distance the pull indicator can travel (default: 150) */
	maxPull?: number;
	/** Whether pull-to-refresh is enabled (default: true) */
	enabled?: boolean;
	/** Element ref to attach handlers to (uses document if not provided) */
	containerRef?: React.RefObject<HTMLElement>;
}

export interface UsePullToRefreshReturn {
	/** Current pull distance in pixels */
	pullDistance: number;
	/** Whether the threshold has been reached */
	isThresholdReached: boolean;
	/** Whether currently refreshing */
	isRefreshing: boolean;
	/** Progress from 0 to 1 (1 = threshold reached) */
	progress: number;
	/** Props to spread on the scrollable container */
	containerProps: {
		onTouchStart: (e: React.TouchEvent) => void;
		onTouchMove: (e: React.TouchEvent) => void;
		onTouchEnd: (e: React.TouchEvent) => void;
	};
}

/**
 * Custom hook for implementing pull-to-refresh gesture
 *
 * @example
 * ```tsx
 * function SessionList() {
 *   const { refreshSessions } = useSessions();
 *   const {
 *     pullDistance,
 *     isRefreshing,
 *     progress,
 *     containerProps
 *   } = usePullToRefresh({
 *     onRefresh: refreshSessions,
 *   });
 *
 *   return (
 *     <div {...containerProps} style={{ overflowY: 'auto' }}>
 *       <PullIndicator distance={pullDistance} progress={progress} isRefreshing={isRefreshing} />
 *       {sessions.map(session => <SessionCard key={session.id} />)}
 *     </div>
 *   );
 * }
 * ```
 */
export function usePullToRefresh(options: UsePullToRefreshOptions): UsePullToRefreshReturn {
	const {
		onRefresh,
		threshold = GESTURE_THRESHOLDS.pullToRefresh,
		maxPull = 150,
		enabled = true,
		containerRef,
	} = options;

	const [pullDistance, setPullDistance] = useState(0);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Refs to track touch state
	const touchStartY = useRef<number>(0);
	const touchStartX = useRef<number>(0);
	const isPulling = useRef<boolean>(false);
	const isScrolledToTop = useRef<boolean>(true);

	// Callback refs to avoid stale closures
	const onRefreshRef = useRef(onRefresh);
	useEffect(() => {
		onRefreshRef.current = onRefresh;
	}, [onRefresh]);

	/**
	 * Check if the container is scrolled to the top
	 */
	const checkScrollTop = useCallback((element: HTMLElement | null): boolean => {
		if (!element) return true;
		return element.scrollTop <= 0;
	}, []);

	/**
	 * Handle touch start
	 */
	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || isRefreshing) return;

			const touch = e.touches[0];
			touchStartY.current = touch.clientY;
			touchStartX.current = touch.clientX;

			// Check if we're at the top of the scroll container
			const target = containerRef?.current ?? (e.currentTarget as HTMLElement);
			isScrolledToTop.current = checkScrollTop(target);
		},
		[enabled, isRefreshing, checkScrollTop, containerRef]
	);

	/**
	 * Handle touch move
	 */
	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!enabled || isRefreshing) return;

			const touch = e.touches[0];
			const deltaY = touch.clientY - touchStartY.current;
			const deltaX = touch.clientX - touchStartX.current;

			// Only trigger pull-to-refresh if:
			// 1. We're at the top of the scroll container
			// 2. We're pulling down (deltaY > 0)
			// 3. The movement is more vertical than horizontal
			if (isScrolledToTop.current && deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX)) {
				// Mark as pulling
				isPulling.current = true;

				// Calculate pull distance with resistance (diminishing returns)
				const resistance = 0.5;
				const adjustedDelta = Math.min(deltaY * resistance, maxPull);
				setPullDistance(adjustedDelta);

				// Prevent default scroll behavior while pulling
				if (adjustedDelta > 10) {
					e.preventDefault();
				}
			}
		},
		[enabled, isRefreshing, maxPull]
	);

	/**
	 * Handle touch end
	 */
	const handleTouchEnd = useCallback(
		async (_e: React.TouchEvent) => {
			if (!enabled || isRefreshing || !isPulling.current) {
				isPulling.current = false;
				return;
			}

			isPulling.current = false;

			if (pullDistance >= threshold) {
				// Threshold reached - trigger refresh
				setIsRefreshing(true);

				try {
					await onRefreshRef.current();
				} catch (error) {
					webLogger.error('Refresh error', 'PullToRefresh', error);
				} finally {
					setIsRefreshing(false);
					setPullDistance(0);
				}
			} else {
				// Threshold not reached - animate back to 0
				setPullDistance(0);
			}
		},
		[enabled, isRefreshing, pullDistance, threshold]
	);

	// Calculate progress (0 to 1)
	const progress = Math.min(pullDistance / threshold, 1);
	const isThresholdReached = pullDistance >= threshold;

	return {
		pullDistance,
		isThresholdReached,
		isRefreshing,
		progress,
		containerProps: {
			onTouchStart: handleTouchStart,
			onTouchMove: handleTouchMove,
			onTouchEnd: handleTouchEnd,
		},
	};
}

export default usePullToRefresh;

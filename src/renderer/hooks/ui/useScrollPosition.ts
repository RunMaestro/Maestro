/**
 * useScrollPosition - Reusable hook for scroll position management
 *
 * This hook encapsulates common scroll position patterns found across
 * many components: "at bottom" detection, scroll position tracking,
 * first visible item detection, and scroll navigation helpers.
 *
 * Usage:
 * ```tsx
 * // Basic "at bottom" detection
 * const { isAtBottom, handleScroll } = useScrollPosition({
 *   containerRef,
 *   bottomThreshold: 50,
 * });
 *
 * // With position tracking (save/restore)
 * const { scrollTop, handleScroll, scrollTo } = useScrollPosition({
 *   containerRef,
 *   onScrollPositionChange: (pos) => savePosition(id, pos),
 * });
 *
 * // With at-bottom change callback (for unread indicators)
 * const { isAtBottom, handleScroll } = useScrollPosition({
 *   containerRef,
 *   bottomThreshold: 50,
 *   onAtBottomChange: (atBottom) => {
 *     if (atBottom) clearUnread();
 *   },
 * });
 *
 * // Full-featured with all tracking
 * const {
 *   scrollTop,
 *   isAtBottom,
 *   scrollProgress,
 *   handleScroll,
 *   scrollTo,
 *   scrollToTop,
 *   scrollToBottom,
 *   scrollByPage,
 * } = useScrollPosition({
 *   containerRef,
 *   bottomThreshold: 50,
 *   throttleMs: 4,
 *   onAtBottomChange,
 *   onScrollPositionChange,
 * });
 * ```
 */

import { useState, useCallback, useRef } from 'react';
import { useThrottledCallback } from '../utils';

export interface UseScrollPositionOptions {
	/**
	 * Ref to the scrollable container element
	 */
	containerRef: React.RefObject<HTMLElement>;

	/**
	 * Threshold in pixels from bottom to consider "at bottom" (default: 50)
	 */
	bottomThreshold?: number;

	/**
	 * Milliseconds to throttle scroll handler (default: 4, ~240fps for smooth scrollbar)
	 * Set to 0 to disable throttling
	 */
	throttleMs?: number;

	/**
	 * Callback invoked when the "at bottom" state changes
	 */
	onAtBottomChange?: (isAtBottom: boolean) => void;

	/**
	 * Callback invoked with scroll position (throttled separately from main handler)
	 * Useful for saving scroll position to storage
	 */
	onScrollPositionChange?: (scrollTop: number) => void;

	/**
	 * Throttle delay for scroll position change callback (default: 200ms)
	 * Higher values reduce storage writes but may lose position on quick unmounts
	 */
	positionChangeThrottleMs?: number;

	/**
	 * Whether to track scroll progress as a percentage (default: false)
	 * Set to true if you need scrollProgress value
	 */
	trackProgress?: boolean;

	/**
	 * Initial value for isAtBottom (default: true)
	 */
	initialAtBottom?: boolean;
}

export interface UseScrollPositionReturn {
	/**
	 * Current scroll position from the top in pixels
	 */
	scrollTop: number;

	/**
	 * Whether the scroll position is at or near the bottom
	 */
	isAtBottom: boolean;

	/**
	 * Scroll progress as a percentage (0-100)
	 * Only calculated when trackProgress option is true
	 */
	scrollProgress: number;

	/**
	 * The scroll handler to attach to the container's onScroll event
	 */
	handleScroll: () => void;

	/**
	 * Scroll to a specific position
	 * @param top - Target scroll position in pixels
	 * @param behavior - 'smooth' or 'auto' (default: 'smooth')
	 */
	scrollTo: (top: number, behavior?: ScrollBehavior) => void;

	/**
	 * Scroll to the top of the container
	 * @param behavior - 'smooth' or 'auto' (default: 'smooth')
	 */
	scrollToTop: (behavior?: ScrollBehavior) => void;

	/**
	 * Scroll to the bottom of the container
	 * @param behavior - 'smooth' or 'auto' (default: 'smooth')
	 */
	scrollToBottom: (behavior?: ScrollBehavior) => void;

	/**
	 * Scroll by a fraction of the viewport height (for page up/down)
	 * @param direction - 'up' or 'down'
	 * @param fraction - Fraction of viewport to scroll (default: 0.8)
	 * @param behavior - 'smooth' or 'auto' (default: 'smooth')
	 */
	scrollByPage: (direction: 'up' | 'down', fraction?: number, behavior?: ScrollBehavior) => void;

	/**
	 * Scroll by a fixed number of pixels
	 * @param pixels - Number of pixels to scroll (positive = down, negative = up)
	 * @param behavior - 'smooth' or 'auto' (default: 'smooth')
	 */
	scrollBy: (pixels: number, behavior?: ScrollBehavior) => void;

	/**
	 * Get current scroll metrics without triggering state updates
	 * Useful for imperative checks in callbacks
	 */
	getScrollMetrics: () => ScrollMetrics | null;

	/**
	 * Ref to track the previous isAtBottom value
	 * Useful for detecting state changes in custom handlers
	 */
	prevIsAtBottomRef: React.MutableRefObject<boolean>;
}

export interface ScrollMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	isAtBottom: boolean;
	scrollProgress: number;
}

/**
 * Hook for managing scroll position with common utilities
 *
 * @param options - Configuration options
 * @returns Object with scroll state and manipulation methods
 *
 * @example
 * // Terminal output with new message indicator
 * const { isAtBottom, handleScroll, scrollToBottom } = useScrollPosition({
 *   containerRef: scrollContainerRef,
 *   bottomThreshold: 50,
 *   onAtBottomChange: (atBottom) => {
 *     if (atBottom) {
 *       setHasNewMessages(false);
 *     }
 *   },
 * });
 *
 * // Show "scroll to bottom" button when not at bottom
 * {!isAtBottom && (
 *   <button onClick={() => scrollToBottom()}>New Messages</button>
 * )}
 *
 * @example
 * // History panel with infinite scroll
 * const { isAtBottom, handleScroll, scrollTop } = useScrollPosition({
 *   containerRef: listRef,
 *   bottomThreshold: 100,
 *   onScrollPositionChange: (pos) => {
 *     scrollPositionCache.set(sessionId, pos);
 *   },
 * });
 *
 * useEffect(() => {
 *   if (isAtBottom && hasMore) {
 *     loadMoreEntries();
 *   }
 * }, [isAtBottom, hasMore]);
 *
 * @example
 * // Keyboard scroll navigation
 * const { scrollToTop, scrollToBottom, scrollByPage, scrollBy } = useScrollPosition({
 *   containerRef,
 * });
 *
 * const handleKeyDown = (e: KeyboardEvent) => {
 *   if (e.metaKey && e.key === 'ArrowUp') scrollToTop();
 *   if (e.metaKey && e.key === 'ArrowDown') scrollToBottom();
 *   if (e.altKey && e.key === 'ArrowUp') scrollByPage('up');
 *   if (e.altKey && e.key === 'ArrowDown') scrollByPage('down');
 *   if (e.key === 'ArrowUp') scrollBy(-100);
 *   if (e.key === 'ArrowDown') scrollBy(100);
 * };
 */
export function useScrollPosition(options: UseScrollPositionOptions): UseScrollPositionReturn {
	const {
		containerRef,
		bottomThreshold = 50,
		throttleMs = 4,
		onAtBottomChange,
		onScrollPositionChange,
		positionChangeThrottleMs = 200,
		trackProgress = false,
		initialAtBottom = true,
	} = options;

	const [scrollTop, setScrollTop] = useState(0);
	const [isAtBottom, setIsAtBottom] = useState(initialAtBottom);
	const [scrollProgress, setScrollProgress] = useState(0);

	const prevIsAtBottomRef = useRef(initialAtBottom);
	const positionSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

	// Cleanup position save timer on unmount
	const cleanupPositionTimer = useCallback(() => {
		if (positionSaveTimerRef.current) {
			clearTimeout(positionSaveTimerRef.current);
			positionSaveTimerRef.current = null;
		}
	}, []);

	/**
	 * Get current scroll metrics without triggering state updates
	 */
	const getScrollMetrics = useCallback((): ScrollMetrics | null => {
		const container = containerRef.current;
		if (!container) return null;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const atBottom = scrollHeight - scrollTop - clientHeight <= bottomThreshold;
		const progress =
			scrollHeight > clientHeight ? (scrollTop / (scrollHeight - clientHeight)) * 100 : 0;

		return {
			scrollTop,
			scrollHeight,
			clientHeight,
			isAtBottom: atBottom,
			scrollProgress: progress,
		};
	}, [containerRef, bottomThreshold]);

	/**
	 * Inner scroll handler (contains actual logic)
	 */
	const handleScrollInner = useCallback(() => {
		const metrics = getScrollMetrics();
		if (!metrics) return;

		setScrollTop(metrics.scrollTop);
		setIsAtBottom(metrics.isAtBottom);

		if (trackProgress) {
			setScrollProgress(metrics.scrollProgress);
		}

		// Notify parent when isAtBottom changes
		if (metrics.isAtBottom !== prevIsAtBottomRef.current) {
			prevIsAtBottomRef.current = metrics.isAtBottom;
			onAtBottomChange?.(metrics.isAtBottom);
		}

		// Throttled scroll position save
		if (onScrollPositionChange) {
			cleanupPositionTimer();
			positionSaveTimerRef.current = setTimeout(() => {
				onScrollPositionChange(metrics.scrollTop);
				positionSaveTimerRef.current = null;
			}, positionChangeThrottleMs);
		}
	}, [
		getScrollMetrics,
		trackProgress,
		onAtBottomChange,
		onScrollPositionChange,
		positionChangeThrottleMs,
		cleanupPositionTimer,
	]);

	// Throttle the scroll handler if throttleMs > 0
	const throttledHandler = useThrottledCallback(handleScrollInner, throttleMs);
	const handleScroll = throttleMs > 0 ? throttledHandler : handleScrollInner;

	/**
	 * Scroll to a specific position
	 */
	const scrollTo = useCallback(
		(top: number, behavior: ScrollBehavior = 'smooth') => {
			containerRef.current?.scrollTo({ top, behavior });
		},
		[containerRef]
	);

	/**
	 * Scroll to the top
	 */
	const scrollToTop = useCallback(
		(behavior: ScrollBehavior = 'smooth') => {
			containerRef.current?.scrollTo({ top: 0, behavior });
		},
		[containerRef]
	);

	/**
	 * Scroll to the bottom
	 */
	const scrollToBottom = useCallback(
		(behavior: ScrollBehavior = 'smooth') => {
			const container = containerRef.current;
			if (container) {
				container.scrollTo({ top: container.scrollHeight, behavior });
			}
		},
		[containerRef]
	);

	/**
	 * Scroll by a page (fraction of viewport)
	 */
	const scrollByPage = useCallback(
		(direction: 'up' | 'down', fraction: number = 0.8, behavior: ScrollBehavior = 'smooth') => {
			const container = containerRef.current;
			if (container) {
				const delta = container.clientHeight * fraction;
				container.scrollBy({
					top: direction === 'down' ? delta : -delta,
					behavior,
				});
			}
		},
		[containerRef]
	);

	/**
	 * Scroll by a fixed number of pixels
	 */
	const scrollBy = useCallback(
		(pixels: number, behavior: ScrollBehavior = 'smooth') => {
			containerRef.current?.scrollBy({ top: pixels, behavior });
		},
		[containerRef]
	);

	return {
		scrollTop,
		isAtBottom,
		scrollProgress,
		handleScroll,
		scrollTo,
		scrollToTop,
		scrollToBottom,
		scrollByPage,
		scrollBy,
		getScrollMetrics,
		prevIsAtBottomRef,
	};
}

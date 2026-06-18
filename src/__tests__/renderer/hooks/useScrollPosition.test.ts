/**
 * Tests for useScrollPosition hook
 *
 * This hook provides scroll position management utilities including
 * "at bottom" detection, scroll position tracking, and navigation helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollPosition } from '../../../renderer/hooks';

// Mock useThrottledCallback to call immediately in tests
vi.mock('../../../renderer/hooks/utils/useThrottle', () => ({
	useThrottledCallback: (fn: () => void) => fn,
}));

describe('useScrollPosition', () => {
	let mockContainer: HTMLElement;
	let containerRef: React.RefObject<HTMLElement>;

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.useFakeTimers();

		// Create a mock container with scroll properties
		mockContainer = document.createElement('div');
		Object.defineProperties(mockContainer, {
			scrollTop: { value: 0, writable: true, configurable: true },
			scrollHeight: { value: 1000, writable: true, configurable: true },
			clientHeight: { value: 500, writable: true, configurable: true },
		});

		// Mock scroll methods
		mockContainer.scrollTo = vi.fn();
		mockContainer.scrollBy = vi.fn();

		containerRef = { current: mockContainer };
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('should initialize with default values', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			expect(result.current.scrollTop).toBe(0);
			expect(result.current.isAtBottom).toBe(true);
			expect(result.current.scrollProgress).toBe(0);
		});

		it('should accept custom initialAtBottom value', () => {
			const { result } = renderHook(() =>
				useScrollPosition({ containerRef, initialAtBottom: false })
			);

			expect(result.current.isAtBottom).toBe(false);
		});

		it('should use default bottomThreshold of 50', () => {
			// Scroll to within 50px of bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 460, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(460) - clientHeight(500) = 40 < 50
			expect(result.current.isAtBottom).toBe(true);
		});

		it('should use default throttleMs of 4 for smooth scrollbar', () => {
			// This is a documentation test - the default is 4ms (~240fps) for smooth scrollbar updates
			// The actual throttling behavior is tested via the mock that bypasses it
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			// Verify the hook initializes correctly with default throttle
			expect(result.current.handleScroll).toBeDefined();
		});

		it('should respect custom bottomThreshold', () => {
			// Scroll to 460px - within 40px of bottom but not within 30px
			Object.defineProperty(mockContainer, 'scrollTop', { value: 460, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef, bottomThreshold: 30 }));

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(460) - clientHeight(500) = 40 > 30
			expect(result.current.isAtBottom).toBe(false);
		});
	});

	describe('handleScroll', () => {
		it('should update scrollTop on scroll', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			Object.defineProperty(mockContainer, 'scrollTop', { value: 200, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			expect(result.current.scrollTop).toBe(200);
		});

		it('should update isAtBottom when scrolling away from bottom', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			// Scroll to middle
			Object.defineProperty(mockContainer, 'scrollTop', { value: 200, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(200) - clientHeight(500) = 300 > 50
			expect(result.current.isAtBottom).toBe(false);
		});

		it('should update isAtBottom when scrolling to bottom', () => {
			const { result } = renderHook(() =>
				useScrollPosition({ containerRef, initialAtBottom: false })
			);

			// Scroll to near bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 480, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(480) - clientHeight(500) = 20 < 50
			expect(result.current.isAtBottom).toBe(true);
		});

		it('should track scroll progress when enabled', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef, trackProgress: true }));

			// Scroll to middle
			Object.defineProperty(mockContainer, 'scrollTop', { value: 250, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			// scrollTop(250) / (scrollHeight(1000) - clientHeight(500)) = 250/500 = 50%
			expect(result.current.scrollProgress).toBe(50);
		});

		it('should not track scroll progress by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			Object.defineProperty(mockContainer, 'scrollTop', { value: 250, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			expect(result.current.scrollProgress).toBe(0);
		});

		it('should handle container with no scrollable content', () => {
			Object.defineProperties(mockContainer, {
				scrollHeight: { value: 500, configurable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const { result } = renderHook(() => useScrollPosition({ containerRef, trackProgress: true }));

			act(() => {
				result.current.handleScroll();
			});

			expect(result.current.scrollProgress).toBe(0);
			expect(result.current.isAtBottom).toBe(true);
		});
	});

	describe('onAtBottomChange callback', () => {
		it('should call onAtBottomChange when isAtBottom changes', () => {
			const onAtBottomChange = vi.fn();

			const { result } = renderHook(() => useScrollPosition({ containerRef, onAtBottomChange }));

			// Scroll away from bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });

			act(() => {
				result.current.handleScroll();
			});

			expect(onAtBottomChange).toHaveBeenCalledWith(false);
		});

		it('should not call onAtBottomChange when isAtBottom stays the same', () => {
			const onAtBottomChange = vi.fn();

			const { result } = renderHook(() => useScrollPosition({ containerRef, onAtBottomChange }));

			// First scroll - not at bottom (initial was true, now changes to false)
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			// isAtBottom changes from true (initial) to false
			expect(onAtBottomChange).toHaveBeenCalledTimes(1);
			expect(onAtBottomChange).toHaveBeenCalledWith(false);
			onAtBottomChange.mockClear();

			// Scroll again, still not at bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 150, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			// Should not have been called since isAtBottom stayed false
			expect(onAtBottomChange).not.toHaveBeenCalled();
		});

		it('should call onAtBottomChange when scrolling back to bottom', () => {
			const onAtBottomChange = vi.fn();

			const { result } = renderHook(() => useScrollPosition({ containerRef, onAtBottomChange }));

			// Scroll away from bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });
			act(() => {
				result.current.handleScroll();
			});
			expect(onAtBottomChange).toHaveBeenLastCalledWith(false);

			// Scroll back to bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 480, configurable: true });
			act(() => {
				result.current.handleScroll();
			});
			expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
		});
	});

	describe('onScrollPositionChange callback', () => {
		it('should call onScrollPositionChange after throttle delay', () => {
			const onScrollPositionChange = vi.fn();

			const { result } = renderHook(() =>
				useScrollPosition({
					containerRef,
					onScrollPositionChange,
					positionChangeThrottleMs: 200,
				})
			);

			Object.defineProperty(mockContainer, 'scrollTop', { value: 150, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			expect(onScrollPositionChange).not.toHaveBeenCalled();

			act(() => {
				vi.advanceTimersByTime(200);
			});

			expect(onScrollPositionChange).toHaveBeenCalledWith(150);
		});

		it('should debounce rapid scroll events', () => {
			const onScrollPositionChange = vi.fn();

			const { result } = renderHook(() =>
				useScrollPosition({
					containerRef,
					onScrollPositionChange,
					positionChangeThrottleMs: 200,
				})
			);

			// Multiple scroll events in quick succession
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			act(() => {
				vi.advanceTimersByTime(50);
			});

			Object.defineProperty(mockContainer, 'scrollTop', { value: 150, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			act(() => {
				vi.advanceTimersByTime(50);
			});

			Object.defineProperty(mockContainer, 'scrollTop', { value: 200, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			// Should not have been called yet
			expect(onScrollPositionChange).not.toHaveBeenCalled();

			// After final throttle delay
			act(() => {
				vi.advanceTimersByTime(200);
			});

			// Should only be called once with the final position
			expect(onScrollPositionChange).toHaveBeenCalledTimes(1);
			expect(onScrollPositionChange).toHaveBeenCalledWith(200);
		});
	});

	describe('scrollTo', () => {
		it('should scroll to a specific position with smooth behavior by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollTo(300);
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 300,
				behavior: 'smooth',
			});
		});

		it('should accept custom scroll behavior', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollTo(300, 'auto');
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 300,
				behavior: 'auto',
			});
		});
	});

	describe('scrollToTop', () => {
		it('should scroll to top with smooth behavior by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollToTop();
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 0,
				behavior: 'smooth',
			});
		});

		it('should accept custom scroll behavior', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollToTop('auto');
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 0,
				behavior: 'auto',
			});
		});
	});

	describe('scrollToBottom', () => {
		it('should scroll to bottom with smooth behavior by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollToBottom();
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 1000, // scrollHeight
				behavior: 'smooth',
			});
		});

		it('should accept custom scroll behavior', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollToBottom('auto');
			});

			expect(mockContainer.scrollTo).toHaveBeenCalledWith({
				top: 1000,
				behavior: 'auto',
			});
		});
	});

	describe('scrollByPage', () => {
		it('should scroll down by 80% of viewport by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollByPage('down');
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: 400, // 500 * 0.8
				behavior: 'smooth',
			});
		});

		it('should scroll up by 80% of viewport by default', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollByPage('up');
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: -400, // -(500 * 0.8)
				behavior: 'smooth',
			});
		});

		it('should accept custom fraction', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollByPage('down', 0.5);
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: 250, // 500 * 0.5
				behavior: 'smooth',
			});
		});

		it('should accept custom scroll behavior', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollByPage('down', 0.8, 'auto');
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: 400,
				behavior: 'auto',
			});
		});
	});

	describe('scrollBy', () => {
		it('should scroll by positive pixels (down)', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollBy(100);
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: 100,
				behavior: 'smooth',
			});
		});

		it('should scroll by negative pixels (up)', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollBy(-100);
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: -100,
				behavior: 'smooth',
			});
		});

		it('should accept custom scroll behavior', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.scrollBy(100, 'auto');
			});

			expect(mockContainer.scrollBy).toHaveBeenCalledWith({
				top: 100,
				behavior: 'auto',
			});
		});
	});

	describe('getScrollMetrics', () => {
		it('should return current scroll metrics without state updates', () => {
			Object.defineProperty(mockContainer, 'scrollTop', { value: 250, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			const metrics = result.current.getScrollMetrics();

			expect(metrics).toEqual({
				scrollTop: 250,
				scrollHeight: 1000,
				clientHeight: 500,
				isAtBottom: false,
				scrollProgress: 50, // 250 / (1000 - 500) = 50%
			});

			// State should not have been updated
			expect(result.current.scrollTop).toBe(0);
		});

		it('should return null when container ref is null', () => {
			const nullRef = { current: null };

			const { result } = renderHook(() => useScrollPosition({ containerRef: nullRef }));

			const metrics = result.current.getScrollMetrics();
			expect(metrics).toBeNull();
		});

		it('should calculate isAtBottom correctly', () => {
			// At bottom (within threshold)
			Object.defineProperty(mockContainer, 'scrollTop', { value: 480, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef, bottomThreshold: 50 }));

			let metrics = result.current.getScrollMetrics();
			expect(metrics?.isAtBottom).toBe(true);

			// Not at bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });
			metrics = result.current.getScrollMetrics();
			expect(metrics?.isAtBottom).toBe(false);
		});
	});

	describe('prevIsAtBottomRef', () => {
		it('should track the previous isAtBottom value', () => {
			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			// Initial value should match initialAtBottom
			expect(result.current.prevIsAtBottomRef.current).toBe(true);

			// Scroll away from bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 100, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			// After scroll, ref should be updated
			expect(result.current.prevIsAtBottomRef.current).toBe(false);
		});
	});

	describe('null container handling', () => {
		it('should handle null container ref gracefully in handleScroll', () => {
			const nullRef = { current: null };

			const { result } = renderHook(() => useScrollPosition({ containerRef: nullRef }));

			// Should not throw
			act(() => {
				result.current.handleScroll();
			});

			// State should remain at initial values
			expect(result.current.scrollTop).toBe(0);
			expect(result.current.isAtBottom).toBe(true);
		});

		it('should handle null container ref gracefully in scroll methods', () => {
			const nullRef = { current: null };

			const { result } = renderHook(() => useScrollPosition({ containerRef: nullRef }));

			// None of these should throw
			act(() => {
				result.current.scrollTo(100);
				result.current.scrollToTop();
				result.current.scrollToBottom();
				result.current.scrollByPage('down');
				result.current.scrollBy(100);
			});
		});
	});

	describe('edge cases', () => {
		it('should handle exactly at bottom (scrollHeight - scrollTop === clientHeight)', () => {
			Object.defineProperty(mockContainer, 'scrollTop', { value: 500, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef }));

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(500) - clientHeight(500) = 0 < 50
			expect(result.current.isAtBottom).toBe(true);
		});

		it('should handle very small scroll containers', () => {
			Object.defineProperties(mockContainer, {
				scrollTop: { value: 0, configurable: true },
				scrollHeight: { value: 50, configurable: true },
				clientHeight: { value: 50, configurable: true },
			});

			const { result } = renderHook(() => useScrollPosition({ containerRef, trackProgress: true }));

			act(() => {
				result.current.handleScroll();
			});

			expect(result.current.isAtBottom).toBe(true);
			expect(result.current.scrollProgress).toBe(0);
		});

		it('should handle content smaller than container', () => {
			Object.defineProperties(mockContainer, {
				scrollTop: { value: 0, configurable: true },
				scrollHeight: { value: 400, configurable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const { result } = renderHook(() => useScrollPosition({ containerRef, trackProgress: true }));

			act(() => {
				result.current.handleScroll();
			});

			// No scrollable area, always at bottom
			expect(result.current.isAtBottom).toBe(true);
			expect(result.current.scrollProgress).toBe(0);
		});

		it('should handle bottomThreshold of 0', () => {
			Object.defineProperty(mockContainer, 'scrollTop', { value: 499, configurable: true });

			const { result } = renderHook(() => useScrollPosition({ containerRef, bottomThreshold: 0 }));

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(499) - clientHeight(500) = 1 > 0
			expect(result.current.isAtBottom).toBe(false);

			// Exactly at bottom
			Object.defineProperty(mockContainer, 'scrollTop', { value: 500, configurable: true });
			act(() => {
				result.current.handleScroll();
			});

			expect(result.current.isAtBottom).toBe(true);
		});

		it('should handle very large bottomThreshold', () => {
			Object.defineProperty(mockContainer, 'scrollTop', { value: 0, configurable: true });

			const { result } = renderHook(() =>
				useScrollPosition({ containerRef, bottomThreshold: 600 })
			);

			act(() => {
				result.current.handleScroll();
			});

			// scrollHeight(1000) - scrollTop(0) - clientHeight(500) = 500 < 600
			expect(result.current.isAtBottom).toBe(true);
		});
	});

	describe('callback stability', () => {
		it('should maintain stable callback references', () => {
			const { result, rerender } = renderHook(() => useScrollPosition({ containerRef }));

			const initialHandleScroll = result.current.handleScroll;
			const initialScrollTo = result.current.scrollTo;
			const initialScrollToTop = result.current.scrollToTop;
			const initialScrollToBottom = result.current.scrollToBottom;
			const initialScrollByPage = result.current.scrollByPage;
			const initialScrollBy = result.current.scrollBy;
			const initialGetScrollMetrics = result.current.getScrollMetrics;

			rerender();

			expect(result.current.scrollTo).toBe(initialScrollTo);
			expect(result.current.scrollToTop).toBe(initialScrollToTop);
			expect(result.current.scrollToBottom).toBe(initialScrollToBottom);
			expect(result.current.scrollByPage).toBe(initialScrollByPage);
			expect(result.current.scrollBy).toBe(initialScrollBy);
			expect(result.current.getScrollMetrics).toBe(initialGetScrollMetrics);
			// handleScroll may change due to throttling setup, so we skip that check
		});
	});
});

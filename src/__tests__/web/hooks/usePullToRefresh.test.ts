/**
 * Tests for usePullToRefresh hook
 *
 * Comprehensive testing of pull-to-refresh gesture handling including:
 * - Initial state
 * - Options handling (threshold, maxPull, enabled)
 * - Touch event handlers (start, move, end)
 * - Progress calculation
 * - Refresh triggering
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePullToRefresh } from '../../../web/hooks/usePullToRefresh';
import type {
	UsePullToRefreshOptions,
	UsePullToRefreshReturn,
} from '../../../web/hooks/usePullToRefresh';

// Mock the constants module
vi.mock('../../../web/mobile/constants', () => ({
	GESTURE_THRESHOLDS: {
		swipeDistance: 50,
		swipeTime: 300,
		pullToRefresh: 80,
		longPress: 500,
	},
}));

// Mock the webLogger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { webLogger } from '../../../web/utils/logger';

/**
 * Create a mock React TouchEvent
 */
function createTouchEvent(
	clientY: number,
	clientX: number = 0,
	scrollTop: number = 0
): React.TouchEvent {
	const target = {
		scrollTop,
	} as HTMLElement;

	return {
		touches: [{ clientY, clientX }],
		currentTarget: target,
		preventDefault: vi.fn(),
	} as unknown as React.TouchEvent;
}

describe('usePullToRefresh', () => {
	let mockOnRefresh: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockOnRefresh = vi.fn().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('initial state', () => {
		it('should return correct initial state', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			expect(result.current.pullDistance).toBe(0);
			expect(result.current.isThresholdReached).toBe(false);
			expect(result.current.isRefreshing).toBe(false);
			expect(result.current.progress).toBe(0);
		});

		it('should return containerProps with touch handlers', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			expect(result.current.containerProps).toBeDefined();
			expect(typeof result.current.containerProps.onTouchStart).toBe('function');
			expect(typeof result.current.containerProps.onTouchMove).toBe('function');
			expect(typeof result.current.containerProps.onTouchEnd).toBe('function');
		});
	});

	describe('options handling', () => {
		it('should use default threshold from GESTURE_THRESHOLDS', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			// Default threshold is 80 from GESTURE_THRESHOLDS.pullToRefresh
			// Pull to exactly threshold
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// 160 * 0.5 resistance = 80
				result.current.containerProps.onTouchMove(createTouchEvent(160, 0, 0));
			});

			expect(result.current.pullDistance).toBe(80);
			expect(result.current.isThresholdReached).toBe(true);
			expect(result.current.progress).toBe(1);
		});

		it('should use custom threshold', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// 100 * 0.5 resistance = 50
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(50);
			expect(result.current.isThresholdReached).toBe(true);
			expect(result.current.progress).toBe(1);
		});

		it('should use default maxPull of 150', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// Even with large delta, should cap at maxPull
				result.current.containerProps.onTouchMove(createTouchEvent(500, 0, 0));
			});

			expect(result.current.pullDistance).toBe(150);
		});

		it('should use custom maxPull', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, maxPull: 100 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(500, 0, 0));
			});

			expect(result.current.pullDistance).toBe(100);
		});

		it('should be enabled by default', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBeGreaterThan(0);
		});

		it('should do nothing when disabled', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, enabled: false })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});
	});

	describe('handleTouchStart', () => {
		it('should record touch position', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(100, 50, 0));
			});

			// Verify by checking subsequent move behavior
			act(() => {
				// Move down 100px from start position (100)
				result.current.containerProps.onTouchMove(createTouchEvent(200, 50, 0));
			});

			// 100 * 0.5 = 50
			expect(result.current.pullDistance).toBe(50);
		});

		it('should check scroll position at top', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			// Start with scrollTop = 0 (at top)
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBeGreaterThan(0);
		});

		it('should not activate pull when not at top', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			// Start with scrollTop > 0 (not at top)
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 100));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 100));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should do nothing when disabled', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, enabled: false })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});
	});

	describe('handleTouchMove', () => {
		it('should update pullDistance when pulling down from top', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			// 100 * 0.5 = 50
			expect(result.current.pullDistance).toBe(50);
		});

		it('should apply resistance factor of 0.5', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(200, 0, 0));
			});

			// 200 * 0.5 = 100
			expect(result.current.pullDistance).toBe(100);
		});

		it('should cap pullDistance at maxPull', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, maxPull: 80 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(1000, 0, 0));
			});

			expect(result.current.pullDistance).toBe(80);
		});

		it('should not update when pulling up', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(100, 0, 0));
			});
			act(() => {
				// Pulling up (negative deltaY)
				result.current.containerProps.onTouchMove(createTouchEvent(50, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should not update when horizontal movement exceeds vertical', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// More horizontal than vertical movement
				result.current.containerProps.onTouchMove(createTouchEvent(50, 100, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should update when vertical movement exceeds horizontal', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// More vertical than horizontal movement
				result.current.containerProps.onTouchMove(createTouchEvent(100, 50, 0));
			});

			// 100 * 0.5 = 50
			expect(result.current.pullDistance).toBe(50);
		});

		it('should prevent default when adjusted delta > 10', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});

			const event = createTouchEvent(100, 0, 0);
			act(() => {
				result.current.containerProps.onTouchMove(event);
			});

			expect(event.preventDefault).toHaveBeenCalled();
		});

		it('should not prevent default when adjusted delta <= 10', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});

			const event = createTouchEvent(15, 0, 0); // 15 * 0.5 = 7.5 < 10
			act(() => {
				result.current.containerProps.onTouchMove(event);
			});

			expect(event.preventDefault).not.toHaveBeenCalled();
		});

		it('should do nothing when not at scroll top', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				// Start not at top
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 50));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 50));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should do nothing when disabled', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, enabled: false })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});
	});

	describe('handleTouchEnd', () => {
		it('should trigger refresh when threshold reached', async () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// Pull to 50 (100 * 0.5 = 50)
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(50);
			expect(result.current.isThresholdReached).toBe(true);

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(mockOnRefresh).toHaveBeenCalledTimes(1);
		});

		it('should set isRefreshing during refresh', async () => {
			let resolveRefresh: () => void;
			const refreshPromise = new Promise<void>((resolve) => {
				resolveRefresh = resolve;
			});
			const slowRefresh = vi.fn().mockReturnValue(refreshPromise);

			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: slowRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			// Start the touch end but don't await it
			let touchEndPromise: Promise<void>;
			act(() => {
				touchEndPromise = result.current.containerProps.onTouchEnd(
					createTouchEvent(100, 0, 0)
				) as unknown as Promise<void>;
			});

			// isRefreshing should be true while refresh is in progress
			expect(result.current.isRefreshing).toBe(true);

			// Complete the refresh
			await act(async () => {
				resolveRefresh!();
				await touchEndPromise;
			});

			expect(result.current.isRefreshing).toBe(false);
		});

		it('should reset pullDistance after refresh completes', async () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(50);

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should handle refresh errors gracefully', async () => {
			const error = new Error('Refresh failed');
			const failingRefresh = vi.fn().mockRejectedValue(error);

			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: failingRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(webLogger.error).toHaveBeenCalledWith('Refresh error', 'PullToRefresh', error);
			expect(result.current.isRefreshing).toBe(false);
			expect(result.current.pullDistance).toBe(0);
		});

		it('should reset pullDistance without refresh when threshold not reached', async () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 80 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// Pull to 40 (80 * 0.5 = 40), below threshold
				result.current.containerProps.onTouchMove(createTouchEvent(80, 0, 0));
			});

			expect(result.current.pullDistance).toBe(40);
			expect(result.current.isThresholdReached).toBe(false);

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(80, 0, 0));
			});

			expect(mockOnRefresh).not.toHaveBeenCalled();
			expect(result.current.pullDistance).toBe(0);
		});

		it('should do nothing when not pulling', async () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			// Call touchEnd without touchStart/touchMove
			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(mockOnRefresh).not.toHaveBeenCalled();
			expect(result.current.pullDistance).toBe(0);
		});

		it('should do nothing when disabled', async () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, enabled: false, threshold: 50 })
			);

			// Try to simulate a full pull gesture with disabled state
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(200, 0, 0));
			});

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(200, 0, 0));
			});

			expect(mockOnRefresh).not.toHaveBeenCalled();
		});

		it('should do nothing when already refreshing', async () => {
			let resolveRefresh: () => void;
			const refreshPromise = new Promise<void>((resolve) => {
				resolveRefresh = resolve;
			});
			const slowRefresh = vi.fn().mockReturnValue(refreshPromise);

			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: slowRefresh, threshold: 50 })
			);

			// First pull
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			// Start refresh
			act(() => {
				result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(result.current.isRefreshing).toBe(true);

			// Try another pull while refreshing - this should be blocked
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			// Should still have original pullDistance (reset to 0 after refresh starts)
			// The handlers should exit early due to isRefreshing check

			await act(async () => {
				resolveRefresh!();
			});

			// Should only have been called once
			expect(slowRefresh).toHaveBeenCalledTimes(1);
		});
	});

	describe('progress calculation', () => {
		it('should calculate progress from 0 to 1', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 100 })
			);

			expect(result.current.progress).toBe(0);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});

			// 50% progress (50 / 100)
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0)); // 100 * 0.5 = 50
			});
			expect(result.current.progress).toBe(0.5);

			// 100% progress
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(200, 0, 0)); // 200 * 0.5 = 100
			});
			expect(result.current.progress).toBe(1);
		});

		it('should cap progress at 1', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50, maxPull: 200 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				// Pull beyond threshold
				result.current.containerProps.onTouchMove(createTouchEvent(300, 0, 0)); // 300 * 0.5 = 150
			});

			// Progress should be capped at 1
			expect(result.current.progress).toBe(1);
			// But pullDistance continues
			expect(result.current.pullDistance).toBe(150);
		});

		it('should update isThresholdReached correctly', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			expect(result.current.isThresholdReached).toBe(false);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});

			// Below threshold
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(80, 0, 0)); // 80 * 0.5 = 40
			});
			expect(result.current.isThresholdReached).toBe(false);

			// At threshold
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0)); // 100 * 0.5 = 50
			});
			expect(result.current.isThresholdReached).toBe(true);

			// Above threshold
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(200, 0, 0)); // 200 * 0.5 = 100
			});
			expect(result.current.isThresholdReached).toBe(true);
		});
	});

	describe('callback ref updates', () => {
		it('should call updated onRefresh callback', async () => {
			const firstRefresh = vi.fn().mockResolvedValue(undefined);
			const secondRefresh = vi.fn().mockResolvedValue(undefined);

			const { result, rerender } = renderHook(
				({ onRefresh }) => usePullToRefresh({ onRefresh, threshold: 50 }),
				{ initialProps: { onRefresh: firstRefresh } }
			);

			// Update the onRefresh callback
			rerender({ onRefresh: secondRefresh });

			// Trigger a refresh
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(firstRefresh).not.toHaveBeenCalled();
			expect(secondRefresh).toHaveBeenCalledTimes(1);
		});
	});

	describe('synchronous onRefresh', () => {
		it('should handle synchronous onRefresh callback', async () => {
			const syncRefresh = vi.fn(); // No return value (synchronous)

			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: syncRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(syncRefresh).toHaveBeenCalledTimes(1);
			expect(result.current.isRefreshing).toBe(false);
			expect(result.current.pullDistance).toBe(0);
		});
	});

	describe('function reference stability', () => {
		it('should maintain stable handler references', () => {
			const { result, rerender } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			const firstHandlers = result.current.containerProps;

			rerender();

			const secondHandlers = result.current.containerProps;

			expect(firstHandlers.onTouchStart).toBe(secondHandlers.onTouchStart);
			expect(firstHandlers.onTouchMove).toBe(secondHandlers.onTouchMove);
			expect(firstHandlers.onTouchEnd).toBe(secondHandlers.onTouchEnd);
		});

		it('should update handlers when dependencies change', () => {
			const { result, rerender } = renderHook(
				({ enabled }) => usePullToRefresh({ onRefresh: mockOnRefresh, enabled }),
				{ initialProps: { enabled: true } }
			);

			const firstHandlers = result.current.containerProps;

			rerender({ enabled: false });

			const secondHandlers = result.current.containerProps;

			// Handlers should be recreated when enabled changes
			expect(firstHandlers.onTouchStart).not.toBe(secondHandlers.onTouchStart);
			expect(firstHandlers.onTouchMove).not.toBe(secondHandlers.onTouchMove);
			expect(firstHandlers.onTouchEnd).not.toBe(secondHandlers.onTouchEnd);
		});
	});

	describe('edge cases', () => {
		it('should handle zero deltaY', () => {
			const { result } = renderHook(() => usePullToRefresh({ onRefresh: mockOnRefresh }));

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(100, 0, 0));
			});
			act(() => {
				// Same Y position
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});

			expect(result.current.pullDistance).toBe(0);
		});

		it('should handle rapid touch events', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});

			// Rapid succession of move events
			for (let i = 1; i <= 10; i++) {
				act(() => {
					result.current.containerProps.onTouchMove(createTouchEvent(i * 20, 0, 0));
				});
			}

			// Final position: 200 * 0.5 = 100
			expect(result.current.pullDistance).toBe(100);
		});

		it('should handle multiple gesture cycles', async () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 50 })
			);

			// First cycle - threshold reached
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});
			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(mockOnRefresh).toHaveBeenCalledTimes(1);
			expect(result.current.pullDistance).toBe(0);

			// Second cycle - threshold not reached
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(50, 0, 0)); // 25 < 50
			});
			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(50, 0, 0));
			});

			expect(mockOnRefresh).toHaveBeenCalledTimes(1); // Still 1
			expect(result.current.pullDistance).toBe(0);

			// Third cycle - threshold reached again
			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(100, 0, 0));
			});
			await act(async () => {
				await result.current.containerProps.onTouchEnd(createTouchEvent(100, 0, 0));
			});

			expect(mockOnRefresh).toHaveBeenCalledTimes(2);
		});

		it('should handle very small threshold', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 1 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(10, 0, 0)); // 5 > 1
			});

			expect(result.current.isThresholdReached).toBe(true);
			expect(result.current.progress).toBe(1);
		});

		it('should handle very large threshold', () => {
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, threshold: 1000, maxPull: 500 })
			);

			act(() => {
				result.current.containerProps.onTouchStart(createTouchEvent(0, 0, 0));
			});
			act(() => {
				result.current.containerProps.onTouchMove(createTouchEvent(1000, 0, 0)); // 500 < 1000
			});

			expect(result.current.pullDistance).toBe(500);
			expect(result.current.isThresholdReached).toBe(false);
			expect(result.current.progress).toBe(0.5);
		});
	});

	describe('containerRef option', () => {
		it('should accept containerRef option without error', () => {
			const containerRef = { current: document.createElement('div') };

			// Just verify it doesn't throw - containerRef is part of the interface
			// but isn't actually used in the current implementation
			const { result } = renderHook(() =>
				usePullToRefresh({ onRefresh: mockOnRefresh, containerRef })
			);

			expect(result.current).toBeDefined();
		});
	});

	describe('default export', () => {
		it('should export usePullToRefresh as default', async () => {
			const module = await import('../../../web/hooks/usePullToRefresh');
			expect(module.default).toBe(module.usePullToRefresh);
		});
	});
});

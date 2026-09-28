import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHoverTooltip } from '../../../renderer/hooks';

describe('useHoverTooltip', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should start with isOpen as false', () => {
		const { result } = renderHook(() => useHoverTooltip());
		expect(result.current.isOpen).toBe(false);
	});

	it('should open when trigger onMouseEnter is called', () => {
		const { result } = renderHook(() => useHoverTooltip());

		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		expect(result.current.isOpen).toBe(true);
	});

	it('should close after delay when trigger onMouseLeave is called', async () => {
		const { result } = renderHook(() => useHoverTooltip(150));

		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		expect(result.current.isOpen).toBe(true);

		act(() => {
			result.current.triggerHandlers.onMouseLeave();
		});

		// Should still be open immediately after leave
		expect(result.current.isOpen).toBe(true);

		// Advance time by delay
		await act(async () => {
			vi.advanceTimersByTime(150);
		});

		expect(result.current.isOpen).toBe(false);
	});

	it('should cancel close timeout when content onMouseEnter is called', async () => {
		const { result } = renderHook(() => useHoverTooltip(150));

		// Open tooltip
		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		// Start closing
		act(() => {
			result.current.triggerHandlers.onMouseLeave();
		});

		// Enter content before timeout completes
		act(() => {
			result.current.contentHandlers.onMouseEnter();
		});

		// Advance past the original timeout
		await act(async () => {
			vi.advanceTimersByTime(200);
		});

		// Should still be open because content was entered
		expect(result.current.isOpen).toBe(true);
	});

	it('should close after delay when content onMouseLeave is called', async () => {
		const { result } = renderHook(() => useHoverTooltip(150));

		// Open via trigger
		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		// Move to content
		act(() => {
			result.current.contentHandlers.onMouseEnter();
		});

		// Leave content
		act(() => {
			result.current.contentHandlers.onMouseLeave();
		});

		// Advance time
		await act(async () => {
			vi.advanceTimersByTime(150);
		});

		expect(result.current.isOpen).toBe(false);
	});

	it('should close immediately when close() is called', () => {
		const { result } = renderHook(() => useHoverTooltip());

		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		expect(result.current.isOpen).toBe(true);

		act(() => {
			result.current.close();
		});

		expect(result.current.isOpen).toBe(false);
	});

	it('should use custom closeDelay', async () => {
		const { result } = renderHook(() => useHoverTooltip(300));

		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		act(() => {
			result.current.triggerHandlers.onMouseLeave();
		});

		// At 150ms, should still be open
		await act(async () => {
			vi.advanceTimersByTime(150);
		});

		expect(result.current.isOpen).toBe(true);

		// At 300ms, should be closed
		await act(async () => {
			vi.advanceTimersByTime(150);
		});

		expect(result.current.isOpen).toBe(false);
	});

	it('should cleanup timeout on unmount', () => {
		const { result, unmount } = renderHook(() => useHoverTooltip());

		act(() => {
			result.current.triggerHandlers.onMouseEnter();
		});

		act(() => {
			result.current.triggerHandlers.onMouseLeave();
		});

		// Unmount before timeout completes
		expect(() => unmount()).not.toThrow();
	});

	it('should handle multiple rapid hover interactions', async () => {
		const { result } = renderHook(() => useHoverTooltip(150));

		// Rapid in/out
		act(() => {
			result.current.triggerHandlers.onMouseEnter();
			result.current.triggerHandlers.onMouseLeave();
			result.current.triggerHandlers.onMouseEnter();
		});

		expect(result.current.isOpen).toBe(true);

		// Wait for any lingering timeouts
		await act(async () => {
			vi.advanceTimersByTime(200);
		});

		// Should still be open because we ended with enter
		expect(result.current.isOpen).toBe(true);
	});

	describe('openDelay', () => {
		it('opens immediately by default', () => {
			const { result } = renderHook(() => useHoverTooltip(150));

			act(() => {
				result.current.triggerHandlers.onMouseEnter();
			});

			expect(result.current.isOpen).toBe(true);
		});

		it('waits for the open delay before opening', () => {
			const { result } = renderHook(() => useHoverTooltip(150, 200));

			act(() => {
				result.current.triggerHandlers.onMouseEnter();
			});
			expect(result.current.isOpen).toBe(false);

			act(() => {
				vi.advanceTimersByTime(199);
			});
			expect(result.current.isOpen).toBe(false);

			act(() => {
				vi.advanceTimersByTime(1);
			});
			expect(result.current.isOpen).toBe(true);
		});

		it('cancels a pending open when the pointer leaves first', () => {
			// A pass-through: entering and leaving before the delay elapses must
			// never open, not even later.
			const { result } = renderHook(() => useHoverTooltip(150, 200));

			act(() => {
				result.current.triggerHandlers.onMouseEnter();
				vi.advanceTimersByTime(100);
				result.current.triggerHandlers.onMouseLeave();
				vi.advanceTimersByTime(1000);
			});

			expect(result.current.isOpen).toBe(false);
		});

		it('opens immediately when the pointer reaches the content', () => {
			// The open delay is only for the trigger - once the pointer is on the
			// content itself there is nothing left to disambiguate.
			const { result } = renderHook(() => useHoverTooltip(150, 200));

			act(() => {
				result.current.contentHandlers.onMouseEnter();
			});

			expect(result.current.isOpen).toBe(true);
		});
	});

	describe('open()', () => {
		it('opens immediately, skipping the open delay', () => {
			const { result } = renderHook(() => useHoverTooltip(150, 200));

			act(() => {
				result.current.open();
			});

			expect(result.current.isOpen).toBe(true);
		});

		it('cancels a pending close', () => {
			const { result } = renderHook(() => useHoverTooltip(150, 200));

			act(() => {
				result.current.open();
				result.current.triggerHandlers.onMouseLeave();
				result.current.open();
				vi.advanceTimersByTime(1000);
			});

			expect(result.current.isOpen).toBe(true);
		});
	});
});

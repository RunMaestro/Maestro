import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabHoverOverlay } from '../../../renderer/hooks/tabs/useTabHoverOverlay';

describe('useTabHoverOverlay', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns correct initial state', () => {
		const { result } = renderHook(() => useTabHoverOverlay());
		expect(result.current.isHovered).toBe(false);
		expect(result.current.overlayOpen).toBe(false);
		expect(result.current.overlayPosition).toBe(null);
		expect(result.current.isOverOverlayRef.current).toBe(false);
	});

	it('sets isHovered on mouse enter', () => {
		const { result } = renderHook(() => useTabHoverOverlay());
		act(() => {
			result.current.handleMouseEnter();
		});
		expect(result.current.isHovered).toBe(true);
	});

	it('opens overlay after 400ms delay on mouse enter', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		// Mock getBoundingClientRect on the tabRef
		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		act(() => {
			result.current.handleMouseEnter();
		});
		expect(result.current.overlayOpen).toBe(false);

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);
		expect(result.current.overlayPosition).toEqual({ top: 100, left: 50, tabWidth: 120 });
	});

	it('clears hover and closes overlay on mouse leave', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		act(() => {
			result.current.handleMouseEnter();
		});
		expect(result.current.isHovered).toBe(true);

		act(() => {
			result.current.handleMouseLeave();
		});
		expect(result.current.isHovered).toBe(false);

		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(result.current.overlayOpen).toBe(false);
	});

	it('does NOT close overlay on mouse leave when mouse is over overlay', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		// Open the overlay
		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);

		// Mouse enters overlay
		act(() => {
			result.current.overlayMouseEnter();
		});

		// Mouse leaves tab
		act(() => {
			result.current.handleMouseLeave();
		});
		act(() => {
			vi.advanceTimersByTime(100);
		});

		// Overlay should stay open because mouse is over it
		expect(result.current.overlayOpen).toBe(true);
	});

	it('closes overlay when mouse leaves the overlay portal', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		// Open overlay
		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);

		// Mouse enters then leaves overlay
		act(() => {
			result.current.overlayMouseEnter();
		});
		act(() => {
			result.current.overlayMouseLeave();
		});

		expect(result.current.overlayOpen).toBe(false);
		expect(result.current.isHovered).toBe(false);
		expect(result.current.isOverOverlayRef.current).toBe(false);
	});

	it('respects shouldOpen guard — does not open when guard returns false', () => {
		const { result } = renderHook(() => useTabHoverOverlay({ shouldOpen: () => false }));

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		act(() => {
			result.current.handleMouseEnter();
		});
		// isHovered should be set regardless
		expect(result.current.isHovered).toBe(true);

		act(() => {
			vi.advanceTimersByTime(400);
		});
		// But overlay should NOT open
		expect(result.current.overlayOpen).toBe(false);
	});

	it('opens when shouldOpen guard returns true', () => {
		const { result } = renderHook(() => useTabHoverOverlay({ shouldOpen: () => true }));

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);
	});

	it('calls registerRef when setTabRef is invoked', () => {
		const registerRef = vi.fn();
		const { result } = renderHook(() => useTabHoverOverlay({ registerRef }));

		const mockEl = document.createElement('div');
		act(() => {
			result.current.setTabRef(mockEl);
		});

		expect(registerRef).toHaveBeenCalledWith(mockEl);
		expect(result.current.tabRef.current).toBe(mockEl);
	});

	it('calls registerRef with null on cleanup', () => {
		const registerRef = vi.fn();
		const { result } = renderHook(() => useTabHoverOverlay({ registerRef }));

		act(() => {
			result.current.setTabRef(null);
		});

		expect(registerRef).toHaveBeenCalledWith(null);
		expect(result.current.tabRef.current).toBe(null);
	});

	it('cancels pending timeout on rapid mouse leave', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		// Mouse enter (starts 400ms timer)
		act(() => {
			result.current.handleMouseEnter();
		});

		// Mouse leave before 400ms (should cancel the open timer)
		act(() => {
			vi.advanceTimersByTime(200);
		});
		act(() => {
			result.current.handleMouseLeave();
		});

		// Advance past original 400ms — overlay should NOT open
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(result.current.overlayOpen).toBe(false);
	});

	it('returns positionReady as false initially', () => {
		const { result } = renderHook(() => useTabHoverOverlay());
		expect(result.current.positionReady).toBe(false);
	});

	it('clamps overlay position when it overflows the right edge of the viewport', () => {
		// Viewport: 800px wide
		Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

		const { result } = renderHook(() => useTabHoverOverlay());

		// Tab near right edge — overlay would start at left: 700
		const mockTab = { getBoundingClientRect: () => ({ bottom: 40, left: 700, width: 80 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockTab as unknown as HTMLDivElement;

		// Attach overlay ref before opening so useLayoutEffect can measure it
		const mockOverlay = document.createElement('div');
		vi.spyOn(mockOverlay, 'getBoundingClientRect').mockReturnValue({
			width: 250,
			height: 300,
			top: 40,
			left: 700,
			bottom: 340,
			right: 950,
			x: 700,
			y: 40,
			toJSON: () => ({}),
		});
		act(() => {
			result.current.setOverlayRef(mockOverlay);
		});

		// Open overlay
		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});

		expect(result.current.overlayOpen).toBe(true);
		// Clamped: max left = 800 - 250 - 8 = 542
		expect(result.current.overlayPosition?.left).toBe(542);
		expect(result.current.positionReady).toBe(true);
	});

	it('clamps overlay position when it overflows the bottom edge of the viewport', () => {
		Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });

		const { result } = renderHook(() => useTabHoverOverlay());

		// Tab positioned so overlay starts at top: 200
		const mockTab = { getBoundingClientRect: () => ({ bottom: 200, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockTab as unknown as HTMLDivElement;

		const mockOverlay = document.createElement('div');
		vi.spyOn(mockOverlay, 'getBoundingClientRect').mockReturnValue({
			width: 250,
			height: 300,
			top: 200,
			left: 50,
			bottom: 500,
			right: 300,
			x: 50,
			y: 200,
			toJSON: () => ({}),
		});
		act(() => {
			result.current.setOverlayRef(mockOverlay);
		});

		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});

		expect(result.current.overlayOpen).toBe(true);
		// Clamped: max top = 400 - 300 - 8 = 92
		expect(result.current.overlayPosition?.top).toBe(92);
		expect(result.current.overlayPosition?.left).toBe(50); // unchanged
		expect(result.current.positionReady).toBe(true);
	});

	it('does not clamp overlay position when it fits within viewport', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

		const { result } = renderHook(() => useTabHoverOverlay());

		const mockTab = { getBoundingClientRect: () => ({ bottom: 40, left: 100, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockTab as unknown as HTMLDivElement;

		const mockOverlay = document.createElement('div');
		vi.spyOn(mockOverlay, 'getBoundingClientRect').mockReturnValue({
			width: 250,
			height: 300,
			top: 40,
			left: 100,
			bottom: 340,
			right: 350,
			x: 100,
			y: 40,
			toJSON: () => ({}),
		});
		act(() => {
			result.current.setOverlayRef(mockOverlay);
		});

		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});

		expect(result.current.overlayOpen).toBe(true);
		// No clamping needed — position unchanged
		expect(result.current.overlayPosition).toEqual({ top: 40, left: 100, tabWidth: 120 });
		expect(result.current.positionReady).toBe(true);
	});

	it('resets positionReady when overlay closes', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

		const { result } = renderHook(() => useTabHoverOverlay());

		const mockTab = { getBoundingClientRect: () => ({ bottom: 40, left: 100, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockTab as unknown as HTMLDivElement;

		const mockOverlay = document.createElement('div');
		vi.spyOn(mockOverlay, 'getBoundingClientRect').mockReturnValue({
			width: 250,
			height: 300,
			top: 40,
			left: 100,
			bottom: 340,
			right: 350,
			x: 100,
			y: 40,
			toJSON: () => ({}),
		});
		act(() => {
			result.current.setOverlayRef(mockOverlay);
		});

		// Open overlay
		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.positionReady).toBe(true);

		// Close overlay
		act(() => {
			result.current.overlayMouseLeave();
		});
		expect(result.current.positionReady).toBe(false);
	});

	it('overlayMouseEnter clears pending close timeout', () => {
		const { result } = renderHook(() => useTabHoverOverlay());

		const mockElement = { getBoundingClientRect: () => ({ bottom: 100, left: 50, width: 120 }) };
		(result.current.tabRef as React.MutableRefObject<HTMLDivElement | null>).current =
			mockElement as unknown as HTMLDivElement;

		// Open overlay
		act(() => {
			result.current.handleMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);

		// Mouse leaves tab (starts 100ms close timer)
		act(() => {
			result.current.handleMouseLeave();
		});

		// Mouse enters overlay before 100ms (should cancel close timer)
		act(() => {
			vi.advanceTimersByTime(50);
		});
		act(() => {
			result.current.overlayMouseEnter();
		});

		// Advance past 100ms — overlay should still be open
		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(result.current.overlayOpen).toBe(true);
	});
});

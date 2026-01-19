import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMobileLandscape } from '../../../renderer/hooks';

describe('useMobileLandscape', () => {
	// Store original values
	let originalInnerWidth: number;
	let originalInnerHeight: number;
	let originalOntouchstart: PropertyDescriptor | undefined;
	let originalMaxTouchPoints: PropertyDescriptor | undefined;

	beforeEach(() => {
		// Save original window properties
		originalInnerWidth = window.innerWidth;
		originalInnerHeight = window.innerHeight;
		originalOntouchstart = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
		originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');

		// Clean up any existing ontouchstart
		if ('ontouchstart' in window) {
			delete (window as any).ontouchstart;
		}
	});

	afterEach(() => {
		// Restore original window dimensions
		Object.defineProperty(window, 'innerWidth', {
			writable: true,
			configurable: true,
			value: originalInnerWidth,
		});
		Object.defineProperty(window, 'innerHeight', {
			writable: true,
			configurable: true,
			value: originalInnerHeight,
		});

		// Restore original touch properties
		if (originalOntouchstart) {
			Object.defineProperty(window, 'ontouchstart', originalOntouchstart);
		} else {
			delete (window as any).ontouchstart;
		}

		if (originalMaxTouchPoints) {
			Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints);
		}

		vi.restoreAllMocks();
	});

	// Helper to set window dimensions
	function setWindowDimensions(width: number, height: number) {
		Object.defineProperty(window, 'innerWidth', {
			writable: true,
			configurable: true,
			value: width,
		});
		Object.defineProperty(window, 'innerHeight', {
			writable: true,
			configurable: true,
			value: height,
		});
	}

	// Helper to enable touch device via ontouchstart
	function enableTouchViaOntouchstart() {
		(window as any).ontouchstart = null;
	}

	// Helper to enable touch device via maxTouchPoints
	function enableTouchViaMaxTouchPoints(points: number = 1) {
		Object.defineProperty(navigator, 'maxTouchPoints', {
			writable: true,
			configurable: true,
			value: points,
		});
	}

	// Helper to disable touch device
	function disableTouch() {
		if ('ontouchstart' in window) {
			delete (window as any).ontouchstart;
		}
		Object.defineProperty(navigator, 'maxTouchPoints', {
			writable: true,
			configurable: true,
			value: 0,
		});
	}

	// Helper to trigger resize event
	function triggerResize() {
		window.dispatchEvent(new Event('resize'));
	}

	// Helper to trigger orientationchange event
	function triggerOrientationChange() {
		window.dispatchEvent(new Event('orientationchange'));
	}

	describe('initial state', () => {
		it('should return false by default on non-touch device', () => {
			disableTouch();
			setWindowDimensions(1920, 1080);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});

		it('should return false on desktop (non-touch) even with mobile dimensions', () => {
			disableTouch();
			setWindowDimensions(800, 400);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('mobile phone landscape detection', () => {
		it('should return true for mobile phone in landscape (touch + landscape + small height)', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 400); // landscape, height <= 500

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should detect touch via navigator.maxTouchPoints', () => {
			enableTouchViaMaxTouchPoints(5);
			setWindowDimensions(800, 400);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should return true at exactly 500px height boundary', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 500); // exactly at boundary

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should return false at 501px height (tablet territory)', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 501); // just above boundary

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('portrait mode', () => {
		it('should return false in portrait mode on mobile', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(400, 800); // portrait

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});

		it('should return false in portrait mode with small dimensions', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(300, 400); // small but portrait

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('tablet detection', () => {
		it('should return false for iPad in landscape (height > 500)', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(1024, 768); // iPad landscape

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});

		it('should return false for small tablet in landscape', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 600); // small tablet

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('square/equal dimensions', () => {
		it('should return false when width equals height', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(500, 500);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('resize event handling', () => {
		it('should update when window resizes to landscape', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(400, 800); // start in portrait

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);

			// Rotate to landscape
			act(() => {
				setWindowDimensions(800, 400);
				triggerResize();
			});

			expect(result.current).toBe(true);
		});

		it('should update when window resizes to portrait', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 400); // start in landscape

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);

			// Rotate to portrait
			act(() => {
				setWindowDimensions(400, 800);
				triggerResize();
			});

			expect(result.current).toBe(false);
		});

		it('should handle multiple resize events', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(400, 800);

			const { result } = renderHook(() => useMobileLandscape());

			// Multiple orientation changes
			act(() => {
				setWindowDimensions(800, 400);
				triggerResize();
			});
			expect(result.current).toBe(true);

			act(() => {
				setWindowDimensions(400, 800);
				triggerResize();
			});
			expect(result.current).toBe(false);

			act(() => {
				setWindowDimensions(800, 400);
				triggerResize();
			});
			expect(result.current).toBe(true);
		});
	});

	describe('orientationchange event handling', () => {
		it('should update on orientationchange event', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(400, 800); // start in portrait

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);

			// Simulate orientation change
			act(() => {
				setWindowDimensions(800, 400);
				triggerOrientationChange();
			});

			expect(result.current).toBe(true);
		});

		it('should handle both resize and orientationchange', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(400, 800);

			const { result } = renderHook(() => useMobileLandscape());

			act(() => {
				setWindowDimensions(800, 400);
				triggerResize();
				triggerOrientationChange();
			});

			expect(result.current).toBe(true);
		});
	});

	describe('event listener cleanup', () => {
		it('should remove event listeners on unmount', () => {
			const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
			const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

			enableTouchViaOntouchstart();
			setWindowDimensions(800, 400);

			const { unmount } = renderHook(() => useMobileLandscape());

			expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
			expect(addEventListenerSpy).toHaveBeenCalledWith('orientationchange', expect.any(Function));

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function));
			expect(removeEventListenerSpy).toHaveBeenCalledWith(
				'orientationchange',
				expect.any(Function)
			);

			addEventListenerSpy.mockRestore();
			removeEventListenerSpy.mockRestore();
		});
	});

	describe('boundary conditions', () => {
		it('should return true at minimum landscape dimensions', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(2, 1); // minimum landscape (width > height)

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should return true at height = 0', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(100, 0);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should handle very large dimensions', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(10000, 400);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should handle zero touch points', () => {
			// Ensure no touch
			delete (window as any).ontouchstart;
			Object.defineProperty(navigator, 'maxTouchPoints', {
				writable: true,
				configurable: true,
				value: 0,
			});
			setWindowDimensions(800, 400);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('common device scenarios', () => {
		it('should detect iPhone in landscape', () => {
			enableTouchViaMaxTouchPoints(5);
			setWindowDimensions(844, 390); // iPhone 12 Pro landscape

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should detect iPhone in portrait as false', () => {
			enableTouchViaMaxTouchPoints(5);
			setWindowDimensions(390, 844); // iPhone 12 Pro portrait

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});

		it('should detect Android phone in landscape', () => {
			enableTouchViaMaxTouchPoints(10);
			setWindowDimensions(915, 412); // Pixel 5 landscape

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);
		});

		it('should not detect iPad Pro as mobile landscape', () => {
			enableTouchViaMaxTouchPoints(5);
			setWindowDimensions(1366, 1024); // iPad Pro landscape

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});

		it('should not detect desktop with large monitor', () => {
			disableTouch();
			setWindowDimensions(2560, 1440);

			const { result } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(false);
		});
	});

	describe('hook return type', () => {
		it('should return a boolean', () => {
			disableTouch();
			setWindowDimensions(1920, 1080);

			const { result } = renderHook(() => useMobileLandscape());
			expect(typeof result.current).toBe('boolean');
		});
	});

	describe('re-render behavior', () => {
		it('should maintain state across re-renders', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 400);

			const { result, rerender } = renderHook(() => useMobileLandscape());
			expect(result.current).toBe(true);

			rerender();
			expect(result.current).toBe(true);

			rerender();
			expect(result.current).toBe(true);
		});

		it('should provide consistent references', () => {
			enableTouchViaOntouchstart();
			setWindowDimensions(800, 400);

			const { result, rerender } = renderHook(() => useMobileLandscape());
			const firstValue = result.current;

			rerender();
			const secondValue = result.current;

			expect(firstValue).toBe(secondValue);
		});
	});
});

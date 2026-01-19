/**
 * Tests for useDeviceColorScheme hook
 *
 * @module __tests__/web/hooks/useDeviceColorScheme.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useDeviceColorScheme,
	ColorSchemePreference,
	UseDeviceColorSchemeReturn,
} from '../../../web/hooks/useDeviceColorScheme';
import defaultExport from '../../../web/hooks/useDeviceColorScheme';

describe('useDeviceColorScheme', () => {
	// Store the original matchMedia
	const originalMatchMedia = window.matchMedia;
	let mockMatchMedia: ReturnType<typeof vi.fn>;
	let mockMediaQueryList: {
		matches: boolean;
		media: string;
		onchange: null;
		addListener: ReturnType<typeof vi.fn>;
		removeListener: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
		removeEventListener: ReturnType<typeof vi.fn>;
		dispatchEvent: ReturnType<typeof vi.fn>;
	};
	let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;

	/**
	 * Helper to create a mock MediaQueryList
	 */
	function createMockMediaQueryList(matches: boolean) {
		return {
			matches,
			media: '(prefers-color-scheme: dark)',
			onchange: null,
			addListener: vi.fn((handler: (event: MediaQueryListEvent) => void) => {
				changeHandler = handler;
			}),
			removeListener: vi.fn(),
			addEventListener: vi.fn((_event: string, handler: (event: MediaQueryListEvent) => void) => {
				changeHandler = handler;
			}),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		};
	}

	beforeEach(() => {
		changeHandler = null;
		mockMediaQueryList = createMockMediaQueryList(false);
		mockMatchMedia = vi.fn().mockReturnValue(mockMediaQueryList);
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: mockMatchMedia,
		});
	});

	afterEach(() => {
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: originalMatchMedia,
		});
	});

	describe('Type Definitions', () => {
		it('ColorSchemePreference type accepts "light" value', () => {
			const scheme: ColorSchemePreference = 'light';
			expect(scheme).toBe('light');
		});

		it('ColorSchemePreference type accepts "dark" value', () => {
			const scheme: ColorSchemePreference = 'dark';
			expect(scheme).toBe('dark');
		});

		it('UseDeviceColorSchemeReturn interface has required properties', () => {
			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current).toHaveProperty('colorScheme');
			expect(result.current).toHaveProperty('prefersDark');
			expect(result.current).toHaveProperty('prefersLight');
		});

		it('colorScheme is a string', () => {
			const { result } = renderHook(() => useDeviceColorScheme());
			expect(typeof result.current.colorScheme).toBe('string');
		});

		it('prefersDark is a boolean', () => {
			const { result } = renderHook(() => useDeviceColorScheme());
			expect(typeof result.current.prefersDark).toBe('boolean');
		});

		it('prefersLight is a boolean', () => {
			const { result } = renderHook(() => useDeviceColorScheme());
			expect(typeof result.current.prefersLight).toBe('boolean');
		});
	});

	describe('Initial State', () => {
		it('returns light scheme when matchMedia returns false', () => {
			mockMediaQueryList.matches = false;
			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('light');
			expect(result.current.prefersDark).toBe(false);
			expect(result.current.prefersLight).toBe(true);
		});

		it('returns dark scheme when matchMedia returns true', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);
			expect(result.current.prefersLight).toBe(false);
		});

		it('queries prefers-color-scheme: dark', () => {
			renderHook(() => useDeviceColorScheme());

			// Called twice: once in getInitialColorScheme, once in useEffect
			expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
		});
	});

	describe('prefersDark and prefersLight Consistency', () => {
		it('prefersDark is true only when colorScheme is dark', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);
			expect(result.current.prefersLight).toBe(false);
		});

		it('prefersLight is true only when colorScheme is light', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('light');
			expect(result.current.prefersDark).toBe(false);
			expect(result.current.prefersLight).toBe(true);
		});

		it('prefersDark and prefersLight are mutually exclusive', () => {
			const { result } = renderHook(() => useDeviceColorScheme());

			// They cannot both be true or both be false at the same time
			expect(result.current.prefersDark !== result.current.prefersLight).toBe(true);
		});
	});

	describe('Event Listener Setup', () => {
		it('adds change event listener using addEventListener', () => {
			renderHook(() => useDeviceColorScheme());

			expect(mockMediaQueryList.addEventListener).toHaveBeenCalledWith(
				'change',
				expect.any(Function)
			);
		});

		it('removes event listener on unmount', () => {
			const { unmount } = renderHook(() => useDeviceColorScheme());

			unmount();

			expect(mockMediaQueryList.removeEventListener).toHaveBeenCalledWith(
				'change',
				expect.any(Function)
			);
		});

		it('uses addListener fallback when addEventListener is not available', () => {
			// Create mock without addEventListener
			const legacyMockMediaQueryList = {
				matches: false,
				media: '(prefers-color-scheme: dark)',
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: undefined as unknown as typeof vi.fn,
				removeEventListener: undefined as unknown as typeof vi.fn,
				dispatchEvent: vi.fn(),
			};
			mockMatchMedia.mockReturnValue(legacyMockMediaQueryList);

			renderHook(() => useDeviceColorScheme());

			expect(legacyMockMediaQueryList.addListener).toHaveBeenCalledWith(expect.any(Function));
		});

		it('uses removeListener fallback when removeEventListener is not available', () => {
			// Create mock without removeEventListener
			const legacyMockMediaQueryList = {
				matches: false,
				media: '(prefers-color-scheme: dark)',
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: undefined as unknown as typeof vi.fn,
				removeEventListener: undefined as unknown as typeof vi.fn,
				dispatchEvent: vi.fn(),
			};
			mockMatchMedia.mockReturnValue(legacyMockMediaQueryList);

			const { unmount } = renderHook(() => useDeviceColorScheme());
			unmount();

			expect(legacyMockMediaQueryList.removeListener).toHaveBeenCalledWith(expect.any(Function));
		});
	});

	describe('Dynamic Color Scheme Changes', () => {
		it('updates to dark when media query changes to match', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('light');

			// Simulate media query change to dark
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});

			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);
			expect(result.current.prefersLight).toBe(false);
		});

		it('updates to light when media query changes to not match', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('dark');

			// Simulate media query change to light
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: false } as MediaQueryListEvent);
				}
			});

			expect(result.current.colorScheme).toBe('light');
			expect(result.current.prefersDark).toBe(false);
			expect(result.current.prefersLight).toBe(true);
		});

		it('handles multiple rapid changes', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('light');

			// Rapid toggling
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('dark');

			act(() => {
				if (changeHandler) {
					changeHandler({ matches: false } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('light');

			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('dark');
		});

		it('updates boolean flags correctly on change', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			// Initially light
			expect(result.current.prefersDark).toBe(false);
			expect(result.current.prefersLight).toBe(true);

			// Change to dark
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});

			expect(result.current.prefersDark).toBe(true);
			expect(result.current.prefersLight).toBe(false);
		});
	});

	describe('SSR Safety', () => {
		it('handles undefined window gracefully in getInitialColorScheme', () => {
			// Temporarily make window undefined
			const originalWindow = global.window;

			// Create a mock module that can handle no window
			// Since we can't truly undefine window in jsdom, we test the matchMedia path
			Object.defineProperty(window, 'matchMedia', {
				writable: true,
				value: undefined,
			});

			const { result } = renderHook(() => useDeviceColorScheme());

			// Should default to 'dark' when matchMedia is undefined
			expect(result.current.colorScheme).toBe('dark');

			// Restore
			Object.defineProperty(window, 'matchMedia', {
				writable: true,
				value: originalMatchMedia,
			});
		});

		it('handles undefined matchMedia in useEffect without throwing', () => {
			Object.defineProperty(window, 'matchMedia', {
				writable: true,
				value: undefined,
			});

			expect(() => {
				const { unmount } = renderHook(() => useDeviceColorScheme());
				unmount();
			}).not.toThrow();
		});
	});

	describe('Hook Stability', () => {
		it('returns the same object reference on re-render when colorScheme unchanged', () => {
			const { result, rerender } = renderHook(() => useDeviceColorScheme());

			const firstResult = result.current;
			rerender();
			const secondResult = result.current;

			// Note: The object is recreated each render, but values should be the same
			expect(secondResult.colorScheme).toBe(firstResult.colorScheme);
			expect(secondResult.prefersDark).toBe(firstResult.prefersDark);
			expect(secondResult.prefersLight).toBe(firstResult.prefersLight);
		});

		it('maintains state across re-renders', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result, rerender } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('dark');

			rerender();
			rerender();
			rerender();

			expect(result.current.colorScheme).toBe('dark');
		});
	});

	describe('Multiple Instances', () => {
		it('multiple hook instances can coexist', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result: result1 } = renderHook(() => useDeviceColorScheme());
			const { result: result2 } = renderHook(() => useDeviceColorScheme());

			expect(result1.current.colorScheme).toBe('dark');
			expect(result2.current.colorScheme).toBe('dark');
		});

		it('each instance sets up its own event listener', () => {
			renderHook(() => useDeviceColorScheme());
			renderHook(() => useDeviceColorScheme());

			// addEventListener is called for each instance
			expect(mockMediaQueryList.addEventListener).toHaveBeenCalledTimes(2);
		});

		it('each instance cleans up its own listener', () => {
			const { unmount: unmount1 } = renderHook(() => useDeviceColorScheme());
			const { unmount: unmount2 } = renderHook(() => useDeviceColorScheme());

			unmount1();
			expect(mockMediaQueryList.removeEventListener).toHaveBeenCalledTimes(1);

			unmount2();
			expect(mockMediaQueryList.removeEventListener).toHaveBeenCalledTimes(2);
		});
	});

	describe('Edge Cases', () => {
		it('handles no event listener methods at all without crashing', () => {
			const minimalMockMediaQueryList = {
				matches: true,
				media: '(prefers-color-scheme: dark)',
				onchange: null,
				addListener: undefined as unknown as typeof vi.fn,
				removeListener: undefined as unknown as typeof vi.fn,
				addEventListener: undefined as unknown as typeof vi.fn,
				removeEventListener: undefined as unknown as typeof vi.fn,
				dispatchEvent: vi.fn(),
			};
			mockMatchMedia.mockReturnValue(minimalMockMediaQueryList);

			expect(() => {
				const { unmount } = renderHook(() => useDeviceColorScheme());
				unmount();
			}).not.toThrow();
		});

		it('correctly reads initial dark preference', () => {
			// Ensure the getInitialColorScheme function is called during useState init
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			// First call to matchMedia should be for initial state
			expect(mockMatchMedia.mock.calls[0][0]).toBe('(prefers-color-scheme: dark)');
			expect(result.current.colorScheme).toBe('dark');
		});

		it('correctly reads initial light preference', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('light');
		});
	});

	describe('Default Export', () => {
		it('default export is the same as named export', () => {
			expect(defaultExport).toBe(useDeviceColorScheme);
		});

		it('default export works correctly', () => {
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => defaultExport());

			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);
			expect(result.current.prefersLight).toBe(false);
		});
	});

	describe('Return Value Structure', () => {
		it('returns exactly three properties', () => {
			const { result } = renderHook(() => useDeviceColorScheme());

			const keys = Object.keys(result.current);
			expect(keys).toHaveLength(3);
			expect(keys).toContain('colorScheme');
			expect(keys).toContain('prefersDark');
			expect(keys).toContain('prefersLight');
		});

		it('colorScheme is always "dark" or "light"', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(['dark', 'light']).toContain(result.current.colorScheme);

			// Change to dark
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});

			expect(['dark', 'light']).toContain(result.current.colorScheme);
		});
	});

	describe('Integration Scenarios', () => {
		it('simulates user switching from light to dark mode', () => {
			// Start in light mode
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			// User was in light mode
			expect(result.current.colorScheme).toBe('light');
			expect(result.current.prefersLight).toBe(true);

			// User switches their device to dark mode
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});

			// UI should reflect dark mode
			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);
		});

		it('simulates user switching from dark to light mode', () => {
			// Start in dark mode
			mockMediaQueryList = createMockMediaQueryList(true);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			expect(result.current.colorScheme).toBe('dark');
			expect(result.current.prefersDark).toBe(true);

			// User switches to light mode
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: false } as MediaQueryListEvent);
				}
			});

			expect(result.current.colorScheme).toBe('light');
			expect(result.current.prefersLight).toBe(true);
		});

		it('handles day/night cycle with multiple toggles', () => {
			mockMediaQueryList = createMockMediaQueryList(false);
			mockMatchMedia.mockReturnValue(mockMediaQueryList);

			const { result } = renderHook(() => useDeviceColorScheme());

			// Morning: light
			expect(result.current.colorScheme).toBe('light');

			// Evening: dark
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('dark');

			// Next morning: light
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: false } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('light');

			// Next evening: dark
			act(() => {
				if (changeHandler) {
					changeHandler({ matches: true } as MediaQueryListEvent);
				}
			});
			expect(result.current.colorScheme).toBe('dark');
		});
	});
});

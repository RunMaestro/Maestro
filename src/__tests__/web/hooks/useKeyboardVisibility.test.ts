/**
 * Tests for useKeyboardVisibility hook
 *
 * Covers:
 * - Default state when Visual Viewport API is unavailable
 * - Keyboard offset calculation when viewport shrinks
 * - Event listener registration and cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useKeyboardVisibility } from '../../../web/hooks/useKeyboardVisibility';

type MockViewport = {
	height: number;
	offsetTop: number;
	addEventListener: (event: string, handler: () => void) => void;
	removeEventListener: (event: string, handler: () => void) => void;
};

function setVisualViewport(mockViewport?: MockViewport) {
	if (mockViewport) {
		Object.defineProperty(window, 'visualViewport', {
			value: mockViewport,
			configurable: true,
			writable: true,
		});
	} else {
		Object.defineProperty(window, 'visualViewport', {
			value: undefined,
			configurable: true,
			writable: true,
		});
	}
}

describe('useKeyboardVisibility', () => {
	const originalInnerHeight = window.innerHeight;

	beforeEach(() => {
		vi.restoreAllMocks();
		setVisualViewport(undefined);
	});

	afterEach(() => {
		window.innerHeight = originalInnerHeight;
		setVisualViewport(undefined);
	});

	it('returns default state when Visual Viewport API is unavailable', () => {
		setVisualViewport(undefined);
		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.keyboardOffset).toBe(0);
		expect(result.current.isKeyboardVisible).toBe(false);
	});

	it('calculates keyboard offset from viewport height', async () => {
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();

		setVisualViewport({
			height: 600,
			offsetTop: 0,
			addEventListener,
			removeEventListener,
		});

		window.innerHeight = 800;

		const { result } = renderHook(() => useKeyboardVisibility());

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(200);
			expect(result.current.isKeyboardVisible).toBe(true);
		});
	});

	it('registers and cleans up viewport listeners', () => {
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();

		setVisualViewport({
			height: 700,
			offsetTop: 0,
			addEventListener,
			removeEventListener,
		});

		const { unmount } = renderHook(() => useKeyboardVisibility());

		expect(addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));

		unmount();

		expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
	});

	it('recalculates keyboard offset when the visual viewport resizes', async () => {
		const handlers = new Map<string, () => void>();
		const viewport = {
			height: 780,
			offsetTop: 0,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				handlers.set(event, handler);
			}),
			removeEventListener: vi.fn(),
		};

		setVisualViewport(viewport);
		window.innerHeight = 800;

		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.keyboardOffset).toBe(0);

		viewport.height = 620;
		await act(async () => {
			handlers.get('resize')?.();
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(180);
			expect(result.current.isKeyboardVisible).toBe(true);
		});
	});

	it('ignores scroll recalculation while the keyboard is hidden', async () => {
		const handlers = new Map<string, () => void>();
		const viewport = {
			height: 790,
			offsetTop: 0,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				handlers.set(event, handler);
			}),
			removeEventListener: vi.fn(),
		};

		setVisualViewport(viewport);
		window.innerHeight = 800;

		const { result } = renderHook(() => useKeyboardVisibility());

		viewport.height = 600;
		await act(async () => {
			handlers.get('scroll')?.();
		});

		expect(result.current.keyboardOffset).toBe(0);
		expect(result.current.isKeyboardVisible).toBe(false);
	});

	it('recalculates keyboard offset on scroll while the keyboard is visible', async () => {
		const handlers = new Map<string, () => void>();
		const viewport = {
			height: 600,
			offsetTop: 0,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				handlers.set(event, handler);
			}),
			removeEventListener: vi.fn(),
		};

		setVisualViewport(viewport);
		window.innerHeight = 800;

		const { result } = renderHook(() => useKeyboardVisibility());

		await waitFor(() => {
			expect(result.current.isKeyboardVisible).toBe(true);
		});

		viewport.height = 650;
		viewport.offsetTop = 25;
		await act(async () => {
			handlers.get('scroll')?.();
		});

		await waitFor(() => {
			expect(result.current.keyboardOffset).toBe(125);
			expect(result.current.isKeyboardVisible).toBe(true);
		});
	});

	it('handles a missing visual viewport during a resize event', async () => {
		const handlers = new Map<string, () => void>();
		const viewport = {
			height: 600,
			offsetTop: 0,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				handlers.set(event, handler);
			}),
			removeEventListener: vi.fn(),
		};

		setVisualViewport(viewport);
		window.innerHeight = 800;

		const { result } = renderHook(() => useKeyboardVisibility());

		await waitFor(() => {
			expect(result.current.isKeyboardVisible).toBe(true);
		});

		setVisualViewport(undefined);
		await act(async () => {
			handlers.get('resize')?.();
		});

		expect(result.current.keyboardOffset).toBe(200);
		expect(result.current.isKeyboardVisible).toBe(true);
	});
});

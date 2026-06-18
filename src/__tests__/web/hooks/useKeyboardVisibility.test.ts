/**
 * Tests for useKeyboardVisibility hook
 *
 * Covers:
 * - Default state when Visual Viewport API is unavailable
 * - Keyboard offset calculation when viewport shrinks
 * - Event listener registration and cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
});

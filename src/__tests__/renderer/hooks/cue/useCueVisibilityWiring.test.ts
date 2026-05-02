/**
 * Tests for useCueVisibilityWiring — forwards renderer visibility
 * changes to the main-process Cue scanner subsystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCueVisibilityWiring } from '../../../../renderer/hooks/cue/useCueVisibilityWiring';

describe('useCueVisibilityWiring', () => {
	let setActive: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setActive = vi.fn().mockResolvedValue(undefined);
		// The cue mock is provided by setup.ts but reset call counts here.
		(window.maestro.cue as unknown as { setActive: typeof setActive }).setActive = setActive;
		// Reset visibility to "visible" between tests.
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('seeds main process with current visibility state on mount', () => {
		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledTimes(1);
		expect(setActive).toHaveBeenCalledWith(false);
	});

	it('seeds with active=true when document is visible at mount', () => {
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledTimes(1);
		expect(setActive).toHaveBeenCalledWith(true);
	});

	it('forwards visibilitychange events as setActive(!hidden)', () => {
		renderHook(() => useCueVisibilityWiring());
		expect(setActive).toHaveBeenCalledWith(true); // mount seed

		// Hide the document and dispatch the event
		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).toHaveBeenLastCalledWith(false);

		// Show the document again
		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).toHaveBeenLastCalledWith(true);
	});

	it('removes its visibilitychange listener on unmount', () => {
		const { unmount } = renderHook(() => useCueVisibilityWiring());
		setActive.mockClear();
		unmount();

		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(setActive).not.toHaveBeenCalled();
	});

	it('does not throw when window.maestro.cue is missing', () => {
		const original = window.maestro.cue;
		(window.maestro as unknown as { cue: unknown }).cue = undefined;
		try {
			expect(() => renderHook(() => useCueVisibilityWiring())).not.toThrow();
		} finally {
			(window.maestro as unknown as { cue: unknown }).cue = original;
		}
	});

	it('swallows IPC rejection without throwing', async () => {
		setActive.mockRejectedValue(new Error('IPC error'));
		expect(() => renderHook(() => useCueVisibilityWiring())).not.toThrow();
		// Wait a microtask for the catch handler.
		await Promise.resolve();
	});
});

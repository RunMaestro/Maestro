/**
 * Tests for useTabDragOut (Phase 3 multi-window tab drag-out detection).
 *
 * The hook snapshots the owning window's bounds at drag start and reports when
 * the cursor leaves them. The behaviours that matter: in-bar reordering is
 * untouched (this hook only flips a boolean), the exit state engages only once
 * the cursor crosses the window edge, the bounds query is async (so early
 * samples are treated as "inside"), and everything resets on drag end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabDragOut } from '../../../../renderer/hooks/tabs/useTabDragOut';
import type { WindowBounds } from '../../../../shared/window-types';

const getBounds = () => vi.mocked(window.maestro.windows.getBounds);

const WINDOW_BOUNDS: WindowBounds = { x: 100, y: 100, width: 800, height: 600 };

/** Arm tracking and flush the async getBounds() query so bounds are loaded. */
async function armWithBounds(
	result: { current: ReturnType<typeof useTabDragOut> },
	bounds: WindowBounds = WINDOW_BOUNDS
): Promise<void> {
	getBounds().mockResolvedValue(bounds);
	await act(async () => {
		result.current.beginDragOut();
	});
}

describe('useTabDragOut', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getBounds().mockResolvedValue(null);
	});

	it('starts idle with no exit state or tracked point', () => {
		const { result } = renderHook(() => useTabDragOut());
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.getDragOutPoint()).toBeNull();
	});

	it('snapshots window bounds on beginDragOut', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);
		expect(getBounds()).toHaveBeenCalledTimes(1);
	});

	it('engages only once the cursor leaves the window bounds', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);

		// Inside the window -> not dragging out.
		act(() => result.current.trackDragOut(200, 200));
		expect(result.current.isDraggingOut).toBe(false);

		// Left of x=100 -> outside.
		act(() => result.current.trackDragOut(50, 200));
		expect(result.current.isDraggingOut).toBe(true);

		// Back inside -> disengages.
		act(() => result.current.trackDragOut(200, 200));
		expect(result.current.isDraggingOut).toBe(false);
	});

	it('records the latest cursor sample in screen coordinates', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);

		act(() => result.current.trackDragOut(640, 480));
		expect(result.current.getDragOutPoint()).toEqual({ x: 640, y: 480 });

		act(() => result.current.trackDragOut(1200, 300));
		expect(result.current.getDragOutPoint()).toEqual({ x: 1200, y: 300 });
	});

	it('treats samples before bounds resolve as inside the window', () => {
		const { result } = renderHook(() => useTabDragOut());
		getBounds().mockResolvedValue(WINDOW_BOUNDS);

		// Sample synchronously, before the async getBounds() microtask settles.
		act(() => {
			result.current.beginDragOut();
			result.current.trackDragOut(5000, 5000); // far outside, but bounds not loaded
		});
		expect(result.current.isDraggingOut).toBe(false);
		// The point is still recorded for later phases to read on drop.
		expect(result.current.getDragOutPoint()).toEqual({ x: 5000, y: 5000 });
	});

	it('ignores the degenerate (0,0) end-of-drag sample', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);

		act(() => result.current.trackDragOut(50, 200)); // outside
		expect(result.current.isDraggingOut).toBe(true);
		const lastPoint = result.current.getDragOutPoint();

		act(() => result.current.trackDragOut(0, 0)); // dropped final event
		// Neither the exit state nor the recorded point changes.
		expect(result.current.isDraggingOut).toBe(true);
		expect(result.current.getDragOutPoint()).toEqual(lastPoint);
	});

	it('resets all tracking on endDragOut', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);

		act(() => result.current.trackDragOut(50, 200)); // outside
		expect(result.current.isDraggingOut).toBe(true);

		act(() => result.current.endDragOut());
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.getDragOutPoint()).toBeNull();
	});

	it('degrades to never-detecting when the windows API is unavailable', () => {
		const original = window.maestro.windows.getBounds;
		// Web build / non-Electron host: getBounds is absent.
		(window.maestro.windows as { getBounds?: unknown }).getBounds = undefined;
		try {
			const { result } = renderHook(() => useTabDragOut());
			act(() => {
				result.current.beginDragOut();
				result.current.trackDragOut(5000, 5000); // far outside
			});
			// No bounds to compare against -> stays "inside", never throws.
			expect(result.current.isDraggingOut).toBe(false);
		} finally {
			window.maestro.windows.getBounds = original;
		}
	});
});

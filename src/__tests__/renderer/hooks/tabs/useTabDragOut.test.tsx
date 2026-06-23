/**
 * Tests for useTabDragOut (Phase 3 multi-window tab drag-out detection).
 *
 * The hook snapshots the owning window's bounds at drag start and reports when
 * the cursor leaves them. The behaviours that matter: in-bar reordering is
 * untouched (this hook only flips a boolean), the exit state engages only once
 * the cursor crosses the window edge, the bounds query is async (so early
 * samples are treated as "inside"), and everything resets on drag end. Once the
 * cursor is outside, each sample also resolves which other Maestro window sits
 * under it (via findWindowAtPoint), coalesced to one in-flight IPC at a time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabDragOut } from '../../../../renderer/hooks/tabs/useTabDragOut';
import type { WindowBounds } from '../../../../shared/window-types';

const getBounds = () => vi.mocked(window.maestro.windows.getBounds);
const findWindowAtPoint = () => vi.mocked(window.maestro.windows.findWindowAtPoint);
const highlightDropZone = () => vi.mocked(window.maestro.windows.highlightDropZone);

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
		// clearAllMocks wipes call history but not implementations, so reset the
		// per-test findWindowAtPoint resolution to "empty space" to avoid leakage.
		findWindowAtPoint().mockReset();
		findWindowAtPoint().mockResolvedValue(null);
	});

	it('starts idle with no exit state, tracked point, or dock target', () => {
		const { result } = renderHook(() => useTabDragOut());
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.isOutsideOwningWindow()).toBe(false);
		expect(result.current.getDragOutPoint()).toBeNull();
		expect(result.current.getTargetWindowId()).toBeNull();
	});

	it('snapshots window bounds on beginDragOut', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);
		expect(getBounds()).toHaveBeenCalledTimes(1);
	});

	it('engages only once the cursor leaves the window bounds', async () => {
		const { result } = renderHook(() => useTabDragOut());
		await armWithBounds(result);

		// Inside the window -> not dragging out. The synchronous getter agrees with
		// the reactive flag at every step (it is what the drop handler reads).
		act(() => result.current.trackDragOut(200, 200));
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.isOutsideOwningWindow()).toBe(false);

		// Left of x=100 -> outside.
		act(() => result.current.trackDragOut(50, 200));
		expect(result.current.isDraggingOut).toBe(true);
		expect(result.current.isOutsideOwningWindow()).toBe(true);

		// Back inside -> disengages.
		act(() => result.current.trackDragOut(200, 200));
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.isOutsideOwningWindow()).toBe(false);
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
		findWindowAtPoint().mockResolvedValue('window-2');

		await act(async () => result.current.trackDragOut(50, 200)); // outside
		expect(result.current.isDraggingOut).toBe(true);
		expect(result.current.getTargetWindowId()).toBe('window-2');

		act(() => result.current.endDragOut());
		expect(result.current.isDraggingOut).toBe(false);
		expect(result.current.isOutsideOwningWindow()).toBe(false);
		expect(result.current.getDragOutPoint()).toBeNull();
		expect(result.current.getTargetWindowId()).toBeNull();
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

	describe('dock-target resolution', () => {
		it('does not look up a window while the cursor stays inside the bounds', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);

			act(() => result.current.trackDragOut(200, 200)); // inside
			expect(findWindowAtPoint()).not.toHaveBeenCalled();
			expect(result.current.getTargetWindowId()).toBeNull();
		});

		it('resolves the Maestro window under the cursor once it leaves the bounds', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');

			await act(async () => result.current.trackDragOut(50, 200)); // left of x=100
			expect(findWindowAtPoint()).toHaveBeenCalledWith(50, 200);
			expect(result.current.getTargetWindowId()).toBe('window-2');
		});

		it('reports no dock target over empty space', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue(null); // no window under the cursor

			await act(async () => result.current.trackDragOut(50, 200)); // outside
			expect(findWindowAtPoint()).toHaveBeenCalledWith(50, 200);
			expect(result.current.getTargetWindowId()).toBeNull();
		});

		it('clears the dock target when the cursor returns inside the window', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');

			await act(async () => result.current.trackDragOut(50, 200)); // outside
			expect(result.current.getTargetWindowId()).toBe('window-2');

			act(() => result.current.trackDragOut(200, 200)); // back inside
			expect(result.current.getTargetWindowId()).toBeNull();
		});

		it('coalesces overlapping lookups and replays the latest point on settle', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);

			// First lookup hangs; later calls resolve immediately to a new window.
			let resolveFirst!: (id: string | null) => void;
			findWindowAtPoint().mockReturnValueOnce(
				new Promise<string | null>((resolve) => {
					resolveFirst = resolve;
				})
			);
			findWindowAtPoint().mockResolvedValue('window-3');

			// First exit sample -> one IPC in flight for point A.
			act(() => result.current.trackDragOut(50, 200));
			expect(findWindowAtPoint()).toHaveBeenCalledTimes(1);
			expect(findWindowAtPoint()).toHaveBeenLastCalledWith(50, 200);

			// Second sample arrives mid-flight -> parked, no extra IPC yet.
			act(() => result.current.trackDragOut(40, 250));
			expect(findWindowAtPoint()).toHaveBeenCalledTimes(1);

			// First settles -> the parked point B replays as the next IPC.
			await act(async () => {
				resolveFirst('window-2');
			});
			await act(async () => {}); // drain the replayed lookup's microtasks
			expect(findWindowAtPoint()).toHaveBeenCalledTimes(2);
			expect(findWindowAtPoint()).toHaveBeenLastCalledWith(40, 250);
			expect(result.current.getTargetWindowId()).toBe('window-3');
		});

		it('does not throw or resolve a target when findWindowAtPoint is unavailable', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			const original = window.maestro.windows.findWindowAtPoint;
			(window.maestro.windows as { findWindowAtPoint?: unknown }).findWindowAtPoint = undefined;
			try {
				act(() => result.current.trackDragOut(50, 200)); // outside, but no IPC available
				expect(result.current.isDraggingOut).toBe(true);
				expect(result.current.getTargetWindowId()).toBeNull();
			} finally {
				window.maestro.windows.findWindowAtPoint = original;
			}
		});
	});

	describe('drop-zone highlight', () => {
		it('lights up the target window once the cursor hovers it', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');

			await act(async () => result.current.trackDragOut(50, 200)); // over window-2
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', true);
		});

		it('dims the previous window and lights the new one when the target changes', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);

			findWindowAtPoint().mockResolvedValue('window-2');
			await act(async () => result.current.trackDragOut(50, 200));
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', true);

			findWindowAtPoint().mockResolvedValue('window-3');
			await act(async () => result.current.trackDragOut(40, 250));
			// Old target cleared, new target lit - never two highlights at once.
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', false);
			expect(highlightDropZone()).toHaveBeenCalledWith('window-3', true);
		});

		it('clears the highlight when the cursor returns inside the owning window', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');

			await act(async () => result.current.trackDragOut(50, 200)); // over window-2
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', true);

			act(() => result.current.trackDragOut(200, 200)); // back inside -> clears
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', false);
		});

		it('clears the active highlight on endDragOut', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');

			await act(async () => result.current.trackDragOut(50, 200));
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', true);

			act(() => result.current.endDragOut());
			expect(highlightDropZone()).toHaveBeenCalledWith('window-2', false);
		});

		it('does not re-light a window when the lookup settles after the drag ended', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);

			// A lookup is in flight but unresolved when the drag ends.
			let resolveLate!: (id: string | null) => void;
			findWindowAtPoint().mockReturnValueOnce(
				new Promise<string | null>((resolve) => {
					resolveLate = resolve;
				})
			);

			act(() => result.current.trackDragOut(50, 200)); // outside -> lookup dispatched
			act(() => result.current.endDragOut()); // drag torn down first
			highlightDropZone().mockClear();

			// The stale resolution arrives - it must NOT light a window that can no
			// longer be cleared.
			await act(async () => {
				resolveLate('window-2');
			});
			expect(highlightDropZone()).not.toHaveBeenCalled();
			expect(result.current.getTargetWindowId()).toBeNull();
		});

		it('does not throw when highlightDropZone is unavailable', async () => {
			const { result } = renderHook(() => useTabDragOut());
			await armWithBounds(result);
			findWindowAtPoint().mockResolvedValue('window-2');
			const original = window.maestro.windows.highlightDropZone;
			(window.maestro.windows as { highlightDropZone?: unknown }).highlightDropZone = undefined;
			try {
				await act(async () => result.current.trackDragOut(50, 200));
				// The target still resolves; only the highlight side-effect is skipped.
				expect(result.current.getTargetWindowId()).toBe('window-2');
			} finally {
				window.maestro.windows.highlightDropZone = original;
			}
		});
	});
});

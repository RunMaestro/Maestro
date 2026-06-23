import { useCallback, useRef, useState } from 'react';
import { isPointOutsideWindowBounds, type WindowBounds } from '../../../shared/window-types';
import { logger } from '../../utils/logger';

/**
 * Latest cursor sample fed to {@link UseTabDragOutReturn.trackDragOut}, in screen
 * coordinates. Screen-relative (not client-relative) so it can be compared
 * directly against a window's `getBounds()` and, in later phases, handed to
 * `findWindowAtPoint` / `windows.create` to land a detached agent at the drop
 * point.
 */
export interface DragOutPoint {
	x: number;
	y: number;
}

export interface UseTabDragOutReturn {
	/**
	 * True while a tab drag's cursor is currently outside the owning window's
	 * bounds. Flips only as the cursor crosses the window edge (not on every
	 * move), so consumers can drive detach affordances without per-frame churn.
	 */
	isDraggingOut: boolean;
	/**
	 * Arm exit tracking for a new drag: snapshots this window's on-screen bounds
	 * (async via `windows.getBounds()`). Call from the tab's `onDragStart`. Until
	 * the bounds resolve, the cursor is treated as inside the window.
	 */
	beginDragOut: () => void;
	/**
	 * Feed a screen-coordinate cursor sample (typically `e.screenX`/`e.screenY`
	 * from the tab's `onDrag`). Records the point and recomputes whether the
	 * cursor has left the window.
	 */
	trackDragOut: (screenX: number, screenY: number) => void;
	/**
	 * The last cursor sample in screen coordinates, or `null` when no drag is in
	 * flight. Read on drop (`onDragEnd`) by later phases to decide the drop
	 * target / new-window position.
	 */
	getDragOutPoint: () => DragOutPoint | null;
	/** Clear all drag-out tracking. Call from the tab's `onDragEnd` / `onDrop`. */
	endDragOut: () => void;
}

/**
 * Drag-out detection for the tab strip (Phase 3 multi-window).
 *
 * Tracks a tab drag in screen coordinates and reports when the cursor leaves the
 * owning window's bounds. This is the foundation the cross-window move / new-
 * window-on-drop wiring builds on: in-bar reordering is untouched (it runs on
 * `onDragOver`/`onDrop` against sibling tabs), and drag-out only "engages" once
 * the cursor exits the window.
 *
 * Bounds are snapshotted once per drag (on {@link UseTabDragOutReturn.beginDragOut})
 * rather than re-queried per move - a window is not resized mid-drag, and one
 * IPC round-trip per drag keeps the move path cheap. The latest cursor point is
 * kept in a ref so feeding samples never forces a re-render; only the boolean
 * exit state is React state, and it is set only when it actually changes.
 */
export function useTabDragOut(): UseTabDragOutReturn {
	const [isDraggingOut, setIsDraggingOut] = useState(false);
	// Window bounds captured at drag start; null until the async query resolves
	// (or when no drag is in flight). Ref, not state: reading it never needs a
	// re-render and it must be live for the very next trackDragOut call.
	const boundsRef = useRef<WindowBounds | null>(null);
	const pointRef = useRef<DragOutPoint | null>(null);

	const beginDragOut = useCallback(() => {
		boundsRef.current = null;
		pointRef.current = null;
		setIsDraggingOut(false);
		// getBounds is absent outside the Electron preload (web build / unit tests);
		// degrade to "never detects an exit" rather than throwing mid-drag.
		const getBounds = window.maestro?.windows?.getBounds;
		if (!getBounds) return;
		void getBounds()
			.then((bounds) => {
				boundsRef.current = bounds;
			})
			.catch((error) => {
				logger.warn('[useTabDragOut] failed to read window bounds', error);
			});
	}, []);

	const trackDragOut = useCallback((screenX: number, screenY: number) => {
		// The drag's final event can report (0,0); ignore that degenerate sample so
		// it does not spuriously flip the exit state at the end of a drag.
		if (screenX === 0 && screenY === 0) return;
		pointRef.current = { x: screenX, y: screenY };
		const bounds = boundsRef.current;
		// No bounds yet (query still in flight) -> treat as inside the window.
		const outside = bounds ? isPointOutsideWindowBounds(pointRef.current, bounds) : false;
		setIsDraggingOut((prev) => (prev === outside ? prev : outside));
	}, []);

	const getDragOutPoint = useCallback(() => pointRef.current, []);

	const endDragOut = useCallback(() => {
		boundsRef.current = null;
		pointRef.current = null;
		setIsDraggingOut(false);
	}, []);

	return { isDraggingOut, beginDragOut, trackDragOut, getDragOutPoint, endDragOut };
}

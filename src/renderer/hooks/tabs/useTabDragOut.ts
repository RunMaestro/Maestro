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
	 * flight. Read on drop (`onDragEnd`) to position a spawned new window at the
	 * drop point.
	 */
	getDragOutPoint: () => DragOutPoint | null;
	/**
	 * Synchronous read of whether the latest sample sits outside the owning
	 * window's bounds - the same fact as {@link UseTabDragOutReturn.isDraggingOut}
	 * but readable inside a `dragend` handler without a stale closure or a reliance
	 * on React having flushed the last `isDraggingOut` render. Used on drop to tell
	 * an empty-space release (spawn a new window) apart from an in-bar reorder
	 * (both leave {@link UseTabDragOutReturn.getTargetWindowId} `null`).
	 */
	isOutsideOwningWindow: () => boolean;
	/**
	 * The ID of another Maestro window currently under the drag cursor, or `null`
	 * when the cursor is over empty space (or still inside the owning window).
	 * Resolved via `windows.findWindowAtPoint()` while {@link UseTabDragOutReturn.isDraggingOut}
	 * is true and read on drop to choose dock-into-window vs. spawn-new-window.
	 * The owning window is never reported - resolution only runs once the cursor
	 * is outside its bounds, which the point can no longer be inside.
	 */
	getTargetWindowId: () => string | null;
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
 *
 * While the cursor is outside the owning window, each sample also resolves which
 * other Maestro window (if any) sits under it via `windows.findWindowAtPoint()`.
 * That lookup is async, so it is coalesced to a single in-flight IPC: the newest
 * point arriving mid-flight is stashed and fired when the previous one settles,
 * trailing-throttling a fast drag to the round-trip rate instead of flooding the
 * main process. The resolved target is held in a ref for the drop handler to read.
 */
export function useTabDragOut(): UseTabDragOutReturn {
	const [isDraggingOut, setIsDraggingOut] = useState(false);
	// Window bounds captured at drag start; null until the async query resolves
	// (or when no drag is in flight). Ref, not state: reading it never needs a
	// re-render and it must be live for the very next trackDragOut call.
	const boundsRef = useRef<WindowBounds | null>(null);
	const pointRef = useRef<DragOutPoint | null>(null);
	// Synchronous mirror of isDraggingOut: the drop handler reads it without a
	// stale closure (the React state may not have re-rendered between the last
	// onDrag and dragend). Drives the empty-space-vs-reorder decision on drop.
	const isOutsideRef = useRef(false);
	// The other Maestro window under the cursor while dragging out, or null over
	// empty space / inside the owning window. Ref, not state: read synchronously
	// on drop, and the cross-window highlight (a later task) drives off broadcasts.
	const targetWindowIdRef = useRef<string | null>(null);
	// True while a findWindowAtPoint IPC is outstanding; the latest point that
	// arrived during that window is parked here and replayed once it resolves.
	const lookupInFlightRef = useRef(false);
	const pendingLookupRef = useRef<DragOutPoint | null>(null);
	// True between beginDragOut and endDragOut. Guards a findWindowAtPoint that
	// resolves AFTER the drag ended from re-lighting a window that can no longer be
	// cleared (the drop handler already read the target and tore the drag down).
	const isDraggingRef = useRef(false);

	// Fire-and-forget toggle of the drop-zone highlight on another window's tab
	// bar. Absent outside the Electron preload (web build / unit tests) -> no-op.
	const highlightDropZone = useCallback((windowId: string, active: boolean) => {
		const toggle = window.maestro?.windows?.highlightDropZone;
		if (!toggle) return;
		void toggle(windowId, active).catch((error) => {
			logger.warn('[useTabDragOut] failed to toggle drop-zone highlight', error);
		});
	}, []);

	// Single writer for the resolved dock target. On every transition it also
	// drives the cross-window drop-zone highlight: dim the window we just left,
	// light the one we just entered. Keeping this the only mutator of
	// targetWindowIdRef (read synchronously on drop) guarantees a highlight can
	// never outlive its hover.
	const applyTargetWindow = useCallback(
		(id: string | null) => {
			const prev = targetWindowIdRef.current;
			if (prev === id) return;
			targetWindowIdRef.current = id;
			if (prev) highlightDropZone(prev, false);
			if (id) highlightDropZone(id, true);
		},
		[highlightDropZone]
	);

	const resetLookup = useCallback(() => {
		// Clears targetWindowIdRef and any active highlight in one step.
		applyTargetWindow(null);
		lookupInFlightRef.current = false;
		pendingLookupRef.current = null;
	}, [applyTargetWindow]);

	// Named function expression so the trailing replay can self-reference without
	// a ref dance or an exhaustive-deps cycle.
	const resolveTargetWindow = useCallback(
		function resolveTargetWindow(point: DragOutPoint): void {
			// findWindowAtPoint is absent outside the Electron preload (web build / unit
			// tests); degrade to "no dock target" rather than throwing mid-drag.
			const findWindowAtPoint = window.maestro?.windows?.findWindowAtPoint;
			if (!findWindowAtPoint) return;
			// Only one lookup in flight: park the newest point and replay it on settle.
			if (lookupInFlightRef.current) {
				pendingLookupRef.current = point;
				return;
			}
			lookupInFlightRef.current = true;
			void findWindowAtPoint(point.x, point.y)
				.then((windowId) => {
					// A result that lands after the drag ended would re-light a window with
					// no drag left to clear it; drop it.
					if (!isDraggingRef.current) return;
					applyTargetWindow(windowId);
				})
				.catch((error) => {
					logger.warn('[useTabDragOut] failed to resolve target window', error);
					applyTargetWindow(null);
				})
				.finally(() => {
					lookupInFlightRef.current = false;
					const pending = pendingLookupRef.current;
					pendingLookupRef.current = null;
					// A newer sample arrived mid-flight - resolve it now the IPC is free.
					if (pending && isDraggingRef.current) resolveTargetWindow(pending);
				});
		},
		[applyTargetWindow]
	);

	const beginDragOut = useCallback(() => {
		isDraggingRef.current = true;
		boundsRef.current = null;
		pointRef.current = null;
		isOutsideRef.current = false;
		resetLookup();
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
	}, [resetLookup]);

	const trackDragOut = useCallback(
		(screenX: number, screenY: number) => {
			// The drag's final event can report (0,0); ignore that degenerate sample so
			// it does not spuriously flip the exit state at the end of a drag.
			if (screenX === 0 && screenY === 0) return;
			const point = { x: screenX, y: screenY };
			pointRef.current = point;
			const bounds = boundsRef.current;
			// No bounds yet (query still in flight) -> treat as inside the window.
			const outside = bounds ? isPointOutsideWindowBounds(point, bounds) : false;
			if (outside) {
				// Cursor has left the owning window: find the Maestro window under it so
				// a drop can dock there, else fall back to spawning a new window.
				resolveTargetWindow(point);
			} else {
				// Inside the owning window (or bounds unresolved): no dock target, and
				// clear any highlight we lit on a window we have since moved back off.
				applyTargetWindow(null);
			}
			isOutsideRef.current = outside;
			setIsDraggingOut((prev) => (prev === outside ? prev : outside));
		},
		[resolveTargetWindow, applyTargetWindow]
	);

	const getDragOutPoint = useCallback(() => pointRef.current, []);

	const isOutsideOwningWindow = useCallback(() => isOutsideRef.current, []);

	const getTargetWindowId = useCallback(() => targetWindowIdRef.current, []);

	const endDragOut = useCallback(() => {
		// Mark the drag done BEFORE resetLookup so any still-in-flight findWindowAtPoint
		// is dropped instead of re-lighting a window; resetLookup then clears the
		// current highlight via applyTargetWindow(null).
		isDraggingRef.current = false;
		boundsRef.current = null;
		pointRef.current = null;
		isOutsideRef.current = false;
		resetLookup();
		setIsDraggingOut(false);
	}, [resetLookup]);

	return {
		isDraggingOut,
		beginDragOut,
		trackDragOut,
		getDragOutPoint,
		isOutsideOwningWindow,
		getTargetWindowId,
		endDragOut,
	};
}

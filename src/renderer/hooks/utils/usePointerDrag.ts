/**
 * usePointerDrag - the window-level pointer-drag dance shared by the Concerto
 * surfaces (Movement panel drag + resize, Cadenza card drag). Returns a
 * `startDrag(e, onDrag, opts)` you call from an element's `onPointerDown`: it
 * captures the down point, calls `onDrag(dx, dy)` with the cumulative delta on
 * each move, and tears down on pointer-up. In-flight listeners are also cleaned
 * up on unmount so a drag interrupted by unmount can't leak.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface PointerDragOptions {
	/** Skip the drag when it starts on a button, so header buttons still click. */
	ignoreButtons?: boolean;
	/** stopPropagation on the down event (e.g. a resize handle inside a draggable). */
	stopPropagation?: boolean;
}

export function usePointerDrag() {
	// Assumes one active drag at a time (true for mouse - a single pointer). The
	// unmount-cleanup ref tracks only the latest drag; a second concurrent drag
	// (multi-pointer touch+pen) would overwrite it, but each drag still removes its
	// own listeners on its own pointer-up, so at worst the earlier drag loses only
	// unmount protection until then. Revisit if these surfaces gain multi-touch drag.
	const cleanupRef = useRef<(() => void) | null>(null);

	useEffect(() => () => cleanupRef.current?.(), []);

	return useCallback(
		(
			e: ReactPointerEvent<HTMLElement>,
			onDrag: (dx: number, dy: number) => void,
			opts: PointerDragOptions = {}
		) => {
			if (opts.ignoreButtons && (e.target as HTMLElement).closest('button')) return;
			e.preventDefault();
			if (opts.stopPropagation) e.stopPropagation();
			const startX = e.clientX;
			const startY = e.clientY;
			const onMove = (ev: PointerEvent) => onDrag(ev.clientX - startX, ev.clientY - startY);
			const cleanup = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', cleanup);
				window.removeEventListener('pointercancel', cleanup);
				cleanupRef.current = null;
			};
			cleanupRef.current = cleanup;
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', cleanup);
			// pointercancel fires instead of pointerup when the system intercepts
			// the gesture (touch scroll, window drag); without it the move listener
			// would leak and keep dragging with stale origin coordinates.
			window.addEventListener('pointercancel', cleanup);
		},
		[]
	);
}

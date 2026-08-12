/**
 * usePointerDrag - the pointer-drag behavior shared by the Concerto
 * surfaces (Movement panel drag + resize, Cadenza card drag). Returns a
 * `startDrag(e, onDrag, opts)` you call from an element's `onPointerDown`: it
 * captures the active pointer, calls `onDrag(dx, dy)` with the cumulative delta
 * on each move, and tears down on pointer-up. Pointer capture keeps the gesture
 * attached to the handle when it crosses an iframe or another floating surface.
 * In-flight listeners are also cleaned up on unmount so a drag interrupted by
 * unmount can't leak.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface PointerDragOptions {
	/** Skip the drag when it starts on a button, so header buttons still click. */
	ignoreButtons?: boolean;
	/** stopPropagation on the down event (e.g. a resize handle inside a draggable). */
	stopPropagation?: boolean;
}

export function usePointerDrag() {
	// Concerto surfaces support one drag at a time. Starting another pointer cancels
	// the previous gesture so its listeners and pointer capture cannot outlive the
	// cleanup tracked for unmount.
	const cleanupRef = useRef<(() => void) | null>(null);

	useEffect(() => () => cleanupRef.current?.(), []);

	return useCallback(
		(
			e: ReactPointerEvent<HTMLElement>,
			onDrag: (dx: number, dy: number) => void,
			opts: PointerDragOptions = {}
		) => {
			if (opts.ignoreButtons && (e.target as HTMLElement).closest('button')) return;
			cleanupRef.current?.();
			e.preventDefault();
			if (opts.stopPropagation) e.stopPropagation();
			const dragTarget = e.currentTarget;
			const pointerId = e.pointerId;
			const startX = e.clientX;
			const startY = e.clientY;

			// Keep the drag bound to its handle even while the pointer crosses an
			// embedded iframe. Window listeners remain as a fallback for environments
			// where pointer capture is unavailable or the pointer was already released.
			try {
				dragTarget.setPointerCapture(pointerId);
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
				// The window listeners below still preserve the existing drag behavior.
			}

			const onMove = (ev: PointerEvent) => {
				if (ev.pointerId !== pointerId) return;
				onDrag(ev.clientX - startX, ev.clientY - startY);
			};
			const cleanup = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onEnd);
				window.removeEventListener('pointercancel', onEnd);
				try {
					dragTarget.releasePointerCapture(pointerId);
				} catch (error) {
					if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
					// Pointer-up and pointercancel may release capture before cleanup runs.
				}
				if (cleanupRef.current === cleanup) cleanupRef.current = null;
			};
			const onEnd = (ev: PointerEvent) => {
				if (ev.pointerId !== pointerId) return;
				cleanup();
			};
			cleanupRef.current = cleanup;
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onEnd);
			// pointercancel fires instead of pointerup when the system intercepts
			// the gesture (touch scroll, window drag); without it the move listener
			// would leak and keep dragging with stale origin coordinates.
			window.addEventListener('pointercancel', onEnd);
		},
		[]
	);
}

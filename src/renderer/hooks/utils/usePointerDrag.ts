/**
 * usePointerDrag - the pointer-drag behavior shared by the Concerto
 * surfaces (Movement panel drag + resize, Cadenza card drag) and tab tiling
 * (split dividers, pane rearrange via usePaneDrag). Returns a
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
	/**
	 * Commit hook, fired once the gesture ends (pointerup or pointercancel).
	 *
	 * Deliberately called AFTER the listeners and pointer capture are torn down:
	 * a drag that commits before cleaning up leaves its move listener attached if
	 * the commit throws, and the handle then keeps tracking the pointer with no
	 * button held. Not fired when the gesture is abandoned rather than finished
	 * (unmount, or a second pointer starting a new drag) - there is nothing to
	 * commit and the component may already be gone.
	 */
	onEnd?: () => void;
	/**
	 * Cancel hook, fired when the gesture stops WITHOUT a release to commit:
	 *   - Escape was pressed (only armed when this hook is supplied, so a drag
	 *     with nothing to undo does not claim the key; arming it also pulls focus
	 *     out of a focused <webview>/<iframe> so the key reaches this window), or
	 *   - the gesture was abandoned (unmount, or a second pointer starting a new
	 *     drag).
	 * Fired after teardown, like `onEnd`. A caller that publishes drag state to a
	 * store clears it here; without it, either ending leaves the state set forever.
	 */
	onCancel?: () => void;
}

export function usePointerDrag() {
	// Concerto surfaces support one drag at a time. Starting another pointer cancels
	// the previous gesture so its listeners and pointer capture cannot outlive the
	// cleanup tracked for unmount.
	// `abandonRef` tears down AND fires the in-flight gesture's `onCancel`; it is
	// what unmount and a superseding drag call.
	const abandonRef = useRef<(() => void) | null>(null);

	useEffect(() => () => abandonRef.current?.(), []);

	return useCallback(
		(
			e: ReactPointerEvent<HTMLElement>,
			onDrag: (dx: number, dy: number) => void,
			opts: PointerDragOptions = {}
		) => {
			if (opts.ignoreButtons && (e.target as HTMLElement).closest('button')) return;
			abandonRef.current?.();
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
				// A mouse with no button held means the release happened but was
				// delivered elsewhere (a guest <webview> or another window can swallow
				// it even with capture set). Settle it as the release it was, rather
				// than dragging on with no button held.
				if (ev.pointerType === 'mouse' && ev.buttons === 0) {
					cleanup();
					opts.onEnd?.();
					return;
				}
				onDrag(ev.clientX - startX, ev.clientY - startY);
			};
			const onKeyDown = (ev: KeyboardEvent) => {
				if (ev.key !== 'Escape') return;
				ev.preventDefault();
				ev.stopPropagation();
				cleanup();
				opts.onCancel?.();
			};
			const cleanup = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onEnd);
				window.removeEventListener('pointercancel', onEnd);
				window.removeEventListener('keydown', onKeyDown, true);
				try {
					dragTarget.releasePointerCapture(pointerId);
				} catch (error) {
					if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
					// Pointer-up and pointercancel may release capture before cleanup runs.
				}
				if (abandonRef.current === abandon) abandonRef.current = null;
			};
			const abandon = () => {
				cleanup();
				opts.onCancel?.();
			};
			const onEnd = (ev: PointerEvent) => {
				if (ev.pointerId !== pointerId) return;
				cleanup();
				opts.onEnd?.();
			};
			abandonRef.current = abandon;
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onEnd);
			// pointercancel fires instead of pointerup when the system intercepts
			// the gesture (touch scroll, window drag); without it the move listener
			// would leak and keep dragging with stale origin coordinates.
			window.addEventListener('pointercancel', onEnd);
			// Capture phase so Escape cancels the drag before a shortcut handler
			// acts on it. Armed only when there is a cancel to run.
			if (opts.onCancel) {
				// The preventDefault above suppresses the mousedown that would move
				// focus, so a guest <webview> or <iframe> the user last clicked keeps
				// keyboard focus and swallows Escape before this window sees it (the
				// main process forwards only modified keys out of a browser tab).
				// Pull focus back to the host page for the length of the drag.
				const focused = document.activeElement;
				if (focused instanceof HTMLElement && /^(WEBVIEW|IFRAME)$/.test(focused.tagName)) {
					focused.blur();
				}
				window.addEventListener('keydown', onKeyDown, true);
			}
		},
		[]
	);
}

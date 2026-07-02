/**
 * useResizablePanel - Shared drag-to-resize logic for sidebar/panel components.
 *
 * Uses direct DOM manipulation during drag for performance (avoids ~60 re-renders/sec),
 * committing React state and persisting to settings only on pointer up.
 * Disables CSS transitions during drag to prevent animation fighting with DOM updates.
 *
 * Uses Pointer Events (not mouse events) so the drag works with touch and pen as
 * well as a mouse. The handle captures the pointer on down, so the drag keeps
 * tracking even when the pointer leaves the thin handle. Pair the returned
 * `onResizeStart` with `touch-action: none` on the handle so the browser does
 * not hijack the gesture as a scroll/pan on touch.
 */

import { useRef, useState, useCallback, useEffect } from 'react';

export interface UseResizablePanelOptions {
	/** Current width from React state */
	width: number;
	/** Min allowed width in px */
	minWidth: number;
	/** Max allowed width in px */
	maxWidth: number;
	/** Settings key to persist width to */
	settingsKey: string;
	/** React state setter for width */
	setWidth: (w: number) => void;
	/** 'left' = left sidebar (drag right to widen), 'right' = right panel (drag left to widen) */
	side: 'left' | 'right';
	/** Optional external ref when the container ref is owned by a parent component */
	externalRef?: React.RefObject<HTMLDivElement>;
}

export interface UseResizablePanelReturn {
	/** Attach to the resizable container div */
	panelRef: React.RefObject<HTMLDivElement>;
	/** True while actively dragging - use to disable CSS transitions */
	isResizing: boolean;
	/** onPointerDown handler for the resize handle (mouse, touch, and pen) */
	onResizeStart: (e: React.PointerEvent) => void;
	/** CSS class string for width transitions (disabled during drag) */
	transitionClass: string;
}

export function useResizablePanel({
	width,
	minWidth,
	maxWidth,
	settingsKey,
	setWidth,
	side,
	externalRef,
}: UseResizablePanelOptions): UseResizablePanelReturn {
	const internalRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
	const panelRef = externalRef ?? internalRef;
	const [isResizing, setIsResizing] = useState(false);

	// Cleanup listeners on unmount (safety net for mid-drag unmount)
	const cleanupRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	const onResizeStart = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			setIsResizing(true);
			const startX = e.clientX;
			const startWidth = width;
			let currentWidth = startWidth;

			// Capture the pointer on the handle so the drag keeps tracking even when
			// the pointer slides off the thin handle. Captured pointer events are
			// dispatched to this element, so we listen on it rather than document.
			const handle = e.currentTarget as HTMLElement;
			const pointerId = e.pointerId;
			try {
				handle.setPointerCapture(pointerId);
			} catch {
				// setPointerCapture can throw if the pointer is already released; the
				// drag still works via the listeners below, so ignore.
			}

			const handlePointerMove = (moveEvent: PointerEvent) => {
				const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
				currentWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
				if (panelRef.current) {
					panelRef.current.style.width = `${currentWidth}px`;
				}
			};

			const cleanup = () => {
				handle.removeEventListener('pointermove', handlePointerMove);
				handle.removeEventListener('pointerup', handlePointerUp);
				handle.removeEventListener('pointercancel', handlePointerUp);
				try {
					handle.releasePointerCapture(pointerId);
				} catch {
					// Already released (e.g. pointercancel); nothing to do.
				}
				cleanupRef.current = null;
			};

			const handlePointerUp = () => {
				setIsResizing(false);
				setWidth(currentWidth);
				window.maestro.settings.set(settingsKey, currentWidth);
				cleanup();
			};

			cleanupRef.current = cleanup;

			handle.addEventListener('pointermove', handlePointerMove);
			handle.addEventListener('pointerup', handlePointerUp);
			handle.addEventListener('pointercancel', handlePointerUp);
		},
		[width, minWidth, maxWidth, settingsKey, setWidth, side]
	);

	const transitionClass = isResizing ? 'transition-none' : 'transition-[width] duration-150';

	return { panelRef, isResizing, onResizeStart, transitionClass };
}

/**
 * useResizablePanel - Shared drag-to-resize logic for sidebar/panel components.
 *
 * Uses direct DOM manipulation during drag for performance (avoids ~60 re-renders/sec),
 * committing React state and persisting to settings only on mouseup.
 * Disables CSS transitions during drag to prevent animation fighting with DOM updates.
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
	/** onMouseDown handler for the resize handle */
	onResizeStart: (e: React.MouseEvent) => void;
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
		(e: React.MouseEvent) => {
			e.preventDefault();
			setIsResizing(true);
			const startX = e.clientX;
			const startWidth = width;
			let currentWidth = startWidth;

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const delta = side === 'left'
					? moveEvent.clientX - startX
					: startX - moveEvent.clientX;
				currentWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
				if (panelRef.current) {
					panelRef.current.style.width = `${currentWidth}px`;
				}
			};

			const handleMouseUp = () => {
				setIsResizing(false);
				setWidth(currentWidth);
				window.maestro.settings.set(settingsKey, currentWidth);
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
				cleanupRef.current = null;
			};

			cleanupRef.current = () => {
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
			};

			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
		},
		[width, minWidth, maxWidth, settingsKey, setWidth, side],
	);

	const transitionClass = isResizing ? 'transition-none' : 'transition-[width] duration-150';

	return { panelRef, isResizing, onResizeStart, transitionClass };
}

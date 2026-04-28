import { useState, useRef, useCallback, useEffect } from 'react';

export interface UseResizableWebPanelOptions {
	side: 'left' | 'right';
	defaultWidth: number;
	minWidth: number;
	maxWidth: number;
	storageKey: string;
}

export function useResizableWebPanel({
	side,
	defaultWidth,
	minWidth,
	maxWidth,
	storageKey,
}: UseResizableWebPanelOptions) {
	// Restore from localStorage on mount
	const [width, setWidth] = useState(() => {
		try {
			const saved = localStorage.getItem(storageKey);
			if (saved) {
				const parsed = parseInt(saved, 10);
				if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed;
			}
		} catch {
			/* ignore localStorage errors */
		}
		return defaultWidth;
	});

	const panelRef = useRef<HTMLDivElement>(null);
	const isResizing = useRef(false);
	const startX = useRef(0);
	const startWidth = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);
	const widthRef = useRef(width);
	widthRef.current = width;

	// Clean up any in-flight drag on unmount
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	// Persist to localStorage when width changes (not during drag — only on commit)
	const commitWidth = useCallback(
		(w: number) => {
			const clamped = Math.max(minWidth, Math.min(maxWidth, w));
			setWidth(clamped);
			try {
				localStorage.setItem(storageKey, String(clamped));
			} catch {
				/* ignore localStorage errors */
			}
		},
		[minWidth, maxWidth, storageKey]
	);

	const onResizeStart = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			// Only react to primary-button drags (left mouse / touch / pen contact)
			if (e.button !== 0 && e.pointerType === 'mouse') return;
			e.preventDefault();

			const handle = e.currentTarget;
			const pointerId = e.pointerId;
			try {
				handle.setPointerCapture(pointerId);
			} catch {
				/* some browsers throw if capture is already active; ignore */
			}

			isResizing.current = true;
			startX.current = e.clientX;
			startWidth.current = widthRef.current;

			// Preserve cursor + prevent text selection for the duration of the drag.
			// setPointerCapture routes pointer events to the handle, so we no longer
			// need a full-screen overlay to catch events outside the handle.
			const prevBodyCursor = document.body.style.cursor;
			const prevBodyUserSelect = document.body.style.userSelect;
			document.body.style.cursor = 'col-resize';
			document.body.style.userSelect = 'none';

			const onPointerMove = (ev: PointerEvent) => {
				if (ev.pointerId !== pointerId) return;
				if (!isResizing.current || !panelRef.current) return;
				const delta = side === 'left' ? ev.clientX - startX.current : startX.current - ev.clientX;
				const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth.current + delta));
				// Direct DOM manipulation for performance (no React re-renders during drag)
				panelRef.current.style.width = `${newWidth}px`;
			};

			const cleanup = () => {
				isResizing.current = false;
				handle.removeEventListener('pointermove', onPointerMove);
				handle.removeEventListener('pointerup', onPointerEnd);
				handle.removeEventListener('pointercancel', onPointerEnd);
				try {
					handle.releasePointerCapture(pointerId);
				} catch {
					/* already released */
				}
				document.body.style.cursor = prevBodyCursor;
				document.body.style.userSelect = prevBodyUserSelect;
				cleanupRef.current = null;
			};

			const onPointerEnd = (ev: PointerEvent) => {
				if (ev.pointerId !== pointerId) return;
				cleanup();
				// Commit final width to React state + localStorage
				const delta = side === 'left' ? ev.clientX - startX.current : startX.current - ev.clientX;
				commitWidth(startWidth.current + delta);
			};

			handle.addEventListener('pointermove', onPointerMove);
			handle.addEventListener('pointerup', onPointerEnd);
			handle.addEventListener('pointercancel', onPointerEnd);
			cleanupRef.current = cleanup;
		},
		[side, minWidth, maxWidth, commitWidth]
	);

	return { width, panelRef, onResizeStart, isResizing };
}

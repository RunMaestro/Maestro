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

	// Clean up listeners and overlay on unmount
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
		(e: React.MouseEvent) => {
			e.preventDefault();
			isResizing.current = true;
			startX.current = e.clientX;
			startWidth.current = widthRef.current;

			// Add a full-screen overlay to capture mouse events during drag
			const overlay = document.createElement('div');
			overlay.id = 'resize-overlay';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;';
			document.body.appendChild(overlay);

			const onMouseMove = (ev: MouseEvent) => {
				if (!isResizing.current || !panelRef.current) return;
				const delta = side === 'left' ? ev.clientX - startX.current : startX.current - ev.clientX;
				const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth.current + delta));
				// Direct DOM manipulation for performance (no React re-renders during drag)
				panelRef.current.style.width = `${newWidth}px`;
			};

			const cleanup = () => {
				isResizing.current = false;
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
				cleanupRef.current = null;
				const el = document.getElementById('resize-overlay');
				if (el) el.remove();
			};

			const onMouseUp = (ev: MouseEvent) => {
				cleanup();
				// Commit final width to React state + localStorage
				const delta = side === 'left' ? ev.clientX - startX.current : startX.current - ev.clientX;
				commitWidth(startWidth.current + delta);
			};

			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
			cleanupRef.current = cleanup;
		},
		[side, minWidth, maxWidth, commitWidth]
	);

	return { width, panelRef, onResizeStart, isResizing };
}

/**
 * usePanZoom - wheel zoom (centered on the cursor), drag-to-pan, and stepped
 * zoom controls for a canvas that shows one piece of content.
 *
 * Shared by the file-preview ImageViewer and the full-screen ZoomViewerOverlay
 * (diagrams and images opened from chat, documents, and Auto Run). Both used to
 * need the same math; this is the one copy.
 *
 * The transform is `translate(x, y) scale(zoom)` with a CENTER origin, so the
 * offset is measured from the container's center. Zooming about a point keeps
 * that point fixed on screen: `offset' = p - s * (p - offset)`.
 *
 * The wheel listener is native and non-passive on purpose. React registers
 * `onWheel` as passive, so `preventDefault()` there is ignored, and a trackpad
 * pinch (a wheel event with `ctrlKey`) would fall through to Chromium's own
 * page zoom and scale the whole window instead of the diagram.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface PanZoomView {
	zoom: number;
	x: number;
	y: number;
}

export interface UsePanZoomOptions {
	minZoom?: number;
	maxZoom?: number;
	/** Reset to the fitted view whenever this value changes (e.g. a new image src). */
	resetKey?: unknown;
}

export interface UsePanZoomReturn {
	/** Attach to the element that receives wheel and drag input. */
	containerRef: React.RefObject<HTMLDivElement>;
	zoom: number;
	offset: { x: number; y: number };
	dragging: boolean;
	/** CSS transform for the content wrapper (use with `transformOrigin: center`). */
	transform: string;
	onMouseDown: (e: React.MouseEvent) => void;
	zoomIn: () => void;
	zoomOut: () => void;
	/** Back to zoom 1, no offset. */
	fitToView: () => void;
	/** Move the content by a screen-space delta (keyboard panning). */
	panBy: (dx: number, dy: number) => void;
	canZoomIn: boolean;
	canZoomOut: boolean;
}

const DEFAULT_MIN_ZOOM = 0.1;
const DEFAULT_MAX_ZOOM = 10;
/** Zoom per wheel delta unit. Mice send large deltas, trackpads small ones. */
const WHEEL_SENSITIVITY = 0.002;
/** A pinch arrives as a ctrl-wheel with much smaller deltas than a scroll. */
const PINCH_SENSITIVITY = 0.01;
/** One zoom-button or keyboard step. */
const ZOOM_STEP = 1.25;

const FITTED: PanZoomView = { zoom: 1, x: 0, y: 0 };

export function usePanZoom({
	minZoom = DEFAULT_MIN_ZOOM,
	maxZoom = DEFAULT_MAX_ZOOM,
	resetKey,
}: UsePanZoomOptions = {}): UsePanZoomReturn {
	const containerRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<PanZoomView>(FITTED);
	const [dragging, setDragging] = useState(false);
	const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
	const viewRef = useRef(view);
	viewRef.current = view;

	useEffect(() => {
		setView(FITTED);
	}, [resetKey]);

	/** Scale by `factor` about (cx, cy), measured from the container center. */
	const zoomAt = useCallback(
		(factor: number, cx = 0, cy = 0) => {
			setView((v) => {
				const zoom = Math.min(maxZoom, Math.max(minZoom, v.zoom * factor));
				const s = zoom / v.zoom;
				return { zoom, x: cx - s * (cx - v.x), y: cy - s * (cy - v.y) };
			});
		},
		[minZoom, maxZoom]
	);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const cx = e.clientX - rect.left - rect.width / 2;
			const cy = e.clientY - rect.top - rect.height / 2;
			const sensitivity = e.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY;
			zoomAt(1 - e.deltaY * sensitivity, cx, cy);
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, [zoomAt]);

	const onMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const v = viewRef.current;
		dragStart.current = { x: e.clientX, y: e.clientY, offsetX: v.x, offsetY: v.y };
		setDragging(true);
	}, []);

	// Track the drag on window so it survives the cursor leaving the canvas.
	useEffect(() => {
		if (!dragging) return;
		const move = (e: MouseEvent) => {
			const start = dragStart.current;
			setView((v) => ({
				...v,
				x: start.offsetX + (e.clientX - start.x),
				y: start.offsetY + (e.clientY - start.y),
			}));
		};
		const up = () => setDragging(false);
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', up);
		return () => {
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', up);
		};
	}, [dragging]);

	const zoomIn = useCallback(() => zoomAt(ZOOM_STEP), [zoomAt]);
	const zoomOut = useCallback(() => zoomAt(1 / ZOOM_STEP), [zoomAt]);
	const fitToView = useCallback(() => setView(FITTED), []);
	const panBy = useCallback((dx: number, dy: number) => {
		setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
	}, []);

	return {
		containerRef,
		zoom: view.zoom,
		offset: { x: view.x, y: view.y },
		dragging,
		transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
		onMouseDown,
		zoomIn,
		zoomOut,
		fitToView,
		panBy,
		canZoomIn: view.zoom < maxZoom,
		canZoomOut: view.zoom > minZoom,
	};
}

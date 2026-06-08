/**
 * GraphMiniMap - Overview minimap for the canvas-based Document Graph.
 *
 * Mirrors the minimap on the Cue Pipeline Editor: a small overview in the
 * bottom-left corner showing every node scaled down, with a viewport rectangle
 * marking the currently-visible region. Click or drag anywhere on the minimap
 * to recenter the main view on that point.
 *
 * The MindMap is canvas-rendered (not React Flow), so this is a hand-rolled
 * canvas minimap rather than React Flow's built-in <MiniMap>.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../types';
import type { MindMapNode } from './MindMap';

/** Minimap box dimensions in CSS px */
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 140;
/** Inner padding so content doesn't touch the minimap edges */
const MINIMAP_PADDING = 10;
/** Width of the GraphLegend help drawer - the minimap slides clear of it when open */
const LEGEND_WIDTH = 280;
/** Margin from the container edges */
const EDGE_MARGIN = 12;

interface Transform {
	zoom: number;
	panX: number;
	panY: number;
}

export interface GraphMiniMapProps {
	/** Nodes with resolved positions (nodesWithState from MindMap) */
	nodes: MindMapNode[];
	/** Current theme */
	theme: Theme;
	/** Main view (canvas) width in CSS px */
	viewWidth: number;
	/** Main view (canvas) height in CSS px */
	viewHeight: number;
	/** Current pan/zoom of the main view */
	transform: Transform;
	/** Recenter the main view on a canvas-space point */
	onRecenter: (canvasX: number, canvasY: number) => void;
	/** When the help drawer is expanded, slide the minimap right to clear it */
	legendExpanded: boolean;
	/** Currently selected node (highlighted in the minimap) */
	selectedNodeId: string | null;
	/** Currently keyboard-focused node (highlighted in the minimap) */
	focusedNodeId: string | null;
}

/**
 * GraphMiniMap component - renders the overview minimap and handles
 * click/drag-to-navigate interaction.
 */
export function GraphMiniMap({
	nodes,
	theme,
	viewWidth,
	viewHeight,
	transform,
	onRecenter,
	legendExpanded,
	selectedNodeId,
	focusedNodeId,
}: GraphMiniMapProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Geometry used to map minimap pixels back to canvas coordinates on click.
	// Updated on every draw so pointer handlers always read the latest mapping.
	const geomRef = useRef<{
		minX: number;
		minY: number;
		scale: number;
		ox: number;
		oy: number;
	} | null>(null);
	const [isDragging, setIsDragging] = useState(false);

	// Bounding box of all node rectangles in canvas space. Only depends on the
	// nodes, so it isn't recomputed on every pan.
	const nodeBounds = useMemo(() => {
		if (nodes.length === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of nodes) {
			const hw = n.width / 2;
			const hh = n.height / 2;
			if (n.x - hw < minX) minX = n.x - hw;
			if (n.x + hw > maxX) maxX = n.x + hw;
			if (n.y - hh < minY) minY = n.y - hh;
			if (n.y + hh > maxY) maxY = n.y + hh;
		}
		return { minX, minY, maxX, maxY };
	}, [nodes]);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx || !nodeBounds) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = MINIMAP_WIDTH * dpr;
		canvas.height = MINIMAP_HEIGHT * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Visible region of the main view, expressed in canvas coordinates.
		const { zoom, panX, panY } = transform;
		const visLeft = -panX / zoom;
		const visTop = -panY / zoom;
		const visRight = (viewWidth - panX) / zoom;
		const visBottom = (viewHeight - panY) / zoom;

		// Union the node bounds with the visible region so the viewport rectangle
		// is always fully drawn, even when zoomed out past the content.
		const minX = Math.min(nodeBounds.minX, visLeft);
		const minY = Math.min(nodeBounds.minY, visTop);
		const maxX = Math.max(nodeBounds.maxX, visRight);
		const maxY = Math.max(nodeBounds.maxY, visBottom);

		const spanX = maxX - minX || 1;
		const spanY = maxY - minY || 1;
		const scale = Math.min(
			(MINIMAP_WIDTH - MINIMAP_PADDING * 2) / spanX,
			(MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / spanY
		);
		// Center the scaled content within the minimap box.
		const ox = (MINIMAP_WIDTH - spanX * scale) / 2;
		const oy = (MINIMAP_HEIGHT - spanY * scale) / 2;
		geomRef.current = { minX, minY, scale, ox, oy };

		const toX = (cx: number) => ox + (cx - minX) * scale;
		const toY = (cy: number) => oy + (cy - minY) * scale;

		ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

		// Nodes - tiny rects, minimum size so they stay visible when zoomed out.
		for (const n of nodes) {
			const isActive = n.id === selectedNodeId || n.id === focusedNodeId;
			ctx.fillStyle = isActive
				? theme.colors.accent
				: n.nodeType === 'external'
					? `${theme.colors.textDim}99`
					: `${theme.colors.accent}99`;
			const w = Math.max(n.width * scale, 2.5);
			const h = Math.max(n.height * scale, 2.5);
			ctx.fillRect(toX(n.x) - w / 2, toY(n.y) - h / 2, w, h);
		}

		// Viewport rectangle - translucent fill plus accent outline.
		const vx = toX(visLeft);
		const vy = toY(visTop);
		const vw = (visRight - visLeft) * scale;
		const vh = (visBottom - visTop) * scale;
		ctx.fillStyle = `${theme.colors.accent}1F`;
		ctx.fillRect(vx, vy, vw, vh);
		ctx.strokeStyle = theme.colors.accent;
		ctx.lineWidth = 1.5;
		ctx.strokeRect(vx, vy, vw, vh);
	}, [nodes, nodeBounds, transform, viewWidth, viewHeight, theme, selectedNodeId, focusedNodeId]);

	useEffect(() => {
		draw();
	}, [draw]);

	// Map a pointer position over the minimap to a canvas-space point and recenter.
	const recenterFromEvent = useCallback(
		(clientX: number, clientY: number) => {
			const canvas = canvasRef.current;
			const geom = geomRef.current;
			if (!canvas || !geom) return;
			const rect = canvas.getBoundingClientRect();
			const mx = clientX - rect.left;
			const my = clientY - rect.top;
			const cx = (mx - geom.ox) / geom.scale + geom.minX;
			const cy = (my - geom.oy) / geom.scale + geom.minY;
			onRecenter(cx, cy);
		},
		[onRecenter]
	);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragging(true);
			recenterFromEvent(e.clientX, e.clientY);
		},
		[recenterFromEvent]
	);

	// While dragging, track the pointer on the window so it keeps recentering
	// even if the cursor leaves the minimap box.
	useEffect(() => {
		if (!isDragging) return;
		const onMove = (e: MouseEvent) => recenterFromEvent(e.clientX, e.clientY);
		const onUp = () => setIsDragging(false);
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
	}, [isDragging, recenterFromEvent]);

	// Nothing worth navigating with a single (or zero) node.
	if (!nodeBounds || nodes.length < 2) return null;

	return (
		<div
			className="absolute z-20 rounded-lg overflow-hidden shadow-lg select-none"
			style={{
				left: legendExpanded ? LEGEND_WIDTH + EDGE_MARGIN : EDGE_MARGIN,
				bottom: EDGE_MARGIN,
				width: MINIMAP_WIDTH,
				height: MINIMAP_HEIGHT,
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
				transition: 'left 200ms ease',
				cursor: isDragging ? 'grabbing' : 'pointer',
			}}
			onMouseDown={handleMouseDown}
			onContextMenu={(e) => e.preventDefault()}
			title="Mini-map - click or drag to navigate"
		>
			<canvas
				ref={canvasRef}
				style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT, display: 'block' }}
			/>
		</div>
	);
}

export default GraphMiniMap;

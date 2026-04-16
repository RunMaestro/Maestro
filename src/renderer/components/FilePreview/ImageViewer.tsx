import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
interface ImageViewerProps {
	src: string;
	alt: string;
	theme: any;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
/** Zoom sensitivity — smaller = slower. Trackpads send small deltas, mice send large ones. */
const ZOOM_SENSITIVITY = 0.002;

/**
 * Zoomable, pannable image viewer for file preview.
 * Supports mouse wheel zoom (centered on cursor), click-drag panning,
 * and a toolbar with zoom controls + fit-to-view reset.
 */
export const ImageViewer = memo(function ImageViewer({ src, alt, theme }: ImageViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(1);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
	const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

	// Reset zoom/pan when image source changes
	useEffect(() => {
		setZoom(1);
		setOffset({ x: 0, y: 0 });
		setNaturalSize(null);
	}, [src]);

	const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
	}, []);

	// Zoom centered on the cursor position, proportional to scroll delta
	const handleWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		const container = containerRef.current;
		if (!container) return;

		const rect = container.getBoundingClientRect();
		const cx = e.clientX - rect.left - rect.width / 2;
		const cy = e.clientY - rect.top - rect.height / 2;

		// Use delta magnitude for smooth trackpad + discrete mouse support
		const delta = -e.deltaY * ZOOM_SENSITIVITY;
		const factor = 1 + delta;

		setZoom((prev) => {
			const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
			const scale = next / prev;
			setOffset((o) => ({
				x: cx - scale * (cx - o.x),
				y: cy - scale * (cy - o.y),
			}));
			return next;
		});
	}, []);

	// Pan via mouse drag
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return; // left click only
			e.preventDefault();
			setDragging(true);
			dragStart.current = { x: e.clientX, y: e.clientY, offsetX: offset.x, offsetY: offset.y };
		},
		[offset]
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!dragging) return;
			setOffset({
				x: dragStart.current.offsetX + (e.clientX - dragStart.current.x),
				y: dragStart.current.offsetY + (e.clientY - dragStart.current.y),
			});
		},
		[dragging]
	);

	const handleMouseUp = useCallback(() => {
		setDragging(false);
	}, []);

	// Release drag if mouse leaves the container
	useEffect(() => {
		if (!dragging) return;
		const up = () => setDragging(false);
		window.addEventListener('mouseup', up);
		return () => window.removeEventListener('mouseup', up);
	}, [dragging]);

	const fitToView = useCallback(() => {
		setZoom(1);
		setOffset({ x: 0, y: 0 });
	}, []);

	const zoomIn = useCallback(() => {
		setZoom((z) => Math.min(MAX_ZOOM, z * 1.25));
	}, []);

	const zoomOut = useCallback(() => {
		setZoom((z) => Math.max(MIN_ZOOM, z / 1.25));
	}, []);

	const zoomPercent = Math.round(zoom * 100);

	return (
		<div className="flex flex-col h-full">
			{/* Zoom toolbar */}
			<div
				className="flex items-center justify-center gap-2 py-1.5 shrink-0 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<GhostIconButton onClick={zoomOut} title="Zoom out" color={theme.colors.textDim}>
					<ZoomOut className="w-4 h-4" />
				</GhostIconButton>
				<span
					className="text-xs font-mono w-12 text-center select-none"
					style={{ color: theme.colors.textMain }}
				>
					{zoomPercent}%
				</span>
				<GhostIconButton onClick={zoomIn} title="Zoom in" color={theme.colors.textDim}>
					<ZoomIn className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton onClick={fitToView} title="Fit to view" color={theme.colors.textDim}>
					<Maximize2 className="w-4 h-4" />
				</GhostIconButton>
				{naturalSize && (
					<span className="text-[10px] ml-2" style={{ color: theme.colors.textDim }}>
						{naturalSize.w} × {naturalSize.h}
					</span>
				)}
			</div>

			{/* Zoomable/pannable canvas */}
			<div
				ref={containerRef}
				className="flex-1 overflow-hidden relative"
				style={{
					cursor: dragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
					// Checkerboard background for transparent images
					backgroundImage: `linear-gradient(45deg, ${theme.colors.bgActivity} 25%, transparent 25%),
						linear-gradient(-45deg, ${theme.colors.bgActivity} 25%, transparent 25%),
						linear-gradient(45deg, transparent 75%, ${theme.colors.bgActivity} 75%),
						linear-gradient(-45deg, transparent 75%, ${theme.colors.bgActivity} 75%)`,
					backgroundSize: '20px 20px',
					backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
				}}
				onWheel={handleWheel}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
			>
				<div
					className="absolute inset-0 flex items-center justify-center"
					style={{
						transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
						transformOrigin: 'center center',
						willChange: 'transform',
					}}
				>
					<img
						src={src}
						alt={alt}
						className="max-w-full max-h-full object-contain select-none"
						style={{ imageRendering: zoom > 2 ? 'pixelated' : 'auto' }}
						draggable={false}
						onLoad={handleImageLoad}
					/>
				</div>
			</div>
		</div>
	);
});

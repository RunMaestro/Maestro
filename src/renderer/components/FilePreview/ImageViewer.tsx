import React, { useState, useCallback, useEffect, memo } from 'react';
import { ZoomIn, ZoomOut, Maximize2, ImageOff } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { Spinner } from '../ui/Spinner';
import { usePanZoom } from '../../hooks/ui/usePanZoom';

interface ImageViewerProps {
	src: string;
	alt: string;
	theme: any;
}

/**
 * Zoomable, pannable image viewer for file preview.
 * Supports mouse wheel zoom (centered on cursor), click-drag panning,
 * and a toolbar with zoom controls + fit-to-view reset.
 */
export const ImageViewer = memo(function ImageViewer({ src, alt, theme }: ImageViewerProps) {
	const { containerRef, zoom, dragging, transform, onMouseDown, zoomIn, zoomOut, fitToView } =
		usePanZoom({ resetKey: src });
	const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
	const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');

	// Reset load state when image source changes (usePanZoom resets the view)
	useEffect(() => {
		setNaturalSize(null);
		setLoadState(src ? 'loading' : 'error');
	}, [src]);

	const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
		setLoadState('loaded');
	}, []);

	const handleImageError = useCallback(() => {
		setLoadState('error');
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
					<span className="text-2xs ml-2" style={{ color: theme.colors.textDim }}>
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
				onMouseDown={onMouseDown}
			>
				<div
					className="absolute inset-0 flex items-center justify-center"
					style={{
						transform,
						transformOrigin: 'center center',
						willChange: 'transform',
					}}
				>
					{src && (
						<img
							src={src}
							alt={alt}
							className="max-w-full max-h-full object-contain select-none"
							style={{
								imageRendering: zoom > 2 ? 'pixelated' : 'auto',
								visibility: loadState === 'loaded' ? 'visible' : 'hidden',
							}}
							draggable={false}
							onLoad={handleImageLoad}
							onError={handleImageError}
						/>
					)}
				</div>

				{loadState === 'loading' && (
					<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
						<Spinner size={32} color={theme.colors.accent} />
					</div>
				)}

				{loadState === 'error' && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
						<ImageOff className="w-10 h-10" style={{ color: theme.colors.textDim }} />
						<span className="text-sm" style={{ color: theme.colors.textDim }}>
							Failed to load image
						</span>
					</div>
				)}
			</div>
		</div>
	);
});

/**
 * AnnotatorCanvas — Pan/zoomable image with an SVG overlay for freehand strokes.
 *
 * Stroke coordinates are stored in native image space (the SVG's viewBox
 * matches the image's intrinsic dimensions) so they survive zoom/pan changes
 * untouched. The transformed inner div applies a `translate(x, y) scale(s)`
 * with `transform-origin: 0 0`, which gives a clean inverse:
 *   imageX = (clientX - svgRect.left) / view.scale
 *   imageY = (clientY - svgRect.top) / view.scale
 *
 * Pen, eraser, and pan tool routing happens on the SVG's pointerEvents prop
 * (the SVG opts out when panning so the wrapper sees the drag), with strokes
 * opting into pointer hits only in eraser mode.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getStroke } from 'perfect-freehand';
import getSvgPathFromStroke from './getSvgPathFromStroke';
import type { UseAnnotatorStateReturn } from './useAnnotatorState';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEventListener } from '../../hooks/utils/useEventListener';

interface AnnotatorCanvasProps {
	imageDataUrl: string;
	state: UseAnnotatorStateReturn;
}

interface ImgSize {
	w: number;
	h: number;
}

interface PanState {
	startX: number;
	startY: number;
	viewX: number;
	viewY: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

export const AnnotatorCanvas = forwardRef<SVGSVGElement, AnnotatorCanvasProps>(
	function AnnotatorCanvas({ imageDataUrl, state }, forwardedRef) {
		const {
			strokes,
			currentPoints,
			tool,
			view,
			setView,
			beginStroke,
			extendStroke,
			endStroke,
			eraseStrokeAt,
		} = state;

		const wrapperRef = useRef<HTMLDivElement>(null);
		const svgRef = useRef<SVGSVGElement>(null);
		useImperativeHandle(forwardedRef, () => svgRef.current!, []);

		const penColor = useSettingsStore((s) => s.annotatorPenColor);
		const penSize = useSettingsStore((s) => s.annotatorPenSize);
		const thinning = useSettingsStore((s) => s.annotatorThinning);
		const smoothing = useSettingsStore((s) => s.annotatorSmoothing);
		const streamline = useSettingsStore((s) => s.annotatorStreamline);
		const taperStart = useSettingsStore((s) => s.annotatorTaperStart);
		const taperEnd = useSettingsStore((s) => s.annotatorTaperEnd);

		const [imgSize, setImgSize] = useState<ImgSize | null>(null);
		const [isSpaceHeld, setIsSpaceHeld] = useState(false);

		// Latest view in a ref — the wheel handler is attached imperatively
		// (see below) and needs the current view without re-binding.
		const viewRef = useRef(view);
		viewRef.current = view;

		const fitToViewport = useCallback(
			(w: number, h: number) => {
				const wrapper = wrapperRef.current;
				if (!wrapper) return;
				const rect = wrapper.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return;
				const scale = Math.min(rect.width / w, rect.height / h, 1);
				setView({
					scale,
					x: (rect.width - w * scale) / 2,
					y: (rect.height - h * scale) / 2,
				});
			},
			[setView]
		);

		const resetView = useCallback(() => {
			if (!imgSize) return;
			const wrapper = wrapperRef.current;
			if (!wrapper) return;
			const rect = wrapper.getBoundingClientRect();
			setView({
				scale: 1,
				x: (rect.width - imgSize.w) / 2,
				y: (rect.height - imgSize.h) / 2,
			});
		}, [imgSize, setView]);

		const handleImageLoad = useCallback(
			(e: React.SyntheticEvent<HTMLImageElement>) => {
				const img = e.currentTarget;
				const size = { w: img.naturalWidth, h: img.naturalHeight };
				setImgSize(size);
				fitToViewport(size.w, size.h);
			},
			[fitToViewport]
		);

		// Wheel zoom-at-cursor. React 17+ registers `onWheel` as passive, which
		// blocks `preventDefault()`. Attach manually with `{ passive: false }` so
		// the page doesn't scroll while zooming.
		useEffect(() => {
			const wrapper = wrapperRef.current;
			if (!wrapper) return;
			const onWheel = (e: WheelEvent) => {
				e.preventDefault();
				const rect = wrapper.getBoundingClientRect();
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				const prev = viewRef.current;
				const zoomFactor = Math.exp(-e.deltaY * 0.001);
				const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * zoomFactor));
				const ix = (cx - prev.x) / prev.scale;
				const iy = (cy - prev.y) / prev.scale;
				setView({
					scale: newScale,
					x: cx - ix * newScale,
					y: cy - iy * newScale,
				});
			};
			wrapper.addEventListener('wheel', onWheel, { passive: false });
			return () => wrapper.removeEventListener('wheel', onWheel);
		}, [setView]);

		// Keyboard shortcuts (`0` reset, `f` fit, space-to-pan).
		useEventListener('keydown', (event: Event) => {
			const e = event as KeyboardEvent;
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement ||
				(e.target instanceof HTMLElement && e.target.isContentEditable)
			) {
				return;
			}
			if (e.code === 'Space' && !e.repeat) {
				setIsSpaceHeld(true);
				e.preventDefault();
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === '0') {
				e.preventDefault();
				resetView();
			} else if (e.key === 'f' || e.key === 'F') {
				if (imgSize) {
					e.preventDefault();
					fitToViewport(imgSize.w, imgSize.h);
				}
			}
		});

		useEventListener('keyup', (event: Event) => {
			const e = event as KeyboardEvent;
			if (e.code === 'Space') setIsSpaceHeld(false);
		});

		// Pan state lives in a ref so move/up handlers see the latest values
		// without needing to re-bind on every drag tick.
		const panRef = useRef<PanState | null>(null);

		const handleWrapperPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
			const wantsPan = e.button === 1 || isSpaceHeld || tool === 'pan';
			if (!wantsPan) return;
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			panRef.current = {
				startX: e.clientX,
				startY: e.clientY,
				viewX: view.x,
				viewY: view.y,
			};
		};

		const handleWrapperPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
			const pan = panRef.current;
			if (!pan) return;
			const dx = e.clientX - pan.startX;
			const dy = e.clientY - pan.startY;
			setView((prev) => ({ ...prev, x: pan.viewX + dx, y: pan.viewY + dy }));
		};

		const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
			if (!panRef.current) return;
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				// Capture may already be released; not fatal.
			}
			panRef.current = null;
		};

		// Pen drawing on the SVG.
		const drawingRef = useRef(false);

		const clientToImage = (clientX: number, clientY: number): [number, number] | null => {
			const svg = svgRef.current;
			if (!svg) return null;
			const rect = svg.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return null;
			return [
				((clientX - rect.left) / rect.width) * (imgSize?.w ?? rect.width),
				((clientY - rect.top) / rect.height) * (imgSize?.h ?? rect.height),
			];
		};

		const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
			if (tool !== 'pen' || !imgSize) return;
			if (e.button !== 0) return;
			if (isSpaceHeld) return;
			e.stopPropagation();
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			drawingRef.current = true;
			const pt = clientToImage(e.clientX, e.clientY);
			if (pt) beginStroke([pt[0], pt[1], e.pressure || 0.5]);
		};

		const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
			if (!drawingRef.current) return;
			const pt = clientToImage(e.clientX, e.clientY);
			if (pt) extendStroke([pt[0], pt[1], e.pressure || 0.5]);
		};

		const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
			if (!drawingRef.current) return;
			drawingRef.current = false;
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				// Capture may already be released; not fatal.
			}
			endStroke();
		};

		const strokeOptions = {
			size: penSize,
			thinning,
			smoothing,
			streamline,
			start: { taper: taperStart },
			end: { taper: taperEnd },
		};

		const wrapperCursor =
			isSpaceHeld || tool === 'pan'
				? panRef.current
					? 'grabbing'
					: 'grab'
				: tool === 'eraser'
					? 'crosshair'
					: 'crosshair';

		// Eraser hit-testing requires the path to receive pointer events. Our
		// strokes are filled (no stroke attribute), so 'all' — not 'stroke' —
		// is the value that actually delivers clicks to the path.
		const strokePointerEvents = tool === 'eraser' ? 'all' : 'none';
		const svgPointerEvents = tool === 'pan' || isSpaceHeld ? 'none' : 'auto';

		return (
			<div
				ref={wrapperRef}
				className="absolute inset-0 overflow-hidden"
				onPointerDown={handleWrapperPointerDown}
				onPointerMove={handleWrapperPointerMove}
				onPointerUp={endPan}
				onPointerCancel={endPan}
				style={{
					cursor: wrapperCursor,
					touchAction: 'none',
					userSelect: 'none',
				}}
			>
				<div
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
						transformOrigin: '0 0',
						willChange: 'transform',
					}}
				>
					<img
						src={imageDataUrl}
						alt=""
						onLoad={handleImageLoad}
						draggable={false}
						style={{
							display: 'block',
							pointerEvents: 'none',
							userSelect: 'none',
							maxWidth: 'none',
						}}
					/>
					{imgSize && (
						<svg
							ref={svgRef}
							width={imgSize.w}
							height={imgSize.h}
							viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
							xmlns="http://www.w3.org/2000/svg"
							style={{
								position: 'absolute',
								top: 0,
								left: 0,
								pointerEvents: svgPointerEvents,
							}}
							onPointerDown={handleSvgPointerDown}
							onPointerMove={handleSvgPointerMove}
							onPointerUp={handleSvgPointerUp}
							onPointerCancel={handleSvgPointerUp}
						>
							{strokes.map((s, idx) => (
								<path
									key={idx}
									d={getSvgPathFromStroke(getStroke(s.points, { ...strokeOptions, last: true }))}
									fill={penColor}
									style={{
										pointerEvents: strokePointerEvents,
										cursor: tool === 'eraser' ? 'pointer' : undefined,
									}}
									onClick={() => {
										if (tool === 'eraser') eraseStrokeAt(idx);
									}}
								/>
							))}
							{currentPoints.length > 0 && (
								<path
									d={getSvgPathFromStroke(getStroke(currentPoints, strokeOptions))}
									fill={penColor}
									style={{ pointerEvents: 'none' }}
								/>
							)}
						</svg>
					)}
				</div>
			</div>
		);
	}
);

export default AnnotatorCanvas;

/**
 * AnnotatorCanvas — Pan/zoomable image with an SVG overlay for freehand strokes
 * and geometric shapes (rect / ellipse / arrow).
 *
 * Stroke and shape coordinates are stored in native image space (the SVG's
 * viewBox matches the image's intrinsic dimensions) so they survive zoom/pan
 * changes untouched. The transformed inner div applies a `translate(x, y)
 * scale(s)` with `transform-origin: 0 0`, which gives a clean inverse:
 *   imageX = (clientX - svgRect.left) / view.scale
 *   imageY = (clientY - svgRect.top) / view.scale
 *
 * Wrapper is `pointer-events: 'none'` in pen/eraser/shape mode (the default)
 * so the portal'd toolbar and the settings drawer can never be blocked by it;
 * the SVG itself catches pointer hits, with shape bodies + handles opting in
 * when a shape tool is active and strokes opting in only in eraser mode.
 * Holding `space` or `shift` flips the wrapper to `'auto'` and lets it consume
 * drag-to-pan; the SVG correspondingly drops to `'none'` so the pan drag
 * isn't interrupted. Wheel zoom listens on `document` (with a bounds check
 * against the wrapper) so it survives the click-through state.
 *
 * Shape interaction routing (when a shape tool is active):
 *   • Pointerdown on a resize handle → start resize
 *   • Pointerdown on a shape body    → select + start move
 *   • Pointerdown on a fill toggle   → flip shape.filled
 *   • Pointerdown on empty SVG       → start drawing a new shape
 * The current interaction lives in `interactionRef` so move/up handlers see
 * the latest values without re-binding on every pointermove tick.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getStroke } from 'perfect-freehand';
import getSvgPathFromStroke from './getSvgPathFromStroke';
import type { Shape, ShapeKind, ShapeStyle, UseAnnotatorStateReturn } from './useAnnotatorState';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { generateId } from '../../utils/ids';

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

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | 'p1' | 'p2';

type Interaction =
	| { kind: 'pen'; pointerId: number }
	| { kind: 'shape-draw'; pointerId: number }
	| {
			kind: 'shape-move';
			pointerId: number;
			shapeId: string;
			startImgX: number;
			startImgY: number;
			origX1: number;
			origY1: number;
			origX2: number;
			origY2: number;
	  }
	| {
			kind: 'shape-resize';
			pointerId: number;
			shapeId: string;
			handle: ResizeHandle;
			origX1: number;
			origY1: number;
			origX2: number;
			origY2: number;
	  };

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

const SHAPE_TOOLS: ReadonlySet<string> = new Set(['rect', 'ellipse', 'arrow']);

interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

function bboxOf(shape: Pick<Shape, 'x1' | 'y1' | 'x2' | 'y2'>): Bbox {
	const x = Math.min(shape.x1, shape.x2);
	const y = Math.min(shape.y1, shape.y2);
	const w = Math.abs(shape.x2 - shape.x1);
	const h = Math.abs(shape.y2 - shape.y1);
	return { x, y, w, h };
}

function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, size: number): string {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 0.5) return '';
	const ux = dx / len;
	const uy = dy / len;
	const px = -uy;
	const py = ux;
	const headLen = Math.max(size * 3, 12);
	const headWidth = Math.max(size * 1.6, 7);
	const baseX = x2 - ux * headLen;
	const baseY = y2 - uy * headLen;
	const leftX = baseX + px * headWidth;
	const leftY = baseY + py * headWidth;
	const rightX = baseX - px * headWidth;
	const rightY = baseY - py * headWidth;
	return `${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}`;
}

export const AnnotatorCanvas = forwardRef<SVGSVGElement, AnnotatorCanvasProps>(
	function AnnotatorCanvas({ imageDataUrl, state }, forwardedRef) {
		const {
			strokes,
			currentPoints,
			shapes,
			currentShape,
			selectedShapeId,
			tool,
			view,
			setView,
			beginStroke,
			extendStroke,
			endStroke,
			eraseStrokeAt,
			beginShape,
			updateCurrentShape,
			commitCurrentShape,
			cancelCurrentShape,
			updateShape,
			deleteShape,
			selectShape,
		} = state;

		const wrapperRef = useRef<HTMLDivElement>(null);
		const svgRef = useRef<SVGSVGElement>(null);
		const [imgSize, setImgSize] = useState<ImgSize | null>(null);
		useImperativeHandle(forwardedRef, () => svgRef.current as SVGSVGElement, [imgSize]);

		const penColor = useSettingsStore((s) => s.annotatorPenColor);
		const penSize = useSettingsStore((s) => s.annotatorPenSize);
		const thinning = useSettingsStore((s) => s.annotatorThinning);
		const smoothing = useSettingsStore((s) => s.annotatorSmoothing);
		const streamline = useSettingsStore((s) => s.annotatorStreamline);
		const taperStart = useSettingsStore((s) => s.annotatorTaperStart);
		const taperEnd = useSettingsStore((s) => s.annotatorTaperEnd);

		const [isSpaceHeld, setIsSpaceHeld] = useState(false);
		const [isShiftHeld, setIsShiftHeld] = useState(false);
		const panEnabled = isSpaceHeld || isShiftHeld || tool === 'pan';

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
		// blocks `preventDefault()`. Attach to document with `{ passive: false }`
		// so the wheel still triggers zoom even when the wrapper itself is
		// `pointer-events: none`.
		useEffect(() => {
			const onWheel = (e: WheelEvent) => {
				const wrapper = wrapperRef.current;
				if (!wrapper) return;
				const rect = wrapper.getBoundingClientRect();
				if (
					e.clientX < rect.left ||
					e.clientX > rect.right ||
					e.clientY < rect.top ||
					e.clientY > rect.bottom
				) {
					return;
				}
				e.preventDefault();
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
			document.addEventListener('wheel', onWheel, { passive: false });
			return () => document.removeEventListener('wheel', onWheel);
		}, [setView]);

		// Keyboard shortcuts (`0` reset, `f` fit, space- or shift-to-pan,
		// Delete/Backspace removes selected shape, Escape deselects/cancels).
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
			if (e.key === 'Shift') {
				setIsShiftHeld(true);
				return;
			}
			if (e.key === 'Escape') {
				if (currentShape) {
					cancelCurrentShape();
					e.preventDefault();
				} else if (selectedShapeId) {
					selectShape(null);
					e.preventDefault();
				}
				return;
			}
			if ((e.key === 'Delete' || e.key === 'Backspace') && selectedShapeId) {
				deleteShape(selectedShapeId);
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
			if (e.key === 'Shift') setIsShiftHeld(false);
		});

		const panRef = useRef<PanState | null>(null);

		const handleWrapperPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
			if (!panEnabled) return;
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

		const interactionRef = useRef<Interaction | null>(null);

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
			if (!imgSize || e.button !== 0 || panEnabled) return;
			// Pen — freehand stroke.
			if (tool === 'pen') {
				e.stopPropagation();
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				interactionRef.current = { kind: 'pen', pointerId: e.pointerId };
				const pt = clientToImage(e.clientX, e.clientY);
				if (pt) beginStroke([pt[0], pt[1], e.pressure || 0.5]);
				return;
			}
			// Shape draw — empty-area click in a shape tool starts a new shape.
			if (SHAPE_TOOLS.has(tool)) {
				e.stopPropagation();
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				interactionRef.current = { kind: 'shape-draw', pointerId: e.pointerId };
				const pt = clientToImage(e.clientX, e.clientY);
				if (pt) {
					beginShape({
						id: generateId(),
						kind: tool as ShapeKind,
						x1: pt[0],
						y1: pt[1],
						x2: pt[0],
						y2: pt[1],
						style: { color: penColor, size: penSize, filled: true },
					});
				}
				return;
			}
			// Eraser/pan — fall through; eraser hits are handled per-stroke /
			// per-shape, pan is handled on the wrapper.
		};

		const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
			const pt = clientToImage(e.clientX, e.clientY);
			if (!pt) return;
			const interaction = interactionRef.current;
			if (!interaction) return;
			if (interaction.kind === 'pen') {
				extendStroke([pt[0], pt[1], e.pressure || 0.5]);
				return;
			}
			if (interaction.kind === 'shape-draw') {
				updateCurrentShape({ x2: pt[0], y2: pt[1] });
				return;
			}
			if (interaction.kind === 'shape-move') {
				const dx = pt[0] - interaction.startImgX;
				const dy = pt[1] - interaction.startImgY;
				updateShape(interaction.shapeId, {
					x1: interaction.origX1 + dx,
					y1: interaction.origY1 + dy,
					x2: interaction.origX2 + dx,
					y2: interaction.origY2 + dy,
				});
				return;
			}
			if (interaction.kind === 'shape-resize') {
				const next: Partial<Shape> = {};
				const minX = Math.min(interaction.origX1, interaction.origX2);
				const maxX = Math.max(interaction.origX1, interaction.origX2);
				const minY = Math.min(interaction.origY1, interaction.origY2);
				const maxY = Math.max(interaction.origY1, interaction.origY2);
				switch (interaction.handle) {
					case 'tl':
						next.x1 = pt[0];
						next.y1 = pt[1];
						next.x2 = maxX;
						next.y2 = maxY;
						break;
					case 'tr':
						next.x1 = minX;
						next.y1 = pt[1];
						next.x2 = pt[0];
						next.y2 = maxY;
						break;
					case 'bl':
						next.x1 = pt[0];
						next.y1 = minY;
						next.x2 = maxX;
						next.y2 = pt[1];
						break;
					case 'br':
						next.x1 = minX;
						next.y1 = minY;
						next.x2 = pt[0];
						next.y2 = pt[1];
						break;
					case 'p1':
						next.x1 = pt[0];
						next.y1 = pt[1];
						break;
					case 'p2':
						next.x2 = pt[0];
						next.y2 = pt[1];
						break;
				}
				updateShape(interaction.shapeId, next);
			}
		};

		const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
			const interaction = interactionRef.current;
			if (!interaction) return;
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				// Capture may already be released; not fatal.
			}
			if (interaction.kind === 'pen') {
				endStroke({
					color: penColor,
					size: penSize,
					thinning,
					smoothing,
					streamline,
					taperStart,
					taperEnd,
				});
			} else if (interaction.kind === 'shape-draw') {
				commitCurrentShape();
			}
			interactionRef.current = null;
		};

		// Begin a move on a shape body. Selects the shape and primes the
		// move state. Stops propagation so the SVG-level pointerdown (which
		// would start a new shape) doesn't also fire.
		const handleShapePointerDown = (shape: Shape, e: React.PointerEvent<SVGElement>) => {
			if (e.button !== 0 || panEnabled) return;
			if (tool === 'eraser') {
				e.stopPropagation();
				deleteShape(shape.id);
				return;
			}
			if (!SHAPE_TOOLS.has(tool)) return;
			e.stopPropagation();
			e.preventDefault();
			selectShape(shape.id);
			const svg = svgRef.current;
			if (!svg) return;
			svg.setPointerCapture(e.pointerId);
			const pt = clientToImage(e.clientX, e.clientY);
			if (!pt) return;
			interactionRef.current = {
				kind: 'shape-move',
				pointerId: e.pointerId,
				shapeId: shape.id,
				startImgX: pt[0],
				startImgY: pt[1],
				origX1: shape.x1,
				origY1: shape.y1,
				origX2: shape.x2,
				origY2: shape.y2,
			};
		};

		// Begin a resize on a selection handle. Stops propagation so we don't
		// fall through to shape-move or shape-draw.
		const handleResizeHandlePointerDown = (
			shape: Shape,
			handle: ResizeHandle,
			e: React.PointerEvent<SVGElement>
		) => {
			if (e.button !== 0 || panEnabled) return;
			e.stopPropagation();
			e.preventDefault();
			const svg = svgRef.current;
			if (!svg) return;
			svg.setPointerCapture(e.pointerId);
			interactionRef.current = {
				kind: 'shape-resize',
				pointerId: e.pointerId,
				shapeId: shape.id,
				handle,
				origX1: shape.x1,
				origY1: shape.y1,
				origX2: shape.x2,
				origY2: shape.y2,
			};
		};

		// Live options for the in-progress freehand stroke only — committed
		// strokes use the per-stroke style captured at endStroke time.
		const liveStrokeOptions = {
			size: penSize,
			thinning,
			smoothing,
			streamline,
			start: { taper: taperStart },
			end: { taper: taperEnd },
		};

		const wrapperCursor = panEnabled
			? panRef.current
				? 'grabbing'
				: 'grab'
			: tool === 'pen' || tool === 'eraser'
				? 'crosshair'
				: SHAPE_TOOLS.has(tool)
					? 'crosshair'
					: 'default';

		const strokePointerEvents = tool === 'eraser' ? 'all' : 'none';
		const svgPointerEvents = panEnabled ? 'none' : 'auto';
		// Shapes are interactive when a shape tool or eraser is active.
		const shapePointerEvents: 'auto' | 'none' =
			SHAPE_TOOLS.has(tool) || tool === 'eraser' ? 'auto' : 'none';

		// Visual sizing for selection handles + fill toggle. We want them to
		// look ~constant on screen across zoom levels — divide by view.scale.
		const HANDLE_PX = 12;
		const TOGGLE_PX = 22;
		const handleSize = HANDLE_PX / view.scale;
		const toggleSize = TOGGLE_PX / view.scale;

		const renderShape = (shape: Shape, opts: { live: boolean }): React.ReactNode => {
			const { x, y, w, h } = bboxOf(shape);
			const stroke = shape.style.color;
			const strokeWidth = shape.style.size;
			const filled = shape.style.filled;
			const fill = filled ? shape.style.color : 'none';
			const cursor = opts.live ? undefined : 'move';
			const onPointerDown = opts.live
				? undefined
				: (e: React.PointerEvent<SVGElement>) => handleShapePointerDown(shape, e);
			const pe = opts.live ? 'none' : shapePointerEvents;
			if (shape.kind === 'rect') {
				return (
					<rect
						x={x}
						y={y}
						width={w}
						height={h}
						fill={fill}
						stroke={stroke}
						strokeWidth={filled ? 0 : strokeWidth}
						style={{ pointerEvents: pe, cursor }}
						onPointerDown={onPointerDown}
					/>
				);
			}
			if (shape.kind === 'ellipse') {
				return (
					<ellipse
						cx={x + w / 2}
						cy={y + h / 2}
						rx={w / 2}
						ry={h / 2}
						fill={fill}
						stroke={stroke}
						strokeWidth={filled ? 0 : strokeWidth}
						style={{ pointerEvents: pe, cursor }}
						onPointerDown={onPointerDown}
					/>
				);
			}
			// arrow
			const head = arrowHeadPoints(shape.x1, shape.y1, shape.x2, shape.y2, strokeWidth);
			return (
				<g
					style={{ pointerEvents: pe, cursor }}
					onPointerDown={onPointerDown as React.PointerEventHandler<SVGGElement> | undefined}
				>
					<line
						x1={shape.x1}
						y1={shape.y1}
						x2={shape.x2}
						y2={shape.y2}
						stroke={stroke}
						strokeWidth={strokeWidth}
						strokeLinecap="round"
					/>
					{head && <polygon points={head} fill={stroke} stroke={stroke} strokeWidth={1} />}
					{/* Wider invisible hit-line so the user doesn't have to click
					    pixel-perfect on a thin arrow shaft. */}
					<line
						x1={shape.x1}
						y1={shape.y1}
						x2={shape.x2}
						y2={shape.y2}
						stroke="transparent"
						strokeWidth={Math.max(strokeWidth * 3, 16)}
						strokeLinecap="round"
					/>
				</g>
			);
		};

		const renderHandles = (shape: Shape): React.ReactNode => {
			const handleColor = '#ffffff';
			const handleStroke = '#000000';
			const handleProps = (handle: ResizeHandle, hx: number, hy: number, cur: string) => ({
				key: handle,
				x: hx - handleSize / 2,
				y: hy - handleSize / 2,
				width: handleSize,
				height: handleSize,
				fill: handleColor,
				stroke: handleStroke,
				strokeWidth: 1 / view.scale,
				style: { pointerEvents: 'auto' as const, cursor: cur },
				onPointerDown: (e: React.PointerEvent<SVGRectElement>) =>
					handleResizeHandlePointerDown(shape, handle, e),
			});
			if (shape.kind === 'arrow') {
				return (
					<g>
						<rect {...handleProps('p1', shape.x1, shape.y1, 'crosshair')} />
						<rect {...handleProps('p2', shape.x2, shape.y2, 'crosshair')} />
					</g>
				);
			}
			const { x, y, w, h } = bboxOf(shape);
			return (
				<g>
					<rect {...handleProps('tl', x, y, 'nwse-resize')} />
					<rect {...handleProps('tr', x + w, y, 'nesw-resize')} />
					<rect {...handleProps('bl', x, y + h, 'nesw-resize')} />
					<rect {...handleProps('br', x + w, y + h, 'nwse-resize')} />
				</g>
			);
		};

		const renderFillToggle = (shape: Shape): React.ReactNode => {
			// Arrows ignore the fill/outline toggle — head is always solid.
			if (shape.kind === 'arrow') return null;
			const { x, y, w } = bboxOf(shape);
			const cx = x + w + toggleSize;
			const cy = y - toggleSize / 2;
			const r = toggleSize / 2;
			const onClick = (e: React.PointerEvent<SVGGElement>) => {
				e.stopPropagation();
				e.preventDefault();
				const nextStyle: ShapeStyle = { ...shape.style, filled: !shape.style.filled };
				updateShape(shape.id, { style: nextStyle });
			};
			return (
				<g
					style={{ pointerEvents: 'auto', cursor: 'pointer' }}
					onPointerDown={onClick}
					aria-label="Toggle fill / outline"
				>
					<circle
						cx={cx}
						cy={cy}
						r={r}
						fill="#1f1f1f"
						stroke="#ffffff"
						strokeWidth={1.5 / view.scale}
					/>
					{/* Half-fill hint: left half of icon matches the current fill state. */}
					{shape.style.filled ? (
						<rect
							x={cx - r * 0.55}
							y={cy - r * 0.55}
							width={r * 1.1}
							height={r * 1.1}
							fill={shape.style.color}
							stroke="none"
							rx={r * 0.15}
						/>
					) : (
						<rect
							x={cx - r * 0.55}
							y={cy - r * 0.55}
							width={r * 1.1}
							height={r * 1.1}
							fill="none"
							stroke={shape.style.color}
							strokeWidth={Math.max(1.5 / view.scale, shape.style.size * 0.6)}
							rx={r * 0.15}
						/>
					)}
				</g>
			);
		};

		const renderSelectionOutline = (shape: Shape): React.ReactNode => {
			const { x, y, w, h } = bboxOf(shape);
			return (
				<rect
					x={x}
					y={y}
					width={w}
					height={h}
					fill="none"
					stroke="#9146FF"
					strokeWidth={1.5 / view.scale}
					strokeDasharray={`${4 / view.scale} ${3 / view.scale}`}
					style={{ pointerEvents: 'none' }}
				/>
			);
		};

		const selectedShape = selectedShapeId ? shapes.find((s) => s.id === selectedShapeId) : null;

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
					pointerEvents: panEnabled ? 'auto' : 'none',
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
							{/* Strokes */}
							{strokes.map((s, idx) => {
								const opts = {
									size: s.style.size,
									thinning: s.style.thinning,
									smoothing: s.style.smoothing,
									streamline: s.style.streamline,
									start: { taper: s.style.taperStart },
									end: { taper: s.style.taperEnd },
									last: true,
								};
								const d = getSvgPathFromStroke(getStroke(s.points, opts));
								const eraseStroke = () => {
									if (tool === 'eraser') eraseStrokeAt(idx);
								};
								return (
									<g key={`stroke-${s.id}`}>
										<path
											d={d}
											fill={s.style.color}
											style={{
												pointerEvents: strokePointerEvents,
												cursor: tool === 'eraser' ? 'pointer' : undefined,
											}}
											onClick={eraseStroke}
											onPointerDown={
												tool === 'eraser'
													? (e) => {
															e.stopPropagation();
															eraseStroke();
														}
													: undefined
											}
										/>
										{tool === 'eraser' && (
											<path
												d={d}
												fill="none"
												stroke="transparent"
												strokeWidth={Math.max(s.style.size * 1.5, 24)}
												strokeLinecap="round"
												strokeLinejoin="round"
												style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
												onClick={eraseStroke}
												onPointerDown={(e) => {
													e.stopPropagation();
													eraseStroke();
												}}
											/>
										)}
									</g>
								);
							})}
							{/* In-progress freehand stroke. */}
							{currentPoints.length > 0 && (
								<path
									d={getSvgPathFromStroke(getStroke(currentPoints, liveStrokeOptions))}
									fill={penColor}
									style={{ pointerEvents: 'none' }}
								/>
							)}
							{/* Committed shapes. */}
							{shapes.map((shape) => (
								<g key={`shape-${shape.id}`}>{renderShape(shape, { live: false })}</g>
							))}
							{/* In-progress shape (during a drag-to-draw). */}
							{currentShape && <g>{renderShape(currentShape, { live: true })}</g>}
							{/* Selection chrome — render last so handles + toggle stack on
							    top of the shape body. The `data-annotator-chrome` flag is
							    used by `compositeAnnotatedImage` to strip these elements
							    out before serializing for save/copy, so the user never
							    bakes selection handles into their image. */}
							{selectedShape && (
								<g data-annotator-chrome="true">
									{renderSelectionOutline(selectedShape)}
									{renderHandles(selectedShape)}
									{renderFillToggle(selectedShape)}
								</g>
							)}
						</svg>
					)}
				</div>
			</div>
		);
	}
);

export default AnnotatorCanvas;

/**
 * useAnnotatorState — In-memory state for the image annotator modal.
 *
 * Owns two collections of drawables — freehand strokes and geometric shapes
 * (rect / ellipse / arrow) — plus the active tool, the in-progress shape/stroke
 * being drawn, the selected shape, and the pan/zoom view transform. Pointer
 * coordinates passed in must already be in image-space — projection from
 * client coordinates is the canvas component's job.
 *
 * Each committed stroke and shape captures the pen/shape style in effect at
 * the moment it was finished, so subsequent setting changes only affect
 * future drawables — past ones stay locked in.
 *
 * Undo walks a unified `history` log so it can pop strokes and shapes in the
 * order they were added, regardless of which collection they live in. Move
 * and resize edits are NOT in the history (live edits) — undoing a moved
 * shape simply removes it.
 */

import { useCallback, useState } from 'react';

export type AnnotatorTool = 'pen' | 'eraser' | 'pan' | 'rect' | 'ellipse' | 'arrow';

export type StrokePoint = [number, number, number];

export interface StrokeStyle {
	color: string;
	size: number;
	thinning: number;
	smoothing: number;
	streamline: number;
	taperStart: number;
	taperEnd: number;
}

export interface Stroke {
	points: StrokePoint[];
	style: StrokeStyle;
}

export interface ShapeStyle {
	color: string;
	size: number;
	filled: boolean;
}

export type ShapeKind = 'rect' | 'ellipse' | 'arrow';

/**
 * A shape is fully described by two image-space anchor points plus a kind.
 * For rect/ellipse, p1 and p2 are opposite corners of the bounding box (any
 * two opposite corners — geometry normalizes). For arrow, p1 is the tail and
 * p2 is the head, so direction is preserved.
 */
export interface Shape {
	id: string;
	kind: ShapeKind;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	style: ShapeStyle;
}

export interface AnnotatorView {
	x: number;
	y: number;
	scale: number;
}

const INITIAL_VIEW: AnnotatorView = { x: 0, y: 0, scale: 1 };

type HistoryEntry = { kind: 'stroke' } | { kind: 'shape'; id: string };

export interface UseAnnotatorStateReturn {
	strokes: Stroke[];
	currentPoints: StrokePoint[];
	shapes: Shape[];
	currentShape: Shape | null;
	selectedShapeId: string | null;
	tool: AnnotatorTool;
	setTool: (tool: AnnotatorTool) => void;
	view: AnnotatorView;
	setView: (view: AnnotatorView | ((prev: AnnotatorView) => AnnotatorView)) => void;
	beginStroke: (point: StrokePoint) => void;
	extendStroke: (point: StrokePoint) => void;
	endStroke: (style: StrokeStyle) => void;
	eraseStrokeAt: (index: number) => void;
	beginShape: (shape: Shape) => void;
	updateCurrentShape: (partial: Partial<Pick<Shape, 'x1' | 'y1' | 'x2' | 'y2'>>) => void;
	commitCurrentShape: () => void;
	cancelCurrentShape: () => void;
	updateShape: (id: string, partial: Partial<Shape>) => void;
	deleteShape: (id: string) => void;
	selectShape: (id: string | null) => void;
	undo: () => void;
	clear: () => void;
}

export function useAnnotatorState(): UseAnnotatorStateReturn {
	const [strokes, setStrokes] = useState<Stroke[]>([]);
	const [currentPoints, setCurrentPoints] = useState<StrokePoint[]>([]);
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [currentShape, setCurrentShape] = useState<Shape | null>(null);
	const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
	const [tool, setToolInternal] = useState<AnnotatorTool>('pen');
	const [view, setView] = useState<AnnotatorView>(INITIAL_VIEW);
	// History is read-only inside `undo` via the setter callback, never as a
	// dependency of any other render path — so we drop the value half of the
	// destructure to keep the hook lean.
	const [, setHistory] = useState<HistoryEntry[]>([]);

	// Switching tools deselects any shape so the user gets a clean slate. The
	// in-progress shape is also cleared if they were mid-draw.
	const setTool = useCallback((next: AnnotatorTool) => {
		setToolInternal(next);
		setSelectedShapeId(null);
		setCurrentShape(null);
	}, []);

	const beginStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints([point]);
	}, []);

	const extendStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints((prev) => (prev.length === 0 ? prev : [...prev, point]));
	}, []);

	const endStroke = useCallback((style: StrokeStyle) => {
		setCurrentPoints((prev) => {
			if (prev.length === 0) return prev;
			setStrokes((s) => [...s, { points: prev, style }]);
			setHistory((h) => [...h, { kind: 'stroke' }]);
			return [];
		});
	}, []);

	const eraseStrokeAt = useCallback((index: number) => {
		setStrokes((prev) => {
			if (index < 0 || index >= prev.length) return prev;
			const next = prev.slice();
			next.splice(index, 1);
			return next;
		});
	}, []);

	const beginShape = useCallback((shape: Shape) => {
		setCurrentShape(shape);
		setSelectedShapeId(null);
	}, []);

	const updateCurrentShape = useCallback(
		(partial: Partial<Pick<Shape, 'x1' | 'y1' | 'x2' | 'y2'>>) => {
			setCurrentShape((prev) => (prev ? { ...prev, ...partial } : prev));
		},
		[]
	);

	const commitCurrentShape = useCallback(() => {
		setCurrentShape((prev) => {
			if (!prev) return prev;
			// Reject zero-area shapes — they're an accidental click rather than a draw.
			if (Math.abs(prev.x2 - prev.x1) < 2 && Math.abs(prev.y2 - prev.y1) < 2) {
				return null;
			}
			setShapes((s) => [...s, prev]);
			setHistory((h) => [...h, { kind: 'shape', id: prev.id }]);
			setSelectedShapeId(prev.id);
			return null;
		});
	}, []);

	const cancelCurrentShape = useCallback(() => {
		setCurrentShape(null);
	}, []);

	const updateShape = useCallback((id: string, partial: Partial<Shape>) => {
		setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, ...partial } : s)));
	}, []);

	const deleteShape = useCallback((id: string) => {
		setShapes((prev) => prev.filter((s) => s.id !== id));
		setSelectedShapeId((prev) => (prev === id ? null : prev));
		setHistory((prev) => prev.filter((h) => h.kind !== 'shape' || h.id !== id));
	}, []);

	const selectShape = useCallback((id: string | null) => {
		setSelectedShapeId(id);
	}, []);

	const undo = useCallback(() => {
		setHistory((prev) => {
			if (prev.length === 0) return prev;
			const last = prev[prev.length - 1];
			if (last.kind === 'stroke') {
				setStrokes((s) => (s.length === 0 ? s : s.slice(0, -1)));
			} else {
				setShapes((s) => s.filter((sh) => sh.id !== last.id));
				setSelectedShapeId((sel) => (sel === last.id ? null : sel));
			}
			return prev.slice(0, -1);
		});
	}, []);

	const clear = useCallback(() => {
		setStrokes([]);
		setCurrentPoints([]);
		setShapes([]);
		setCurrentShape(null);
		setSelectedShapeId(null);
		setHistory([]);
	}, []);

	return {
		strokes,
		currentPoints,
		shapes,
		currentShape,
		selectedShapeId,
		tool,
		setTool,
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
		undo,
		clear,
	};
}

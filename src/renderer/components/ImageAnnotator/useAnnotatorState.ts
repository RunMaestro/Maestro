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
import { generateId } from '../../utils/ids';

export type AnnotatorTool = 'pen' | 'eraser' | 'pan' | 'rect' | 'ellipse' | 'arrow' | 'text';

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
	id: string;
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

export interface TextStyle {
	color: string;
	size: number;
	font: string;
	/** Background fill behind the text. `null` means no background (transparent). */
	bgColor: string | null;
}

/**
 * A text label is anchored at (x, y) in image space (top-left of its bounding
 * box). `value` is the rendered string; an empty string means the user opened
 * an editor and then dismissed it without typing — those are filtered out on
 * commit rather than rendered as ghost selection rectangles.
 */
export interface TextBox {
	id: string;
	x: number;
	y: number;
	value: string;
	style: TextStyle;
}

export interface AnnotatorView {
	x: number;
	y: number;
	scale: number;
}

const INITIAL_VIEW: AnnotatorView = { x: 0, y: 0, scale: 1 };

type HistoryEntry =
	{ kind: 'stroke'; id: string } | { kind: 'shape'; id: string } | { kind: 'text'; id: string };

export interface UseAnnotatorStateReturn {
	strokes: Stroke[];
	currentPoints: StrokePoint[];
	shapes: Shape[];
	currentShape: Shape | null;
	selectedShapeId: string | null;
	texts: TextBox[];
	editingTextId: string | null;
	selectedTextId: string | null;
	tool: AnnotatorTool;
	setTool: (tool: AnnotatorTool) => void;
	view: AnnotatorView;
	setView: (view: AnnotatorView | ((prev: AnnotatorView) => AnnotatorView)) => void;
	beginStroke: (point: StrokePoint) => void;
	extendStroke: (point: StrokePoint) => void;
	extendStrokeStraight: (point: StrokePoint) => void;
	endStroke: (style: StrokeStyle) => void;
	eraseStrokeAt: (index: number) => void;
	beginShape: (shape: Shape) => void;
	updateCurrentShape: (partial: Partial<Pick<Shape, 'x1' | 'y1' | 'x2' | 'y2'>>) => void;
	commitCurrentShape: () => void;
	cancelCurrentShape: () => void;
	updateShape: (id: string, partial: Partial<Shape>) => void;
	deleteShape: (id: string) => void;
	selectShape: (id: string | null) => void;
	beginText: (x: number, y: number, style: TextStyle) => string;
	updateTextValue: (id: string, value: string) => void;
	updateText: (id: string, partial: Partial<TextBox>) => void;
	commitTextEditing: () => void;
	deleteText: (id: string) => void;
	selectText: (id: string | null) => void;
	editText: (id: string | null) => void;
	undo: () => void;
	clear: () => void;
}

export function useAnnotatorState(): UseAnnotatorStateReturn {
	const [strokes, setStrokes] = useState<Stroke[]>([]);
	const [currentPoints, setCurrentPoints] = useState<StrokePoint[]>([]);
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [currentShape, setCurrentShape] = useState<Shape | null>(null);
	const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
	const [texts, setTexts] = useState<TextBox[]>([]);
	const [editingTextId, setEditingTextId] = useState<string | null>(null);
	const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
	const [tool, setToolInternal] = useState<AnnotatorTool>('pen');
	const [view, setView] = useState<AnnotatorView>(INITIAL_VIEW);
	// History is read-only inside `undo` via the setter callback, never as a
	// dependency of any other render path — so we drop the value half of the
	// destructure to keep the hook lean.
	const [, setHistory] = useState<HistoryEntry[]>([]);

	// Switching tools deselects any shape so the user gets a clean slate. The
	// in-progress shape is also cleared if they were mid-draw. Text editing
	// is committed (not cancelled) so a tool change doesn't silently discard
	// what the user just typed.
	const setTool = useCallback((next: AnnotatorTool) => {
		setToolInternal(next);
		setSelectedShapeId(null);
		setCurrentShape(null);
		setSelectedTextId(null);
		setEditingTextId(null);
	}, []);

	const beginStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints([point]);
	}, []);

	const extendStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints((prev) => (prev.length === 0 ? prev : [...prev, point]));
	}, []);

	// Straight-line variant (shift held while drawing): collapse the stroke to
	// the anchor (its first point) and the current cursor, so perfect-freehand
	// renders a clean straight segment instead of the freehand trail.
	const extendStrokeStraight = useCallback((point: StrokePoint) => {
		setCurrentPoints((prev) => (prev.length === 0 ? prev : [prev[0], point]));
	}, []);

	const endStroke = useCallback((style: StrokeStyle) => {
		setCurrentPoints((prev) => {
			if (prev.length === 0) return prev;
			const id = generateId();
			setStrokes((s) => [...s, { id, points: prev, style }]);
			setHistory((h) => [...h, { kind: 'stroke', id }]);
			return [];
		});
	}, []);

	// Erase removes the stroke and its matching history entry so a subsequent
	// `undo()` doesn't pop a different stroke than the one the user erased.
	const eraseStrokeAt = useCallback((index: number) => {
		setStrokes((prev) => {
			if (index < 0 || index >= prev.length) return prev;
			const erased = prev[index];
			const next = prev.slice();
			next.splice(index, 1);
			setHistory((h) => h.filter((entry) => !(entry.kind === 'stroke' && entry.id === erased.id)));
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

	// Create a fresh text box and immediately open it for editing. Returns the
	// new id so the caller (canvas) can focus the textarea on next paint.
	const beginText = useCallback((x: number, y: number, style: TextStyle): string => {
		const id = generateId();
		setTexts((prev) => [...prev, { id, x, y, value: '', style }]);
		setHistory((h) => [...h, { kind: 'text', id }]);
		setEditingTextId(id);
		setSelectedTextId(id);
		setSelectedShapeId(null);
		return id;
	}, []);

	const updateTextValue = useCallback((id: string, value: string) => {
		setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, value } : t)));
	}, []);

	const updateText = useCallback((id: string, partial: Partial<TextBox>) => {
		setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, ...partial } : t)));
	}, []);

	// Closing the editor: empty values are discarded along with their history
	// entry so undo doesn't have to step through phantom commits.
	const commitTextEditing = useCallback(() => {
		setEditingTextId((prev) => {
			if (!prev) return prev;
			const id = prev;
			setTexts((ts) => {
				const target = ts.find((t) => t.id === id);
				if (target && target.value.trim() === '') {
					setHistory((h) => h.filter((e) => !(e.kind === 'text' && e.id === id)));
					setSelectedTextId((sel) => (sel === id ? null : sel));
					return ts.filter((t) => t.id !== id);
				}
				return ts;
			});
			return null;
		});
	}, []);

	const deleteText = useCallback((id: string) => {
		setTexts((prev) => prev.filter((t) => t.id !== id));
		setSelectedTextId((prev) => (prev === id ? null : prev));
		setEditingTextId((prev) => (prev === id ? null : prev));
		setHistory((prev) => prev.filter((h) => h.kind !== 'text' || h.id !== id));
	}, []);

	const selectText = useCallback((id: string | null) => {
		setSelectedTextId(id);
		if (id !== null) setSelectedShapeId(null);
	}, []);

	const editText = useCallback((id: string | null) => {
		setEditingTextId(id);
		if (id !== null) {
			setSelectedTextId(id);
			setSelectedShapeId(null);
		}
	}, []);

	const undo = useCallback(() => {
		setHistory((prev) => {
			if (prev.length === 0) return prev;
			const last = prev[prev.length - 1];
			if (last.kind === 'stroke') {
				// Match by id so undo removes the same stroke that history points
				// at, even if earlier strokes were erased mid-session.
				setStrokes((s) => s.filter((stroke) => stroke.id !== last.id));
			} else if (last.kind === 'shape') {
				setShapes((s) => s.filter((sh) => sh.id !== last.id));
				setSelectedShapeId((sel) => (sel === last.id ? null : sel));
			} else {
				setTexts((ts) => ts.filter((t) => t.id !== last.id));
				setSelectedTextId((sel) => (sel === last.id ? null : sel));
				setEditingTextId((cur) => (cur === last.id ? null : cur));
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
		setTexts([]);
		setSelectedTextId(null);
		setEditingTextId(null);
		setHistory([]);
	}, []);

	return {
		strokes,
		currentPoints,
		shapes,
		currentShape,
		selectedShapeId,
		texts,
		editingTextId,
		selectedTextId,
		tool,
		setTool,
		view,
		setView,
		beginStroke,
		extendStroke,
		extendStrokeStraight,
		endStroke,
		eraseStrokeAt,
		beginShape,
		updateCurrentShape,
		commitCurrentShape,
		cancelCurrentShape,
		updateShape,
		deleteShape,
		selectShape,
		beginText,
		updateTextValue,
		updateText,
		commitTextEditing,
		deleteText,
		selectText,
		editText,
		undo,
		clear,
	};
}

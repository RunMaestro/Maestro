/**
 * useAnnotatorState — In-memory state for the image annotator modal.
 *
 * Owns the stroke list, the in-progress stroke, the active tool, and the
 * pan/zoom view transform. Pointer coordinates passed in must already be in
 * image-space — projection from client coordinates is the canvas component's
 * job. Undo is a simple `pop()`; clear is unconditional (the toolbar handles
 * confirmation). State is purely transient — nothing is persisted here.
 */

import { useCallback, useState } from 'react';

export type AnnotatorTool = 'pen' | 'eraser' | 'pan';

export type StrokePoint = [number, number, number];

export interface Stroke {
	points: StrokePoint[];
}

export interface AnnotatorView {
	x: number;
	y: number;
	scale: number;
}

const INITIAL_VIEW: AnnotatorView = { x: 0, y: 0, scale: 1 };

export interface UseAnnotatorStateReturn {
	strokes: Stroke[];
	currentPoints: StrokePoint[];
	tool: AnnotatorTool;
	setTool: (tool: AnnotatorTool) => void;
	view: AnnotatorView;
	setView: (view: AnnotatorView | ((prev: AnnotatorView) => AnnotatorView)) => void;
	beginStroke: (point: StrokePoint) => void;
	extendStroke: (point: StrokePoint) => void;
	endStroke: () => void;
	eraseStrokeAt: (index: number) => void;
	undo: () => void;
	clear: () => void;
}

export function useAnnotatorState(): UseAnnotatorStateReturn {
	const [strokes, setStrokes] = useState<Stroke[]>([]);
	const [currentPoints, setCurrentPoints] = useState<StrokePoint[]>([]);
	const [tool, setTool] = useState<AnnotatorTool>('pen');
	const [view, setView] = useState<AnnotatorView>(INITIAL_VIEW);

	const beginStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints([point]);
	}, []);

	const extendStroke = useCallback((point: StrokePoint) => {
		setCurrentPoints((prev) => (prev.length === 0 ? prev : [...prev, point]));
	}, []);

	const endStroke = useCallback(() => {
		setCurrentPoints((prev) => {
			if (prev.length === 0) return prev;
			setStrokes((s) => [...s, { points: prev }]);
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

	const undo = useCallback(() => {
		setStrokes((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
	}, []);

	const clear = useCallback(() => {
		setStrokes([]);
		setCurrentPoints([]);
	}, []);

	return {
		strokes,
		currentPoints,
		tool,
		setTool,
		view,
		setView,
		beginStroke,
		extendStroke,
		endStroke,
		eraseStrokeAt,
		undo,
		clear,
	};
}

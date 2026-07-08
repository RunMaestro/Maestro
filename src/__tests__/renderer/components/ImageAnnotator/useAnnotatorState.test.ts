import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useAnnotatorState,
	type Shape,
	type ShapeStyle,
	type StrokeStyle,
	type TextStyle,
} from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';

const idState = vi.hoisted(() => ({ counter: 0 }));

vi.mock('../../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idState.counter}`),
}));

const strokeStyle: StrokeStyle = {
	color: '#ff0000',
	size: 4,
	thinning: 0.5,
	smoothing: 0.5,
	streamline: 0.5,
	taperStart: 0,
	taperEnd: 0,
};

const shapeStyle: ShapeStyle = {
	color: '#00ff00',
	size: 2,
	filled: false,
};

const textStyle: TextStyle = {
	color: '#0000ff',
	size: 14,
	font: 'Inter',
	bgColor: null,
};

function makeShape(id: string, overrides: Partial<Shape> = {}): Shape {
	return {
		id,
		kind: 'rect',
		x1: 10,
		y1: 20,
		x2: 80,
		y2: 90,
		style: shapeStyle,
		...overrides,
	};
}

describe('useAnnotatorState', () => {
	beforeEach(() => {
		idState.counter = 0;
	});

	it('tracks strokes, straight-line drawing, erasing, and undo', () => {
		const { result } = renderHook(() => useAnnotatorState());

		act(() => {
			result.current.extendStroke([1, 1, 0.5]);
		});
		expect(result.current.currentPoints).toEqual([]);

		act(() => {
			result.current.beginStroke([1, 1, 0.5]);
			result.current.extendStroke([2, 2, 0.6]);
			result.current.extendStrokeStraight([5, 5, 0.7]);
			result.current.endStroke(strokeStyle);
		});

		expect(result.current.currentPoints).toEqual([]);
		expect(result.current.strokes).toHaveLength(1);
		expect(result.current.strokes[0]).toMatchObject({
			id: 'mock-id-1',
			points: [
				[1, 1, 0.5],
				[5, 5, 0.7],
			],
			style: strokeStyle,
		});

		act(() => {
			result.current.beginStroke([9, 9, 0.4]);
			result.current.endStroke(strokeStyle);
			result.current.eraseStrokeAt(-1);
			result.current.eraseStrokeAt(99);
		});
		expect(result.current.strokes).toHaveLength(2);

		act(() => {
			result.current.eraseStrokeAt(0);
		});
		expect(result.current.strokes.map((stroke) => stroke.id)).toEqual(['mock-id-2']);

		act(() => {
			result.current.undo();
		});
		expect(result.current.strokes).toEqual([]);
	});

	it('commits, updates, selects, deletes, and cancels shapes', () => {
		const { result } = renderHook(() => useAnnotatorState());

		act(() => {
			result.current.beginShape(makeShape('zero-shape', { x1: 1, y1: 1, x2: 2, y2: 2 }));
			result.current.commitCurrentShape();
		});
		expect(result.current.currentShape).toBeNull();
		expect(result.current.shapes).toEqual([]);

		act(() => {
			result.current.beginShape(makeShape('shape-1'));
			result.current.updateCurrentShape({ x2: 100 });
			result.current.commitCurrentShape();
		});
		expect(result.current.shapes[0]).toMatchObject({ id: 'shape-1', x2: 100 });
		expect(result.current.selectedShapeId).toBe('shape-1');

		act(() => {
			result.current.updateShape('shape-1', { kind: 'ellipse', y2: 120 });
			result.current.selectShape('shape-1');
		});
		expect(result.current.shapes[0]).toMatchObject({ kind: 'ellipse', y2: 120 });
		expect(result.current.selectedShapeId).toBe('shape-1');

		act(() => {
			result.current.beginShape(makeShape('shape-2'));
			result.current.cancelCurrentShape();
		});
		expect(result.current.currentShape).toBeNull();

		act(() => {
			result.current.deleteShape('shape-1');
		});
		expect(result.current.shapes).toEqual([]);
		expect(result.current.selectedShapeId).toBeNull();
	});

	it('creates, commits, edits, selects, deletes, and discards text boxes', () => {
		const { result } = renderHook(() => useAnnotatorState());
		let emptyTextId = '';
		let textId = '';

		act(() => {
			emptyTextId = result.current.beginText(10, 20, textStyle);
			result.current.commitTextEditing();
		});
		expect(emptyTextId).toBe('mock-id-1');
		expect(result.current.texts).toEqual([]);
		expect(result.current.editingTextId).toBeNull();
		expect(result.current.selectedTextId).toBeNull();

		act(() => {
			textId = result.current.beginText(30, 40, textStyle);
			result.current.updateTextValue(textId, 'Hello');
			result.current.updateText(textId, { x: 35, y: 45 });
			result.current.commitTextEditing();
		});
		expect(result.current.texts[0]).toMatchObject({
			id: 'mock-id-2',
			x: 35,
			y: 45,
			value: 'Hello',
		});
		expect(result.current.editingTextId).toBeNull();
		expect(result.current.selectedTextId).toBe(textId);

		act(() => {
			result.current.selectText(textId);
			result.current.editText(textId);
		});
		expect(result.current.selectedTextId).toBe(textId);
		expect(result.current.editingTextId).toBe(textId);
		expect(result.current.selectedShapeId).toBeNull();

		act(() => {
			result.current.editText(null);
			result.current.selectText(null);
			result.current.deleteText(textId);
		});
		expect(result.current.texts).toEqual([]);
		expect(result.current.selectedTextId).toBeNull();
		expect(result.current.editingTextId).toBeNull();
	});

	it('keeps tool/view state, undoes mixed history entries, and clears everything', () => {
		const { result } = renderHook(() => useAnnotatorState());
		let textId = '';

		act(() => {
			result.current.setView({ x: 10, y: 20, scale: 2 });
			result.current.setTool('rect');
		});
		act(() => {
			result.current.beginStroke([1, 1, 0.5]);
		});
		act(() => {
			result.current.endStroke(strokeStyle);
		});
		act(() => {
			result.current.beginShape(makeShape('shape-1'));
		});
		act(() => {
			result.current.commitCurrentShape();
		});
		act(() => {
			textId = result.current.beginText(30, 40, textStyle);
		});
		act(() => {
			result.current.updateTextValue(textId, 'Note');
		});
		act(() => {
			result.current.commitTextEditing();
		});

		expect(result.current.view).toEqual({ x: 10, y: 20, scale: 2 });
		expect(result.current.tool).toBe('rect');
		expect(result.current.strokes).toHaveLength(1);
		expect(result.current.shapes).toHaveLength(1);
		expect(result.current.texts).toHaveLength(1);

		act(() => {
			result.current.undo();
		});
		expect(result.current.texts).toEqual([]);
		expect(result.current.selectedTextId).toBeNull();

		act(() => {
			result.current.undo();
		});
		expect(result.current.shapes).toEqual([]);
		expect(result.current.selectedShapeId).toBeNull();

		act(() => {
			result.current.undo();
		});
		expect(result.current.strokes).toEqual([]);

		act(() => {
			result.current.undo();
			result.current.beginStroke([9, 9, 0.5]);
			result.current.beginShape(makeShape('shape-2'));
			result.current.beginText(50, 60, textStyle);
			result.current.setTool('pan');
		});
		expect(result.current.currentShape).toBeNull();
		expect(result.current.selectedShapeId).toBeNull();
		expect(result.current.selectedTextId).toBeNull();
		expect(result.current.editingTextId).toBeNull();

		act(() => {
			result.current.clear();
		});
		expect(result.current.strokes).toEqual([]);
		expect(result.current.currentPoints).toEqual([]);
		expect(result.current.shapes).toEqual([]);
		expect(result.current.currentShape).toBeNull();
		expect(result.current.texts).toEqual([]);
		expect(result.current.selectedShapeId).toBeNull();
		expect(result.current.selectedTextId).toBeNull();
		expect(result.current.editingTextId).toBeNull();
	});
});

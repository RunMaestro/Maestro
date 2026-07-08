import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotatorCanvas } from '../../../../renderer/components/ImageAnnotator/AnnotatorCanvas';
import type {
	Shape,
	Stroke,
	TextBox,
	UseAnnotatorStateReturn,
} from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

const idState = vi.hoisted(() => ({ counter: 0 }));

vi.mock('../../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `canvas-id-${++idState.counter}`),
}));

const imageDataUrl =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEklEQVR42mP8z8AARLJgYGBgAAUFAgJ9WwY0AAAAAElFTkSuQmCC';

const shapeStyle = {
	color: '#10b981',
	size: 4,
	filled: true,
};

const textStyle = {
	color: '#f97316',
	size: 20,
	font: 'sans-serif',
	bgColor: '#111827',
};

const selectedRect: Shape = {
	id: 'shape-1',
	kind: 'rect',
	x1: 20,
	y1: 30,
	x2: 80,
	y2: 90,
	style: shapeStyle,
};

const ellipseShape: Shape = {
	...selectedRect,
	id: 'shape-ellipse',
	kind: 'ellipse',
	x1: 100,
	y1: 60,
	x2: 170,
	y2: 130,
};

const arrowShape: Shape = {
	...selectedRect,
	id: 'shape-arrow',
	kind: 'arrow',
	x1: 40,
	y1: 40,
	x2: 160,
	y2: 120,
};

const selectedText: TextBox = {
	id: 'text-1',
	x: 60,
	y: 70,
	value: 'Label',
	style: textStyle,
};

const stroke: Stroke = {
	id: 'stroke-1',
	points: [
		[10, 10, 0.5],
		[35, 35, 0.5],
		[50, 20, 0.5],
	],
	style: {
		color: '#9146FF',
		size: 10,
		thinning: 0.5,
		smoothing: 0.5,
		streamline: 0.5,
		taperStart: 0,
		taperEnd: 0,
	},
};

function resetAnnotatorSettings() {
	useSettingsStore.setState({
		annotatorPenColor: '#9146FF',
		annotatorPenSize: 10,
		annotatorThinning: 0.5,
		annotatorSmoothing: 0.5,
		annotatorStreamline: 0.5,
		annotatorTaperStart: 0,
		annotatorTaperEnd: 0,
		annotatorTextColor: '#38bdf8',
		annotatorTextSize: 24,
		annotatorTextFont: 'serif',
		annotatorTextBgColor: '',
	});
}

function makeState(overrides: Partial<UseAnnotatorStateReturn> = {}): UseAnnotatorStateReturn {
	return {
		strokes: [],
		currentPoints: [],
		shapes: [],
		currentShape: null,
		selectedShapeId: null,
		texts: [],
		editingTextId: null,
		selectedTextId: null,
		tool: 'pen',
		setTool: vi.fn(),
		view: { x: 0, y: 0, scale: 1 },
		setView: vi.fn(),
		beginStroke: vi.fn(),
		extendStroke: vi.fn(),
		extendStrokeStraight: vi.fn(),
		endStroke: vi.fn(),
		eraseStrokeAt: vi.fn(),
		beginShape: vi.fn(),
		updateCurrentShape: vi.fn(),
		commitCurrentShape: vi.fn(),
		cancelCurrentShape: vi.fn(),
		updateShape: vi.fn(),
		deleteShape: vi.fn(),
		selectShape: vi.fn(),
		beginText: vi.fn(() => 'text-new'),
		updateTextValue: vi.fn(),
		updateText: vi.fn(),
		commitTextEditing: vi.fn(),
		deleteText: vi.fn(),
		selectText: vi.fn(),
		editText: vi.fn(),
		undo: vi.fn(),
		clear: vi.fn(),
		...overrides,
	} as UseAnnotatorStateReturn;
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
	return {
		x,
		y,
		left: x,
		top: y,
		width,
		height,
		right: x + width,
		bottom: y + height,
		toJSON: () => ({}),
	} as DOMRect;
}

async function renderLoadedCanvas(state = makeState()) {
	const result = render(<AnnotatorCanvas imageDataUrl={imageDataUrl} state={state} />);
	const img = result.container.querySelector('img') as HTMLImageElement;
	Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 400 });
	Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 300 });
	fireEvent.load(img);
	const svg = await waitFor(() => {
		const found = result.container.querySelector('svg');
		expect(found).not.toBeNull();
		return found as SVGSVGElement;
	});
	return {
		...result,
		img,
		svg,
		wrapper: result.container.firstElementChild as HTMLDivElement,
	};
}

function dispatchKey(type: 'keydown' | 'keyup', init: KeyboardEventInit) {
	if (type === 'keydown') {
		fireEvent.keyDown(window, init);
	} else {
		fireEvent.keyUp(window, init);
	}
}

describe('AnnotatorCanvas', () => {
	beforeEach(() => {
		idState.counter = 0;
		resetAnnotatorSettings();
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
			rect(0, 0, 800, 600)
		);
		vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
			rect(0, 0, 400, 300)
		);
		Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
			configurable: true,
			value: vi.fn(),
		});
		Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
			configurable: true,
			value: vi.fn(),
		});
		Object.defineProperty(SVGElement.prototype, 'setPointerCapture', {
			configurable: true,
			value: vi.fn(),
		});
		Object.defineProperty(SVGElement.prototype, 'releasePointerCapture', {
			configurable: true,
			value: vi.fn(),
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		resetAnnotatorSettings();
	});

	it('fits the image on load, zooms with the wheel, and resets/fits from keyboard shortcuts', async () => {
		const state = makeState();
		const { img } = await renderLoadedCanvas(state);

		expect(img).toHaveAttribute('src', imageDataUrl);
		expect(state.setView).toHaveBeenCalledWith({ scale: 1, x: 200, y: 150 });

		document.dispatchEvent(
			new WheelEvent('wheel', {
				clientX: 100,
				clientY: 120,
				deltaY: -100,
				bubbles: true,
				cancelable: true,
			})
		);
		expect(state.setView).toHaveBeenLastCalledWith({
			scale: expect.any(Number),
			x: expect.any(Number),
			y: expect.any(Number),
		});

		dispatchKey('keydown', { key: '0' });
		expect(state.setView).toHaveBeenLastCalledWith({ scale: 1, x: 200, y: 150 });

		dispatchKey('keydown', { key: 'f' });
		expect(state.setView).toHaveBeenLastCalledWith({ scale: 1, x: 200, y: 150 });
	});

	it('draws freehand pen strokes and constrains strokes while shift is held', async () => {
		const state = makeState();
		const { svg } = await renderLoadedCanvas(state);

		fireEvent.pointerDown(svg, {
			button: 0,
			pointerId: 1,
			clientX: 20,
			clientY: 30,
			pressure: 0.7,
		});
		expect(state.beginStroke).toHaveBeenCalledWith([20, 30, expect.closeTo(0.7)]);

		fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 60, pressure: 0.6 });
		expect(state.extendStroke).toHaveBeenCalledWith([40, 60, expect.closeTo(0.6)]);

		dispatchKey('keydown', { key: 'Shift' });
		fireEvent.pointerMove(svg, { pointerId: 1, clientX: 80, clientY: 100, pressure: 0.4 });
		expect(state.extendStrokeStraight).toHaveBeenCalledWith([80, 100, expect.closeTo(0.4)]);

		fireEvent.pointerUp(svg, { pointerId: 1 });
		expect(state.endStroke).toHaveBeenCalledWith({
			color: '#9146FF',
			size: 10,
			thinning: 0.5,
			smoothing: 0.5,
			streamline: 0.5,
			taperStart: 0,
			taperEnd: 0,
		});
		dispatchKey('keyup', { key: 'Shift' });
	});

	it('draws shapes, moves selected shapes, resizes handles, toggles fill, and deletes selection', async () => {
		const drawingState = makeState({ tool: 'rect' });
		const { svg: drawingSvg } = await renderLoadedCanvas(drawingState);

		fireEvent.pointerDown(drawingSvg, {
			button: 0,
			pointerId: 2,
			clientX: 30,
			clientY: 40,
		});
		expect(drawingState.beginShape).toHaveBeenCalledWith({
			id: 'canvas-id-1',
			kind: 'rect',
			x1: 30,
			y1: 40,
			x2: 30,
			y2: 40,
			style: { color: '#9146FF', size: 10, filled: true },
		});

		fireEvent.pointerMove(drawingSvg, { pointerId: 2, clientX: 120, clientY: 140 });
		expect(drawingState.updateCurrentShape).toHaveBeenCalledWith({ x2: 120, y2: 140 });
		fireEvent.pointerUp(drawingSvg, { pointerId: 2 });
		expect(drawingState.commitCurrentShape).toHaveBeenCalledTimes(1);
		cleanup();

		const selectedState = makeState({
			tool: 'rect',
			shapes: [selectedRect, ellipseShape, arrowShape],
			selectedShapeId: 'shape-1',
		});
		const { container, svg } = await renderLoadedCanvas(selectedState);
		expect(container.querySelector('ellipse')).toBeInTheDocument();
		expect(container.querySelector('polygon')).toBeInTheDocument();

		const rectBody = container.querySelector('rect[width="60"][height="60"]') as SVGRectElement;
		fireEvent.pointerDown(rectBody, {
			button: 0,
			pointerId: 3,
			clientX: 40,
			clientY: 50,
		});
		expect(selectedState.selectShape).toHaveBeenCalledWith('shape-1');
		fireEvent.pointerMove(svg, { pointerId: 3, clientX: 70, clientY: 80 });
		expect(selectedState.updateShape).toHaveBeenCalledWith('shape-1', {
			x1: 50,
			x2: 110,
			y1: 60,
			y2: 120,
		});

		const fillToggle = screen.getByLabelText('Toggle fill / outline');
		fireEvent.pointerDown(fillToggle);
		expect(selectedState.updateShape).toHaveBeenCalledWith('shape-1', {
			style: { ...shapeStyle, filled: false },
		});

		const handle = container.querySelector('rect[fill="#ffffff"]') as SVGRectElement;
		fireEvent.pointerDown(handle, {
			button: 0,
			pointerId: 4,
			clientX: 20,
			clientY: 30,
		});
		fireEvent.pointerMove(svg, { pointerId: 4, clientX: 10, clientY: 15 });
		expect(selectedState.updateShape).toHaveBeenCalledWith('shape-1', {
			x1: 10,
			x2: 80,
			y1: 15,
			y2: 90,
		});

		dispatchKey('keydown', { key: 'Delete' });
		expect(selectedState.deleteShape).toHaveBeenCalledWith('shape-1');
		dispatchKey('keydown', { key: 'Escape' });
		expect(selectedState.selectShape).toHaveBeenCalledWith(null);
	});

	it('places, edits, moves, commits, and deletes text annotations', async () => {
		const placingState = makeState({ tool: 'text' });
		const { svg: placingSvg } = await renderLoadedCanvas(placingState);

		fireEvent.pointerDown(placingSvg, {
			button: 0,
			clientX: 160,
			clientY: 90,
			pointerId: 5,
		});
		expect(placingState.beginText).toHaveBeenCalledWith(160, 90, {
			color: '#38bdf8',
			size: 24,
			font: 'serif',
			bgColor: null,
		});
		cleanup();

		const textState = makeState({
			tool: 'text',
			texts: [selectedText],
			selectedTextId: 'text-1',
			editingTextId: 'text-1',
		});
		const { container, svg } = await renderLoadedCanvas(textState);

		const editor = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: 'Updated' } });
		expect(textState.updateTextValue).toHaveBeenCalledWith('text-1', 'Updated');
		fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
		expect(textState.commitTextEditing).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(editor, { key: 'Escape' });
		expect(textState.commitTextEditing).toHaveBeenCalledTimes(2);
		fireEvent.blur(editor);
		expect(textState.commitTextEditing).toHaveBeenCalledTimes(3);

		const textElement = container.querySelector('text') as SVGTextElement;
		fireEvent.pointerDown(textElement, {
			button: 0,
			pointerId: 6,
			clientX: 60,
			clientY: 70,
		});
		expect(textState.selectText).toHaveBeenCalledWith('text-1');
		fireEvent.pointerMove(svg, { pointerId: 6, clientX: 90, clientY: 100 });
		expect(textState.updateText).toHaveBeenCalledWith('text-1', { x: 90, y: 100 });

		dispatchKey('keydown', { key: 'Backspace' });
		expect(textState.deleteText).toHaveBeenCalledWith('text-1');
		dispatchKey('keydown', { key: 'Escape' });
		expect(textState.selectText).toHaveBeenCalledWith(null);
	});

	it('erases strokes, shapes, and text, and supports wrapper panning', async () => {
		const eraserState = makeState({
			tool: 'eraser',
			strokes: [stroke],
			shapes: [selectedRect],
			texts: [selectedText],
		});
		const { container } = await renderLoadedCanvas(eraserState);

		const strokePath = container.querySelector('path[stroke="transparent"]') as SVGPathElement;
		fireEvent.pointerDown(strokePath);
		expect(eraserState.eraseStrokeAt).toHaveBeenCalledWith(0);

		const shapeBody = container.querySelector('rect[width="60"][height="60"]') as SVGRectElement;
		fireEvent.pointerDown(shapeBody, { button: 0 });
		expect(eraserState.deleteShape).toHaveBeenCalledWith('shape-1');

		const textElement = container.querySelector('text') as SVGTextElement;
		fireEvent.pointerDown(textElement, { button: 0 });
		expect(eraserState.deleteText).toHaveBeenCalledWith('text-1');
		cleanup();

		const panState = makeState({ tool: 'pan', view: { x: 5, y: 10, scale: 1 } });
		const { wrapper } = await renderLoadedCanvas(panState);
		fireEvent.pointerDown(wrapper, {
			button: 0,
			pointerId: 7,
			clientX: 20,
			clientY: 30,
		});
		fireEvent.pointerMove(wrapper, { pointerId: 7, clientX: 45, clientY: 65 });
		expect(panState.setView).toHaveBeenCalledWith(expect.any(Function));
		const updater = vi.mocked(panState.setView).mock.calls.at(-1)?.[0] as (
			prev: typeof panState.view
		) => typeof panState.view;
		expect(updater({ x: 5, y: 10, scale: 1 })).toEqual({ x: 30, y: 45, scale: 1 });
		fireEvent.pointerUp(wrapper, { pointerId: 7 });
	});
});

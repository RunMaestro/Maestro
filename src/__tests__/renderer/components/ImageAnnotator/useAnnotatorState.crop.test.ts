/**
 * Crop behavior of the annotator state hook.
 *
 * The contract that matters: a crop is NOT a flatten. It swaps the base image
 * and translates every drawable into the new origin, so annotations stay live -
 * and undoing a crop restores the exact pre-crop state, image included.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	useAnnotatorState,
	type StrokeStyle,
	type TextStyle,
} from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';

const ORIGINAL = 'data:image/png;base64,ORIGINAL';
const CROPPED = 'data:image/png;base64,CROPPED';

const STROKE_STYLE: StrokeStyle = {
	color: '#ff0000',
	size: 8,
	thinning: 0.5,
	smoothing: 0.5,
	streamline: 0.5,
	taperStart: 0,
	taperEnd: 0,
};

const TEXT_STYLE: TextStyle = {
	color: '#ffffff',
	size: 24,
	font: 'sans-serif',
	bgColor: null,
};

function renderAnnotator() {
	return renderHook(() => useAnnotatorState(ORIGINAL));
}

describe('useAnnotatorState crop', () => {
	it('starts on the opened image with no crop armed', () => {
		const { result } = renderAnnotator();
		expect(result.current.image).toBe(ORIGINAL);
		expect(result.current.cropRect).toBeNull();
		expect(result.current.cropCount).toBe(0);
	});

	it('translates strokes, shapes and text into the cropped origin', () => {
		const { result } = renderAnnotator();

		act(() => {
			result.current.beginStroke([100, 60, 0.5]);
			result.current.extendStroke([120, 80, 0.5]);
		});
		act(() => result.current.endStroke(STROKE_STYLE));
		act(() =>
			result.current.beginShape({
				id: 'shape-1',
				kind: 'rect',
				x1: 50,
				y1: 40,
				x2: 150,
				y2: 140,
				style: { color: '#00ff00', size: 4, filled: false },
			})
		);
		act(() => result.current.commitCurrentShape());
		act(() => {
			result.current.beginText(70, 30, TEXT_STYLE);
		});
		const textId = result.current.texts[0].id;
		act(() => result.current.updateTextValue(textId, 'hello'));
		act(() => result.current.commitTextEditing());

		act(() => result.current.applyCrop(CROPPED, { x: 40, y: 20, w: 200, h: 200 }));

		expect(result.current.image).toBe(CROPPED);
		expect(result.current.cropCount).toBe(1);
		expect(result.current.cropRect).toBeNull();
		expect(result.current.strokes[0].points).toEqual([
			[60, 40, 0.5],
			[80, 60, 0.5],
		]);
		expect(result.current.shapes[0]).toMatchObject({ x1: 10, y1: 20, x2: 110, y2: 120 });
		expect(result.current.texts[0]).toMatchObject({ x: 30, y: 10, value: 'hello' });
	});

	it('restores the pre-crop image, drawables and selection on undo', () => {
		const { result } = renderAnnotator();

		act(() => {
			result.current.beginStroke([100, 60, 0.5]);
		});
		act(() => result.current.endStroke(STROKE_STYLE));
		act(() => result.current.applyCrop(CROPPED, { x: 40, y: 20, w: 200, h: 200 }));
		act(() => result.current.undo());

		expect(result.current.image).toBe(ORIGINAL);
		expect(result.current.cropCount).toBe(0);
		expect(result.current.strokes[0].points).toEqual([[100, 60, 0.5]]);
		// The rect comes back armed so the user can nudge it and re-apply.
		expect(result.current.cropRect).toEqual({ x: 40, y: 20, w: 200, h: 200 });
	});

	it('undoes a stroke drawn after the crop before undoing the crop itself', () => {
		const { result } = renderAnnotator();

		act(() => result.current.applyCrop(CROPPED, { x: 10, y: 10, w: 100, h: 100 }));
		act(() => {
			result.current.beginStroke([5, 5, 0.5]);
		});
		act(() => result.current.endStroke(STROKE_STYLE));

		act(() => result.current.undo());
		expect(result.current.strokes).toHaveLength(0);
		expect(result.current.image).toBe(CROPPED);

		act(() => result.current.undo());
		expect(result.current.image).toBe(ORIGINAL);
	});

	it('keeps the crop when Clear all wipes the drawables', () => {
		const { result } = renderAnnotator();

		act(() => {
			result.current.beginStroke([100, 60, 0.5]);
		});
		act(() => result.current.endStroke(STROKE_STYLE));
		act(() => result.current.applyCrop(CROPPED, { x: 10, y: 10, w: 100, h: 100 }));
		act(() => result.current.clear());

		expect(result.current.strokes).toHaveLength(0);
		expect(result.current.image).toBe(CROPPED);
		expect(result.current.cropCount).toBe(1);

		// The crop stays undoable, and undoing it brings the cleared work back.
		act(() => result.current.undo());
		expect(result.current.image).toBe(ORIGINAL);
		expect(result.current.strokes).toHaveLength(1);
	});

	it('drops an armed crop selection when the tool changes', () => {
		const { result } = renderAnnotator();

		act(() => result.current.setCropRect({ x: 5, y: 5, w: 50, h: 50 }));
		expect(result.current.cropRect).not.toBeNull();

		act(() => result.current.setTool('pen'));
		expect(result.current.cropRect).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';
import {
	MIN_CROP_SIZE,
	clampCropRect,
	isFullImageCrop,
	resizeCropRect,
	type CropRect,
} from '../../../../renderer/components/ImageAnnotator/cropImageDataUrl';

describe('clampCropRect', () => {
	it('passes an in-bounds rect through unchanged', () => {
		expect(clampCropRect({ x: 10, y: 20, w: 100, h: 50 }, 400, 300)).toEqual({
			x: 10,
			y: 20,
			w: 100,
			h: 50,
		});
	});

	it('normalizes a rect dragged up and to the left', () => {
		expect(clampCropRect({ x: 110, y: 70, w: -100, h: -50 }, 400, 300)).toEqual({
			x: 10,
			y: 20,
			w: 100,
			h: 50,
		});
	});

	it('clamps a drag that runs off every edge back to the image', () => {
		expect(clampCropRect({ x: -50, y: -50, w: 900, h: 900 }, 400, 300)).toEqual({
			x: 0,
			y: 0,
			w: 400,
			h: 300,
		});
	});

	it('rejects a selection smaller than the minimum on either axis', () => {
		expect(clampCropRect({ x: 0, y: 0, w: MIN_CROP_SIZE - 1, h: 200 }, 400, 300)).toBeNull();
		expect(clampCropRect({ x: 0, y: 0, w: 200, h: MIN_CROP_SIZE - 1 }, 400, 300)).toBeNull();
	});

	it('rejects a stray click that produced no area at all', () => {
		expect(clampCropRect({ x: 40, y: 40, w: 0, h: 0 }, 400, 300)).toBeNull();
	});

	it('rejects a rect that lies entirely outside the image', () => {
		expect(clampCropRect({ x: 500, y: 500, w: 100, h: 100 }, 400, 300)).toBeNull();
	});
});

describe('isFullImageCrop', () => {
	it('is true for a rect covering the whole image', () => {
		expect(isFullImageCrop({ x: 0, y: 0, w: 400, h: 300 }, 400, 300)).toBe(true);
	});

	it('is true for a rect that overhangs the image on every side', () => {
		expect(isFullImageCrop({ x: -5, y: -5, w: 500, h: 400 }, 400, 300)).toBe(true);
	});

	it('is false once any edge is pulled in', () => {
		expect(isFullImageCrop({ x: 1, y: 0, w: 399, h: 300 }, 400, 300)).toBe(false);
		expect(isFullImageCrop({ x: 0, y: 0, w: 400, h: 299 }, 400, 300)).toBe(false);
	});
});

describe('resizeCropRect', () => {
	const orig: CropRect = { x: 100, y: 100, w: 200, h: 100 };

	it('moves only the dragged edge for a side handle', () => {
		expect(resizeCropRect(orig, 'l', 60, 999)).toEqual({ x: 60, y: 100, w: 240, h: 100 });
		expect(resizeCropRect(orig, 'r', 400, 999)).toEqual({ x: 100, y: 100, w: 300, h: 100 });
		expect(resizeCropRect(orig, 't', 999, 40)).toEqual({ x: 100, y: 40, w: 200, h: 160 });
		expect(resizeCropRect(orig, 'b', 999, 260)).toEqual({ x: 100, y: 100, w: 200, h: 160 });
	});

	it('moves both edges for a corner handle', () => {
		expect(resizeCropRect(orig, 'tl', 50, 50)).toEqual({ x: 50, y: 50, w: 250, h: 150 });
		expect(resizeCropRect(orig, 'br', 350, 250)).toEqual({ x: 100, y: 100, w: 250, h: 150 });
		expect(resizeCropRect(orig, 'tr', 350, 50)).toEqual({ x: 100, y: 50, w: 250, h: 150 });
		expect(resizeCropRect(orig, 'bl', 50, 250)).toEqual({ x: 50, y: 100, w: 250, h: 150 });
	});

	it('leaves the opposite edge untouched', () => {
		// Dragging the left grip must not drift the right edge off 300.
		const next = resizeCropRect(orig, 'l', 275, 0);
		expect(next.x + next.w).toBe(300);
	});

	it('returns an inverted rect when dragged past the opposite edge', () => {
		// Deliberate: clamping mid-drag would make the frame fight the pointer.
		// clampCropRect normalizes this on pointerup.
		const next = resizeCropRect(orig, 'l', 400, 0);
		expect(next.w).toBeLessThan(0);
		expect(clampCropRect(next, 800, 600)).toEqual({ x: 300, y: 100, w: 100, h: 100 });
	});
});

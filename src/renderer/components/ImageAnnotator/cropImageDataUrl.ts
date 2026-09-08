/**
 * cropImageDataUrl - Cut a rectangle out of an image and return it as a PNG.
 *
 * The annotator's crop is non-destructive to the annotations: only the base
 * pixels are re-cut here, and `useAnnotatorState.applyCrop` translates the
 * strokes / shapes / text into the new origin. So this module has exactly one
 * job - source rect in, cropped PNG data URL out.
 *
 * The rect arrives in image space (the same coordinate system the annotator
 * stores every drawable in) and may be inverted or hang off the edge after a
 * drag, so it is normalized and clamped to the image before it reaches the
 * canvas. A rect that clamps down to nothing throws rather than returning a
 * 0x0 canvas, which `toDataURL` would happily hand back as an unusable image.
 */

import { loadImageElement } from '../../utils/loadImage';

export interface CropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Corner and edge grips on the crop frame. */
export type CropHandle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'r' | 'b' | 'l';

/**
 * Apply a handle drag to a crop rect. Corner handles move two edges, side
 * handles move one, and the untouched edges stay exactly where they were - so
 * dragging the left grip can never nudge the right edge.
 *
 * The result may come back inverted or out of bounds: that is deliberate.
 * Clamping mid-drag makes a frame stick to the image edge and fight the
 * pointer, so the rect is left raw here and normalized by `clampCropRect` on
 * pointerup.
 */
export function resizeCropRect(
	orig: CropRect,
	handle: CropHandle,
	px: number,
	py: number
): CropRect {
	let { x, y } = orig;
	let right = orig.x + orig.w;
	let bottom = orig.y + orig.h;
	if (handle.includes('l')) x = px;
	if (handle.includes('r')) right = px;
	if (handle.includes('t')) y = py;
	if (handle.includes('b')) bottom = py;
	return { x, y, w: right - x, h: bottom - y };
}

/** Smallest crop we accept, in image pixels, on either axis. */
export const MIN_CROP_SIZE = 8;

/**
 * Normalize a (possibly inverted) rect and clamp it inside `0,0,width,height`.
 * Returns `null` when nothing usable survives the clamp.
 */
export function clampCropRect(
	rect: CropRect,
	width: number,
	height: number,
	minSize = MIN_CROP_SIZE
): CropRect | null {
	const left = Math.max(0, Math.min(rect.x, rect.x + rect.w));
	const top = Math.max(0, Math.min(rect.y, rect.y + rect.h));
	const right = Math.min(width, Math.max(rect.x, rect.x + rect.w));
	const bottom = Math.min(height, Math.max(rect.y, rect.y + rect.h));
	const w = right - left;
	const h = bottom - top;
	if (w < minSize || h < minSize) return null;
	return { x: left, y: top, w, h };
}

/** True when the rect covers the whole image, so cropping would be a no-op. */
export function isFullImageCrop(rect: CropRect, width: number, height: number): boolean {
	return (
		Math.round(rect.x) <= 0 &&
		Math.round(rect.y) <= 0 &&
		Math.round(rect.w) >= Math.round(width) &&
		Math.round(rect.h) >= Math.round(height)
	);
}

export default async function cropImageDataUrl(
	imageDataUrl: string,
	rect: CropRect
): Promise<{ dataUrl: string; rect: CropRect }> {
	const img = await loadImageElement(imageDataUrl);
	const clamped = clampCropRect(rect, img.naturalWidth, img.naturalHeight);
	if (!clamped) throw new Error('Crop area is too small');

	// Round to whole pixels so the cropped image has an integral size and the
	// annotation translation lands on the same grid the drawables were on.
	const x = Math.round(clamped.x);
	const y = Math.round(clamped.y);
	const w = Math.max(1, Math.round(clamped.w));
	const h = Math.max(1, Math.round(clamped.h));

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Failed to acquire 2D canvas context');
	ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

	return { dataUrl: canvas.toDataURL('image/png'), rect: { x, y, w, h } };
}

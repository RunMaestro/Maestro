import { describe, expect, it } from 'vitest';
import {
	MEDIA_FLOAT_DEFAULT_SIZE,
	MEDIA_FLOAT_EDGE_MARGIN,
	MEDIA_FLOAT_MIN_HEIGHT,
	MEDIA_FLOAT_MIN_WIDTH,
	clampMediaFloatRect,
	initialMediaFloatRect,
} from '../../../renderer/utils/mediaFloatGeometry';

const VIEW = { width: 1600, height: 900 };

describe('clampMediaFloatRect', () => {
	it('leaves an already-valid rect alone', () => {
		const rect = { top: 100, left: 200, width: 400, height: 300 };
		expect(clampMediaFloatRect(rect, VIEW)).toEqual(rect);
	});

	it('pulls a rect back on screen from the right and bottom', () => {
		const clamped = clampMediaFloatRect({ top: 880, left: 1560, width: 400, height: 300 }, VIEW);
		expect(clamped.left).toBe(1200);
		expect(clamped.top).toBe(600);
	});

	it('pulls a rect back from negative coordinates', () => {
		const clamped = clampMediaFloatRect({ top: -50, left: -80, width: 400, height: 300 }, VIEW);
		expect(clamped.left).toBe(0);
		expect(clamped.top).toBe(0);
	});

	it('recovers a rect persisted on a larger monitor', () => {
		// The whole reason this function exists: geometry saved at 2560x1440 must
		// not leave the widget off screen on a laptop.
		const clamped = clampMediaFloatRect(
			{ top: 1300, left: 2400, width: 480, height: 336 },
			{ width: 1280, height: 800 }
		);
		expect(clamped.left).toBeGreaterThanOrEqual(0);
		expect(clamped.top).toBeGreaterThanOrEqual(0);
		expect(clamped.left + clamped.width).toBeLessThanOrEqual(1280);
		expect(clamped.top + clamped.height).toBeLessThanOrEqual(800);
	});

	it('enforces the minimum size', () => {
		const clamped = clampMediaFloatRect({ top: 0, left: 0, width: 40, height: 10 }, VIEW);
		expect(clamped.width).toBe(MEDIA_FLOAT_MIN_WIDTH);
		expect(clamped.height).toBe(MEDIA_FLOAT_MIN_HEIGHT);
	});

	it('lets a viewport smaller than the minimum win, rather than going off screen', () => {
		const clamped = clampMediaFloatRect(
			{ top: 0, left: 0, width: 400, height: 300 },
			{ width: 200, height: 80 }
		);
		expect(clamped.width).toBe(200);
		expect(clamped.height).toBe(80);
		expect(clamped.left).toBe(0);
		expect(clamped.top).toBe(0);
	});

	it('clamps size before position, so a shrunk rect is not left mispositioned', () => {
		const clamped = clampMediaFloatRect({ top: 700, left: 1500, width: 10, height: 10 }, VIEW);
		expect(clamped.left + clamped.width).toBeLessThanOrEqual(VIEW.width);
		expect(clamped.top + clamped.height).toBeLessThanOrEqual(VIEW.height);
	});
});

describe('initialMediaFloatRect', () => {
	it('parks audio bottom-right at the audio default size', () => {
		const rect = initialMediaFloatRect('audio', VIEW);
		const size = MEDIA_FLOAT_DEFAULT_SIZE.audio;
		expect(rect.width).toBe(size.width);
		expect(rect.height).toBe(size.height);
		expect(rect.left).toBe(VIEW.width - size.width - MEDIA_FLOAT_EDGE_MARGIN);
		expect(rect.top).toBe(VIEW.height - size.height - MEDIA_FLOAT_EDGE_MARGIN);
	});

	it('gives video a taller box than audio, since audio has no picture', () => {
		expect(MEDIA_FLOAT_DEFAULT_SIZE.video.height).toBeGreaterThan(
			MEDIA_FLOAT_DEFAULT_SIZE.audio.height
		);
	});

	it('stays on screen in a viewport smaller than the default size', () => {
		const rect = initialMediaFloatRect('video', { width: 320, height: 200 });
		expect(rect.left).toBe(0);
		expect(rect.top).toBe(0);
		expect(rect.width).toBeLessThanOrEqual(320);
		expect(rect.height).toBeLessThanOrEqual(200);
	});
});

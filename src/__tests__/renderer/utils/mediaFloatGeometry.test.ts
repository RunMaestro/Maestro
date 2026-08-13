import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MEDIA_ASPECT,
	MEDIA_FLOAT_DEFAULT_WIDTH,
	MEDIA_FLOAT_EDGE_MARGIN,
	MEDIA_FLOAT_MIN_WIDTH,
	MEDIA_FLOAT_TITLE_BAR_HEIGHT,
	MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT,
	fitMediaFloatRect,
	initialMediaFloatRect,
	mediaFloatChromeHeight,
	mediaFloatHeight,
	mediaFloatResizeWidth,
	mediaFloatWidthFor,
	normalizeMediaAspect,
	sanitizeMediaFloat,
	type MediaFloatFit,
} from '../../../renderer/utils/mediaFloatGeometry';

const VIEW = { width: 1600, height: 900 };
const CHROME = mediaFloatChromeHeight(null);

const audioFit: MediaFloatFit = {
	kind: 'audio',
	aspect: DEFAULT_MEDIA_ASPECT,
	chromeHeight: CHROME,
};
const videoFit: MediaFloatFit = {
	kind: 'video',
	aspect: DEFAULT_MEDIA_ASPECT,
	chromeHeight: CHROME,
};

describe('mediaFloatChromeHeight', () => {
	it('uses the measured transport when there is one', () => {
		expect(mediaFloatChromeHeight(70)).toBe(MEDIA_FLOAT_TITLE_BAR_HEIGHT + 70);
	});

	it('falls back before anything has been measured', () => {
		// jsdom and the first paint both report nothing; a zero-height chrome would
		// collapse the widget to a sliver.
		expect(mediaFloatChromeHeight(null)).toBe(
			MEDIA_FLOAT_TITLE_BAR_HEIGHT + MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT
		);
		expect(mediaFloatChromeHeight(0)).toBe(mediaFloatChromeHeight(null));
	});
});

describe('normalizeMediaAspect', () => {
	it('keeps a real ratio', () => {
		expect(normalizeMediaAspect(4 / 3)).toBeCloseTo(4 / 3);
		// Vertical phone video.
		expect(normalizeMediaAspect(9 / 16)).toBeCloseTo(9 / 16);
	});

	it('falls back to 16:9 for anything unusable', () => {
		expect(normalizeMediaAspect(0)).toBe(DEFAULT_MEDIA_ASPECT);
		expect(normalizeMediaAspect(Number.NaN)).toBe(DEFAULT_MEDIA_ASPECT);
		expect(normalizeMediaAspect(undefined)).toBe(DEFAULT_MEDIA_ASPECT);
	});

	it('refuses a ratio that would shape the widget like a ruler', () => {
		expect(normalizeMediaAspect(50)).toBe(4);
		expect(normalizeMediaAspect(0.01)).toBe(0.25);
	});
});

describe('mediaFloatHeight', () => {
	it('collapses audio to the chrome, since it has no picture', () => {
		expect(mediaFloatHeight(audioFit, 380)).toBe(CHROME);
		// Width does not change it: there is nothing to be proportional to.
		expect(mediaFloatHeight(audioFit, 900)).toBe(CHROME);
	});

	it('gives video exactly its own aspect ratio, so it never letterboxes', () => {
		expect(mediaFloatHeight(videoFit, 560)).toBe(CHROME + 315);
		expect(mediaFloatHeight({ ...videoFit, aspect: 4 / 3 }, 560)).toBe(CHROME + 420);
		expect(mediaFloatHeight({ ...videoFit, aspect: 9 / 16 }, 360)).toBe(CHROME + 640);
	});
});

describe('fitMediaFloatRect', () => {
	it('derives the height rather than taking one', () => {
		const rect = fitMediaFloatRect({ top: 100, left: 200, width: 560 }, videoFit, VIEW);
		expect(rect.height).toBe(CHROME + 315);
		expect(rect.top).toBe(100);
		expect(rect.left).toBe(200);
	});

	it('pulls a rect back on screen from the right and bottom', () => {
		const rect = fitMediaFloatRect({ top: 880, left: 1560, width: 400 }, audioFit, VIEW);
		expect(rect.left).toBe(1200);
		expect(rect.top).toBe(900 - CHROME);
	});

	it('pulls a rect back from negative coordinates', () => {
		const rect = fitMediaFloatRect({ top: -50, left: -80, width: 400 }, audioFit, VIEW);
		expect(rect.left).toBe(0);
		expect(rect.top).toBe(0);
	});

	it('recovers a position persisted on a larger monitor', () => {
		// The whole reason this clamping exists: geometry saved at 2560x1440 must
		// not leave the widget off screen on a laptop.
		const rect = fitMediaFloatRect({ top: 1300, left: 2400, width: 480 }, videoFit, {
			width: 1280,
			height: 800,
		});
		expect(rect.left).toBeGreaterThanOrEqual(0);
		expect(rect.top).toBeGreaterThanOrEqual(0);
		expect(rect.left + rect.width).toBeLessThanOrEqual(1280);
		expect(rect.top + rect.height).toBeLessThanOrEqual(800);
	});

	it('enforces the minimum width', () => {
		expect(fitMediaFloatRect({ top: 0, left: 0, width: 40 }, audioFit, VIEW).width).toBe(
			MEDIA_FLOAT_MIN_WIDTH
		);
	});

	it('narrows a tall video instead of running it off the bottom', () => {
		// A 9:16 clip at a wide width would be taller than the screen. The picture
		// stays whole, just smaller.
		const view = { width: 1600, height: 700 };
		const rect = fitMediaFloatRect(
			{ top: 0, left: 0, width: 900 },
			{ ...videoFit, aspect: 9 / 16 },
			view
		);
		expect(rect.height).toBeLessThanOrEqual(view.height);
		expect(rect.width).toBeLessThan(900);
	});

	it('lets a viewport smaller than the frame win, rather than going off screen', () => {
		const rect = fitMediaFloatRect({ top: 0, left: 0, width: 400 }, audioFit, {
			width: 200,
			height: 80,
		});
		expect(rect.width).toBe(200);
		expect(rect.height).toBe(80);
		expect(rect.left).toBe(0);
		expect(rect.top).toBe(0);
	});
});

describe('initialMediaFloatRect', () => {
	it('parks audio bottom-right as a control strip', () => {
		const rect = initialMediaFloatRect(audioFit, VIEW);
		expect(rect.width).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
		expect(rect.height).toBe(CHROME);
		expect(rect.left).toBe(VIEW.width - rect.width - MEDIA_FLOAT_EDGE_MARGIN);
		expect(rect.top).toBe(VIEW.height - rect.height - MEDIA_FLOAT_EDGE_MARGIN);
	});

	it('opens video wide enough to actually watch', () => {
		const rect = initialMediaFloatRect(videoFit, VIEW);
		expect(rect.width).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.video);
		expect(rect.width).toBeGreaterThan(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
		// The stage is the file's own shape, not a guess at a box.
		expect(rect.height - CHROME).toBe(Math.round(rect.width / DEFAULT_MEDIA_ASPECT));
	});

	it('stays on screen in a viewport smaller than the default', () => {
		const rect = initialMediaFloatRect(videoFit, { width: 320, height: 200 });
		expect(rect.left).toBe(0);
		expect(rect.top).toBe(0);
		expect(rect.width).toBeLessThanOrEqual(320);
		expect(rect.height).toBeLessThanOrEqual(200);
	});
});

describe('mediaFloatWidthFor', () => {
	it('uses the width the user chose for that kind', () => {
		expect(mediaFloatWidthFor('video', { audio: 400, video: 900 })).toBe(900);
	});

	it('falls back to the kind default rather than the other kind width', () => {
		// Carrying a movie's width onto an MP3 would make a control strip half the
		// screen wide.
		expect(mediaFloatWidthFor('audio', { video: 900 })).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
		expect(mediaFloatWidthFor('video', {})).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.video);
	});
});

describe('mediaFloatResizeWidth', () => {
	const origin = { width: 560, height: CHROME + 315 };

	it('takes the horizontal drag for audio, since height is not a dimension', () => {
		expect(mediaFloatResizeWidth(origin, { dx: 40, dy: 200 }, audioFit)).toBe(600);
	});

	it('lets a downward corner drag grow a video, with the aspect kept', () => {
		// The grip is a corner. Dragging it down must do something, even though
		// height follows the picture rather than the cursor.
		const width = mediaFloatResizeWidth(origin, { dx: 0, dy: 90 }, videoFit);
		expect(width).toBeCloseTo(origin.width + 90 * DEFAULT_MEDIA_ASPECT);
	});

	it('follows whichever axis the user moved further', () => {
		expect(mediaFloatResizeWidth(origin, { dx: 300, dy: 10 }, videoFit)).toBe(860);
	});
});

describe('sanitizeMediaFloat', () => {
	it('keeps a position and its per-kind widths', () => {
		expect(sanitizeMediaFloat({ top: 10, left: 20, widths: { audio: 400, video: 800 } })).toEqual({
			top: 10,
			left: 20,
			widths: { audio: 400, video: 800 },
		});
	});

	it('keeps the position of the older full-rect shape but drops its width', () => {
		// That width was saved without recording which kind it belonged to, so
		// applying it would size a podcast like a movie half the time.
		expect(sanitizeMediaFloat({ top: 10, left: 20, width: 480, height: 336 })).toEqual({
			top: 10,
			left: 20,
			widths: {},
		});
	});

	it('drops widths that are not usable numbers', () => {
		expect(sanitizeMediaFloat({ top: 0, left: 0, widths: { audio: -1, video: 'wide' } })).toEqual({
			top: 0,
			left: 0,
			widths: {},
		});
	});

	it('rejects anything without a position', () => {
		expect(sanitizeMediaFloat(null)).toBeNull();
		expect(sanitizeMediaFloat({ widths: { audio: 400 } })).toBeNull();
		expect(sanitizeMediaFloat('nope')).toBeNull();
	});
});

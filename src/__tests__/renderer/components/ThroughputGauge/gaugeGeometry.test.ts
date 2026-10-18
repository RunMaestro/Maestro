/**
 * Tests for the Throughput Gauge card's geometry: where each layout opens, how
 * a rect is clamped on every edge and below the title strip, how stored values
 * are sanitized, and the per-layout minimum sizes.
 */
import { describe, expect, it } from 'vitest';
import {
	fitGaugeRect,
	gaugeLiftsToasts,
	GAUGE_CLAMP_MARGIN,
	GAUGE_DEFAULT_SIZE,
	GAUGE_EDGE_MARGIN,
	GAUGE_INPUT_AREA_CLEARANCE,
	GAUGE_MIN_SIZE,
	initialGaugeRect,
	resolveGaugeRect,
	sameGaugeRect,
	sanitizeGaugeRect,
	sanitizeGaugeRects,
} from '../../../../renderer/components/ThroughputGauge/gaugeGeometry';

const VIEWPORT = { width: 1400, height: 900 };
const TITLE_STRIP = 40;

describe('initialGaugeRect', () => {
	it('parks each layout bottom-left above the composer at its default size', () => {
		for (const layout of ['single', 'all'] as const) {
			const rect = initialGaugeRect(layout, VIEWPORT);
			expect(rect).toEqual({
				left: GAUGE_EDGE_MARGIN,
				top: VIEWPORT.height - GAUGE_DEFAULT_SIZE[layout].height - GAUGE_INPUT_AREA_CLEARANCE,
				...GAUGE_DEFAULT_SIZE[layout],
			});
		}
	});

	it('opens the all-three layout wider than the single gauge', () => {
		expect(GAUGE_DEFAULT_SIZE.all.width).toBeGreaterThan(GAUGE_DEFAULT_SIZE.single.width);
		expect(GAUGE_MIN_SIZE.all.width).toBeGreaterThan(GAUGE_MIN_SIZE.single.width);
	});

	it('stays below the title strip in a short window', () => {
		const rect = initialGaugeRect('single', { width: 800, height: 300, top: TITLE_STRIP });
		expect(rect.top).toBeGreaterThanOrEqual(TITLE_STRIP + GAUGE_CLAMP_MARGIN);
	});
});

describe('fitGaugeRect', () => {
	const size = GAUGE_DEFAULT_SIZE.single;

	it('leaves a rect that already fits alone', () => {
		const rect = { left: 300, top: 200, ...size };
		expect(fitGaugeRect(rect, 'single', VIEWPORT)).toEqual(rect);
	});

	it('clamps on the left and top edges', () => {
		const rect = fitGaugeRect({ left: -500, top: -500, ...size }, 'single', VIEWPORT);
		expect(rect.left).toBe(GAUGE_CLAMP_MARGIN);
		expect(rect.top).toBe(GAUGE_CLAMP_MARGIN);
	});

	it('clamps on the right and bottom edges', () => {
		const rect = fitGaugeRect({ left: 5000, top: 5000, ...size }, 'single', VIEWPORT);
		expect(rect.left).toBe(VIEWPORT.width - GAUGE_CLAMP_MARGIN - size.width);
		expect(rect.top).toBe(VIEWPORT.height - GAUGE_CLAMP_MARGIN - size.height);
	});

	it('keeps the card clear of the title strip', () => {
		const rect = fitGaugeRect({ left: 100, top: 0, ...size }, 'single', {
			...VIEWPORT,
			top: TITLE_STRIP,
		});
		expect(rect.top).toBe(TITLE_STRIP + GAUGE_CLAMP_MARGIN);
	});

	it('raises a size below the layout minimum to it', () => {
		for (const layout of ['single', 'all'] as const) {
			const rect = fitGaugeRect({ left: 50, top: 50, width: 10, height: 10 }, layout, VIEWPORT);
			expect(rect.width).toBe(GAUGE_MIN_SIZE[layout].width);
			expect(rect.height).toBe(GAUGE_MIN_SIZE[layout].height);
		}
	});

	it('shrinks a card bigger than the window to the room available', () => {
		const rect = fitGaugeRect({ left: 0, top: 0, width: 3000, height: 3000 }, 'all', {
			width: 600,
			height: 400,
			top: TITLE_STRIP,
		});
		expect(rect.width).toBe(600 - 2 * GAUGE_CLAMP_MARGIN);
		expect(rect.height).toBe(400 - TITLE_STRIP - 2 * GAUGE_CLAMP_MARGIN);
		expect(rect.left).toBe(GAUGE_CLAMP_MARGIN);
		expect(rect.top).toBe(TITLE_STRIP + GAUGE_CLAMP_MARGIN);
	});

	it('lets the window win over the minimum size when it is smaller', () => {
		const rect = fitGaugeRect({ left: 0, top: 0, ...size }, 'all', { width: 200, height: 150 });
		expect(rect.width).toBe(200 - 2 * GAUGE_CLAMP_MARGIN);
		expect(rect.height).toBe(150 - 2 * GAUGE_CLAMP_MARGIN);
	});

	it('rounds to whole pixels', () => {
		const rect = fitGaugeRect(
			{ left: 10.4, top: 20.6, width: 200.5, height: 210.2 },
			'single',
			VIEWPORT
		);
		expect(rect).toEqual({ left: 10, top: 21, width: 201, height: 210 });
	});
});

describe('resolveGaugeRect', () => {
	it('uses the stored rect, pulled into the viewport', () => {
		const stored = { left: 1300, top: 100, width: 300, height: 240 };
		expect(resolveGaugeRect('single', stored, VIEWPORT)).toEqual({
			...stored,
			left: VIEWPORT.width - GAUGE_CLAMP_MARGIN - 300,
		});
	});

	it('falls back to the default placement with nothing stored', () => {
		expect(resolveGaugeRect('all', undefined, VIEWPORT)).toEqual(initialGaugeRect('all', VIEWPORT));
	});
});

describe('sanitizeGaugeRect', () => {
	it('keeps four finite numbers with a positive size', () => {
		const rect = { left: -4, top: 12, width: 200, height: 180 };
		expect(sanitizeGaugeRect({ ...rect, extra: 'ignored' })).toEqual(rect);
	});

	it('rejects garbage', () => {
		expect(sanitizeGaugeRect(null)).toBeNull();
		expect(sanitizeGaugeRect('rect')).toBeNull();
		expect(sanitizeGaugeRect([1, 2, 3, 4])).toBeNull();
		expect(sanitizeGaugeRect({ left: 1, top: 2, width: 3 })).toBeNull();
		expect(sanitizeGaugeRect({ left: '1', top: 2, width: 3, height: 4 })).toBeNull();
		expect(sanitizeGaugeRect({ left: Number.NaN, top: 2, width: 3, height: 4 })).toBeNull();
		expect(sanitizeGaugeRect({ left: 1, top: 2, width: 0, height: 4 })).toBeNull();
		expect(sanitizeGaugeRect({ left: 1, top: 2, width: 3, height: -4 })).toBeNull();
	});

	it('keeps each good per-layout rect and drops bad ones and unknown layouts', () => {
		const single = { left: 1, top: 2, width: 200, height: 200 };
		expect(sanitizeGaugeRects({ single, all: { left: 'x' }, giant: single })).toEqual({ single });
		expect(sanitizeGaugeRects('nope')).toEqual({});
		expect(sanitizeGaugeRects(null)).toEqual({});
	});
});

describe('sameGaugeRect', () => {
	it('compares all four sides', () => {
		const rect = { left: 1, top: 2, width: 3, height: 4 };
		expect(sameGaugeRect(rect, { ...rect })).toBe(true);
		expect(sameGaugeRect(rect, { ...rect, height: 5 })).toBe(false);
	});
});

describe('gaugeLiftsToasts', () => {
	const size = GAUGE_DEFAULT_SIZE.single;

	it('is true for a card in the lower half of the window', () => {
		expect(gaugeLiftsToasts({ left: 0, top: 700, ...size }, VIEWPORT)).toBe(true);
	});

	it('is false for a card parked high up', () => {
		expect(gaugeLiftsToasts({ left: 0, top: 100, ...size }, VIEWPORT)).toBe(false);
	});
});

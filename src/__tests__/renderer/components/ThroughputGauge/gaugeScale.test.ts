/**
 * Tests for the Throughput Gauge's shared scale: the "nice" ceiling every style
 * draws against, and the clamped fraction of it a reading fills.
 */
import { describe, expect, it } from 'vitest';
import {
	gaugeFraction,
	MIN_GAUGE_MAX,
	niceGaugeMax,
} from '../../../../renderer/components/ThroughputGauge/gaugeScale';

describe('niceGaugeMax', () => {
	it('reads zero, negative, and non-finite input as the idle minimum', () => {
		expect(niceGaugeMax(0, 0)).toBe(MIN_GAUGE_MAX);
		expect(niceGaugeMax(-20, -5)).toBe(MIN_GAUGE_MAX);
		expect(niceGaugeMax(Number.NaN, 0)).toBe(MIN_GAUGE_MAX);
		expect(niceGaugeMax(Number.POSITIVE_INFINITY, 0)).toBe(MIN_GAUGE_MAX);
	});

	it('keeps a value exactly on a ceiling at that ceiling', () => {
		for (const ceiling of [50, 100, 250, 500, 1000, 2500, 5000, 10000]) {
			expect(niceGaugeMax(ceiling, 0)).toBe(ceiling);
		}
	});

	it('steps to the next ceiling just past one', () => {
		expect(niceGaugeMax(50.5, 0)).toBe(100);
		expect(niceGaugeMax(101, 0)).toBe(250);
		expect(niceGaugeMax(251, 0)).toBe(500);
		expect(niceGaugeMax(1001, 0)).toBe(2500);
	});

	it('scales to the peak when it is above the value', () => {
		expect(niceGaugeMax(30, 420)).toBe(500);
		expect(niceGaugeMax(420, 30)).toBe(500);
		expect(niceGaugeMax(0, 3000)).toBe(5000);
	});

	it('keeps finding ceilings for very large rates', () => {
		expect(niceGaugeMax(1_200_000, 0)).toBe(2_500_000);
		expect(niceGaugeMax(7_000_000_000, 0)).toBe(10_000_000_000);
	});
});

describe('gaugeFraction', () => {
	it('is the share of the scale, clamped to 0..1', () => {
		expect(gaugeFraction(25, 100)).toBe(0.25);
		expect(gaugeFraction(150, 100)).toBe(1);
		expect(gaugeFraction(-5, 100)).toBe(0);
	});

	it('reads a broken scale or reading as empty', () => {
		expect(gaugeFraction(10, 0)).toBe(0);
		expect(gaugeFraction(Number.NaN, 100)).toBe(0);
	});
});

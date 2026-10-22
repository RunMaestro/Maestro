/**
 * The Throughput Gauge's full-scale value, shared by every style.
 *
 * The scale is not fixed: it snaps to the next "nice" ceiling above the larger
 * of the reading and the peak, so a 30 tok/s trickle and a 4k tok/s burst both
 * use the whole dial, bar, or chart, and the scale only moves when the peak
 * does. The card computes it once and hands it to the style, which is how the
 * three gauges of the "All three" layout end up on one comparable scale.
 */

/** Smallest ceiling the gauge ever shows, so an idle gauge still reads as a scale. */
export const MIN_GAUGE_MAX = 50;
/** Ceilings run 1, 2.5, 5 per decade: each divides into five labeled steps. */
const NICE_STEPS = [1, 2.5, 5] as const;

/**
 * The smallest ceiling in the 50, 100, 250, 500, 1k, 2.5k, 5k, ... sequence
 * that is at least the larger of `value` and `peak`. Negative, NaN, and
 * infinite input reads as idle.
 */
export function niceGaugeMax(value: number, peak: number): number {
	const target = Math.max(value, peak, 0);
	if (!Number.isFinite(target)) return MIN_GAUGE_MAX;
	for (let magnitude = 10; ; magnitude *= 10) {
		for (const step of NICE_STEPS) {
			const ceiling = step * magnitude;
			if (ceiling >= MIN_GAUGE_MAX && ceiling >= target) return ceiling;
		}
	}
}

/** Where `value` sits on a 0..`max` scale, clamped to 0..1. */
export function gaugeFraction(value: number, max: number): number {
	if (!(max > 0) || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / max));
}

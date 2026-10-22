/**
 * The contract every Throughput Gauge style draws from.
 *
 * One props shape for all four styles (dial, VU, LCD, sparkline), so any style
 * can render any metric in either layout and the card never special-cases one.
 * The card owns the scale: it computes `max` with `niceGaugeMax()` and passes
 * it in, which is what keeps the three gauges of the "All three" layout on the
 * same scale.
 */

import type { Theme } from '../../../types';

export interface GaugeStyleProps {
	theme: Theme;
	/** Current reading, tokens per second. */
	value: number;
	/** Highest reading since the last reset, tokens per second. */
	peak: number;
	/** Full-scale value, from `niceGaugeMax()`. Shared across a layout's gauges. */
	max: number;
	/** The metric's name ("Combined", "In", "Out"). */
	label: string;
	/** Whose output is counted ("all agents", an agent's name). Omitted when the card shows it once. */
	caption?: string;
	/** Recent readings of this metric, oldest first. */
	history: readonly number[];
	/** True when three gauges share the card, so each draws a denser variant. */
	compact: boolean;
}

// The unit and the rate formatter live in shared/ so `maestro-cli
// throughput-gauge status` prints a reading exactly as the gauge does.
export { GAUGE_UNIT, formatGaugeRate } from '../../../../shared/throughputGauge';

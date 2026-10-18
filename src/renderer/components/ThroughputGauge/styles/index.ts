/**
 * The Throughput Gauge's styles, keyed by the `style` setting. Every entry
 * takes the same `GaugeStyleProps`, so the card renders whichever is chosen
 * without knowing which one it is.
 */

import type { ComponentType } from 'react';
import type { ThroughputGaugeSettings } from '../../../../shared/throughputGauge';
import { AnalogDial } from './AnalogDial';
import { LcdReadout } from './LcdReadout';
import { SparklineStyle } from './SparklineStyle';
import { VuMeter } from './VuMeter';
import type { GaugeStyleProps } from './types';

export const GAUGE_STYLE_COMPONENTS: Record<
	ThroughputGaugeSettings['style'],
	ComponentType<GaugeStyleProps>
> = {
	dial: AnalogDial,
	vu: VuMeter,
	lcd: LcdReadout,
	sparkline: SparklineStyle,
};

export { AnalogDial, LcdReadout, SparklineStyle, VuMeter };
export { formatGaugeRate, GAUGE_UNIT, type GaugeStyleProps } from './types';

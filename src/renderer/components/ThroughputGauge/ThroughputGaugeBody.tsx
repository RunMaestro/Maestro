/**
 * ThroughputGaugeBody - what the Throughput Gauge draws, without its frame.
 *
 * Draws the chosen style (`GAUGE_STYLE_COMPONENTS`): one gauge for the chosen
 * metric, or In, Out, and Combined side by side on ONE shared scale so the
 * three read against each other at a glance. The scope caption says whose
 * output is counted.
 *
 * Pure props in, no store reads, so the in-app card (`FloatingThroughputGauge`)
 * and the desktop widget window draw exactly the same thing from whichever
 * source holds the readings.
 */

import { memo } from 'react';

import {
	THROUGHPUT_METRICS,
	throughputOptionLabel,
	throughputScopeCaption,
	type ThroughputGaugeSettings,
} from '../../../shared/throughputGauge';
import type { ThroughputMetric, ThroughputRates } from '../../../shared/throughputRate';
import type { ThroughputHistory } from '../../stores/throughputGaugeStore';
import { niceGaugeMax } from './gaugeScale';
import { GAUGE_STYLE_COMPONENTS } from './styles';
import type { Theme } from '../../types';

/** The "All three" layout's gauges, left to right. */
export const ALL_LAYOUT_METRICS: readonly ThroughputMetric[] = ['in', 'out', 'combined'];

const metricLabel = (metric: ThroughputMetric) => throughputOptionLabel(THROUGHPUT_METRICS, metric);

export interface ThroughputGaugeBodyProps {
	theme: Theme;
	metric: ThroughputGaugeSettings['metric'];
	scope: ThroughputGaugeSettings['scope'];
	layout: ThroughputGaugeSettings['layout'];
	style: ThroughputGaugeSettings['style'];
	/** Latest rates, tokens per second. */
	rates: ThroughputRates;
	/** Highest rates since the last reset. */
	peak: ThroughputRates;
	/** Recent readings per metric, oldest first. */
	history: ThroughputHistory;
	/** The active agent's name, used by the caption when `scope` is `active`. */
	activeAgentName: string | null;
}

export const ThroughputGaugeBody = memo(function ThroughputGaugeBody({
	theme,
	metric,
	scope,
	layout,
	style,
	rates,
	peak,
	history,
	activeAgentName,
}: ThroughputGaugeBodyProps) {
	const StyleComponent = GAUGE_STYLE_COMPONENTS[style];
	const scopeCaption = throughputScopeCaption(scope, activeAgentName);

	if (layout === 'all') {
		// One scale for all three, from the largest reading and peak among them.
		const max = niceGaugeMax(
			Math.max(...ALL_LAYOUT_METRICS.map((m) => rates[m])),
			Math.max(...ALL_LAYOUT_METRICS.map((m) => peak[m]))
		);
		return (
			<>
				<div className="flex-1 min-h-0 grid grid-cols-3 gap-2">
					{ALL_LAYOUT_METRICS.map((m) => (
						<div key={m} className="min-w-0 min-h-0" data-testid={`throughput-gauge-${m}`}>
							<StyleComponent
								theme={theme}
								value={rates[m]}
								peak={peak[m]}
								max={max}
								label={metricLabel(m)}
								history={history[m]}
								compact
							/>
						</div>
					))}
				</div>
				<div
					className="shrink-0 truncate text-2xs leading-tight text-center"
					style={{ color: theme.colors.textDim }}
					title={scopeCaption}
					data-testid="throughput-gauge-scope-caption"
				>
					{scopeCaption}
				</div>
			</>
		);
	}

	return (
		<div className="flex-1 min-h-0">
			<StyleComponent
				theme={theme}
				value={rates[metric]}
				peak={peak[metric]}
				max={niceGaugeMax(rates[metric], peak[metric])}
				label={metricLabel(metric)}
				caption={scopeCaption}
				history={history[metric]}
				compact={false}
			/>
		</div>
	);
});

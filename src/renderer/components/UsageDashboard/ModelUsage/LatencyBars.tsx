/**
 * LatencyBars - p50 and p95 per source, as one horizontal bar per row.
 *
 * Each row is two bars on one track: the solid one ends at the median and the
 * faint one behind it runs on to p95, so the gap between them is the tail. The
 * track is a log scale (`latencyBarPercent`), because one chart holds sources
 * that answer in milliseconds and sources that take seconds.
 *
 * Purely presentational: the caller picks the rows (`latencyBarRows`) and says
 * what one sample is.
 */

import React, { memo, useMemo } from 'react';
import { formatCount } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import { formatLatency, latencyBarPercent, type LatencyBarRow } from './modelUsageView';

export interface LatencyBarsProps {
	theme: Theme;
	rows: LatencyBarRow[];
	/** Plural noun for one sample, e.g. "requests" or "turns". */
	unitLabel: string;
	/** Said in place of the bars when no source has a sample. */
	emptyLabel: string;
	testId?: string;
}

export const LatencyBars = memo(function LatencyBars({
	theme,
	rows,
	unitLabel,
	emptyLabel,
	testId,
}: LatencyBarsProps) {
	const maxMs = useMemo(() => Math.max(0, ...rows.map((row) => row.p95)), [rows]);

	if (rows.length === 0) {
		return (
			<div className="text-xs py-2" style={{ color: theme.colors.textDim }} data-testid={testId}>
				{emptyLabel}
			</div>
		);
	}

	return (
		// One label column for every row, hugging the longest name and capped so
		// a long endpoint name cannot starve the bars (the same grid as the
		// shared AgentActivityBars).
		<div
			className="grid items-center gap-x-3 gap-y-2 text-xs"
			style={{ gridTemplateColumns: 'fit-content(40%) minmax(0, 1fr) auto' }}
			data-testid={testId}
		>
			{rows.map((row) => (
				<React.Fragment key={row.key}>
					<span
						className="text-right truncate"
						style={{ color: theme.colors.textMain }}
						title={row.label}
					>
						{row.label}
					</span>
					<div
						className="relative h-2.5 rounded-full overflow-hidden"
						style={{ backgroundColor: theme.colors.border }}
						role="img"
						aria-label={`${row.label}: p50 ${formatLatency(row.p50)}, p95 ${formatLatency(row.p95)}, over ${formatCount(row.count)} ${unitLabel}`}
						data-testid="latency-bar"
						data-source={row.key}
					>
						<div
							className="absolute inset-y-0 left-0 rounded-full"
							style={{
								width: `${latencyBarPercent(row.p95, maxMs)}%`,
								backgroundColor: theme.colors.accent,
								opacity: 0.35,
							}}
						/>
						<div
							className="absolute inset-y-0 left-0 rounded-full"
							style={{
								width: `${latencyBarPercent(row.p50, maxMs)}%`,
								backgroundColor: theme.colors.accent,
							}}
						/>
					</div>
					<span
						className="text-right tabular-nums whitespace-nowrap"
						style={{ color: theme.colors.textDim }}
						title={`${formatCount(row.count)} ${unitLabel}`}
					>
						<span style={{ color: theme.colors.textMain }}>{formatLatency(row.p50)}</span>
						{' / '}
						{formatLatency(row.p95)}
					</span>
				</React.Fragment>
			))}
		</div>
	);
});

export default LatencyBars;

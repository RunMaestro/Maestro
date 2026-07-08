/**
 * PercentilesCard
 *
 * Reusable duration-distribution card for the Usage Dashboard. Renders the
 * p50 / p75 / p90 / p95 / p99 / max strip (the long-tail view that a single
 * average hides) for any labeled set of run durations: agent query times, Auto
 * Run task times, Cue run times. Optionally renders a per-group breakdown
 * (e.g. per agent) below the overall strip.
 *
 * Data comes from `computePercentiles()` (`src/shared/percentiles.ts`); this
 * component is presentation only.
 */

import { memo, useMemo } from 'react';
import type { Theme } from '../../types';
import { emptyPercentiles, type DurationPercentiles } from '../../../shared/percentiles';
import { formatDurationHuman } from '../../../shared/formatters';

interface PercentileColumn {
	key: keyof Pick<DurationPercentiles, 'p50' | 'p75' | 'p90' | 'p95' | 'p99' | 'max'>;
	label: string;
}

// Mirror of the percentile table in the analysis screenshot: median through max.
const PCT_COLUMNS: PercentileColumn[] = [
	{ key: 'p50', label: 'p50' },
	{ key: 'p75', label: 'p75' },
	{ key: 'p90', label: 'p90' },
	{ key: 'p95', label: 'p95' },
	{ key: 'p99', label: 'p99' },
	{ key: 'max', label: 'max' },
];

interface BreakdownRow {
	label: string;
	distribution?: DurationPercentiles | null;
}

interface PercentilesCardProps {
	theme: Theme;
	title: string;
	distribution: DurationPercentiles;
	/** Optional per-group distributions rendered as rows below the strip. */
	breakdown?: BreakdownRow[];
	/** Formatter for duration values (ms). Defaults to `formatDurationHuman`. */
	format?: (ms: number) => string;
	/** Plural noun for the sample-count caption, e.g. "queries", "runs", "tasks". */
	unitLabel?: string;
}

export const PercentilesCard = memo(function PercentilesCard({
	theme,
	title,
	distribution,
	breakdown,
	format = formatDurationHuman,
	unitLabel = 'runs',
}: PercentilesCardProps) {
	const normalizedDistribution = useMemo(() => normalizeDistribution(distribution), [distribution]);

	// Only show groups that actually have samples, biggest first.
	const visibleBreakdown = useMemo(
		() =>
			(breakdown ?? [])
				.map((row) => ({
					...row,
					distribution: normalizeDistribution(row.distribution),
				}))
				.filter((row) => row.distribution.count > 0)
				.sort((a, b) => b.distribution.count - a.distribution.count),
		[breakdown]
	);

	const hasData = normalizedDistribution.count > 0;

	return (
		<div
			className="rounded-lg p-4 border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			data-testid="percentiles-card"
		>
			<div className="flex items-baseline justify-between mb-3 gap-2">
				<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					{title}
				</h3>
				<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
					{hasData
						? `across ${normalizedDistribution.count.toLocaleString()} ${unitLabel}`
						: `no ${unitLabel} in range`}
				</span>
			</div>

			{hasData ? (
				<>
					<div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
						{PCT_COLUMNS.map((col) => (
							<PercentileCell
								key={col.key}
								label={col.label}
								value={format(normalizedDistribution[col.key])}
								theme={theme}
								emphasize={col.key === 'p99'}
							/>
						))}
					</div>

					{visibleBreakdown.length > 0 && (
						<div className="mt-4">
							<div
								className="text-[10px] uppercase tracking-wide mb-1.5"
								style={{ color: theme.colors.textDim }}
							>
								By Agent
							</div>
							<div
								className="rounded-md border overflow-hidden"
								style={{ borderColor: theme.colors.border }}
							>
								{/* header */}
								<div
									className="grid items-center px-2 py-1 text-[10px] uppercase tracking-wide"
									style={{
										gridTemplateColumns: `minmax(0,1.4fr) repeat(${PCT_COLUMNS.length}, minmax(0,1fr))`,
										color: theme.colors.textDim,
										borderBottom: `1px solid ${theme.colors.border}`,
									}}
								>
									<span />
									{PCT_COLUMNS.map((col) => (
										<span key={col.key} className="text-right tabular-nums">
											{col.label}
										</span>
									))}
								</div>
								{visibleBreakdown.map((row, i) => (
									<div
										key={row.label}
										className="grid items-center px-2 py-1 text-xs"
										style={{
											gridTemplateColumns: `minmax(0,1.4fr) repeat(${PCT_COLUMNS.length}, minmax(0,1fr))`,
											color: theme.colors.textMain,
											borderTop: i === 0 ? 'none' : `1px solid ${theme.colors.border}`,
										}}
									>
										<span className="truncate pr-2" title={row.label}>
											{row.label}
										</span>
										{PCT_COLUMNS.map((col) => (
											<span
												key={col.key}
												className="text-right tabular-nums"
												style={{ color: theme.colors.textDim }}
											>
												{format(row.distribution[col.key])}
											</span>
										))}
									</div>
								))}
							</div>
						</div>
					)}
				</>
			) : (
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					No completed runs to summarize yet.
				</div>
			)}
		</div>
	);
});

function normalizeDistribution(distribution?: DurationPercentiles | null): DurationPercentiles {
	return {
		...emptyPercentiles(),
		...(distribution ?? {}),
		count: distribution?.count ?? 0,
	};
}

interface PercentileCellProps {
	label: string;
	value: string;
	theme: Theme;
	emphasize?: boolean;
}

const PercentileCell = memo(function PercentileCell({
	label,
	value,
	theme,
	emphasize = false,
}: PercentileCellProps) {
	return (
		<div
			className="rounded-md border px-2 py-2"
			style={{
				borderColor: emphasize ? theme.colors.accent : theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			<div
				className="text-[10px] uppercase tracking-wide mb-0.5"
				style={{ color: emphasize ? theme.colors.accent : theme.colors.textDim }}
			>
				{label}
			</div>
			<div className="text-sm font-semibold tabular-nums" style={{ color: theme.colors.textMain }}>
				{value}
			</div>
		</div>
	);
});

export default PercentilesCard;

/**
 * AgentUsageChart
 *
 * "Agent Usage Over Time" on the Agent Overview tab: one line per agent across
 * every calendar day of the selected range, for the 10 agents with the most
 * queries in that range, plus one "Other agents" line holding everyone else so
 * the lines still add up to the range's total.
 *
 * - The x axis is the aggregation's calendar `window`, gap-filled: a day with no
 *   queries plots as zero instead of being skipped.
 * - An agent deleted since it recorded work is labeled "Deleted agent", never a
 *   prettified id.
 * - Worktree agents draw dashed.
 * - Queries or Time, remembered across opens. There is no Tokens mode: per-day
 *   token totals can only be joined to an agent through provider conversations
 *   an open tab still references, which silently undercounts.
 *
 * Drawn by the shared `MultiLineChart` widget, whose legend doubles as the
 * show/hide control.
 */

import { memo, useMemo } from 'react';
import type { Theme, Session } from '../../types';
import type { StatsTimeRange, StatsAggregation } from '../../../shared/stats-types';
import { formatCalendarDay, formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { localDaysBetween } from '../../../shared/daySeries';
import { toLocalYmd } from '../../../shared/localDay';
import { MultiLineChart, type LineSeries } from '../widgets';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { getSeriesColor, isWorktreeAgent } from './chartUtils';
import { MetricModeToggle, OVERVIEW_METRIC_LABELS } from './MetricModeToggle';

/** Lines drawn individually before the rest fold into "Other agents". */
export const AGENT_USAGE_TOP_N = 10;

/** Label for an agent that recorded work and has since been deleted. */
export const DELETED_AGENT_LABEL = 'Deleted agent';

/** Label for the line that sums every agent outside the top N. */
export const OTHER_AGENTS_LABEL = 'Other agents';

export const OTHER_AGENTS_KEY = '__other__';

const METRIC_STORAGE_KEY = 'usageDashboard.agentUsageMetric';
const METRIC_MODES = ['count', 'duration'] as const;
type AgentUsageMetric = (typeof METRIC_MODES)[number];

interface AgentUsageChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current time range selection. Kept for the view's prop contract. */
	timeRange?: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/** Live agents, for names and worktree status. */
	sessions?: Session[];
}

interface AgentLine {
	key: string;
	label: string;
	isWorktree: boolean;
	totalQueries: number;
	byDate: Map<string, { count: number; duration: number }>;
}

/**
 * Rank every agent with rows in the range, name it, and split it into the top
 * N plus the remainder. Pure, so the ranking and naming rules are testable.
 */
export function buildAgentUsageLines(
	bySessionByDay: StatsAggregation['bySessionByDay'],
	sessions: readonly Session[] | undefined,
	topN: number = AGENT_USAGE_TOP_N
): { top: AgentLine[]; rest: AgentLine[] } {
	const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
	const lines: AgentLine[] = Object.entries(bySessionByDay ?? {}).map(([key, days]) => {
		const byDate = new Map<string, { count: number; duration: number }>();
		let totalQueries = 0;
		for (const day of days) {
			byDate.set(day.date, { count: day.count, duration: day.duration });
			totalQueries += day.count;
		}
		const session = byId.get(key);
		return {
			key,
			label: session?.name || DELETED_AGENT_LABEL,
			isWorktree: session ? isWorktreeAgent(session) : false,
			totalQueries,
			byDate,
		};
	});

	lines.sort((a, b) => b.totalQueries - a.totalQueries || a.key.localeCompare(b.key));
	const top = lines.slice(0, topN);
	const rest = lines.slice(topN);

	// Two lines can share a name (two deleted agents, two agents the user named
	// alike); number the repeats so the legend and tooltip stay unambiguous.
	const seen = new Map<string, number>();
	for (const line of top) {
		const n = (seen.get(line.label) ?? 0) + 1;
		seen.set(line.label, n);
		if (n > 1) line.label = `${line.label} ${n}`;
	}
	return { top, rest };
}

export const AgentUsageChart = memo(function AgentUsageChart({
	data,
	theme,
	colorBlindMode = false,
	sessions,
}: AgentUsageChartProps) {
	const { value: metric, setValue: setMetric } = usePersistedChoice<AgentUsageMetric>(
		METRIC_STORAGE_KEY,
		METRIC_MODES,
		'count'
	);

	const days = useMemo(() => {
		const endYmd = data.window?.endYmd ?? toLocalYmd(Date.now());
		return localDaysBetween(data.window?.startYmd ?? endYmd, endYmd);
	}, [data.window]);

	const { top, rest } = useMemo(
		() => buildAgentUsageLines(data.bySessionByDay, sessions),
		[data.bySessionByDay, sessions]
	);

	const series = useMemo((): LineSeries[] => {
		const pick = (cell: { count: number; duration: number } | undefined) =>
			cell ? (metric === 'count' ? cell.count : cell.duration) : 0;
		const lines: LineSeries[] = top.map((line, index) => ({
			key: line.key,
			label: line.label,
			color: getSeriesColor(index, theme, colorBlindMode),
			dashed: line.isWorktree,
			values: days.map((date) => pick(line.byDate.get(date))),
		}));
		if (rest.length > 0) {
			lines.push({
				key: OTHER_AGENTS_KEY,
				label: `${OTHER_AGENTS_LABEL} (${formatNumber(rest.length)})`,
				color: theme.colors.textDim,
				values: days.map((date) =>
					rest.reduce((sum, line) => sum + pick(line.byDate.get(date)), 0)
				),
			});
		}
		return lines;
	}, [top, rest, days, metric, theme, colorBlindMode]);

	const xLabels = useMemo(() => days.map((date) => formatCalendarDay(date)), [days]);
	const formatValue = (value: number) =>
		metric === 'count' ? formatNumber(Math.round(value)) : formatDurationHuman(value);
	const noun = metric === 'count' ? 'queries' : 'time';

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="agent-usage-chart"
		>
			<div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
				<div>
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Agent Usage Over Time
					</h3>
					<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						Top {AGENT_USAGE_TOP_N} agents by queries in this range
						{rest.length > 0 ? `; the other ${formatNumber(rest.length)} share one line` : ''}.
					</p>
				</div>
				<MetricModeToggle
					mode={metric}
					onChange={setMetric}
					theme={theme}
					modes={[...METRIC_MODES]}
					labels={OVERVIEW_METRIC_LABELS}
				/>
			</div>

			{series.length === 0 ? (
				<div
					className="flex items-center justify-center h-40 text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="agent-usage-empty"
				>
					No queries in this range
				</div>
			) : (
				<MultiLineChart
					theme={theme}
					ariaLabel={`Agent ${noun} per day, top ${AGENT_USAGE_TOP_N} agents`}
					xLabels={xLabels}
					series={series}
					formatValue={formatValue}
					height={200}
					testId="agent-usage-lines"
				/>
			)}
		</div>
	);
});

export default AgentUsageChart;

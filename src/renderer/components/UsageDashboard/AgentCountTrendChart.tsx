/**
 * AgentCountTrendChart
 *
 * How many agents existed on each day of the selected range, in the Agent
 * Overview tab. The series is rebuilt from the live agent list plus the
 * `session_lifecycle` table (the only record of deleted agents); the rules live
 * in `src/shared/agentCountTimeline.ts`.
 *
 * Lifecycle rows are fetched for ALL time regardless of the range picker: an
 * agent created before the range and deleted inside it still counts on the
 * range's early days.
 */

import { memo, useMemo } from 'react';
import type { Theme, Session } from '../../types';
import type { StatsTimeRange } from '../../../shared/stats-types';
import { buildAgentCountTimeline, buildAgentLifespans } from '../../../shared/agentCountTimeline';
import { formatCalendarDay, formatNumber } from '../../../shared/formatters';
import { MultiLineChart, type LineSeries } from '../widgets';
import { useDashboardResource } from './useDashboardResource';

interface AgentCountTrendChartProps {
	sessions: Session[];
	timeRange: StatsTimeRange;
	theme: Theme;
}

const NO_LIFECYCLE: Awaited<ReturnType<typeof window.maestro.stats.getSessionLifecycle>> = [];

export const AgentCountTrendChart = memo(function AgentCountTrendChart({
	sessions,
	timeRange,
	theme,
}: AgentCountTrendChartProps) {
	const { data } = useDashboardResource(
		'session-lifecycle:all',
		() => window.maestro.stats.getSessionLifecycle('all'),
		'fetchSessionLifecycle'
	);
	const lifecycle = data ?? NO_LIFECYCLE;

	const timeline = useMemo(
		() => buildAgentCountTimeline(buildAgentLifespans(sessions, lifecycle), timeRange),
		[sessions, lifecycle, timeRange]
	);

	const xLabels = useMemo(
		() => timeline.points.map((p) => formatCalendarDay(p.date)),
		[timeline.points]
	);
	const series = useMemo(
		(): LineSeries[] => [
			{
				key: 'agents',
				label: 'Agents',
				color: theme.colors.accent,
				values: timeline.points.map((p) => p.count),
			},
		],
		[timeline.points, theme.colors.accent]
	);

	const current = timeline.points[timeline.points.length - 1]?.count ?? 0;
	const caption = [
		`${formatNumber(current)} now`,
		`${formatNumber(timeline.created)} created`,
		`${formatNumber(timeline.removed)} deleted in this range`,
	].join(' · ');

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="agent-count-trend"
		>
			<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
				Agents Over Time
			</h3>
			<p className="text-xs mt-0.5 mb-4" style={{ color: theme.colors.textDim }}>
				Agents that existed at the end of each day. {caption}.
			</p>
			<MultiLineChart
				theme={theme}
				ariaLabel="Agent count over time"
				xLabels={xLabels}
				series={series}
				formatValue={(v) => formatNumber(Math.round(v))}
				showLegend={false}
				testId="agent-count-trend-chart"
			/>
		</div>
	);
});

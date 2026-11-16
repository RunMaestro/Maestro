/**
 * WizardStats - Auto Run wizard usage for the Usage Dashboard's Auto Run tab.
 *
 * Answers what the wizard actually bought you: how long you spent talking to
 * it, how many times you reached for it, how many Auto Run documents came out,
 * and how many tasks those documents contain. Metric tiles up top, then a
 * per-day timeline of runs split by outcome.
 *
 * Data source: `wizard_runs` (one row per conversation, upserted at every
 * milestone - see `WizardRun` in shared/stats-types.ts). Self-contained on
 * purpose: fetches its own data and takes only `{ timeRange, theme }`, so
 * moving it to a different tab is a one-line change.
 */

import { memo, useMemo } from 'react';
import { Wand2, Clock, FileText, ListChecks, MessagesSquare, Sparkles } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, WizardRun } from '../../../shared/stats-types';
import { formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { toLocalYmd } from '../../../shared/localDay';
import { localDaysBetween } from '../../../shared/daySeries';
import { usageReadWindow } from '../../../shared/usageDashboardReads';
import { StatCardGrid } from '../widgets';
import type { StatCardDatum } from '../widgets';
import { DashboardPanelState } from './DashboardPanelState';
import { DayBarTimeline, type DayBarEntry } from './DayBarTimeline';
import { useDashboardResource } from './useDashboardResource';

interface WizardStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

const NO_RUNS: WizardRun[] = [];

export interface WizardSummary {
	runs: number;
	inline: number;
	iterate: number;
	productive: number;
	documents: number;
	tasks: number;
	exchanges: number;
	totalMs: number;
	untimed: number;
	averageMs: number;
	averageExchanges: number;
	tasksPerDoc: number;
	docsPerProductiveRun: number;
	hitRate: number;
}

export function summarizeWizardRuns(runs: WizardRun[]): WizardSummary {
	const productive = runs.filter((r) => r.documents > 0);
	const documents = runs.reduce((sum, r) => sum + r.documents, 0);
	const tasks = runs.reduce((sum, r) => sum + r.tasks, 0);
	const exchanges = runs.reduce((sum, r) => sum + r.exchanges, 0);
	// Active time only (agent turns plus capped user gaps), never
	// endedAt - startedAt: a wizard tab left open for days is not time spent
	// in the wizard. Rows recorded before activeMs existed are left out of
	// the time figures rather than guessed at.
	const timed = runs.filter((r) => r.activeMs !== undefined);
	const totalMs = timed.reduce((sum, r) => sum + Math.max(0, r.activeMs ?? 0), 0);
	return {
		runs: runs.length,
		inline: runs.filter((r) => r.surface === 'inline').length,
		iterate: runs.filter((r) => r.mode === 'iterate').length,
		productive: productive.length,
		documents,
		tasks,
		exchanges,
		totalMs,
		untimed: runs.length - timed.length,
		averageMs: timed.length > 0 ? Math.round(totalMs / timed.length) : 0,
		averageExchanges: runs.length > 0 ? Math.round((exchanges / runs.length) * 10) / 10 : 0,
		tasksPerDoc: documents > 0 ? Math.round((tasks / documents) * 10) / 10 : 0,
		docsPerProductiveRun:
			productive.length > 0 ? Math.round((documents / productive.length) * 10) / 10 : 0,
		hitRate: runs.length > 0 ? Math.round((productive.length / runs.length) * 100) : 0,
	};
}

/** One entry per day of the range: runs that produced documents, then runs that did not. */
export function buildWizardDays(
	runs: WizardRun[],
	timeRange: StatsTimeRange,
	colors: { produced: string; none: string },
	now: number = Date.now()
): Array<DayBarEntry & { produced: number; none: number; documents: number }> {
	if (runs.length === 0) return [];
	const earliest = toLocalYmd(Math.min(...runs.map((r) => r.startedAt)));
	const window = usageReadWindow(timeRange, earliest, now);
	const byDay = new Map<string, { produced: number; none: number; documents: number }>();
	for (const run of runs) {
		const key = toLocalYmd(run.startedAt);
		const day = byDay.get(key) ?? { produced: 0, none: 0, documents: 0 };
		if (run.documents > 0) day.produced++;
		else day.none++;
		day.documents += run.documents;
		byDay.set(key, day);
	}
	return localDaysBetween(window.startYmd, window.endYmd).map((date) => {
		const day = byDay.get(date) ?? { produced: 0, none: 0, documents: 0 };
		return {
			date,
			...day,
			segments: [
				{ value: day.produced, color: colors.produced },
				{ value: day.none, color: colors.none },
			],
		};
	});
}

function plural(n: number, word: string): string {
	return `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
}

export const WizardStats = memo(function WizardStats({ timeRange, theme }: WizardStatsProps) {
	const { data, loading, error, refresh } = useDashboardResource(
		`wizard-runs:${timeRange}`,
		() => window.maestro.stats.getWizardRuns(timeRange),
		'fetchWizardStats',
		{ tables: ['wizard_runs'] }
	);
	const runs = data ?? NO_RUNS;
	const summary = useMemo(() => summarizeWizardRuns(runs), [runs]);
	const days = useMemo(
		() =>
			buildWizardDays(runs, timeRange, {
				produced: theme.colors.accent,
				none: theme.colors.textDim,
			}),
		[runs, timeRange, theme.colors.accent, theme.colors.textDim]
	);

	const cards: StatCardDatum[] = [
		{
			label: 'Time in the Wizard',
			icon: Clock,
			value: summary.totalMs,
			displayValue:
				summary.totalMs > 0
					? formatDurationHuman(summary.totalMs)
					: summary.untimed === summary.runs
						? '-'
						: '0m',
			caption:
				[
					summary.averageMs > 0 ? `${formatDurationHuman(summary.averageMs)} per run` : null,
					summary.untimed > 0 ? `${summary.untimed} earlier untimed` : null,
				]
					.filter(Boolean)
					.join(' · ') || undefined,
		},
		{
			label: 'Wizard Runs',
			icon: Wand2,
			value: summary.runs,
			caption: `${summary.inline} inline · ${summary.runs - summary.inline} onboarding`,
		},
		{
			label: 'Docs Produced',
			icon: FileText,
			value: summary.documents,
			caption:
				summary.docsPerProductiveRun > 0
					? `${summary.docsPerProductiveRun} per productive run`
					: undefined,
		},
		{
			label: 'Tasks Written',
			icon: ListChecks,
			value: summary.tasks,
			caption: summary.tasksPerDoc > 0 ? `${summary.tasksPerDoc} per document` : undefined,
		},
		{
			label: 'Messages Sent',
			icon: MessagesSquare,
			value: summary.exchanges,
			caption: `${summary.averageExchanges} per run`,
		},
		{
			label: 'Runs That Shipped',
			icon: Sparkles,
			value: summary.hitRate,
			displayValue: `${summary.hitRate}%`,
			caption: `${summary.productive} of ${summary.runs} · ${summary.iterate} revised existing docs`,
		},
	];

	return (
		<div data-testid="wizard-stats" role="region" aria-label="Wizard statistics">
			<h3
				className="text-sm font-medium mb-3 flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
				Wizard
			</h3>
			<DashboardPanelState
				theme={theme}
				loading={loading}
				error={error}
				empty={runs.length === 0}
				emptyMessage="No wizard runs in this time range. Type /wizard in an agent to plan Auto Run documents through a conversation, and the runs show up here."
				onRetry={() => void refresh()}
				testId="wizard-stats"
			>
				<div className="space-y-4">
					<StatCardGrid theme={theme} cards={cards} />
					<DayBarTimeline
						days={days}
						theme={theme}
						title="Wizard Runs Over Time"
						legend={[
							{ label: 'Produced docs', color: theme.colors.accent },
							{ label: 'No docs', color: theme.colors.textDim },
						]}
						ariaLabel="Wizard runs per day, split by whether they produced Auto Run documents"
						testId="wizard-timeline"
						describeDay={(day) => {
							const d = day as (typeof days)[number];
							return `${day.date}: ${plural(d.produced, 'run')} produced docs, ${formatNumber(d.none)} without`;
						}}
						renderTooltip={(day) => {
							const d = day as (typeof days)[number];
							if (d.produced + d.none === 0) return <div>No wizard runs</div>;
							return (
								<>
									{d.produced > 0 && (
										<div>
											{plural(d.produced, 'run')} produced {plural(d.documents, 'doc')}
										</div>
									)}
									{d.none > 0 && <div>{formatNumber(d.none)} without docs</div>}
								</>
							);
						}}
					/>
				</div>
			</DashboardPanelState>
		</div>
	);
});

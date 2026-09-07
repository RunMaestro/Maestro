/**
 * WizardStats - Auto Run wizard usage for the Usage Dashboard's Auto Run tab.
 *
 * Answers what the wizard actually bought you: how long you spent talking to
 * it, how many times you reached for it, how many Auto Run documents came out,
 * and how many tasks those documents contain. Metric tiles up top, then a
 * per-day timeline of runs split by outcome and a new-vs-iterate breakdown.
 *
 * Data source: `wizard_runs` (one row per conversation, upserted at every
 * milestone - see `WizardRun` in shared/stats-types.ts). Self-contained on
 * purpose: fetches its own data and takes only `{ timeRange, theme }`, so
 * moving it to a different tab is a one-line change.
 */

import { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { Wand2, Clock, FileText, ListChecks, MessagesSquare, Sparkles } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, WizardRun } from '../../../shared/stats-types';
import { captureException } from '../../utils/sentry';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';
import { MetricCard } from './MetricCard';

interface WizardStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

/** Local-midnight day key, so bars bucket by the user's calendar day. */
function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface DayBucket {
	key: string;
	label: string;
	generated: number;
	other: number;
	documents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const WizardStats = memo(function WizardStats({ timeRange, theme }: WizardStatsProps) {
	const [runs, setRuns] = useState<WizardRun[]>([]);
	const [loading, setLoading] = useState(true);
	const [hoveredDay, setHoveredDay] = useState<number | null>(null);

	const fetchRuns = useCallback(async () => {
		try {
			setRuns(await window.maestro.stats.getWizardRuns(timeRange));
		} catch (err) {
			captureException(err, { extra: { operation: 'fetchWizardStats' } });
		} finally {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		fetchRuns();
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			fetchRuns();
		});
		return () => unsubscribe();
	}, [fetchRuns]);

	const summary = useMemo(() => {
		const productive = runs.filter((r) => r.documents > 0);
		const documents = runs.reduce((sum, r) => sum + r.documents, 0);
		const tasks = runs.reduce((sum, r) => sum + r.tasks, 0);
		const exchanges = runs.reduce((sum, r) => sum + r.exchanges, 0);
		// Time in conversation, not wall clock between runs: endedAt is the last
		// activity in a run, so a wizard left open overnight does not inflate this.
		const totalMs = runs.reduce((sum, r) => sum + Math.max(0, r.endedAt - r.startedAt), 0);
		return {
			runs: runs.length,
			inline: runs.filter((r) => r.surface === 'inline').length,
			iterate: runs.filter((r) => r.mode === 'iterate').length,
			productive: productive.length,
			documents,
			tasks,
			exchanges,
			totalMs,
			averageMs: runs.length > 0 ? Math.round(totalMs / runs.length) : 0,
			averageExchanges: runs.length > 0 ? Math.round((exchanges / runs.length) * 10) / 10 : 0,
			tasksPerDoc: documents > 0 ? Math.round((tasks / documents) * 10) / 10 : 0,
			docsPerProductiveRun:
				productive.length > 0 ? Math.round((documents / productive.length) * 10) / 10 : 0,
			hitRate: runs.length > 0 ? Math.round((productive.length / runs.length) * 100) : 0,
		};
	}, [runs]);

	// Contiguous day buckets from the earliest run to today, so quiet days
	// render as gaps rather than being squeezed out of the timeline.
	const days = useMemo((): DayBucket[] => {
		if (runs.length === 0) return [];
		const earliest = Math.min(...runs.map((r) => r.startedAt));
		const buckets = new Map<string, DayBucket>();
		for (let ts = earliest; dayKey(ts) <= dayKey(Date.now()); ts += DAY_MS) {
			const key = dayKey(ts);
			buckets.set(key, {
				key,
				label: new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
				generated: 0,
				other: 0,
				documents: 0,
			});
		}
		for (const run of runs) {
			const bucket = buckets.get(dayKey(run.startedAt));
			if (!bucket) continue;
			if (run.documents > 0) bucket.generated++;
			else bucket.other++;
			bucket.documents += run.documents;
		}
		return Array.from(buckets.values());
	}, [runs]);

	const maxDay = useMemo(() => Math.max(...days.map((d) => d.generated + d.other), 1), [days]);

	if (loading) return null;

	if (runs.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-2 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
					Wizard
				</h3>
				<div className="text-sm" style={{ color: theme.colors.textDim }}>
					No wizard runs in this time range. Type <code>/wizard</code> in an agent to plan Auto Run
					documents through a conversation, and the runs show up here.
				</div>
			</div>
		);
	}

	const hovered = hoveredDay !== null ? days[hoveredDay] : null;

	return (
		<div data-testid="wizard-stats">
			<h3
				className="text-sm font-medium mb-3 flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
				Wizard
			</h3>

			{/* Metric tiles */}
			<div
				className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4"
				data-testid="wizard-metrics"
				role="region"
				aria-label="Wizard summary metrics"
			>
				<MetricCard
					testId="wizard-metric-card"
					icon={<Clock className="w-4 h-4" />}
					label="Time in the Wizard"
					value={summary.totalMs > 0 ? formatDuration(summary.totalMs) : '0m'}
					subValue={
						summary.averageMs > 0 ? `${formatDuration(summary.averageMs)} per run` : undefined
					}
					theme={theme}
				/>
				<MetricCard
					testId="wizard-metric-card"
					icon={<Wand2 className="w-4 h-4" />}
					label="Wizard Runs"
					value={formatNumber(summary.runs)}
					subValue={`${summary.inline} inline · ${summary.runs - summary.inline} onboarding`}
					theme={theme}
				/>
				<MetricCard
					testId="wizard-metric-card"
					icon={<FileText className="w-4 h-4" />}
					label="Docs Produced"
					value={formatNumber(summary.documents)}
					subValue={
						summary.docsPerProductiveRun > 0
							? `${summary.docsPerProductiveRun} per productive run`
							: undefined
					}
					theme={theme}
				/>
				<MetricCard
					testId="wizard-metric-card"
					icon={<ListChecks className="w-4 h-4" />}
					label="Tasks Written"
					value={formatNumber(summary.tasks)}
					subValue={summary.tasksPerDoc > 0 ? `${summary.tasksPerDoc} per document` : undefined}
					theme={theme}
				/>
				<MetricCard
					testId="wizard-metric-card"
					icon={<MessagesSquare className="w-4 h-4" />}
					label="Messages Sent"
					value={formatNumber(summary.exchanges)}
					subValue={`${summary.averageExchanges} per run`}
					theme={theme}
				/>
				<MetricCard
					testId="wizard-metric-card"
					icon={<Sparkles className="w-4 h-4" />}
					label="Runs That Shipped"
					value={`${summary.hitRate}%`}
					subValue={`${summary.productive} of ${summary.runs} · ${summary.iterate} revised existing docs`}
					theme={theme}
				/>
			</div>

			{/* Per-day timeline */}
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex items-center justify-between mb-3">
					<h4 className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Wizard Runs Over Time
					</h4>
					<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
						<span className="flex items-center gap-1">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: theme.colors.accent }}
							/>
							Produced docs
						</span>
						<span className="flex items-center gap-1">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
							No docs
						</span>
					</div>
				</div>

				<div className="relative">
					{hovered && hovered.generated + hovered.other > 0 && (
						<div
							className="absolute z-10 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
							style={{
								left: `${((hoveredDay! + 0.5) / days.length) * 100}%`,
								bottom: '100%',
								transform: 'translateX(-50%)',
								marginBottom: '8px',
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<div className="font-medium mb-1">{hovered.label}</div>
							<div style={{ color: theme.colors.textDim }}>
								{hovered.generated > 0 && (
									<div>
										{hovered.generated} run{hovered.generated === 1 ? '' : 's'} produced{' '}
										{hovered.documents} doc{hovered.documents === 1 ? '' : 's'}
									</div>
								)}
								{hovered.other > 0 && <div>{hovered.other} without docs</div>}
							</div>
						</div>
					)}

					<div
						className="flex items-end justify-center gap-0.5 h-20"
						role="img"
						aria-label="Wizard runs per day, split by whether they produced Auto Run documents"
					>
						{days.map((day, i) => {
							const total = day.generated + day.other;
							return (
								<div
									key={day.key}
									className="flex-1 flex flex-col justify-end h-full cursor-default"
									// Cap the column so a 1-3 day range reads as bars, not slabs.
									style={{ maxWidth: 48 }}
									onMouseEnter={() => setHoveredDay(i)}
									onMouseLeave={() => setHoveredDay(null)}
								>
									{/* Barren runs on top, so the "produced something" base reads first. */}
									{day.other > 0 && (
										<div
											className="w-full rounded-t-sm"
											style={{
												height: `${(day.other / maxDay) * 100}%`,
												backgroundColor: theme.colors.textDim,
												opacity: hoveredDay === i ? 0.9 : 0.5,
											}}
										/>
									)}
									{day.generated > 0 && (
										<div
											className={`w-full ${day.other === 0 ? 'rounded-t-sm' : ''}`}
											style={{
												height: `${(day.generated / maxDay) * 100}%`,
												backgroundColor: theme.colors.accent,
												opacity: hoveredDay === i ? 1 : 0.75,
											}}
										/>
									)}
									{total === 0 && (
										<div
											className="w-full"
											style={{ height: 2, backgroundColor: `${theme.colors.border}80` }}
										/>
									)}
								</div>
							);
						})}
					</div>

					<div
						className="flex justify-between mt-1 text-2xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>{days[0]?.label}</span>
						<span>{days[days.length - 1]?.label}</span>
					</div>
				</div>
			</div>
		</div>
	);
});

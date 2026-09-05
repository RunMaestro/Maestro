/**
 * ResilienceStats - Agent Resilience outcomes for the Usage Dashboard.
 *
 * Answers one question: how often did a provider refuse work (quota wall,
 * overload) and Maestro carried the turn through anyway? Metric tiles up top,
 * then a per-day timeline of outages split by outcome.
 *
 * Data source: `resilience_events` (one row per RESOLVED outage - recovered or
 * user-stopped; live countdowns are never recorded). Self-contained on purpose:
 * fetches its own data and takes only `{ timeRange, theme }`, so mounting it on
 * a different dashboard tab (main's monolith vs rc's split Tokens tab) is a
 * one-line change per branch.
 */

import React, { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { ShieldCheck, Clock, RefreshCw, Percent } from 'lucide-react';
import type { Theme } from '../../types';
import type { StatsTimeRange, ResilienceEvent } from '../../../shared/stats-types';
import { captureException } from '../../utils/sentry';
import { formatDurationHuman as formatDuration, formatNumber } from '../../../shared/formatters';

interface ResilienceStatsProps {
	/** Current time range for filtering */
	timeRange: StatsTimeRange;
	/** Current theme for styling */
	theme: Theme;
}

interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	subValue?: string;
	theme: Theme;
}

function MetricCard({ icon, label, value, subValue, theme }: MetricCardProps) {
	return (
		<div
			className="p-4 rounded-lg flex items-start gap-3"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="group"
			aria-label={`${label}: ${value}${subValue ? `, ${subValue}` : ''}`}
		>
			<div
				className="flex-shrink-0 p-2 rounded-md"
				style={{ backgroundColor: `${theme.colors.accent}15`, color: theme.colors.accent }}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</div>
				<div
					className="text-2xl font-bold truncate"
					style={{ color: theme.colors.textMain }}
					title={value}
				>
					{value}
				</div>
				{subValue && (
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{subValue}
					</div>
				)}
			</div>
		</div>
	);
}

/** Local-midnight day key, so bars bucket by the user's calendar day. */
function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface DayBucket {
	key: string;
	label: string;
	recovered: number;
	stopped: number;
}

export const ResilienceStats = memo(function ResilienceStats({
	timeRange,
	theme,
}: ResilienceStatsProps) {
	const [events, setEvents] = useState<ResilienceEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [hoveredDay, setHoveredDay] = useState<number | null>(null);

	const fetchEvents = useCallback(async () => {
		try {
			setEvents(await window.maestro.stats.getResilience(timeRange));
		} catch (err) {
			captureException(err, { extra: { operation: 'fetchResilienceStats' } });
		} finally {
			setLoading(false);
		}
	}, [timeRange]);

	useEffect(() => {
		fetchEvents();
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			fetchEvents();
		});
		return () => unsubscribe();
	}, [fetchEvents]);

	const summary = useMemo(() => {
		const recovered = events.filter((e) => e.outcome === 'recovered');
		const quotaRecovered = recovered.filter((e) => e.strategy === 'token-exhaustion').length;
		return {
			total: events.length,
			recovered: recovered.length,
			quotaRecovered,
			availabilityRecovered: recovered.length - quotaRecovered,
			// Downtime the user did NOT have to babysit: summed wait of recovered
			// outages. Stopped outages are excluded - that wait ended in the user
			// taking over, so nothing was bridged.
			bridgedMs: recovered.reduce((sum, e) => sum + (e.resolvedAt - e.startedAt), 0),
			longestMs: recovered.reduce((max, e) => Math.max(max, e.resolvedAt - e.startedAt), 0),
			retries: events.reduce((sum, e) => sum + e.retries, 0),
			rate: events.length > 0 ? Math.round((recovered.length / events.length) * 100) : 0,
		};
	}, [events]);

	// Contiguous day buckets from the earliest event to today, so quiet days
	// render as gaps rather than being squeezed out of the timeline.
	const days = useMemo((): DayBucket[] => {
		if (events.length === 0) return [];
		const earliest = Math.min(...events.map((e) => e.startedAt));
		const buckets = new Map<string, DayBucket>();
		const DAY_MS = 24 * 60 * 60 * 1000;
		for (let ts = earliest; dayKey(ts) <= dayKey(Date.now()); ts += DAY_MS) {
			const key = dayKey(ts);
			buckets.set(key, {
				key,
				label: new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
				recovered: 0,
				stopped: 0,
			});
		}
		for (const e of events) {
			const bucket = buckets.get(dayKey(e.startedAt));
			if (!bucket) continue;
			if (e.outcome === 'recovered') bucket.recovered++;
			else bucket.stopped++;
		}
		return Array.from(buckets.values());
	}, [events]);

	const maxDay = useMemo(() => Math.max(...days.map((d) => d.recovered + d.stopped), 1), [days]);

	if (loading) return null;

	if (events.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-2 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
					Resilience
				</h3>
				<div className="text-sm" style={{ color: theme.colors.textDim }}>
					No provider outages in this time range. When a quota wall or overload interrupts a turn,
					the automatic recovery shows up here.
				</div>
			</div>
		);
	}

	const hovered = hoveredDay !== null ? days[hoveredDay] : null;

	return (
		<div data-testid="resilience-stats">
			<h3
				className="text-sm font-medium mb-3 flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
				Resilience
			</h3>

			{/* Metric tiles */}
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
				<MetricCard
					icon={<ShieldCheck className="w-4 h-4" />}
					label="Outages Survived"
					value={formatNumber(summary.recovered)}
					subValue={`${summary.quotaRecovered} quota · ${summary.availabilityRecovered} availability`}
					theme={theme}
				/>
				<MetricCard
					icon={<Clock className="w-4 h-4" />}
					label="Downtime Bridged"
					value={summary.bridgedMs > 0 ? formatDuration(summary.bridgedMs) : '0m'}
					subValue={
						summary.longestMs > 0 ? `longest ${formatDuration(summary.longestMs)}` : undefined
					}
					theme={theme}
				/>
				<MetricCard
					icon={<Percent className="w-4 h-4" />}
					label="Recovery Rate"
					value={`${summary.rate}%`}
					subValue={`${summary.recovered} of ${summary.total} outages`}
					theme={theme}
				/>
				<MetricCard
					icon={<RefreshCw className="w-4 h-4" />}
					label="Auto-Retries Sent"
					value={formatNumber(summary.retries)}
					theme={theme}
				/>
			</div>

			{/* Per-day timeline */}
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex items-center justify-between mb-3">
					<h4 className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Outages Over Time
					</h4>
					<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
						<span className="flex items-center gap-1">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: theme.colors.success }}
							/>
							Recovered
						</span>
						<span className="flex items-center gap-1">
							<span
								className="inline-block w-2.5 h-2.5 rounded-sm"
								style={{ backgroundColor: theme.colors.error }}
							/>
							Stopped
						</span>
					</div>
				</div>

				<div className="relative">
					{hovered && (hovered.recovered > 0 || hovered.stopped > 0) && (
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
								{hovered.recovered > 0 && <div>{hovered.recovered} recovered</div>}
								{hovered.stopped > 0 && <div>{hovered.stopped} stopped</div>}
							</div>
						</div>
					)}

					<div
						className="flex items-end justify-center gap-0.5 h-20"
						role="img"
						aria-label="Provider outages per day, split by outcome"
					>
						{days.map((day, i) => {
							const total = day.recovered + day.stopped;
							return (
								<div
									key={day.key}
									className="flex-1 flex flex-col justify-end h-full cursor-default"
									// Cap the column so a 1-3 day range reads as bars, not slabs.
									style={{ maxWidth: 48 }}
									onMouseEnter={() => setHoveredDay(i)}
									onMouseLeave={() => setHoveredDay(null)}
								>
									{/* Stopped on top of recovered, so the "kept working" base reads first. */}
									{day.stopped > 0 && (
										<div
											className="w-full rounded-t-sm"
											style={{
												height: `${(day.stopped / maxDay) * 100}%`,
												backgroundColor: theme.colors.error,
												opacity: hoveredDay === i ? 1 : 0.75,
											}}
										/>
									)}
									{day.recovered > 0 && (
										<div
											className={`w-full ${day.stopped === 0 ? 'rounded-t-sm' : ''}`}
											style={{
												height: `${(day.recovered / maxDay) * 100}%`,
												backgroundColor: theme.colors.success,
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

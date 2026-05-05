/**
 * AgentDetailModal
 *
 * Per-agent stats sub-modal opened by double-clicking an agent card on the
 * Usage Dashboard's Agents tab. Stays scoped to stats — no recent-queries
 * list, no per-agent token/cost (those live in provider session files and
 * aren't aggregated per Maestro session yet).
 *
 * Reuses `data.bySessionByDay[session.id]` (already fetched by the dashboard)
 * for cheap aggregates and daily activity. Pulls the raw query events for the
 * session via `stats.getStats('all', { sessionId })` to compute the duration
 * distribution (median, p95) and user/auto split, since those aren't already
 * aggregated per session.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { formatDurationHuman, formatNumber, formatRelativeTime } from '../../../shared/formatters';
import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { logger } from '../../utils/logger';
import { Sparkline } from './Sparkline';

interface AgentDetailModalProps {
	session: Session;
	data: StatsAggregation;
	theme: Theme;
	/** All visible agent sessions — used to surface worktree relationships. */
	allSessions: Session[];
	onClose: () => void;
}

interface QueryEvent {
	id: string;
	sessionId: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
}

interface AutoRunSessionRow {
	id: string;
	sessionId: string;
	startTime: number;
	duration: number;
	tasksTotal?: number;
	tasksCompleted?: number;
}

interface DurationDistribution {
	min: number;
	median: number;
	p95: number;
	max: number;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
	return sorted[idx];
}

function computeDistribution(durations: number[]): DurationDistribution {
	if (durations.length === 0) return { min: 0, median: 0, p95: 0, max: 0 };
	const sorted = [...durations].sort((a, b) => a - b);
	return {
		min: sorted[0],
		median: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1],
	};
}

export const AgentDetailModal = memo(function AgentDetailModal({
	session,
	data,
	theme,
	allSessions,
	onClose,
}: AgentDetailModalProps) {
	const [events, setEvents] = useState<QueryEvent[] | null>(null);
	const [autoRuns, setAutoRuns] = useState<AutoRunSessionRow[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEvents(null);
		setAutoRuns(null);

		// Raw query events scoped to this session — needed for median/p95 and the
		// user/auto source split. The aggregated `bySessionByDay` only carries
		// daily totals, not per-event durations, so we fetch raw rows here.
		window.maestro.stats
			.getStats('all', { sessionId: session.id })
			.then((rows) => {
				if (!cancelled) setEvents(rows as QueryEvent[]);
			})
			.catch((error) => {
				logger.error('Failed to load per-agent query events', undefined, error);
				if (!cancelled) setEvents([]);
			});

		// Auto Run sessions across all-time, filtered client-side. The IPC has
		// no sessionId filter for auto runs, but the volume is small.
		window.maestro.stats
			.getAutoRunSessions('all')
			.then((rows) => {
				if (!cancelled) {
					setAutoRuns(rows.filter((r) => r.sessionId === session.id) as AutoRunSessionRow[]);
				}
			})
			.catch((error) => {
				logger.error('Failed to load per-agent auto-run sessions', undefined, error);
				if (!cancelled) setAutoRuns([]);
			});

		return () => {
			cancelled = true;
		};
	}, [session.id]);

	const aggregates = useMemo(() => {
		const byDay = data.bySessionByDay?.[session.id] ?? [];
		const totalQueries = byDay.reduce((sum, d) => sum + d.count, 0);
		const totalDuration = byDay.reduce((sum, d) => sum + d.duration, 0);
		const avgDuration = totalQueries > 0 ? totalDuration / totalQueries : 0;
		const activeDays = byDay.filter((d) => d.count > 0);
		const firstActive = activeDays[0]?.date ?? null;
		const lastActive = activeDays[activeDays.length - 1]?.date ?? null;
		return { byDay, totalQueries, totalDuration, avgDuration, firstActive, lastActive };
	}, [data, session.id]);

	const sourceSplit = useMemo(() => {
		if (!events) return null;
		let user = 0;
		let auto = 0;
		for (const e of events) {
			if (e.source === 'user') user++;
			else if (e.source === 'auto') auto++;
		}
		return { user, auto };
	}, [events]);

	const distribution = useMemo<DurationDistribution | null>(() => {
		if (!events) return null;
		return computeDistribution(events.map((e) => e.duration));
	}, [events]);

	const autoRunSummary = useMemo(() => {
		if (!autoRuns) return null;
		const total = autoRuns.length;
		const totalTasks = autoRuns.reduce((sum, r) => sum + (r.tasksCompleted ?? 0), 0);
		const longest = autoRuns.reduce((max, r) => Math.max(max, r.duration), 0);
		const totalDuration = autoRuns.reduce((sum, r) => sum + r.duration, 0);
		return { total, totalTasks, longest, totalDuration };
	}, [autoRuns]);

	const worktreeRelations = useMemo(() => {
		if (session.parentSessionId) {
			const parent = allSessions.find((s) => s.id === session.parentSessionId);
			return { parent: parent ?? null, siblings: 0, children: [] as Session[] };
		}
		const children = allSessions.filter((s) => s.parentSessionId === session.id);
		return { parent: null, siblings: children.length, children };
	}, [session, allSessions]);

	// Sparkline for the entire byDay window (not capped at 7 days like the card)
	const fullSparkline = useMemo(() => aggregates.byDay.map((d) => d.count), [aggregates]);

	const isWorktree = Boolean(session.parentSessionId);
	const headerLabel = `${session.name}${isWorktree ? ' (worktree)' : ''}`;

	return (
		<Modal
			theme={theme}
			title={headerLabel}
			priority={MODAL_PRIORITIES.USAGE_DASHBOARD_AGENT_DETAIL}
			onClose={onClose}
			width={720}
			maxHeight="85vh"
			closeOnBackdropClick={true}
			testId="agent-detail-modal"
		>
			<div className="space-y-5">
				{/* Identity row */}
				<section
					className="rounded-lg p-3 border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
						<MetaField label="Agent" value={getAgentDisplayName(session.toolType)} theme={theme} />
						{session.worktreeBranch && (
							<MetaField label="Branch" value={session.worktreeBranch} theme={theme} />
						)}
						{session.cwd && <MetaField label="Path" value={session.cwd} theme={theme} mono />}
						{aggregates.firstActive && (
							<MetaField label="First active" value={aggregates.firstActive} theme={theme} />
						)}
						{aggregates.lastActive && (
							<MetaField label="Last active" value={aggregates.lastActive} theme={theme} />
						)}
					</div>
				</section>

				{/* KPI row */}
				<section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<Kpi label="Total queries" value={formatNumber(aggregates.totalQueries)} theme={theme} />
					<Kpi
						label="Total duration"
						value={
							aggregates.totalDuration > 0 ? formatDurationHuman(aggregates.totalDuration) : '—'
						}
						theme={theme}
					/>
					<Kpi
						label="Avg duration"
						value={aggregates.avgDuration > 0 ? formatDurationHuman(aggregates.avgDuration) : '—'}
						theme={theme}
					/>
					<Kpi
						label="Active days"
						value={formatNumber(aggregates.byDay.filter((d) => d.count > 0).length)}
						theme={theme}
					/>
				</section>

				{/* Daily activity sparkline (full window) */}
				{fullSparkline.length > 0 && (
					<section>
						<SectionHeading theme={theme}>Daily Activity</SectionHeading>
						<div
							className="rounded-md p-3 border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<Sparkline data={fullSparkline} color={theme.colors.accent} width={680} height={64} />
							<div
								className="flex justify-between mt-1 text-[10px]"
								style={{ color: theme.colors.textDim }}
							>
								<span>{aggregates.byDay[0]?.date ?? ''}</span>
								<span>{aggregates.byDay[aggregates.byDay.length - 1]?.date ?? ''}</span>
							</div>
						</div>
					</section>
				)}

				{/* Duration distribution */}
				<section>
					<SectionHeading theme={theme}>Duration Distribution</SectionHeading>
					<div className="grid grid-cols-4 gap-3">
						<Kpi
							label="Min"
							value={distribution ? formatDurationHuman(distribution.min) : '…'}
							theme={theme}
							compact
						/>
						<Kpi
							label="Median"
							value={distribution ? formatDurationHuman(distribution.median) : '…'}
							theme={theme}
							compact
						/>
						<Kpi
							label="p95"
							value={distribution ? formatDurationHuman(distribution.p95) : '…'}
							theme={theme}
							compact
						/>
						<Kpi
							label="Max"
							value={distribution ? formatDurationHuman(distribution.max) : '…'}
							theme={theme}
							compact
						/>
					</div>
				</section>

				{/* Source split */}
				<section>
					<SectionHeading theme={theme}>Query Source</SectionHeading>
					{sourceSplit ? (
						<SourceSplitBar user={sourceSplit.user} auto={sourceSplit.auto} theme={theme} />
					) : (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading…
						</div>
					)}
				</section>

				{/* Auto Run summary */}
				<section>
					<SectionHeading theme={theme}>Auto Run</SectionHeading>
					{autoRunSummary ? (
						autoRunSummary.total === 0 ? (
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								No Auto Run sessions for this agent.
							</div>
						) : (
							<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
								<Kpi
									label="Sessions"
									value={formatNumber(autoRunSummary.total)}
									theme={theme}
									compact
								/>
								<Kpi
									label="Tasks completed"
									value={formatNumber(autoRunSummary.totalTasks)}
									theme={theme}
									compact
								/>
								<Kpi
									label="Longest run"
									value={formatDurationHuman(autoRunSummary.longest)}
									theme={theme}
									compact
								/>
								<Kpi
									label="Total run time"
									value={formatDurationHuman(autoRunSummary.totalDuration)}
									theme={theme}
									compact
								/>
							</div>
						)
					) : (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading…
						</div>
					)}
				</section>

				{/* Worktree relationship */}
				{(worktreeRelations.parent || worktreeRelations.siblings > 0) && (
					<section>
						<SectionHeading theme={theme}>Worktree</SectionHeading>
						<div className="text-xs" style={{ color: theme.colors.textMain }}>
							{worktreeRelations.parent ? (
								<>
									Worktree of{' '}
									<span style={{ color: theme.colors.accent }}>
										{worktreeRelations.parent.name}
									</span>
								</>
							) : (
								<>
									Parent agent with{' '}
									<span style={{ color: theme.colors.accent }}>{worktreeRelations.siblings}</span>{' '}
									{worktreeRelations.siblings === 1 ? 'worktree' : 'worktrees'}
								</>
							)}
						</div>
					</section>
				)}

				{/* Footer note: when the most recent activity was, formatted relative */}
				{aggregates.lastActive && (
					<div className="text-[10px] text-right" style={{ color: theme.colors.textDim }}>
						Last active {formatRelativeTime(new Date(aggregates.lastActive).getTime())}
					</div>
				)}
			</div>
		</Modal>
	);
});

interface KpiProps {
	label: string;
	value: string;
	theme: Theme;
	compact?: boolean;
}

const Kpi = memo(function Kpi({ label, value, theme, compact = false }: KpiProps) {
	return (
		<div
			className="rounded-md border"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
				padding: compact ? '8px 10px' : '12px',
			}}
		>
			<div
				className="text-[10px] uppercase tracking-wide mb-1"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</div>
			<div
				className={compact ? 'text-base font-semibold' : 'text-lg font-bold'}
				style={{ color: theme.colors.textMain }}
			>
				{value}
			</div>
		</div>
	);
});

interface MetaFieldProps {
	label: string;
	value: string;
	theme: Theme;
	mono?: boolean;
}

const MetaField = memo(function MetaField({ label, value, theme, mono }: MetaFieldProps) {
	return (
		<span className="inline-flex items-baseline gap-1">
			<span style={{ color: theme.colors.textDim }}>{label}:</span>
			<span
				className={mono ? 'font-mono' : ''}
				style={{ color: theme.colors.textMain }}
				title={value}
			>
				{value}
			</span>
		</span>
	);
});

interface SectionHeadingProps {
	theme: Theme;
	children: React.ReactNode;
}

const SectionHeading = memo(function SectionHeading({ theme, children }: SectionHeadingProps) {
	return (
		<h3
			className="text-xs font-semibold uppercase tracking-wide mb-2"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</h3>
	);
});

interface SourceSplitBarProps {
	user: number;
	auto: number;
	theme: Theme;
}

const SourceSplitBar = memo(function SourceSplitBar({ user, auto, theme }: SourceSplitBarProps) {
	const total = user + auto;
	if (total === 0) {
		return (
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				No queries recorded.
			</div>
		);
	}
	const userPct = (user / total) * 100;
	const autoPct = 100 - userPct;
	return (
		<div className="space-y-2">
			<div
				className="h-3 rounded-full overflow-hidden flex"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<div
					style={{
						width: `${userPct}%`,
						backgroundColor: theme.colors.accent,
					}}
					title={`User: ${user}`}
				/>
				<div
					style={{
						width: `${autoPct}%`,
						backgroundColor: theme.colors.warning,
					}}
					title={`Auto: ${auto}`}
				/>
			</div>
			<div className="flex justify-between text-xs" style={{ color: theme.colors.textMain }}>
				<span>
					User: <span style={{ color: theme.colors.accent }}>{formatNumber(user)}</span> (
					{userPct.toFixed(0)}%)
				</span>
				<span>
					Auto: <span style={{ color: theme.colors.warning }}>{formatNumber(auto)}</span> (
					{autoPct.toFixed(0)}%)
				</span>
			</div>
		</div>
	);
});

export default AgentDetailModal;

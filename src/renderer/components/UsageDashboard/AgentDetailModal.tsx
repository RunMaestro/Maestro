/**
 * AgentDetailModal
 *
 * Per-agent stats sub-modal opened by clicking an agent card on the Usage
 * Dashboard's Agents tab (or a member row in a group's detail modal). Stays
 * scoped to stats - no recent-queries list.
 *
 * Every figure covers the dashboard's SELECTED RANGE, the Auto Run block
 * included. Tokens and cost come from
 * `data.bySessionTokens[session.id]` (per-turn rows in the stats database) with
 * a coverage note, because rows recorded before the token columns existed carry
 * none. The agent's running lifetime total (`session.usageStats`) is shown on
 * its own labelled line: placed in the KPI row it read as the range's spend,
 * putting an agent's whole history beside a 30-day query count.
 *
 * Reuses `data.bySessionByDay[session.id]` (already fetched by the dashboard)
 * for cheap aggregates and daily activity, zero-filled over the range's
 * calendar window. Pulls the raw query events for the session in the same
 * range via `stats.getStats(timeRange, { sessionId })` to compute the time
 * distribution (median, p95) and user/auto split, since those aren't already
 * aggregated per session. Both fetches go through `useDashboardResource`, so a
 * failure renders as an error rather than as "no data".
 */

import { memo, useCallback, useMemo, useRef } from 'react';
import { LogIn, Settings } from 'lucide-react';
import type { Session, Theme } from '../../types';
import type { QueryEvent, StatsAggregation, StatsTimeRange } from '../../../shared/stats-types';
import {
	formatCalendarDay,
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatRelativeTime,
	formatTokensCompact,
} from '../../../shared/formatters';
import { hasUsage, resolveUsageCost, sumUsageTokens } from '../../../shared/usageStats';
import { Modal } from '../ui/Modal';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { jumpToAgent, openAgentSettings } from '../../services/agentNavigation';
import { notifyToast } from '../../stores/notificationStore';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { computePercentiles } from '../../../shared/percentiles';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { Sparkline } from '../widgets';
import { Kpi, MetaField, SectionHeading } from './DetailPrimitives';
import { TabBreakdown } from './TabBreakdown';
import { usageCoverageNote } from './usageCoverage';
import { useDashboardResource } from './useDashboardResource';
import { DashboardPanelState } from './DashboardPanelState';
import { buildRangeActivity } from './agentOverviewUtils';

interface AgentDetailModalProps {
	session: Session;
	data: StatsAggregation;
	/** The dashboard's selected range; every figure in this modal covers it. */
	timeRange: StatsTimeRange;
	theme: Theme;
	/** All visible agent sessions - used to surface worktree relationships. */
	allSessions: Session[];
	onClose: () => void;
	/**
	 * Closes the whole Usage Dashboard, not just this sub-modal. Only the jump
	 * uses it: the dashboard is a full-window modal, so an agent it is sitting
	 * on top of is an agent the user cannot see. Agent Settings deliberately
	 * does NOT call it - that modal stacks above the dashboard so Escape puts
	 * the user back where they were reading stats.
	 */
	onCloseDashboard: () => void;
}

interface AutoRunSessionRow {
	id: string;
	sessionId: string;
	startTime: number;
	duration: number;
	tasksTotal?: number;
	tasksCompleted?: number;
}

export const AgentDetailModal = memo(function AgentDetailModal({
	session,
	data,
	timeRange,
	theme,
	allSessions,
	onClose,
	onCloseDashboard,
}: AgentDetailModalProps) {
	// Raw query events scoped to this agent and range - needed for the time
	// percentiles and the user/auto split. `bySessionByDay` only carries daily
	// totals, not per-event durations.
	const eventsResource = useDashboardResource<QueryEvent[]>(
		`agent-detail-events:${session.id}:${timeRange}`,
		async () =>
			(await window.maestro.stats.getStats(timeRange, { sessionId: session.id })) as QueryEvent[],
		'fetchAgentDetailEvents',
		{ tables: ['query_events'] }
	);
	const events = eventsResource.data ?? null;

	// Auto Run sessions in the SAME range as every other figure here. The IPC
	// has no agent filter, so the range's runs are filtered client-side.
	const autoRunResource = useDashboardResource<AutoRunSessionRow[]>(
		`agent-detail-autoruns:${timeRange}`,
		async () => (await window.maestro.stats.getAutoRunSessions(timeRange)) as AutoRunSessionRow[],
		'fetchAgentDetailAutoRuns',
		{ tables: ['auto_run'] }
	);
	const autoRuns = useMemo(
		() => autoRunResource.data?.filter((run) => run.sessionId === session.id) ?? null,
		[autoRunResource.data, session.id]
	);

	const aggregates = useMemo(() => {
		const byDay = data.bySessionByDay?.[session.id] ?? [];
		const totalQueries = byDay.reduce((sum, d) => sum + d.count, 0);
		const totalDuration = byDay.reduce((sum, d) => sum + d.duration, 0);
		const avgDuration = totalQueries > 0 ? totalDuration / totalQueries : 0;
		const activeDays = byDay.filter((d) => d.count > 0);
		const firstActive = activeDays[0]?.date ?? null;
		// The exact time of the last query, not the day it fell on: a day string
		// read as a timestamp lands on midnight (UTC midnight, even, once parsed).
		const lastQueryAt = data.bySessionLastQuery?.[session.id] ?? null;
		return {
			byDay,
			totalQueries,
			totalDuration,
			avgDuration,
			activeDayCount: activeDays.length,
			firstActive,
			lastQueryAt,
		};
	}, [data, session.id]);

	// Token/cost for the selected range, from the per-turn stats rows.
	const rangeUsage = useMemo(() => {
		const t = data.bySessionTokens?.[session.id];
		const pricedQueries = t?.pricedQueries ?? 0;
		return {
			pricedQueries,
			total: t ? t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens : 0,
			inputTokens: t?.inputTokens ?? 0,
			outputTokens: t?.outputTokens ?? 0,
			cacheReadTokens: t?.cacheReadTokens ?? 0,
			costUsd: t?.costUsd ?? 0,
			note: usageCoverageNote(pricedQueries, aggregates.totalQueries),
		};
	}, [data, session.id, aggregates.totalQueries]);

	// The agent's running lifetime total, accumulated turn by turn since it was
	// created. Not range-scoped, so it is labelled as lifetime wherever shown.
	const lifetimeUsage = useMemo(() => {
		const u = session.usageStats;
		if (!hasUsage(u)) return null;
		const { costUsd, estimated } = resolveUsageCost(u, session.customModel);
		return { total: sumUsageTokens(u), costUsd, estimated };
	}, [session.usageStats, session.customModel]);

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

	const distribution = useMemo(() => {
		if (!events) return null;
		return computePercentiles(events.map((e) => e.duration));
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

	// Daily activity over every calendar day of the range, zero-filled, so idle
	// days read as idle instead of being squeezed out. The modal is resizable, so
	// the chart's width has to be measured rather than hard-coded - an inline SVG
	// needs real pixels for its viewBox.
	const rangeActivity = useMemo(
		() => buildRangeActivity(aggregates.byDay, data.window),
		[aggregates.byDay, data.window]
	);
	const fullSparkline = useMemo(() => rangeActivity.map((d) => d.count), [rangeActivity]);
	const activityRef = useRef<HTMLDivElement>(null);
	const activityWidth = useElementWidth(activityRef);

	const isWorktree = Boolean(session.parentSessionId);
	const headerLabel = `${session.name}${isWorktree ? ' (worktree)' : ''}`;

	// A jump leaves the dashboard behind - the agent it would land on is under a
	// full-window modal otherwise.
	const handleJump = useCallback(() => {
		if (!jumpToAgent(session.id)) {
			notifyToast({
				color: 'yellow',
				title: 'Agent not found',
				message: `${session.name} is no longer open. Its stats are kept, but there is nothing to jump to.`,
			});
			return;
		}
		onClose();
		onCloseDashboard();
	}, [session.id, session.name, onClose, onCloseDashboard]);

	// Settings STACKS instead. Edit Agent outranks this modal in the layer stack
	// (MODAL_PRIORITIES.NEW_INSTANCE, 750, against 543 here), so it takes the
	// Escape key and, on close, hands the user back the stats they were reading
	// rather than an empty workspace.
	const handleOpenSettings = useCallback(() => {
		openAgentSettings(session);
	}, [session]);

	return (
		<Modal
			theme={theme}
			title={headerLabel}
			priority={MODAL_PRIORITIES.USAGE_DASHBOARD_AGENT_DETAIL}
			onClose={onClose}
			width={860}
			maxHeight="85vh"
			resizeKey="modal-usage-agent-detail"
			defaultSize={{ width: 860, height: 720 }}
			minSize={{ width: 460, height: 360 }}
			closeOnBackdropClick={true}
			testId="agent-detail-modal"
			contentClassName="p-6 overflow-y-auto flex-1 min-h-0"
			headerActions={
				<>
					<HeaderActionButton
						theme={theme}
						onClick={handleJump}
						icon={<LogIn />}
						title={`Switch to ${session.name}`}
						testId="agent-detail-jump"
					>
						Jump to Agent
					</HeaderActionButton>
					<HeaderActionButton
						theme={theme}
						onClick={handleOpenSettings}
						variant="ghost"
						icon={<Settings />}
						title={`Edit ${session.name}`}
						testId="agent-detail-settings"
					>
						Agent Settings
					</HeaderActionButton>
				</>
			}
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
							<MetaField
								label="First active"
								value={formatCalendarDay(aggregates.firstActive)}
								theme={theme}
							/>
						)}
						{aggregates.lastQueryAt !== null && (
							<MetaField
								label="Last active"
								value={formatRelativeTime(aggregates.lastQueryAt)}
								theme={theme}
							/>
						)}
					</div>
				</section>

				{/* KPI row */}
				<section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<Kpi label="Total queries" value={formatNumber(aggregates.totalQueries)} theme={theme} />
					<Kpi
						label="Total time"
						value={
							aggregates.totalDuration > 0 ? formatDurationHuman(aggregates.totalDuration) : '-'
						}
						theme={theme}
					/>
					<Kpi
						label="Avg time per query"
						value={aggregates.avgDuration > 0 ? formatDurationHuman(aggregates.avgDuration) : '-'}
						theme={theme}
					/>
					<Kpi label="Active days" value={formatNumber(aggregates.activeDayCount)} theme={theme} />
				</section>

				{/* Token & cost for the selected range, from per-turn stats rows. */}
				{(rangeUsage.pricedQueries > 0 || lifetimeUsage) && (
					<section>
						<SectionHeading theme={theme}>Tokens &amp; Cost</SectionHeading>
						{rangeUsage.pricedQueries > 0 && (
							<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
								<Kpi
									label="Total tokens"
									value={formatTokensCompact(rangeUsage.total)}
									title={rangeUsage.note}
									theme={theme}
								/>
								<Kpi
									label="Input / Output"
									value={`${formatTokensCompact(rangeUsage.inputTokens)} / ${formatTokensCompact(
										rangeUsage.outputTokens
									)}`}
									title={rangeUsage.note}
									theme={theme}
								/>
								<Kpi
									label="Cache reads"
									value={formatTokensCompact(rangeUsage.cacheReadTokens)}
									title={rangeUsage.note}
									theme={theme}
								/>
								<Kpi
									label="Cost"
									value={formatCost(rangeUsage.costUsd)}
									title={rangeUsage.note}
									theme={theme}
									testId="agent-detail-range-cost"
								/>
							</div>
						)}
						<div className="mt-2 space-y-1 text-xs-plus" style={{ color: theme.colors.textDim }}>
							{rangeUsage.pricedQueries < aggregates.totalQueries && (
								<p role="note">{rangeUsage.note}</p>
							)}
							{lifetimeUsage && (
								<p data-testid="agent-detail-lifetime-usage">
									Lifetime since {new Date(session.createdAt).toLocaleDateString()}:{' '}
									{formatTokensCompact(lifetimeUsage.total)} tokens,{' '}
									{lifetimeUsage.estimated ? '~' : ''}
									{formatCost(lifetimeUsage.costUsd)}
									{lifetimeUsage.estimated ? ' (est.)' : ''}
								</p>
							)}
						</div>
					</section>
				)}

				{/* Daily activity across the whole range, zero-filled */}
				{aggregates.totalQueries > 0 && (
					<section>
						<SectionHeading theme={theme}>Daily Activity</SectionHeading>
						<div
							ref={activityRef}
							className="rounded-md p-3 border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<Sparkline
								data={fullSparkline}
								color={theme.colors.accent}
								// 24px of horizontal padding on the measured container.
								// Width is 0 until the observer fires; fall back to the
								// default frame width so the first paint is not empty.
								width={activityWidth > 0 ? Math.max(120, activityWidth - 24) : 800}
								height={64}
							/>
							<div
								className="flex justify-between mt-1 text-2xs"
								style={{ color: theme.colors.textDim }}
							>
								<span>{formatCalendarDay(rangeActivity[0]?.date ?? '')}</span>
								<span>
									{formatCalendarDay(rangeActivity[rangeActivity.length - 1]?.date ?? '')}
								</span>
							</div>
						</div>
					</section>
				)}

				{/* Time per query distribution */}
				<section>
					<SectionHeading theme={theme}>Time per Query</SectionHeading>
					<DashboardPanelState
						theme={theme}
						loading={eventsResource.loading}
						error={eventsResource.error}
						empty={!events}
						onRetry={() => void eventsResource.refresh()}
						minHeight={48}
						testId="agent-detail-distribution"
					>
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
							<Kpi
								label="Min"
								value={distribution ? formatDurationHuman(distribution.min) : '-'}
								theme={theme}
								compact
							/>
							<Kpi
								label="Median"
								value={distribution ? formatDurationHuman(distribution.p50) : '-'}
								theme={theme}
								compact
							/>
							<Kpi
								label="p95"
								value={distribution ? formatDurationHuman(distribution.p95) : '-'}
								theme={theme}
								compact
							/>
							<Kpi
								label="Max"
								value={distribution ? formatDurationHuman(distribution.max) : '-'}
								theme={theme}
								compact
							/>
						</div>
					</DashboardPanelState>
				</section>

				{/* Source split */}
				<section>
					<SectionHeading theme={theme}>Query Source</SectionHeading>
					<DashboardPanelState
						theme={theme}
						loading={eventsResource.loading}
						error={eventsResource.error}
						empty={!sourceSplit}
						onRetry={() => void eventsResource.refresh()}
						minHeight={48}
						testId="agent-detail-source"
					>
						{sourceSplit && (
							<SourceSplitBar user={sourceSplit.user} auto={sourceSplit.auto} theme={theme} />
						)}
					</DashboardPanelState>
				</section>

				{/* Auto Run summary, for the selected range */}
				<section>
					<SectionHeading theme={theme}>Auto Run</SectionHeading>
					<DashboardPanelState
						theme={theme}
						loading={autoRunResource.loading}
						error={autoRunResource.error}
						empty={!autoRunSummary || autoRunSummary.total === 0}
						emptyMessage="No Auto Runs for this agent in this range."
						onRetry={() => void autoRunResource.refresh()}
						minHeight={48}
						testId="agent-detail-autorun"
					>
						{autoRunSummary && (
							<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
								<Kpi
									label="Runs"
									value={formatNumber(autoRunSummary.total)}
									theme={theme}
									compact
									testId="agent-detail-autorun-runs"
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
						)}
					</DashboardPanelState>
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

				{/* Per-tab breakdown - the same query events, grouped by the tab that
				    issued them. Last of the sections because it is the only
				    open-ended one: it paginates, and its own filter and sort
				    controls would otherwise push the fixed summaries below the
				    fold. */}
				<section>
					<SectionHeading theme={theme}>Tabs</SectionHeading>
					<DashboardPanelState
						theme={theme}
						loading={eventsResource.loading}
						error={eventsResource.error}
						empty={!events}
						onRetry={() => void eventsResource.refresh()}
						minHeight={48}
						testId="agent-detail-tabs"
					>
						<TabBreakdown session={session} theme={theme} events={events} />
					</DashboardPanelState>
				</section>

				{/* Footer note: when the last query ran, formatted relative */}
				{aggregates.lastQueryAt !== null && (
					<div
						className="text-2xs text-right"
						style={{ color: theme.colors.textDim }}
						title={new Date(aggregates.lastQueryAt).toLocaleString()}
						data-testid="agent-detail-last-active"
					>
						Last active {formatRelativeTime(aggregates.lastQueryAt)}
					</div>
				)}
			</div>
		</Modal>
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

/**
 * AgentOverviewCards
 *
 * Top-of-dashboard grid showing one compact card per active agent
 * (excluding internal terminal sessions). Each card surfaces the agent
 * name, live status dot, query count, and a 7-day activity sparkline.
 *
 * Worktree children render with a dashed accent border, a "WT" badge,
 * and their checked-out branch — so a parent and its worktrees are
 * visually distinguishable at a glance.
 */

import { memo, useMemo } from 'react';
import type { Session, SessionState, Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { Sparkline } from './Sparkline';

const SPARKLINE_DAYS = 7;

type ByDayEntry = StatsAggregation['byDay'][number];

/**
 * Map a session state to its theme status color. Falls back to
 * `textDim` for transient states (waiting_input, connecting, etc.)
 * so they don't false-positive as healthy / errored.
 */
function getStatusColor(state: SessionState, theme: Theme): string {
	switch (state) {
		case 'idle':
			return theme.colors.success;
		case 'busy':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		default:
			return theme.colors.textDim;
	}
}

/**
 * Pull the last `SPARKLINE_DAYS` entries' counts (oldest → newest),
 * left-padding with zeros so the sparkline geometry stays stable for
 * sessions with fewer than seven recorded days.
 */
function buildSessionSparkline(sessionByDay: ByDayEntry[] | undefined): number[] {
	if (!sessionByDay || sessionByDay.length === 0) {
		return new Array(SPARKLINE_DAYS).fill(0);
	}
	const counts = sessionByDay.slice(-SPARKLINE_DAYS).map((d) => d.count);
	if (counts.length >= SPARKLINE_DAYS) return counts;
	return [...new Array(SPARKLINE_DAYS - counts.length).fill(0), ...counts];
}

/**
 * Resolve whether a session card should be highlighted by the current
 * drill-down filter. The filter key originates from a few different surfaces:
 *
 *   - `AgentComparisonChart` emits provider keys like `claude-code` (parent)
 *     or `claude-code__worktree` (worktree variant).
 *   - `AgentUsageChart` emits per-session keys (e.g. `${provider}:${id}` or
 *     bare session ids).
 *
 * We highlight cards by matching against either the session id directly, or
 * — for provider-shaped keys — the session's `toolType`, separating worktree
 * and non-worktree variants so a "Worktrees" filter doesn't paint the parent
 * card and vice versa.
 */
function isSessionHighlighted(session: Session, activeFilterKey: string | null): boolean {
	if (!activeFilterKey) return false;
	if (activeFilterKey === session.id) return true;

	const WORKTREE_SUFFIX = '__worktree';
	if (activeFilterKey.endsWith(WORKTREE_SUFFIX)) {
		const provider = activeFilterKey.slice(0, -WORKTREE_SUFFIX.length);
		return Boolean(session.parentSessionId) && session.toolType === provider;
	}

	return !session.parentSessionId && session.toolType === activeFilterKey;
}

interface AgentCardProps {
	session: Session;
	data: StatsAggregation;
	theme: Theme;
	/** 0-based index for the staggered card-enter animation */
	animationIndex: number;
	/** When true, render the card with a thicker accent border to flag the active filter */
	isSelected: boolean;
}

const AgentCard = memo(function AgentCard({
	session,
	data,
	theme,
	animationIndex,
	isSelected,
}: AgentCardProps) {
	const isWorktree = Boolean(session.parentSessionId);
	const isBusy = session.state === 'busy';
	const statusColor = getStatusColor(session.state, theme);

	const { queryCount, sparklineData } = useMemo(() => {
		const sessionByDay = data.bySessionByDay?.[session.id];
		if (sessionByDay && sessionByDay.length > 0) {
			const total = sessionByDay.reduce((sum, d) => sum + d.count, 0);
			return { queryCount: total, sparklineData: buildSessionSparkline(sessionByDay) };
		}
		// Per-session breakdown isn't available — fall back to the
		// provider-level total so we still surface a count.
		const agentData = data.byAgent?.[session.toolType];
		return {
			queryCount: agentData?.count ?? 0,
			sparklineData: buildSessionSparkline(undefined),
		};
	}, [data.bySessionByDay, data.byAgent, session.id, session.toolType]);

	const sparklineColor = isWorktree ? theme.colors.accent : statusColor;

	// When the dashboard filter selects this card's agent, the 1px default
	// border is replaced with a 2px solid accent border. Worktree dashing is
	// suppressed for the duration — the highlight outranks the worktree
	// affordance, and the existing "WT" badge keeps the worktree distinction
	// visible.
	const border = isSelected
		? `2px solid ${theme.colors.accent}`
		: isWorktree
			? `1px dashed ${theme.colors.accent}99`
			: `1px solid ${theme.colors.border}`;

	return (
		<div
			className="card-enter relative p-3 rounded-lg flex flex-col gap-1.5"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border,
				animationDelay: `${animationIndex * 60}ms`,
			}}
			data-testid="agent-card"
			data-selected={isSelected ? 'true' : undefined}
			role="group"
			aria-label={`${session.name}, ${session.state}, ${queryCount} ${
				queryCount === 1 ? 'query' : 'queries'
			}`}
		>
			<div className="flex items-center gap-2 min-w-0">
				<span
					className="flex-shrink-0 w-2 h-2 rounded-full"
					style={{
						backgroundColor: statusColor,
						animation: isBusy ? 'status-pulse 1.4s ease-in-out infinite' : undefined,
					}}
					aria-hidden="true"
					data-testid="agent-card-status-dot"
				/>
				<span
					className="text-sm font-medium truncate flex-1 min-w-0"
					style={{ color: theme.colors.textMain }}
					title={session.name}
				>
					{session.name}
				</span>
				{isWorktree && (
					<span
						className="flex-shrink-0 px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
						}}
						data-testid="agent-card-wt-badge"
					>
						WT
					</span>
				)}
			</div>
			{isWorktree && session.worktreeBranch && (
				<div
					className="text-[11px] truncate"
					style={{ color: theme.colors.textDim }}
					title={session.worktreeBranch}
					data-testid="agent-card-branch"
				>
					{session.worktreeBranch}
				</div>
			)}
			<div className="flex items-end justify-between gap-2 mt-auto">
				<div className="flex flex-col min-w-0">
					<span
						className="text-[9px] uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Queries
					</span>
					<span
						className="text-base font-semibold"
						style={{ color: theme.colors.textMain }}
						data-testid="agent-card-query-count"
					>
						{queryCount}
					</span>
				</div>
				<div className="flex-shrink-0 opacity-80 pointer-events-none">
					<Sparkline data={sparklineData} color={sparklineColor} width={70} height={22} />
				</div>
			</div>
		</div>
	);
});

interface AgentOverviewCardsProps {
	/** All known sessions (terminal-only sessions are filtered out) */
	sessions: Session[];
	/** Aggregated stats — used for per-session query counts and sparklines */
	data: StatsAggregation;
	/** Current theme for color-aware styling */
	theme: Theme;
	/**
	 * Active dashboard drill-down filter key. When set, the matching session
	 * card(s) render with a 2px accent border so the selection is visible at
	 * the top of the dashboard. `null` means no filter is active.
	 */
	activeFilterKey?: string | null;
}

export const AgentOverviewCards = memo(function AgentOverviewCards({
	sessions,
	data,
	theme,
	activeFilterKey = null,
}: AgentOverviewCardsProps) {
	// Terminal sessions aren't "agents" — exclude them so the card row
	// matches the agent count shown elsewhere in the dashboard.
	const activeSessions = useMemo(
		() => sessions.filter((s) => s.toolType !== 'terminal'),
		[sessions]
	);

	if (activeSessions.length === 0) return null;

	return (
		<div
			className="grid gap-3"
			style={{
				gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
			}}
			data-testid="agent-overview-cards"
			role="region"
			aria-label="Active agents overview"
		>
			{activeSessions.map((session, index) => (
				<AgentCard
					key={session.id}
					session={session}
					data={data}
					theme={theme}
					animationIndex={index}
					isSelected={isSessionHighlighted(session, activeFilterKey)}
				/>
			))}
		</div>
	);
});

export default AgentOverviewCards;

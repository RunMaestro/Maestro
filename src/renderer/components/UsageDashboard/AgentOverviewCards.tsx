/**
 * AgentOverviewCards
 *
 * Top-of-dashboard grid showing one compact card per active agent
 * (excluding internal terminal sessions). Each card surfaces the agent
 * name, live status dot, query count, and a 7-day activity sparkline.
 *
 * Worktree children render with a dashed accent border, a "WT" badge,
 * and their checked-out branch, so a parent and its worktrees are
 * visually distinguishable at a glance.
 */

import { memo, useMemo, useState } from 'react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { formatAgeShort } from '../../../shared/formatters';
import { Sparkline } from './Sparkline';
import {
	AGENT_OVERVIEW_SORT_OPTIONS,
	buildSessionSparkline,
	getSessionAutoPercent,
	getSessionQueryCount,
	getStatusColor,
	isSessionHighlighted,
	sortAgentOverviewSessions,
	type SortMode,
} from './agentOverviewUtils';

/** Per-card stat we should visually emphasize. Mirrors `SortMode` minus `name`
 *  (the default sort has no per-card highlight). */
type HighlightedStat = 'created' | 'queries' | 'tabs' | 'auto' | null;
const EMPTY_AUTO_PERCENT_LABEL = String.fromCharCode(8212);

interface AgentCardProps {
	session: Session;
	data: StatsAggregation;
	theme: Theme;
	/** 0-based index for the staggered card-enter animation */
	animationIndex: number;
	/** When true, render the card with a thicker accent border to flag the active filter */
	isSelected: boolean;
	/** All visible sessions; needed to disambiguate the provider-fallback count */
	visibleSessions: Session[];
	/** Which stat to color-emphasize so it's obvious what the cards are sorted by.
	 *  `null` (Name sort, the default) leaves all stats in their neutral color. */
	highlightedStat: HighlightedStat;
	/** Click handler for the entire card. When provided, the tile becomes a
	 *  button that opens the per-agent stats sub-modal and gains a hover
	 *  affordance to signal clickability. */
	onShowDetails?: (session: Session) => void;
}

const AgentCard = memo(function AgentCard({
	session,
	data,
	theme,
	animationIndex,
	isSelected,
	visibleSessions,
	highlightedStat,
	onShowDetails,
}: AgentCardProps) {
	const isWorktree = Boolean(session.parentSessionId);
	const isBusy = session.state === 'busy';
	const statusColor = getStatusColor(session.state, theme);
	const isClickable = Boolean(onShowDetails);
	const [isHovered, setIsHovered] = useState(false);

	const { queryCount, sparklineData, autoPercent } = useMemo(() => {
		const sessionByDay = data.bySessionByDay?.[session.id];
		const sparkline = buildSessionSparkline(sessionByDay);
		return {
			queryCount: getSessionQueryCount(session, data, visibleSessions),
			sparklineData: sparkline,
			autoPercent: getSessionAutoPercent(session, data),
		};
	}, [data, session, visibleSessions]);

	const tabCount = session.aiTabs?.length ?? 0;
	const sparklineColor = isWorktree ? theme.colors.accent : statusColor;

	// When the dashboard filter selects this card's agent, the 1px default
	// border is replaced with a 2px solid accent border. Worktree dashing is
	// suppressed for the duration. The highlight outranks the worktree
	// affordance, and the existing "WT" badge keeps the worktree distinction
	// visible. While hovered (clickable cards only), we promote the border to
	// the accent color so the tile reads as actionable.
	const border = isSelected
		? `2px solid ${theme.colors.accent}`
		: isHovered && isClickable
			? `1px solid ${theme.colors.accent}`
			: isWorktree
				? `1px dashed ${theme.colors.accent}99`
				: `1px solid ${theme.colors.border}`;
	const backgroundColor =
		isHovered && isClickable ? `${theme.colors.accent}12` : theme.colors.bgActivity;

	const handleClick = onShowDetails ? () => onShowDetails(session) : undefined;
	const handleKeyDown = onShowDetails
		? (e: React.KeyboardEvent<HTMLDivElement>) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onShowDetails(session);
				}
			}
		: undefined;

	const autoPctLabel = autoPercent === null ? 'no recorded queries' : `${autoPercent}% auto`;
	const ageLabel = session.createdAt ? formatAgeShort(session.createdAt) : null;
	const ageTitle = session.createdAt
		? `Created ${new Date(session.createdAt).toLocaleString()}`
		: undefined;
	const baseAriaLabel = `${session.name}, ${session.state}, ${queryCount} ${
		queryCount === 1 ? 'query' : 'queries'
	}, ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}, ${autoPctLabel}${
		ageLabel ? `, age ${ageLabel}` : ''
	}`;
	const ariaLabel = isClickable ? `${baseAriaLabel}. View detailed stats.` : baseAriaLabel;

	return (
		<div
			className={`card-enter relative p-3 rounded-lg flex flex-col gap-1.5 transition-colors ${
				isClickable ? 'cursor-pointer focus:outline-none focus-visible:ring-2' : ''
			}`}
			style={{
				backgroundColor,
				border,
				animationDelay: `${animationIndex * 60}ms`,
				transitionDuration: '120ms',
				...(isClickable ? ({ '--tw-ring-color': theme.colors.accent } as React.CSSProperties) : {}),
			}}
			data-testid="agent-card"
			data-selected={isSelected ? 'true' : undefined}
			data-clickable={isClickable ? 'true' : undefined}
			role={isClickable ? 'button' : 'group'}
			tabIndex={isClickable ? 0 : undefined}
			onClick={handleClick}
			onKeyDown={handleKeyDown}
			onMouseEnter={isClickable ? () => setIsHovered(true) : undefined}
			onMouseLeave={isClickable ? () => setIsHovered(false) : undefined}
			aria-label={ariaLabel}
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
				{ageLabel && (
					<span
						className="flex-shrink-0 text-[10px] tabular-nums"
						style={{
							color: highlightedStat === 'created' ? theme.colors.accent : theme.colors.textDim,
							fontWeight: highlightedStat === 'created' ? 600 : undefined,
						}}
						title={ageTitle}
						data-testid="agent-card-age"
						data-highlighted={highlightedStat === 'created' ? 'true' : undefined}
					>
						{ageLabel}
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
				<div className="flex items-end gap-3 min-w-0">
					<div className="flex flex-col min-w-0">
						<span
							className="text-[9px] uppercase tracking-wide"
							style={{
								color: highlightedStat === 'queries' ? theme.colors.accent : theme.colors.textDim,
							}}
						>
							Queries
						</span>
						<span
							className="text-base font-semibold"
							style={{
								color: highlightedStat === 'queries' ? theme.colors.accent : theme.colors.textMain,
							}}
							data-testid="agent-card-query-count"
							data-highlighted={highlightedStat === 'queries' ? 'true' : undefined}
						>
							{queryCount}
						</span>
					</div>
					<div className="flex flex-col min-w-0">
						<span
							className="text-[9px] uppercase tracking-wide"
							style={{
								color: highlightedStat === 'tabs' ? theme.colors.accent : theme.colors.textDim,
							}}
						>
							Tabs
						</span>
						<span
							className="text-base font-semibold"
							style={{
								color: highlightedStat === 'tabs' ? theme.colors.accent : theme.colors.textMain,
							}}
							data-testid="agent-card-tab-count"
							data-highlighted={highlightedStat === 'tabs' ? 'true' : undefined}
						>
							{tabCount}
						</span>
					</div>
					<div className="flex flex-col min-w-0">
						<span
							className="text-[9px] uppercase tracking-wide"
							style={{
								color: highlightedStat === 'auto' ? theme.colors.accent : theme.colors.textDim,
							}}
						>
							Auto %
						</span>
						<span
							className="text-base font-semibold"
							style={{
								color:
									highlightedStat === 'auto' && autoPercent !== null
										? theme.colors.accent
										: autoPercent === null
											? theme.colors.textDim
											: theme.colors.textMain,
							}}
							data-testid="agent-card-auto-pct"
							data-highlighted={highlightedStat === 'auto' ? 'true' : undefined}
							title={
								autoPercent === null
									? 'No recorded queries'
									: `${autoPercent}% of queries from Auto Run / Cue`
							}
						>
							{autoPercent === null ? EMPTY_AUTO_PERCENT_LABEL : `${autoPercent}%`}
						</span>
					</div>
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
	/** Aggregated stats used for per-session query counts and sparklines */
	data: StatsAggregation;
	/** Current theme for color-aware styling */
	theme: Theme;
	/**
	 * Active dashboard drill-down filter key. When set, the matching session
	 * card(s) render with a 2px accent border so the selection is visible at
	 * the top of the dashboard. `null` means no filter is active.
	 */
	activeFilterKey?: string | null;
	/** Click handler for the per-card "view stats" icon, opens the per-agent
	 *  stats sub-modal. When omitted, the icon is not rendered. */
	onShowAgentDetails?: (session: Session) => void;
}

export const AgentOverviewCards = memo(function AgentOverviewCards({
	sessions,
	data,
	theme,
	activeFilterKey = null,
	onShowAgentDetails,
}: AgentOverviewCardsProps) {
	const [sortMode, setSortMode] = useState<SortMode>('name');

	// Terminal sessions aren't "agents". Exclude them so the card row
	// matches the agent count shown elsewhere in the dashboard. Default sort
	// is alphabetical (ascending), ignoring any leading emoji prefix to match
	// how the Left Bar's session list orders names; the user can switch to
	// query or tab count (descending) via the sort control above the grid.
	const activeSessions = useMemo(() => {
		return sortAgentOverviewSessions(sessions, data, sortMode);
	}, [sessions, data, sortMode]);

	if (activeSessions.length === 0) return null;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-end gap-2">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Sort by:
				</span>
				<div
					className="flex rounded overflow-hidden border"
					style={{ borderColor: theme.colors.border }}
					role="radiogroup"
					aria-label="Sort agents"
					data-testid="agent-overview-sort"
				>
					{AGENT_OVERVIEW_SORT_OPTIONS.map((opt, i) => {
						const isActive = sortMode === opt.value;
						return (
							<button
								key={opt.value}
								type="button"
								onClick={() => setSortMode(opt.value)}
								className="px-2 py-1 text-xs transition-colors"
								style={{
									backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
									color: isActive ? theme.colors.accent : theme.colors.textDim,
									borderLeft: i === 0 ? undefined : `1px solid ${theme.colors.border}`,
								}}
								aria-pressed={isActive}
								data-testid={`agent-overview-sort-${opt.value}`}
							>
								{opt.label}
							</button>
						);
					})}
				</div>
			</div>
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
						visibleSessions={activeSessions}
						highlightedStat={sortMode === 'name' ? null : sortMode}
						onShowDetails={onShowAgentDetails}
					/>
				))}
			</div>
		</div>
	);
});

export default AgentOverviewCards;

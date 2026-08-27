/**
 * AgentOverviewCards
 *
 * Top-of-dashboard grid showing one compact card per active agent
 * (excluding internal terminal sessions). Each card surfaces the agent
 * name, live status dot, query count, and a 7-day activity sparkline.
 *
 * Worktree children render with a dashed accent border, a "WT" badge,
 * and their checked-out branch - so a parent and its worktrees are
 * visually distinguishable at a glance.
 *
 * A fuzzy filter above the grid narrows the cards live as the user types,
 * matching on the agent name (with or without its leading emoji) and on a
 * worktree's branch name.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { stripLeadingEmojis } from '../../../shared/emojiUtils';
import { formatAgeShort } from '../../../shared/formatters';
import { fuzzyMatchWithScore } from '../../utils/search';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { EscCloseButton } from '../ui/EscCloseButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { EntityTile } from './EntityTile';
import {
	AGENT_OVERVIEW_SORT_OPTIONS,
	buildSessionSparkline,
	getSessionAutoPercent,
	getSessionLastQueryAt,
	getSessionQueryCount,
	getStatusColor,
	isSessionHighlighted,
	sortAgentOverviewSessions,
	type SortMode,
} from './agentOverviewUtils';

/** Per-card stat we should visually emphasize. Mirrors `SortMode` minus `name`
 *  (the default sort has no per-card highlight). */
type HighlightedStat = 'created' | 'recent' | 'queries' | 'tabs' | 'auto' | null;

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
	const isClickable = Boolean(onShowDetails);

	const { queryCount, sparklineData, autoPercent, lastQueryAt } = useMemo(() => {
		const sessionByDay = data.bySessionByDay?.[session.id];
		const sparkline = buildSessionSparkline(sessionByDay);
		return {
			queryCount: getSessionQueryCount(session, data, visibleSessions),
			sparklineData: sparkline,
			autoPercent: getSessionAutoPercent(session, data),
			lastQueryAt: getSessionLastQueryAt(session, data),
		};
	}, [data, session, visibleSessions]);

	const tabCount = session.aiTabs?.length ?? 0;
	const statusColor = getStatusColor(session.state, theme);

	const autoPctLabel = autoPercent === null ? 'no recorded queries' : `${autoPercent}% auto`;

	// The corner badge normally carries the agent's age. Under the Recent sort
	// that number explains nothing about the order, so the badge switches to the
	// last-query time - the value the cards are actually ranked on.
	const showLastQuery = highlightedStat === 'recent';
	const cornerTs = showLastQuery ? lastQueryAt : (session.createdAt ?? null);
	const ageLabel = cornerTs !== null ? formatAgeShort(cornerTs) : undefined;
	const ageTitle =
		cornerTs !== null
			? `${showLastQuery ? 'Last query' : 'Created'} ${new Date(cornerTs).toLocaleString()}`
			: showLastQuery
				? 'No queries in this range'
				: undefined;
	const cornerAriaLabel = ageLabel ? `, ${showLastQuery ? 'last query' : 'age'} ${ageLabel}` : '';
	const baseAriaLabel = `${session.name}, ${session.state}, ${queryCount} ${
		queryCount === 1 ? 'query' : 'queries'
	}, ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}, ${autoPctLabel}${cornerAriaLabel}`;

	return (
		<EntityTile
			theme={theme}
			testId="agent-card"
			title={session.name}
			statusColor={statusColor}
			statusPulsing={session.state === 'busy'}
			age={ageLabel}
			ageTitle={ageTitle}
			ageHighlighted={highlightedStat === 'created' || showLastQuery}
			badges={isWorktree ? [{ label: 'WT', testId: 'agent-card-wt-badge' }] : undefined}
			subtitle={isWorktree ? (session.worktreeBranch ?? undefined) : undefined}
			subtitleTestId="agent-card-branch"
			stats={[
				{
					label: 'Queries',
					value: String(queryCount),
					highlighted: highlightedStat === 'queries',
					testId: 'agent-card-query-count',
				},
				{
					label: 'Tabs',
					value: String(tabCount),
					highlighted: highlightedStat === 'tabs',
					testId: 'agent-card-tab-count',
				},
				{
					label: 'Auto %',
					value: autoPercent === null ? '\u2014' : `${autoPercent}%`,
					highlighted: highlightedStat === 'auto',
					muted: autoPercent === null,
					testId: 'agent-card-auto-pct',
					title:
						autoPercent === null
							? 'No recorded queries'
							: `${autoPercent}% of queries from Auto Run / Cue`,
				},
			]}
			sparkline={sparklineData}
			sparklineColor={isWorktree ? theme.colors.accent : statusColor}
			animationIndex={animationIndex}
			isSelected={isSelected}
			isDashed={isWorktree}
			onClick={onShowDetails ? () => onShowDetails(session) : undefined}
			ariaLabel={isClickable ? `${baseAriaLabel}. View detailed stats.` : baseAriaLabel}
		/>
	);
});

interface AgentOverviewCardsProps {
	/** All known sessions (terminal-only sessions are filtered out) */
	sessions: Session[];
	/** Aggregated stats - used for per-session query counts and sparklines */
	data: StatsAggregation;
	/** Current theme for color-aware styling */
	theme: Theme;
	/**
	 * Active dashboard drill-down filter key. When set, the matching session
	 * card(s) render with a 2px accent border so the selection is visible at
	 * the top of the dashboard. `null` means no filter is active.
	 */
	activeFilterKey?: string | null;
	/** Click handler for the per-card "view stats" icon - opens the per-agent
	 *  stats sub-modal. When omitted, the icon is not rendered. */
	onShowAgentDetails?: (session: Session) => void;
	/**
	 * Narrow the grid to these session ids. Set by the Groups tab drilling into
	 * a group's members. `null`/omitted shows every agent.
	 *
	 * This is a hard restriction rather than a highlight: a group with three
	 * agents is not usefully answered by tinting three cards inside a grid of
	 * ninety. The restriction is always paired with a visible, dismissible chip
	 * - a silently filtered grid reads as missing agents.
	 */
	restrictToSessionIds?: string[] | null;
	/** Label for the restriction chip, e.g. the group's name. */
	restrictionLabel?: string;
	/** Clears the restriction. When omitted the chip renders without a button. */
	onClearRestriction?: () => void;
}

/**
 * Fuzzy-score a session against the filter query. Returns `null` when the
 * session doesn't match at all.
 *
 * Three haystacks are tried and the best score wins:
 *   - the raw name, so an emoji-prefixed agent still matches on its emoji;
 *   - the name with leading emojis stripped, so "ag" matches "🕵️ Agent OSINT"
 *     from the first real letter (the raw name would force the query to skip
 *     past the emoji, which kills the prefix bonus);
 *   - a worktree's branch, discounted so a name match always outranks it.
 */
function scoreSessionForFilter(session: Session, query: string): number | null {
	const nameScore = fuzzyMatchWithScore(session.name, query);
	const strippedName = stripLeadingEmojis(session.name);
	const strippedScore =
		strippedName === session.name ? nameScore : fuzzyMatchWithScore(strippedName, query);

	let best = -1;
	if (nameScore.matches) best = Math.max(best, nameScore.score);
	if (strippedScore.matches) best = Math.max(best, strippedScore.score);

	if (session.worktreeBranch) {
		const branchScore = fuzzyMatchWithScore(session.worktreeBranch, query);
		if (branchScore.matches) best = Math.max(best, branchScore.score / 2);
	}

	return best < 0 ? null : best;
}

export const AgentOverviewCards = memo(function AgentOverviewCards({
	sessions,
	data,
	theme,
	activeFilterKey = null,
	onShowAgentDetails,
	restrictToSessionIds = null,
	restrictionLabel,
	onClearRestriction,
}: AgentOverviewCardsProps) {
	const [sortMode, setSortMode] = useState<SortMode>('name');
	const [filterQuery, setFilterQuery] = useState('');
	const filterInputRef = useRef<HTMLInputElement>(null);

	const clearFilter = useCallback(() => {
		setFilterQuery('');
		filterInputRef.current?.focus();
	}, []);

	// While the filter holds text, it owns Escape: the key clears the box
	// instead of closing the whole dashboard. The layer stack handles Escape on
	// a capture-phase window listener, so an input-local key handler can never
	// win - this has to be a real layer that outranks USAGE_DASHBOARD.
	useModalLayer(MODAL_PRIORITIES.USAGE_DASHBOARD_AGENT_FILTER, undefined, clearFilter, {
		enabled: filterQuery.length > 0,
		focusTrap: 'none',
		blocksLowerLayers: false,
		capturesFocus: false,
	});

	// Terminal sessions aren't "agents" - excluded inside
	// `sortAgentOverviewSessions`, which also owns the ordering so the grid and
	// its sort control can't drift. The group drill-down narrows the input first:
	// restricting before sorting is what keeps the query-count ranking relative
	// to the agents actually on screen rather than to the whole fleet.
	const activeSessions = useMemo(() => {
		const allowed = restrictToSessionIds ? new Set(restrictToSessionIds) : null;
		const scoped = allowed ? sessions.filter((session) => allowed.has(session.id)) : sessions;
		return sortAgentOverviewSessions(scoped, data, sortMode);
	}, [sessions, data, sortMode, restrictToSessionIds]);

	// Live fuzzy filter. With the default Name sort we re-rank by match score so
	// the best hit lands first; an explicit sort (Queries, Tabs, ...) is the
	// user's stated order and survives filtering untouched.
	const filteredSessions = useMemo(() => {
		const query = filterQuery.trim();
		if (!query) return activeSessions;

		const scored = activeSessions
			.map((session) => ({ session, score: scoreSessionForFilter(session, query) }))
			.filter((entry): entry is { session: Session; score: number } => entry.score !== null);

		if (sortMode === 'name') {
			scored.sort((a, b) => b.score - a.score);
		}
		return scored.map((entry) => entry.session);
	}, [activeSessions, filterQuery, sortMode]);

	// A restriction that matches nothing must still render, otherwise the tab
	// goes blank with no visible reason and no way back to the full grid.
	const isRestricted = Boolean(restrictToSessionIds);
	if (activeSessions.length === 0 && !isRestricted) return null;

	return (
		<div className="flex flex-col gap-3">
			{isRestricted && (
				<div
					className="flex items-center gap-2 text-xs px-2 py-1 rounded self-start"
					style={{
						backgroundColor: `${theme.colors.accent}18`,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.accent}55`,
					}}
					data-testid="agent-overview-restriction"
					role="status"
				>
					<span className="truncate">
						Showing {restrictionLabel ?? 'selected agents'} ({activeSessions.length})
					</span>
					{onClearRestriction && (
						<button
							type="button"
							onClick={onClearRestriction}
							className="font-medium underline underline-offset-2"
							style={{ color: theme.colors.accent }}
							data-testid="agent-overview-restriction-clear"
						>
							Show all agents
						</button>
					)}
				</div>
			)}
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-2 min-w-0">
					<div className="relative flex items-center" style={{ width: 260, maxWidth: '100%' }}>
						<Search
							className="absolute left-2 w-3.5 h-3.5 pointer-events-none"
							style={{ color: filterQuery ? theme.colors.accent : theme.colors.textDim }}
							aria-hidden="true"
						/>
						<input
							ref={filterInputRef}
							type="text"
							value={filterQuery}
							onChange={(e) => setFilterQuery(e.target.value)}
							placeholder="Filter agents..."
							className="w-full rounded border bg-transparent outline-none text-xs py-1 pl-7"
							style={{
								borderColor: filterQuery ? theme.colors.accent : theme.colors.border,
								color: theme.colors.textMain,
								paddingRight: filterQuery ? 52 : 8,
							}}
							aria-label="Filter agents"
							data-testid="agent-overview-filter-input"
						/>
						{filterQuery && (
							<EscCloseButton
								theme={theme}
								variant="adornment"
								label="Clear filter (Esc)"
								onClose={clearFilter}
								testId="agent-overview-filter-clear"
							/>
						)}
					</div>
					{filterQuery && (
						<span
							className="text-xs tabular-nums whitespace-nowrap"
							style={{ color: theme.colors.textDim }}
							data-testid="agent-overview-filter-count"
						>
							{filteredSessions.length} of {activeSessions.length}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Sort by:
					</span>
					<SegmentedControl
						value={sortMode}
						onChange={setSortMode}
						options={AGENT_OVERVIEW_SORT_OPTIONS}
						theme={theme}
						ariaLabel="Sort agents"
						testId="agent-overview-sort"
					/>
				</div>
			</div>
			{activeSessions.length === 0 ? (
				<div
					className="py-8 text-center text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="agent-overview-restriction-empty"
					role="status"
				>
					{restrictionLabel ? `${restrictionLabel} has no agents.` : 'No agents to show.'}
				</div>
			) : filteredSessions.length === 0 ? (
				<div
					className="py-8 text-center text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="agent-overview-no-matches"
					role="status"
				>
					No agents match &ldquo;{filterQuery.trim()}&rdquo;
				</div>
			) : (
				<div
					className="grid gap-3"
					style={{
						gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
					}}
					data-testid="agent-overview-cards"
					role="region"
					aria-label="Active agents overview"
				>
					{filteredSessions.map((session, index) => (
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
			)}
		</div>
	);
});

export default AgentOverviewCards;

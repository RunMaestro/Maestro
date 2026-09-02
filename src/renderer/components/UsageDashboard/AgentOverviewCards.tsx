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
 * worktree's branch name. An "Active only" toggle beside it drops every agent
 * that recorded no work inside the dashboard's selected time range, so a
 * hundred-agent install can be cut down to what was actually used this month
 * (or this year, following the range picker).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Search } from 'lucide-react';
import type { Session, SessionState, Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { compareNamesIgnoringEmojis, stripLeadingEmojis } from '../../../shared/emojiUtils';
import { formatAgeShort } from '../../../shared/formatters';
import { fuzzyMatchWithScore } from '../../utils/search';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { EscCloseButton } from '../ui/EscCloseButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { ThemedSelect, type ThemedSelectOption } from '../shared/ThemedSelect';
import { UNGROUPED_ID, UNGROUPED_NAME, type GroupLike } from '../../../shared/statsGroupRollup';
import { isAgentActiveInRange } from '../../../shared/statsActiveAgents';
import { EntityTile } from './EntityTile';

/** Dropdown value meaning "do not narrow by group". */
const ALL_GROUPS_VALUE = '__all__';

const EMPTY_GROUPS: GroupLike[] = [];

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
 * Resolve the query count shown on a session's card. Prefers the per-session
 * breakdown when available; otherwise falls back to the provider-level total
 * - but only when this is the sole visible session for that provider. With
 * multiple sessions sharing a provider, the provider total can't be safely
 * attributed to any single one, so we show 0 instead of overstating each card.
 * Shared between the parent (for sort order) and `AgentCard` (for display) so
 * both stay in sync.
 */
function getSessionQueryCount(
	session: Session,
	data: StatsAggregation,
	visibleSessions?: Session[]
): number {
	const sessionByDay = data.bySessionByDay?.[session.id];
	if (sessionByDay && sessionByDay.length > 0) {
		return sessionByDay.reduce((sum, d) => sum + d.count, 0);
	}
	if (visibleSessions) {
		const sameProviderCount = visibleSessions.filter((s) => s.toolType === session.toolType).length;
		if (sameProviderCount !== 1) return 0;
	}
	return data.byAgent?.[session.toolType]?.count ?? 0;
}

/**
 * Auto-sourced query share for a session, as a 0-100 integer. `null` means
 * the session has no recorded queries - sort and display fall back to a dim
 * em-dash rather than a misleading 0%.
 */
function getSessionAutoPercent(session: Session, data: StatsAggregation): number | null {
	const split = data.bySessionSource?.[session.id];
	if (!split) return null;
	const total = split.user + split.auto;
	if (total <= 0) return null;
	return Math.round((split.auto / total) * 100);
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
 * - for provider-shaped keys - the session's `toolType`, separating worktree
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

/** Per-card stat we should visually emphasize. Mirrors `SortMode` minus `name`
 *  (the default sort has no per-card highlight). */
type HighlightedStat = 'created' | 'queries' | 'tabs' | 'auto' | null;

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
	const statusColor = getStatusColor(session.state, theme);

	const autoPctLabel = autoPercent === null ? 'no recorded queries' : `${autoPercent}% auto`;
	const ageLabel = session.createdAt ? formatAgeShort(session.createdAt) : undefined;
	const ageTitle = session.createdAt
		? `Created ${new Date(session.createdAt).toLocaleString()}`
		: undefined;
	const baseAriaLabel = `${session.name}, ${session.state}, ${queryCount} ${
		queryCount === 1 ? 'query' : 'queries'
	}, ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}, ${autoPctLabel}${
		ageLabel ? `, age ${ageLabel}` : ''
	}`;

	return (
		<EntityTile
			theme={theme}
			testId="agent-card"
			title={session.name}
			statusColor={statusColor}
			statusPulsing={session.state === 'busy'}
			age={ageLabel}
			ageTitle={ageTitle}
			ageHighlighted={highlightedStat === 'created'}
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
	 * Left Bar groups, used to populate the group filter dropdown. Omit (or pass
	 * an empty array) and the dropdown is not rendered at all - a filter with
	 * one option is a control that can only do nothing.
	 */
	groups?: GroupLike[];
}

type SortMode = 'name' | 'created' | 'queries' | 'tabs' | 'auto';

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

const SORT_OPTIONS: SegmentedOption<SortMode>[] = [
	{ value: 'name', label: 'Name' },
	{ value: 'created', label: 'Created' },
	{ value: 'queries', label: 'Queries' },
	{ value: 'tabs', label: 'Tabs' },
	{ value: 'auto', label: 'Auto %' },
];

export const AgentOverviewCards = memo(function AgentOverviewCards({
	sessions,
	data,
	theme,
	activeFilterKey = null,
	onShowAgentDetails,
	groups = EMPTY_GROUPS,
}: AgentOverviewCardsProps) {
	const [sortMode, setSortMode] = useState<SortMode>('name');
	const [filterQuery, setFilterQuery] = useState('');
	// Narrow the grid to agents that did something inside the selected range.
	// Off by default: the grid's job is still "every agent I have".
	const [activeOnly, setActiveOnly] = useState(false);
	// Which group the grid is narrowed to. ALL_GROUPS_VALUE means no narrowing;
	// UNGROUPED_ID is the agents filed under no group.
	const [groupFilter, setGroupFilter] = useState<string>(ALL_GROUPS_VALUE);

	// Only groups that actually hold an agent are offered, plus Ungrouped when
	// any agent is unfiled. An option that can only ever produce an empty grid
	// is a dead end the user has to back out of.
	const groupOptions = useMemo((): ThemedSelectOption[] => {
		const agents = sessions.filter((s) => s.toolType !== 'terminal');
		const liveGroupIds = new Set(groups.map((g) => g.id));
		const populated = new Set<string>();
		for (const agent of agents) {
			populated.add(
				agent.groupId && liveGroupIds.has(agent.groupId) ? agent.groupId : UNGROUPED_ID
			);
		}

		const options: ThemedSelectOption[] = [{ value: ALL_GROUPS_VALUE, label: 'All groups' }];
		for (const group of groups) {
			if (!populated.has(group.id)) continue;
			options.push({
				value: group.id,
				label: group.emoji ? `${group.emoji} ${group.name}` : group.name,
			});
		}
		if (populated.has(UNGROUPED_ID)) {
			options.push({ value: UNGROUPED_ID, label: UNGROUPED_NAME });
		}
		return options;
	}, [groups, sessions]);

	// A group emptied or deleted while its filter was active would otherwise
	// strand the grid on a selection with no option behind it, showing nothing.
	useEffect(() => {
		if (!groupOptions.some((o) => o.value === groupFilter)) {
			setGroupFilter(ALL_GROUPS_VALUE);
		}
	}, [groupOptions, groupFilter]);
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

	// Terminal sessions aren't "agents" - exclude them so the card row
	// matches the agent count shown elsewhere in the dashboard. Default sort
	// is alphabetical (ascending), ignoring any leading emoji prefix to match
	// how the Left Bar's session list orders names; the user can switch to
	// query or tab count (descending) via the sort control above the grid.
	const activeSessions = useMemo(() => {
		// A groupId pointing at a deleted group counts as ungrouped, matching how
		// the Left Bar and the group rollup both treat a dangling pointer - an
		// agent must never become unreachable from every filter option.
		const liveGroupIds = new Set(groups.map((g) => g.id));
		const matchesGroup = (s: Session) => {
			if (groupFilter === ALL_GROUPS_VALUE) return true;
			const resolved = s.groupId && liveGroupIds.has(s.groupId) ? s.groupId : UNGROUPED_ID;
			return resolved === groupFilter;
		};
		const filtered = sessions.filter(
			(s) =>
				s.toolType !== 'terminal' &&
				matchesGroup(s) &&
				(!activeOnly || isAgentActiveInRange(s.id, data.bySessionByDay))
		);
		const byName = (a: Session, b: Session) => compareNamesIgnoringEmojis(a.name, b.name);

		if (sortMode === 'name') {
			return filtered.slice().sort(byName);
		}

		// Pre-sort alphabetically so equal counts fall back to a stable, scannable order.
		const alphabetical = filtered.slice().sort(byName);

		if (sortMode === 'created') {
			// Most-recent-first. Sessions missing `createdAt` (legacy data) sink
			// to the bottom rather than masquerading as the newest agent.
			return alphabetical.slice().sort((a, b) => {
				const aTs = a.createdAt ?? 0;
				const bTs = b.createdAt ?? 0;
				return bTs - aTs;
			});
		}

		if (sortMode === 'queries') {
			return alphabetical
				.slice()
				.sort(
					(a, b) =>
						getSessionQueryCount(b, data, alphabetical) -
						getSessionQueryCount(a, data, alphabetical)
				);
		}

		if (sortMode === 'tabs') {
			return alphabetical.slice().sort((a, b) => (b.aiTabs?.length ?? 0) - (a.aiTabs?.length ?? 0));
		}

		// 'auto' - descending by auto %, sessions with no recorded queries
		// sink to the bottom so the leaderboard isn't polluted by null cards.
		return alphabetical.slice().sort((a, b) => {
			const aPct = getSessionAutoPercent(a, data);
			const bPct = getSessionAutoPercent(b, data);
			if (aPct === null && bPct === null) return 0;
			if (aPct === null) return 1;
			if (bPct === null) return -1;
			return bPct - aPct;
		});
	}, [sessions, data, sortMode, groupFilter, groups, activeOnly]);

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

	// The dropdown earns its place only once a REAL group is on offer. With no
	// groups configured the options collapse to "All groups" and "Ungrouped",
	// which render the identical grid - a control whose every choice is a no-op.
	const hasGroupChoice = groupOptions.some(
		(o) => o.value !== ALL_GROUPS_VALUE && o.value !== UNGROUPED_ID
	);
	const isGroupFiltered = groupFilter !== ALL_GROUPS_VALUE;
	// A group or active-only filter that matches nothing must still render the
	// toolbar, otherwise the tab goes blank with no visible reason and no way
	// back to the control that emptied it.
	if (activeSessions.length === 0 && !isGroupFiltered && !activeOnly) return null;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-2 min-w-0">
					{hasGroupChoice && (
						<ThemedSelect
							value={groupFilter}
							options={groupOptions}
							onChange={setGroupFilter}
							theme={theme}
							style={{ width: 200 }}
							aria-label="Filter agents by group"
							// Long group lists are the normal case for anyone using
							// groups per client, so the menu carries its own search.
							filterable={groupOptions.length > 8}
							filterPlaceholder="Filter groups…"
						/>
					)}
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
					<button
						type="button"
						role="switch"
						aria-checked={activeOnly}
						onClick={() => setActiveOnly((v) => !v)}
						title="Show only agents that ran a query in the selected time range"
						className="flex items-center gap-1.5 px-2 py-1 rounded border text-xs whitespace-nowrap transition-colors"
						style={{
							borderColor: activeOnly ? theme.colors.accent : theme.colors.border,
							backgroundColor: activeOnly ? `${theme.colors.accent}20` : 'transparent',
							color: activeOnly ? theme.colors.accent : theme.colors.textDim,
						}}
						data-testid="agent-overview-active-only"
					>
						<Activity className="w-3 h-3" aria-hidden="true" />
						Active only
					</button>
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
						options={SORT_OPTIONS}
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
					data-testid="agent-overview-group-empty"
					role="status"
				>
					{activeOnly
						? isGroupFiltered
							? `No agents in ${groupOptions.find((o) => o.value === groupFilter)?.label ?? 'this group'} ran a query in this time range.`
							: 'No agents ran a query in this time range.'
						: `${groupOptions.find((o) => o.value === groupFilter)?.label ?? 'This group'} has no agents.`}
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

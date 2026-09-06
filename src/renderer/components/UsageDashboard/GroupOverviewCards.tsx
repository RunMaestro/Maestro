/**
 * GroupOverviewCards
 *
 * The Usage Dashboard's group grid: one tile per Left Bar group, rolling every
 * member agent's queries, active time, auto share, tokens, and cost into a
 * single number. Bundle a client's agents into a group and this answers what
 * that client cost.
 *
 * Agents filed under no group land in a synthetic "Ungrouped" tile rather than
 * being dropped, so the tiles still add up to the totals the rest of the
 * dashboard shows. An empty group is omitted - the user can already see it in
 * the Left Bar, and a row of zeroes is noise here.
 *
 * Cost and tokens only exist for turns recorded after the stats DB grew its
 * token columns, so a tile whose priced-query count is short of its query count
 * says so in the tooltip instead of presenting a partial total as complete.
 *
 * Clicking a tile reports the group up so the dashboard can drill into its
 * members; the arithmetic itself lives in `shared/statsGroupRollup` so it can
 * be unit-tested without a store and reused outside the renderer.
 */

import { memo, useMemo, useState } from 'react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { GroupLike, GroupStatRollup } from '../../../shared/statsGroupRollup';
import { rollUpGroupStats, totalTokens } from '../../../shared/statsGroupRollup';
import { formatCost, formatNumber, formatTokensCompact } from '../../../shared/formatters';
import { formatDurationHuman } from '../../../shared/duration';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { FilterInput } from '../ui/FilterInput';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { buildGroupsSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';
import { EntityTile, type EntityTileStat } from './EntityTile';

const SPARKLINE_DAYS = 14;
const EM_DASH = '—';

type SortMode = 'name' | 'queries' | 'duration' | 'cost' | 'agents';

const SORT_OPTIONS: SegmentedOption<SortMode>[] = [
	{ value: 'name', label: 'Name' },
	{ value: 'queries', label: 'Queries' },
	{ value: 'duration', label: 'Time' },
	{ value: 'cost', label: 'Cost' },
	{ value: 'agents', label: 'Agents' },
];

/**
 * Last `SPARKLINE_DAYS` daily counts, oldest to newest, left-padded with zeros
 * so every tile's sparkline has the same geometry regardless of how long the
 * group has existed.
 */
function buildGroupSparkline(byDay: GroupStatRollup['byDay']): number[] {
	const counts = byDay.slice(-SPARKLINE_DAYS).map((d) => d.count);
	if (counts.length >= SPARKLINE_DAYS) return counts;
	return [...new Array(SPARKLINE_DAYS - counts.length).fill(0), ...counts];
}

/**
 * Explain how complete a group's cost figure is.
 *
 * `pricedQueries` counts rows that actually carried token data. Everything
 * recorded before the token columns landed reports none, so a long-lived group
 * can show thousands of queries against a handful of priced ones. Saying so is
 * the difference between a number the user can trust and one that quietly
 * understates their spend by an order of magnitude.
 */
function buildCoverageNote(rollup: GroupStatRollup): string {
	const { pricedQueries } = rollup.tokens;
	if (pricedQueries === 0) {
		return 'No token data recorded for this group yet. Cost tracking starts with turns recorded after the upgrade.';
	}
	if (pricedQueries >= rollup.queries) {
		return `Covers all ${formatNumber(rollup.queries)} recorded ${
			rollup.queries === 1 ? 'query' : 'queries'
		}.`;
	}
	return `Covers ${formatNumber(pricedQueries)} of ${formatNumber(
		rollup.queries
	)} queries - turns recorded before token tracking report no usage.`;
}

interface GroupCardProps {
	rollup: GroupStatRollup;
	theme: Theme;
	animationIndex: number;
	isSelected: boolean;
	highlightedStat: SortMode | null;
	onSelect?: (rollup: GroupStatRollup) => void;
}

const GroupCard = memo(function GroupCard({
	rollup,
	theme,
	animationIndex,
	isSelected,
	highlightedStat,
	onSelect,
}: GroupCardProps) {
	const tokens = totalTokens(rollup.tokens);
	const hasUsage = rollup.tokens.pricedQueries > 0;
	const coverageNote = buildCoverageNote(rollup);
	const sparkline = useMemo(() => buildGroupSparkline(rollup.byDay), [rollup.byDay]);

	// Providers are the group's real composition - "which agents are in here"
	// matters more than any single one's name, and the member list is already a
	// click away.
	const providerLabel = rollup.providers.map((p) => getAgentDisplayName(p)).join(', ');

	const stats: EntityTileStat[] = [
		{
			label: 'Queries',
			value: formatNumber(rollup.queries),
			highlighted: highlightedStat === 'queries',
			testId: 'group-card-queries',
		},
		{
			label: 'Time',
			value: rollup.duration > 0 ? formatDurationHuman(rollup.duration) : EM_DASH,
			muted: rollup.duration === 0,
			highlighted: highlightedStat === 'duration',
			title: 'Total agent run time across the group',
			testId: 'group-card-duration',
		},
		{
			label: 'Tokens',
			value: hasUsage ? formatTokensCompact(tokens) : EM_DASH,
			muted: !hasUsage,
			title: hasUsage
				? `${formatNumber(rollup.tokens.inputTokens)} in / ${formatNumber(
						rollup.tokens.outputTokens
					)} out / ${formatNumber(
						rollup.tokens.cacheReadTokens + rollup.tokens.cacheCreationTokens
					)} cache. ${coverageNote}`
				: coverageNote,
			testId: 'group-card-tokens',
		},
		{
			label: 'Cost',
			value: hasUsage ? formatCost(rollup.tokens.costUsd) : EM_DASH,
			muted: !hasUsage,
			highlighted: highlightedStat === 'cost',
			title: coverageNote,
			testId: 'group-card-cost',
		},
	];

	const agentsLabel = `${rollup.memberCount} ${rollup.memberCount === 1 ? 'agent' : 'agents'}`;
	const autoLabel =
		rollup.autoPercent === null ? 'no recorded queries' : `${rollup.autoPercent}% auto`;

	return (
		<EntityTile
			theme={theme}
			testId="group-card"
			title={rollup.emoji ? `${rollup.emoji} ${rollup.name}` : rollup.name}
			// A group has no live state of its own, so the dot would be a
			// meaningless decoration - omit it rather than invent a color.
			age={agentsLabel}
			ageTitle={`${agentsLabel} in this group`}
			ageHighlighted={highlightedStat === 'agents'}
			badges={
				rollup.autoPercent !== null
					? [
							{
								label: `${rollup.autoPercent}% auto`,
								title: `${autoLabel} (Auto Run / Cue)`,
								testId: 'group-card-auto-badge',
							},
						]
					: undefined
			}
			subtitle={providerLabel || undefined}
			subtitleTestId="group-card-providers"
			stats={stats}
			sparkline={sparkline}
			animationIndex={animationIndex}
			size="lg"
			isSelected={isSelected}
			// The Ungrouped bucket is not a real group the user created, so it
			// carries the same dashed treatment worktree agents get.
			isDashed={rollup.isUngrouped}
			onClick={onSelect ? () => onSelect(rollup) : undefined}
			ariaLabel={`${rollup.name}, ${agentsLabel}, ${formatNumber(rollup.queries)} ${
				rollup.queries === 1 ? 'query' : 'queries'
			}, ${autoLabel}${hasUsage ? `, ${formatCost(rollup.tokens.costUsd)}` : ''}`}
		/>
	);
});

export interface GroupOverviewCardsProps {
	/** Left Bar groups, in their stored order. */
	groups: GroupLike[];
	/** All known sessions. Terminal sessions are excluded here, not by the caller. */
	sessions: Session[];
	data: StatsAggregation;
	theme: Theme;
	/** Group id whose tile should render selected. */
	activeGroupId?: string | null;
	/** Fired when a tile is clicked - the dashboard drills into the members. */
	onSelectGroup?: (rollup: GroupStatRollup) => void;
}

export const GroupOverviewCards = memo(function GroupOverviewCards({
	groups,
	sessions,
	data,
	theme,
	activeGroupId = null,
	onSelectGroup,
}: GroupOverviewCardsProps) {
	const [sortMode, setSortMode] = useState<SortMode>('queries');
	const [filterQuery, setFilterQuery] = useState('');

	const rollups = useMemo(() => {
		// Terminal sessions aren't agents; excluding them here keeps the group
		// member counts consistent with the Agents tab.
		const agents = sessions.filter((s) => s.toolType !== 'terminal');
		return rollUpGroupStats(groups, agents, data);
	}, [groups, sessions, data]);

	const sorted = useMemo(() => {
		const byName = (a: GroupStatRollup, b: GroupStatRollup) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
		// Alphabetical first so ties inside any other sort stay scannable.
		const alphabetical = rollups.slice().sort(byName);

		const ordered =
			sortMode === 'name'
				? alphabetical
				: sortMode === 'queries'
					? alphabetical.slice().sort((a, b) => b.queries - a.queries)
					: sortMode === 'duration'
						? alphabetical.slice().sort((a, b) => b.duration - a.duration)
						: sortMode === 'agents'
							? alphabetical.slice().sort((a, b) => b.memberCount - a.memberCount)
							: alphabetical.slice().sort((a, b) => b.tokens.costUsd - a.tokens.costUsd);

		// Ungrouped is a leftovers bucket, not a peer - it sinks to the end
		// whatever the sort, so a big pile of unfiled agents can't top the board.
		return [...ordered.filter((r) => !r.isUngrouped), ...ordered.filter((r) => r.isUngrouped)];
	}, [rollups, sortMode]);

	const filtered = useMemo(() => {
		const query = filterQuery.trim().toLowerCase();
		if (!query) return sorted;
		return sorted.filter(
			(rollup) =>
				rollup.name.toLowerCase().includes(query) ||
				rollup.sessions.some((s) => s.name.toLowerCase().includes(query))
		);
	}, [sorted, filterQuery]);

	// Ungrouped is a leftovers bucket, not a group, so it is excluded from both
	// counts and reported separately - "23 agents unfiled" is the actionable
	// half of this tab, and folding it into the group total would hide it.
	const footerCounts = useMemo(() => {
		const real = rollups.filter((r) => !r.isUngrouped).length;
		const visible = filtered.filter((r) => !r.isUngrouped).length;
		const unfiled = rollups.find((r) => r.isUngrouped)?.memberCount ?? 0;
		return { real, visible, unfiled };
	}, [rollups, filtered]);
	usePublishFooterSummary(
		'groups',
		buildGroupsSummary(footerCounts.visible, footerCounts.real, footerCounts.unfiled)
	);

	if (rollups.length === 0) {
		return (
			<div
				className="p-6 rounded-lg text-center text-sm"
				style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
				data-testid="group-overview-empty"
			>
				No groups yet. Group agents in the Left Bar to see per-group usage here.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<FilterInput
					theme={theme}
					value={filterQuery}
					onChange={setFilterQuery}
					placeholder="Filter groups..."
					ariaLabel="Filter groups"
					resultLabel={filterQuery ? `${filtered.length} of ${sorted.length}` : undefined}
					width={240}
				/>
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Sort by:
					</span>
					<SegmentedControl
						value={sortMode}
						onChange={setSortMode}
						options={SORT_OPTIONS}
						theme={theme}
						ariaLabel="Sort groups"
						testId="group-overview-sort"
					/>
				</div>
			</div>
			{filtered.length === 0 ? (
				<div
					className="py-8 text-center text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="group-overview-no-matches"
					role="status"
				>
					No groups match &ldquo;{filterQuery.trim()}&rdquo;
				</div>
			) : (
				<div
					className="grid gap-3"
					// Twice the agent grid's 220px. A group tile is larger than the
					// agents it contains, and it carries four stats whose values are
					// the long ones - "142h 5m", "220.7M", "$187.18" - so the width
					// buys legible numbers rather than whitespace. Trading a column
					// for extra rows is the right way round here: the grid scrolls
					// vertically, so a row costs nothing a clipped value does not.
					style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))' }}
					data-testid="group-overview-cards"
					role="region"
					aria-label="Group usage overview"
				>
					{filtered.map((rollup, index) => (
						<GroupCard
							key={rollup.groupId}
							rollup={rollup}
							theme={theme}
							animationIndex={index}
							isSelected={rollup.groupId === activeGroupId}
							highlightedStat={sortMode === 'name' ? null : sortMode}
							onSelect={onSelectGroup}
						/>
					))}
				</div>
			)}
		</div>
	);
});

export default GroupOverviewCards;

/**
 * GroupOverviewCards
 *
 * The Usage Dashboard's group grid: one tile per Left Bar group, rolling every
 * member agent's queries, active time, auto share, tokens, and cost into a
 * single number. Bundle a client's agents into a group and this answers what
 * that client cost.
 *
 * Agents filed under no group land in a synthetic "Ungrouped" tile rather than
 * being dropped, and queries from agents that have since been deleted land in a
 * synthetic "Deleted agents" tile (they can no longer be attributed to a
 * group), so the tiles add up to the range's totals on the Overview. An empty
 * group is omitted - the user can already see it in the Left Bar, and a row of
 * zeroes is noise here.
 *
 * Cost and tokens only exist for turns recorded after the stats DB grew its
 * token columns, so a tile whose priced-query count is short of its query count
 * says so in the tooltip instead of presenting a partial total as complete.
 *
 * Clicking a tile reports the group up so the dashboard can drill into its
 * members (the Deleted agents tile has no live members, so it is not
 * clickable); the arithmetic itself lives in `shared/statsGroupRollup` so it can
 * be unit-tested without a store and reused outside the renderer.
 */

import { memo, useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { Session, Theme } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { GroupLike, GroupStatRollup } from '../../../shared/statsGroupRollup';
import { rollUpGroupStats, totalTokens } from '../../../shared/statsGroupRollup';
import {
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatTokensCompact,
} from '../../../shared/formatters';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { FilterInput } from '../ui/FilterInput';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { buildGroupsSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';
import { EntityTile, type EntityTileStat } from './EntityTile';
import { useScalePreference } from '../../hooks/ui/useScalePreference';
import { useScaleShortcuts } from '../../hooks/ui/useScaleShortcuts';
import { useIsTopLayer } from '../../hooks/ui/useIsTopLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { ScaleControl } from '../ui/ScaleControl';
import {
	GROUP_TILE_MIN_WIDTH,
	GROUP_TILE_SCALE_KEY,
	TILE_SCALE_RANGE,
	tileGridColumns,
} from './tileScale';
import { usageCoverageNote } from './usageCoverage';
import { buildCalendarSparkline } from './agentOverviewUtils';

/** Days behind a group tile's sparkline. */
const GROUP_SPARKLINE_DAYS = 14;
/** Placeholder for a value that is absent rather than zero. */
const NO_VALUE = '-';

type SortMode = 'name' | 'queries' | 'duration' | 'cost' | 'agents';

const SORT_OPTIONS: SegmentedOption<SortMode>[] = [
	{ value: 'name', label: 'Name' },
	{ value: 'queries', label: 'Queries' },
	{ value: 'duration', label: 'Time' },
	{ value: 'cost', label: 'Cost' },
	{ value: 'agents', label: 'Agents' },
];

interface GroupCardProps {
	rollup: GroupStatRollup;
	/** The aggregation's calendar window, so the sparkline ends today. */
	dayWindow: StatsAggregation['window'];
	theme: Theme;
	animationIndex: number;
	isSelected: boolean;
	highlightedStat: SortMode | null;
	onSelect?: (rollup: GroupStatRollup) => void;
}

const GroupCard = memo(function GroupCard({
	rollup,
	dayWindow,
	theme,
	animationIndex,
	isSelected,
	highlightedStat,
	onSelect,
}: GroupCardProps) {
	const tokens = totalTokens(rollup.tokens);
	const hasUsage = rollup.tokens.pricedQueries > 0;
	const coverageNote = usageCoverageNote(rollup.tokens.pricedQueries, rollup.queries);
	const sparkline = useMemo(
		() => buildCalendarSparkline(rollup.byDay, dayWindow, GROUP_SPARKLINE_DAYS),
		[rollup.byDay, dayWindow]
	);

	// Providers are the group's real composition - "which agents are in here"
	// matters more than any single one's name, and the member list is already a
	// click away.
	const providerLabel = rollup.isDeleted
		? 'Agents deleted since they ran'
		: rollup.providers.map((p) => getAgentDisplayName(p)).join(', ');

	const stats: EntityTileStat[] = [
		{
			label: 'Queries',
			value: formatNumber(rollup.queries),
			highlighted: highlightedStat === 'queries',
			testId: 'group-card-queries',
		},
		{
			label: 'Time',
			value: rollup.duration > 0 ? formatDurationHuman(rollup.duration) : NO_VALUE,
			muted: rollup.duration === 0,
			highlighted: highlightedStat === 'duration',
			title: 'Total agent time across the group',
			testId: 'group-card-duration',
		},
		{
			label: 'Tokens',
			value: hasUsage ? formatTokensCompact(tokens) : NO_VALUE,
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
			value: hasUsage ? formatCost(rollup.tokens.costUsd) : NO_VALUE,
			muted: !hasUsage,
			highlighted: highlightedStat === 'cost',
			title: coverageNote,
			testId: 'group-card-cost',
		},
	];

	const agentsLabel = `${formatNumber(rollup.memberCount)} ${
		rollup.memberCount === 1 ? 'agent' : 'agents'
	}`;
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
			ageTitle={
				rollup.isDeleted ? `${agentsLabel} deleted since they ran` : `${agentsLabel} in this group`
			}
			ageHighlighted={highlightedStat === 'agents'}
			badges={
				rollup.autoPercent !== null
					? [
							{
								label: `${rollup.autoPercent}% auto`,
								title: `${autoLabel} (Auto Run)`,
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
			// The Ungrouped and Deleted agents buckets are not real groups the user
			// created, so they carry the same dashed treatment worktree agents get.
			isDashed={rollup.isUngrouped || rollup.isDeleted}
			// The deleted bucket has no live agents to break down.
			onClick={onSelect && !rollup.isDeleted ? () => onSelect(rollup) : undefined}
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
	// Tile width, remembered across restarts and independent of the Agents
	// tab's: the two grids start from very different floors, so widening one
	// says nothing about the other. Bare `+` / `-` / `0` drive it, and only
	// while this grid is the top layer - a group detail modal opened from a
	// tile owns those keys while it is up.
	const tileScale = useScalePreference(GROUP_TILE_SCALE_KEY, TILE_SCALE_RANGE);
	const dashboardIsTop = useIsTopLayer(MODAL_PRIORITIES.USAGE_DASHBOARD);
	useScaleShortcuts(tileScale, { enabled: dashboardIsTop });

	const rollups = useMemo(() => {
		// Terminal sessions aren't agents; excluding them here keeps the group
		// member counts consistent with the Agents tab.
		// Deleted agents' rows get their own tile so the tiles reconcile with the
		// range's totals.
		const agents = sessions.filter((s) => s.toolType !== 'terminal');
		return rollUpGroupStats(groups, agents, data, { includeDeletedAgents: true });
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

		// Ungrouped and Deleted agents are leftovers buckets, not peers - they
		// sink to the end whatever the sort, so a big pile of unfiled or deleted
		// agents can't top the board.
		const isLeftover = (r: GroupStatRollup) => r.isUngrouped || r.isDeleted;
		return [
			...ordered.filter((r) => !isLeftover(r)),
			...ordered.filter((r) => r.isUngrouped),
			...ordered.filter((r) => r.isDeleted),
		];
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
		const real = rollups.filter((r) => !r.isUngrouped && !r.isDeleted).length;
		const visible = filtered.filter((r) => !r.isUngrouped && !r.isDeleted).length;
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
				{/* Centered in the free space between the filters and the sort pills
				    rather than crowding either: the control belongs to the grid, not
				    to the filtering or the ordering. */}
				<div className="flex-1 flex justify-center">
					<ScaleControl
						theme={theme}
						control={tileScale}
						decreaseIcon={Minus}
						increaseIcon={Plus}
						subject="tile size"
						shortcutHint={{ decrease: '-', increase: '+', reset: '0' }}
						size="sm"
						showReset={false}
						testId="group-overview-tile-zoom"
					/>
				</div>
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
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
					style={{ gridTemplateColumns: tileGridColumns(GROUP_TILE_MIN_WIDTH, tileScale.scale) }}
					data-testid="group-overview-cards"
					role="region"
					aria-label="Group usage overview"
				>
					{filtered.map((rollup, index) => (
						<GroupCard
							key={rollup.groupId}
							rollup={rollup}
							dayWindow={data.window}
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

/**
 * TabBreakdown - per-tab stat tiles inside the per-agent detail modal.
 *
 * An agent's queries are already attributed to the AI tab that issued them
 * (`query_events.tab_id`), so the agent's totals can be split per tab without
 * any new IPC: this takes the raw event rows `AgentDetailModal` already fetched
 * and groups them client-side.
 *
 * Naming is the interesting part. The stats database stores only a tab id, and
 * tab names live on the live `Session` object, so a tab can only be named while
 * it still exists somewhere in that session:
 *
 *   - `session.aiTabs` for open tabs,
 *   - `session.snoozedTabs` for snoozed ones,
 *   - `session.closedTabHistory` for recently closed ones (runtime-only, and
 *     capped, so it does not survive a restart).
 *
 * Anything older is a closed tab we can only identify by its id, which we
 * render as the same short uppercase octet Maestro already shows for unnamed
 * tabs. That is why the default filter is "Open": a long-lived agent
 * accumulates hundreds of retired tab ids, and a list of bare octets is not
 * what someone opening this modal is looking for. The wider filters are there
 * for when the question really is "what was I working on recently".
 */

import { memo, useMemo, useState } from 'react';
import type { AITab, Session, Theme } from '../../types';
import type { QueryEvent } from '../../../shared/stats-types';
import { formatAgeShort, formatDurationHuman, formatNumber } from '../../../shared/formatters';
import { getTabDisplayName } from '../../utils/tabHelpers';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { Pager } from '../ui/Pager';
import { usePagination } from '../../hooks/ui/usePagination';
import { EntityTile } from './EntityTile';

/** Days of daily-count history behind each tile's sparkline. */
const SPARKLINE_DAYS = 14;

/**
 * Tiles per page. Chosen so the bounded filters never paginate - Last 25 is the
 * largest of them - and only "All" (which reaches four figures on a long-lived
 * agent) turns the pager on. That way the control appears exactly when it is
 * needed and is absent the rest of the time.
 */
const TABS_PER_PAGE = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

type TabStatus = 'open' | 'snoozed' | 'closed';

export type TabSortMode = 'recent' | 'queries' | 'duration' | 'name';
export type TabFilterMode = 'open' | 'recent10' | 'recent25' | 'all';

interface TabStat {
	tabId: string;
	name: string;
	status: TabStatus;
	/** Live tab state - only known while the tab is still open. */
	isBusy: boolean;
	isStarred: boolean;
	/** True for the tab the agent currently has focused. */
	isActive: boolean;
	queries: number;
	totalDuration: number;
	avgDuration: number;
	autoPercent: number | null;
	/** ms epoch of the tab's most recent recorded query, or its creation time
	 *  when it has none yet. `null` when neither is known. */
	lastActive: number | null;
	/** Daily counts over the last `SPARKLINE_DAYS`, or null when the tab had no
	 *  activity in that window (a flat zero line would imply it is idle *now*
	 *  rather than long retired). */
	sparkline: number[] | null;
}

const SORT_OPTIONS: SegmentedOption<TabSortMode>[] = [
	{ value: 'recent', label: 'Recent', title: 'Most recently active first' },
	{ value: 'queries', label: 'Queries', title: 'Most queries first' },
	{ value: 'duration', label: 'Time', title: 'Most total agent time first' },
	{ value: 'name', label: 'Name', title: 'Alphabetical' },
];

const FILTER_OPTIONS: SegmentedOption<TabFilterMode>[] = [
	{ value: 'open', label: 'Open', title: 'Tabs currently open on this agent' },
	{ value: 'recent10', label: 'Last 10', title: 'The 10 most recently active tabs' },
	{ value: 'recent25', label: 'Last 25', title: 'The 25 most recently active tabs' },
	{ value: 'all', label: 'All', title: 'Every tab with recorded activity' },
];

/** How many tiles each filter admits. `null` means unbounded. */
const FILTER_LIMITS: Record<TabFilterMode, number | null> = {
	open: null,
	recent10: 10,
	recent25: 25,
	all: null,
};

/**
 * Index every tab we can still put a name to, keyed by tab id. Open tabs win
 * over snoozed, which win over recently-closed, so a tab that was closed and
 * whose id somehow reappears live is described by its live state.
 */
function indexKnownTabs(session: Session): Map<string, { tab: AITab; status: TabStatus }> {
	const known = new Map<string, { tab: AITab; status: TabStatus }>();
	for (const entry of session.closedTabHistory ?? []) {
		known.set(entry.tab.id, { tab: entry.tab, status: 'closed' });
	}
	// Usage is measured per AI tab - a snoozed file or terminal tab has no
	// tokens, cost, or turns to break down, so it isn't part of this index.
	for (const entry of session.snoozedTabs ?? []) {
		if (entry.type !== 'ai') continue;
		known.set(entry.tab.id, { tab: entry.tab, status: 'snoozed' });
	}
	for (const tab of session.aiTabs ?? []) {
		known.set(tab.id, { tab, status: 'open' });
	}
	return known;
}

/** Short uppercase label for a tab id we have no name for. Mirrors the octet
 *  convention `getTabDisplayName` uses for unnamed live tabs. */
function formatUnknownTabLabel(tabId: string): string {
	return tabId.includes('-') ? tabId.split('-')[0].toUpperCase() : tabId.slice(0, 8).toUpperCase();
}

/**
 * Bucket a tab's events into daily counts over the trailing window. Returns
 * null when nothing lands in the window, so the tile can omit the sparkline
 * rather than draw a flat line that reads as "idle right now".
 */
function buildTabSparkline(events: QueryEvent[], now: number): number[] | null {
	const windowStart = now - SPARKLINE_DAYS * DAY_MS;
	const buckets = new Array<number>(SPARKLINE_DAYS).fill(0);
	let any = false;
	for (const e of events) {
		if (e.startTime < windowStart) continue;
		const index = Math.min(SPARKLINE_DAYS - 1, Math.floor((e.startTime - windowStart) / DAY_MS));
		buckets[index]++;
		any = true;
	}
	return any ? buckets : null;
}

/**
 * Fold raw query events plus the session's live tab state into one row per tab.
 *
 * Every tab that has recorded activity gets a row, and so does every currently
 * open tab - including one opened moments ago with nothing recorded yet, which
 * should still appear under the "Open" filter rather than silently missing.
 */
export function buildTabStats(session: Session, events: QueryEvent[], now: number): TabStat[] {
	const known = indexKnownTabs(session);
	const byTab = new Map<string, QueryEvent[]>();

	for (const event of events) {
		if (!event.tabId) continue;
		const bucket = byTab.get(event.tabId);
		if (bucket) bucket.push(event);
		else byTab.set(event.tabId, [event]);
	}

	// Open tabs with no recorded queries still deserve a tile.
	for (const tab of session.aiTabs ?? []) {
		if (!byTab.has(tab.id)) byTab.set(tab.id, []);
	}

	const stats: TabStat[] = [];
	for (const [tabId, tabEvents] of byTab) {
		const entry = known.get(tabId);
		const queries = tabEvents.length;
		const totalDuration = tabEvents.reduce((sum, e) => sum + e.duration, 0);
		const autoCount = tabEvents.reduce((sum, e) => sum + (e.source === 'auto' ? 1 : 0), 0);
		const lastEventTime = tabEvents.reduce((max, e) => Math.max(max, e.startTime), 0);

		stats.push({
			tabId,
			name: entry ? getTabDisplayName(entry.tab) : formatUnknownTabLabel(tabId),
			status: entry?.status ?? 'closed',
			isBusy: entry?.status === 'open' && entry.tab.state === 'busy',
			isStarred: Boolean(entry?.tab.starred),
			isActive: entry?.status === 'open' && session.activeTabId === tabId,
			queries,
			totalDuration,
			avgDuration: queries > 0 ? totalDuration / queries : 0,
			autoPercent: queries > 0 ? Math.round((autoCount / queries) * 100) : null,
			lastActive: lastEventTime > 0 ? lastEventTime : (entry?.tab.createdAt ?? null),
			sparkline: buildTabSparkline(tabEvents, now),
		});
	}

	return stats;
}

/** Apply the tile filter. Recent-N sorts by recency first so "last 10" means
 *  the 10 most recent regardless of the sort the user is viewing them in. */
export function applyTabFilter(stats: TabStat[], filter: TabFilterMode): TabStat[] {
	if (filter === 'open') return stats.filter((s) => s.status === 'open');
	const limit = FILTER_LIMITS[filter];
	if (limit === null) return stats;
	return stats
		.slice()
		.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
		.slice(0, limit);
}

export function sortTabStats(stats: TabStat[], sort: TabSortMode): TabStat[] {
	const sorted = stats.slice();
	switch (sort) {
		case 'queries':
			sorted.sort((a, b) => b.queries - a.queries);
			break;
		case 'duration':
			sorted.sort((a, b) => b.totalDuration - a.totalDuration);
			break;
		case 'name':
			sorted.sort((a, b) => a.name.localeCompare(b.name));
			break;
		case 'recent':
		default:
			sorted.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
			break;
	}
	return sorted;
}

interface TabBreakdownProps {
	session: Session;
	theme: Theme;
	/** Raw query events for this agent. `null` while still loading. */
	events: QueryEvent[] | null;
	/** Injectable clock so tests get deterministic sparkline buckets. */
	now?: number;
}

export const TabBreakdown = memo(function TabBreakdown({
	session,
	theme,
	events,
	now,
}: TabBreakdownProps) {
	const [sortMode, setSortMode] = useState<TabSortMode>('recent');
	const [filterMode, setFilterMode] = useState<TabFilterMode>('open');

	const allStats = useMemo(
		() => (events ? buildTabStats(session, events, now ?? Date.now()) : []),
		[session, events, now]
	);

	const visibleStats = useMemo(
		() => sortTabStats(applyTabFilter(allStats, filterMode), sortMode),
		[allStats, filterMode, sortMode]
	);

	// Reset to page 1 whenever the user changes what they are looking at:
	// staying on page 7 after re-sorting would show an arbitrary slice of a
	// brand-new ordering.
	const pager = usePagination(visibleStats, TABS_PER_PAGE, `${filterMode}:${sortMode}`);

	if (!events) {
		return (
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				Loading…
			</div>
		);
	}

	if (allStats.length === 0) {
		return (
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				No tab-level activity recorded for this agent.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3" data-testid="tab-breakdown">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Show:
					</span>
					<SegmentedControl
						value={filterMode}
						onChange={setFilterMode}
						options={FILTER_OPTIONS}
						theme={theme}
						ariaLabel="Filter tabs"
						testId="tab-breakdown-filter"
					/>
					<span
						className="text-xs tabular-nums whitespace-nowrap"
						style={{ color: theme.colors.textDim }}
						data-testid="tab-breakdown-count"
					>
						{pager.isPaginated
							? `${pager.range.from}-${pager.range.to} of ${visibleStats.length}`
							: `${visibleStats.length} of ${allStats.length}`}
					</span>
					{pager.isPaginated && (
						<Pager
							theme={theme}
							page={pager.page}
							totalPages={pager.totalPages}
							onPrev={pager.prevPage}
							onNext={pager.nextPage}
							canGoPrev={pager.canGoPrev}
							canGoNext={pager.canGoNext}
							ariaLabel="Tab pages"
							testId="tab-breakdown-pager"
						/>
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
						ariaLabel="Sort tabs"
						testId="tab-breakdown-sort"
					/>
				</div>
			</div>

			{visibleStats.length === 0 ? (
				<div
					className="py-6 text-center text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid="tab-breakdown-empty"
					role="status"
				>
					{filterMode === 'open'
						? 'This agent has no open tabs. Switch to Last 10 or All to see retired tabs.'
						: 'No tabs match this filter.'}
				</div>
			) : (
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
					data-testid="tab-breakdown-grid"
					role="region"
					aria-label="Tab activity"
				>
					{pager.pageItems.map((stat, index) => (
						<TabCard
							key={stat.tabId}
							stat={stat}
							theme={theme}
							animationIndex={index}
							highlightedStat={sortMode}
						/>
					))}
				</div>
			)}
		</div>
	);
});

/** Status dot color for a tab: busy tabs pulse warning, open tabs read healthy,
 *  snoozed and closed tabs are dim - they are history, not live state. */
function getTabStatusColor(stat: TabStat, theme: Theme): string {
	if (stat.isBusy) return theme.colors.warning;
	if (stat.status === 'open') return theme.colors.success;
	return theme.colors.textDim;
}

interface TabCardProps {
	stat: TabStat;
	theme: Theme;
	animationIndex: number;
	highlightedStat: TabSortMode;
}

const TabCard = memo(function TabCard({
	stat,
	theme,
	animationIndex,
	highlightedStat,
}: TabCardProps) {
	const badges = [];
	if (stat.isActive) badges.push({ label: 'Active', testId: 'tab-card-active-badge' });
	if (stat.status === 'snoozed') {
		badges.push({
			label: 'Snoozed',
			testId: 'tab-card-snoozed-badge',
			color: theme.colors.warning,
		});
	}

	const ageLabel = stat.lastActive ? formatAgeShort(stat.lastActive) : undefined;
	const ageTitle = stat.lastActive
		? `Last active ${new Date(stat.lastActive).toLocaleString()}`
		: undefined;

	const durationLabel = stat.totalDuration > 0 ? formatDurationHuman(stat.totalDuration) : '—';
	const autoLabel = stat.autoPercent === null ? '—' : `${stat.autoPercent}%`;

	const ariaLabel = `${stat.name}, ${stat.status} tab, ${stat.queries} ${
		stat.queries === 1 ? 'query' : 'queries'
	}, ${durationLabel} total${ageLabel ? `, last active ${ageLabel}` : ''}`;

	return (
		<EntityTile
			theme={theme}
			testId="tab-card"
			title={stat.name}
			statusColor={getTabStatusColor(stat, theme)}
			statusPulsing={stat.isBusy}
			age={ageLabel}
			ageTitle={ageTitle}
			ageHighlighted={highlightedStat === 'recent'}
			badges={badges.length > 0 ? badges : undefined}
			// A closed tab is history rather than live state; the dashed border
			// separates the two at a glance without needing a third badge.
			isDashed={stat.status === 'closed'}
			stats={[
				{
					label: 'Queries',
					value: formatNumber(stat.queries),
					highlighted: highlightedStat === 'queries',
					testId: 'tab-card-query-count',
				},
				{
					label: 'Time',
					value: durationLabel,
					highlighted: highlightedStat === 'duration',
					muted: stat.totalDuration === 0,
					testId: 'tab-card-duration',
					title:
						stat.avgDuration > 0
							? `${formatDurationHuman(stat.avgDuration)} average per query`
							: undefined,
				},
				{
					label: 'Auto %',
					value: autoLabel,
					muted: stat.autoPercent === null,
					testId: 'tab-card-auto-pct',
					title:
						stat.autoPercent === null
							? 'No recorded queries'
							: `${stat.autoPercent}% of queries from Auto Run / Cue`,
				},
			]}
			sparkline={stat.sparkline ?? undefined}
			sparklineColor={getTabStatusColor(stat, theme)}
			animationIndex={animationIndex}
			ariaLabel={ariaLabel}
		/>
	);
});

export default TabBreakdown;

import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { Session, SessionState, Theme } from '../../types';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { fillDaySeries } from '../../../shared/daySeries';
import { addLocalDays, toLocalYmd } from '../../../shared/localDay';
import { visibleAiTabs } from '../../utils/tabHelpers';
import type { ProviderProfileIndex } from '../../hooks/stats/useProviderProfiles';

export type SortMode = 'name' | 'created' | 'recent' | 'queries' | 'tabs' | 'auto' | 'provider';

export const AGENT_OVERVIEW_SORT_OPTIONS: { value: SortMode; label: string }[] = [
	{ value: 'queries', label: 'Queries' },
	{ value: 'name', label: 'Name' },
	{ value: 'created', label: 'Created' },
	{ value: 'recent', label: 'Recent' },
	{ value: 'tabs', label: 'Tabs' },
	{ value: 'auto', label: 'Auto %' },
	{ value: 'provider', label: 'Provider' },
];

/**
 * The grid's default order, shared with the Groups grid so both tabs open the
 * same way: busiest first.
 */
export const DEFAULT_AGENT_SORT: SortMode = 'queries';

/** Days behind an agent tile's sparkline. */
export const AGENT_SPARKLINE_DAYS = 7;

type DayCount = { date: string; count: number };

export function getStatusColor(state: SessionState, theme: Theme): string {
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
 * A tile sparkline: the entity's daily counts over the last `days` CALENDAR
 * days, oldest first, ending on the aggregation window's last day (today).
 *
 * The per-entity series (`bySessionByDay`, a group's merged days) is sparse -
 * it only has rows for days with activity - so taking its last N rows drew the
 * last N ACTIVE days, which could span months while reading as a week. Filling
 * over real calendar days keeps an idle stretch visible as zeros.
 *
 * The window is clipped to the selected range: under Today the sparkline is
 * one day, not six zero days the range never asked about.
 */
export function buildCalendarSparkline(
	rows: ReadonlyArray<DayCount> | undefined,
	window: StatsAggregation['window'] | undefined,
	days: number
): number[] {
	const endYmd = window?.endYmd ?? toLocalYmd(Date.now());
	const earliest = addLocalDays(endYmd, -(Math.max(1, days) - 1));
	const startYmd = window?.startYmd && window.startYmd > earliest ? window.startYmd : earliest;
	return fillDaySeries<DayCount>(rows ?? [], startYmd, endYmd, (date) => ({ date, count: 0 })).map(
		(day) => day.count
	);
}

/**
 * Daily counts across the WHOLE selected range, zero-filled, for a detail
 * modal's Daily Activity chart. Returns the dates beside the counts so the
 * chart can label its ends with real days.
 */
export function buildRangeActivity(
	rows: ReadonlyArray<DayCount> | undefined,
	window: StatsAggregation['window'] | undefined
): DayCount[] {
	const endYmd = window?.endYmd ?? toLocalYmd(Date.now());
	const startYmd = window?.startYmd ?? endYmd;
	return fillDaySeries<DayCount>(rows ?? [], startYmd, endYmd, (date) => ({ date, count: 0 }));
}

/**
 * Queries the agent ran in the selected range. Only the agent's OWN rows: an
 * agent with none shows 0. (An earlier fallback showed its provider's whole
 * total when it was the only visible agent of that provider, which credited
 * other and deleted agents' work to it.)
 */
export function getSessionQueryCount(session: Session, data: StatsAggregation): number {
	const sessionByDay = data.bySessionByDay?.[session.id];
	if (!sessionByDay) return 0;
	return sessionByDay.reduce((sum, day) => sum + day.count, 0);
}

/**
 * Epoch ms of the agent's most recent query inside the selected range, or
 * `null` when it has none. `bySessionByDay` only resolves to a calendar day,
 * so ordering by it would tie every agent that ran today.
 */
export function getSessionLastQueryAt(session: Session, data: StatsAggregation): number | null {
	return data.bySessionLastQuery?.[session.id] ?? null;
}

export function getSessionAutoPercent(session: Session, data: StatsAggregation): number | null {
	const split = data.bySessionSource?.[session.id];
	if (!split) return null;
	const total = split.user + split.auto;
	if (total <= 0) return null;
	return Math.round((split.auto / total) * 100);
}

export function sortAgentOverviewSessions(
	sessions: Session[],
	data: StatsAggregation,
	sortMode: SortMode,
	profileIndex?: ProviderProfileIndex
): Session[] {
	const filtered = sessions.filter((session) => session.toolType !== 'terminal');
	const byName = (a: Session, b: Session) => compareNamesIgnoringEmojis(a.name, b.name);

	if (sortMode === 'name') {
		return filtered.slice().sort(byName);
	}

	const alphabetical = filtered.slice().sort(byName);

	if (sortMode === 'created') {
		return alphabetical.slice().sort((a, b) => {
			const aTs = a.createdAt ?? 0;
			const bTs = b.createdAt ?? 0;
			return bTs - aTs;
		});
	}

	if (sortMode === 'queries') {
		return alphabetical
			.slice()
			.sort((a, b) => getSessionQueryCount(b, data) - getSessionQueryCount(a, data));
	}

	if (sortMode === 'tabs') {
		return alphabetical
			.slice()
			.sort((a, b) => visibleAiTabs(b.aiTabs).length - visibleAiTabs(a.aiTabs).length);
	}

	if (sortMode === 'provider') {
		// Alphabetical by profile label so the fleet reads as one block per
		// account, names still ascending inside each block. An agent whose
		// account has not resolved sorts last rather than into an arbitrary
		// block it may not belong to.
		return alphabetical.slice().sort((a, b) => {
			const aLabel = profileIndex?.labelByKey[profileIndex.profileKeyBySessionId[a.id] ?? ''];
			const bLabel = profileIndex?.labelByKey[profileIndex.profileKeyBySessionId[b.id] ?? ''];
			if (aLabel === bLabel) return 0;
			if (!aLabel) return 1;
			if (!bLabel) return -1;
			return aLabel.localeCompare(bLabel);
		});
	}

	if (sortMode === 'recent') {
		// Most-recently-queried first. Agents with no query in the range have no
		// timestamp to rank on, so they sink below every agent that does rather
		// than mixing into the middle on a zero.
		return alphabetical.slice().sort((a, b) => {
			const aTs = getSessionLastQueryAt(a, data);
			const bTs = getSessionLastQueryAt(b, data);
			if (aTs === null && bTs === null) return 0;
			if (aTs === null) return 1;
			if (bTs === null) return -1;
			return bTs - aTs;
		});
	}

	return alphabetical.slice().sort((a, b) => {
		const aPct = getSessionAutoPercent(a, data);
		const bPct = getSessionAutoPercent(b, data);
		if (aPct === null && bPct === null) return 0;
		if (aPct === null) return 1;
		if (bPct === null) return -1;
		return bPct - aPct;
	});
}

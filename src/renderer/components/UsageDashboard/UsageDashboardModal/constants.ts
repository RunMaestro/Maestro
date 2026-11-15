import type { StatsTimeRange } from '../../../../shared/stats-types';
import { formatCalendarDay } from '../../../../shared/formatters';
import { toLocalYmd } from '../../../../shared/localDay';
import type { UsageDashboardTab } from './types';

/**
 * Range labels. Every bounded range is N whole local days ending today (see
 * `getTimeRangeStart()`), so the labels say so rather than naming a calendar
 * week or month the range does not follow.
 */
export const TIME_RANGE_OPTIONS: { value: StatsTimeRange; label: string }[] = [
	{ value: 'day', label: 'Today' },
	{ value: 'week', label: 'Last 7 Days' },
	{ value: 'month', label: 'Last 30 Days' },
	{ value: 'quarter', label: 'Last 90 Days' },
	{ value: 'year', label: 'Last 365 Days' },
	{ value: 'all', label: 'All Time' },
];

/**
 * The display label for a range. All Time names the day it starts on when the
 * first recorded query is known ("All Time (since Jul 10, 2026)"): stats are
 * never pruned, so that day is the true start of the data.
 */
export function getTimeRangeLabel(range: StatsTimeRange, earliestQueryAt?: number | null): string {
	const label = TIME_RANGE_OPTIONS.find((option) => option.value === range)?.label ?? range;
	if (range === 'all' && earliestQueryAt != null) {
		return `${label} (since ${formatCalendarDay(toLocalYmd(earliestQueryAt))})`;
	}
	return label;
}

export const BASE_VIEW_MODE_TABS: UsageDashboardTab[] = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'agent-overview', label: 'Agent Overview' },
	{ value: 'agents', label: 'Agents' },
	{ value: 'groups', label: 'Groups' },
	{ value: 'tokens', label: 'Tokens' },
	{ value: 'activity', label: 'Activity' },
	{ value: 'autorun', label: 'Auto Run' },
	{ value: 'shortcuts', label: 'Shortcuts' },
];

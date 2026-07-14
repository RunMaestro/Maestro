import type { StatsTimeRange } from '../../../../shared/stats-types';
import type { UsageDashboardTab } from './types';

export const TIME_RANGE_OPTIONS: { value: StatsTimeRange; label: string }[] = [
	{ value: 'day', label: 'Today' },
	{ value: 'week', label: 'This Week' },
	{ value: 'month', label: 'This Month' },
	{ value: 'quarter', label: 'This Quarter' },
	{ value: 'year', label: 'This Year' },
	{ value: 'all', label: 'All Time' },
];

export const BASE_VIEW_MODE_TABS: UsageDashboardTab[] = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'agent-overview', label: 'Agent Overview' },
	{ value: 'agents', label: 'Agents' },
	{ value: 'activity', label: 'Activity' },
	{ value: 'autorun', label: 'Auto Run' },
	{ value: 'accounts', label: 'Virtuosos' },
	{ value: 'shortcuts', label: 'Shortcuts' },
];

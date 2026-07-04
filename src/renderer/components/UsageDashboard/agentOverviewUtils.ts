import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { Session, SessionState, Theme } from '../../types';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';

export type SortMode = 'name' | 'created' | 'queries' | 'tabs' | 'auto';

export const AGENT_OVERVIEW_SORT_OPTIONS: { value: SortMode; label: string }[] = [
	{ value: 'name', label: 'Name' },
	{ value: 'created', label: 'Created' },
	{ value: 'queries', label: 'Queries' },
	{ value: 'tabs', label: 'Tabs' },
	{ value: 'auto', label: 'Auto %' },
];

const SPARKLINE_DAYS = 7;
type SessionByDayEntry = StatsAggregation['bySessionByDay'][string][number];

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

export function buildSessionSparkline(sessionByDay: SessionByDayEntry[] | undefined): number[] {
	if (!sessionByDay || sessionByDay.length === 0) {
		return new Array(SPARKLINE_DAYS).fill(0);
	}
	const counts = sessionByDay.slice(-SPARKLINE_DAYS).map((day) => day.count);
	if (counts.length >= SPARKLINE_DAYS) return counts;
	return [...new Array(SPARKLINE_DAYS - counts.length).fill(0), ...counts];
}

export function getSessionQueryCount(
	session: Session,
	data: StatsAggregation,
	visibleSessions?: Session[]
): number {
	const sessionByDay = data.bySessionByDay?.[session.id];
	if (sessionByDay && sessionByDay.length > 0) {
		return sessionByDay.reduce((sum, day) => sum + day.count, 0);
	}
	if (visibleSessions) {
		const sameProviderCount = visibleSessions.filter(
			(item) => item.toolType === session.toolType
		).length;
		if (sameProviderCount !== 1) return 0;
	}
	return data.byAgent?.[session.toolType]?.count ?? 0;
}

export function getSessionAutoPercent(session: Session, data: StatsAggregation): number | null {
	const split = data.bySessionSource?.[session.id];
	if (!split) return null;
	const total = split.user + split.auto;
	if (total <= 0) return null;
	return Math.round((split.auto / total) * 100);
}

export function isSessionHighlighted(session: Session, activeFilterKey: string | null): boolean {
	if (!activeFilterKey) return false;
	if (activeFilterKey === session.id) return true;

	const worktreeSuffix = '__worktree';
	if (activeFilterKey.endsWith(worktreeSuffix)) {
		const provider = activeFilterKey.slice(0, -worktreeSuffix.length);
		return Boolean(session.parentSessionId) && session.toolType === provider;
	}

	return !session.parentSessionId && session.toolType === activeFilterKey;
}

export function sortAgentOverviewSessions(
	sessions: Session[],
	data: StatsAggregation,
	sortMode: SortMode
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
			.sort(
				(a, b) =>
					getSessionQueryCount(b, data, alphabetical) - getSessionQueryCount(a, data, alphabetical)
			);
	}

	if (sortMode === 'tabs') {
		return alphabetical.slice().sort((a, b) => (b.aiTabs?.length ?? 0) - (a.aiTabs?.length ?? 0));
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

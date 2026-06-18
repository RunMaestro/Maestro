import type { AutoRunStats } from '../../../../renderer/types';
import { mockTheme } from '../../../helpers/mockTheme';

export { mockTheme };

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

export function makeAutoRunStats(overrides: Partial<AutoRunStats> = {}): AutoRunStats {
	return {
		cumulativeTimeMs: 0,
		longestRunMs: 0,
		totalRuns: 0,
		lastRunMs: 0,
		badgeHistory: [],
		...overrides,
	};
}

export const firstBadgeStats = makeAutoRunStats({
	cumulativeTimeMs: 15 * MINUTE,
	longestRunMs: 10 * MINUTE,
	totalRuns: 3,
	lastRunMs: 5 * MINUTE,
	badgeHistory: [{ level: 1, unlockedAt: Date.UTC(2026, 0, 1) }],
});

export const level5Stats = makeAutoRunStats({
	cumulativeTimeMs: 7 * DAY,
	longestRunMs: 2 * HOUR,
	totalRuns: 15,
	lastRunMs: 30 * MINUTE,
	badgeHistory: [
		{ level: 5, unlockedAt: Date.UTC(2026, 0, 5) },
		{ level: 1, unlockedAt: Date.UTC(2026, 0, 1) },
		{ level: 3, unlockedAt: Date.UTC(2026, 0, 3) },
		{ level: 2, unlockedAt: Date.UTC(2026, 0, 2) },
		{ level: 4, unlockedAt: Date.UTC(2026, 0, 4) },
	],
});

export const maxLevelStats = makeAutoRunStats({
	cumulativeTimeMs: 10 * YEAR,
	longestRunMs: DAY,
	totalRuns: 1000,
	lastRunMs: HOUR,
	badgeHistory: Array.from({ length: 11 }, (_, i) => ({
		level: i + 1,
		unlockedAt: Date.UTC(2026, 0, i + 1),
	})),
});

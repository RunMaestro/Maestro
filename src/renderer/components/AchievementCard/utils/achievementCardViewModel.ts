import type { AutoRunStats } from '../../../types';
import {
	CONDUCTOR_BADGES,
	formatCumulativeTime,
	formatTimeRemaining,
	getBadgeForTime,
	getNextBadge,
	getProgressToNextBadge,
} from '../../../constants/conductorBadges';
import type { AchievementCardViewModel } from '../types';

export function createAchievementCardViewModel(
	autoRunStats: AutoRunStats
): AchievementCardViewModel {
	const currentBadge = getBadgeForTime(autoRunStats.cumulativeTimeMs);
	const nextBadge = getNextBadge(currentBadge);
	const progressPercent = getProgressToNextBadge(
		autoRunStats.cumulativeTimeMs,
		currentBadge,
		nextBadge
	);
	const currentLevel = currentBadge?.level || 0;

	// Cue time is a subset of cumulative time, so Auto Run is whatever is left.
	// Clamped at 0 so a stats file where cueTimeMs somehow exceeds the total
	// (hand-edited settings) degrades to "all Cue" instead of a negative label.
	const cueTimeMs = Math.min(autoRunStats.cueTimeMs ?? 0, autoRunStats.cumulativeTimeMs);
	const autoRunTimeMs = Math.max(0, autoRunStats.cumulativeTimeMs - cueTimeMs);

	return {
		currentBadge,
		nextBadge,
		progressPercent,
		timeRemaining: formatTimeRemaining(autoRunStats.cumulativeTimeMs, nextBadge),
		currentLevel,
		cumulativeTimeFormatted: formatCumulativeTime(autoRunStats.cumulativeTimeMs),
		cueTimeFormatted: formatCumulativeTime(cueTimeMs),
		autoRunTimeFormatted: formatCumulativeTime(autoRunTimeMs),
		cueSharePercent:
			autoRunStats.cumulativeTimeMs > 0
				? Math.round((cueTimeMs / autoRunStats.cumulativeTimeMs) * 100)
				: 0,
		longestRunFormatted: formatCumulativeTime(autoRunStats.longestRunMs),
		totalRuns: autoRunStats.totalRuns,
		unlockedCountLabel: `${currentLevel}/${CONDUCTOR_BADGES.length} unlocked`,
		hasMaxLevel: !nextBadge && !!currentBadge,
		allBadges: CONDUCTOR_BADGES,
	};
}

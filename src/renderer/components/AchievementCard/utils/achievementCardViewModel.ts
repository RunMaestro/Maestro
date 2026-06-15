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

	return {
		currentBadge,
		nextBadge,
		progressPercent,
		timeRemaining: formatTimeRemaining(autoRunStats.cumulativeTimeMs, nextBadge),
		currentLevel,
		cumulativeTimeFormatted: formatCumulativeTime(autoRunStats.cumulativeTimeMs),
		longestRunFormatted: formatCumulativeTime(autoRunStats.longestRunMs),
		totalRuns: autoRunStats.totalRuns,
		unlockedCountLabel: `${currentLevel}/${CONDUCTOR_BADGES.length} unlocked`,
		hasMaxLevel: !nextBadge && !!currentBadge,
		allBadges: CONDUCTOR_BADGES,
	};
}

import { useState, useCallback } from 'react';
import type { AutoRunStats } from '../../types';
import {
	CONDUCTOR_BADGES,
	getBadgeForTime,
	getNextBadge,
	getProgressToNextBadge,
	formatTimeRemaining,
	formatCumulativeTime,
	type ConductorBadge,
} from '../../constants/conductorBadges';

export interface AchievementState {
	currentBadge: ConductorBadge | null;
	nextBadge: ConductorBadge | null;
	progressPercent: number;
	timeRemaining: string;
	cumulativeTimeFormatted: string;
	longestRunFormatted: string;
	totalRuns: number;
}

export interface PendingAchievement {
	type: 'badge_unlock' | 'new_record';
	badge?: ConductorBadge;
	elapsedTimeMs?: number;
}

export interface UseAchievementsReturn {
	// Current achievement state
	state: AchievementState;

	// Queue of pending achievements to show (for overlay)
	pendingAchievements: PendingAchievement[];

	// Clear the next pending achievement (after showing overlay)
	dismissAchievement: () => void;

	// Get badge by level
	getBadgeByLevel: (level: number) => ConductorBadge | undefined;

	// All badges for display
	allBadges: ConductorBadge[];
}

/**
 * Hook for managing achievement state and pending notifications
 */
export function useAchievements(autoRunStats: AutoRunStats): UseAchievementsReturn {
	// Queue of pending achievements to show
	const [pendingAchievements, setPendingAchievements] = useState<PendingAchievement[]>([]);

	// Calculate current state from stats
	const currentBadge = getBadgeForTime(autoRunStats.cumulativeTimeMs);
	const nextBadge = getNextBadge(currentBadge);
	const progressPercent = getProgressToNextBadge(
		autoRunStats.cumulativeTimeMs,
		currentBadge,
		nextBadge
	);
	const timeRemaining = formatTimeRemaining(autoRunStats.cumulativeTimeMs, nextBadge);
	const cumulativeTimeFormatted = formatCumulativeTime(autoRunStats.cumulativeTimeMs);
	const longestRunFormatted = formatCumulativeTime(autoRunStats.longestRunMs);

	const state: AchievementState = {
		currentBadge,
		nextBadge,
		progressPercent,
		timeRemaining,
		cumulativeTimeFormatted,
		longestRunFormatted,
		totalRuns: autoRunStats.totalRuns,
	};

	// Dismiss the first pending achievement
	const dismissAchievement = useCallback(() => {
		setPendingAchievements((prev) => prev.slice(1));
	}, []);

	// Get badge by level
	const getBadgeByLevel = useCallback((level: number): ConductorBadge | undefined => {
		return CONDUCTOR_BADGES.find((b) => b.level === level);
	}, []);

	return {
		state,
		pendingAchievements,
		dismissAchievement,
		getBadgeByLevel,
		allBadges: CONDUCTOR_BADGES,
	};
}

/**
 * Add a new achievement to the pending queue
 * This should be called from App.tsx when recordAutoRunComplete returns a new badge or record
 */
export function queueAchievement(
	setPendingAchievements: React.Dispatch<React.SetStateAction<PendingAchievement[]>>,
	achievement: PendingAchievement
) {
	setPendingAchievements((prev) => [...prev, achievement]);
}

export default useAchievements;

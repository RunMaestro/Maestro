import { useCallback, useState } from 'react';
import { CONDUCTOR_BADGES, getBadgeForTime } from '../../../constants/conductorBadges';
import type { AutoRunStats } from '../../../types';
import type { AchievementPlaygroundState } from '../types';

export function useAchievementPlayground(): AchievementPlaygroundState {
	const [mockCumulativeTime, setMockCumulativeTime] = useState(0);
	const [mockLongestRun, setMockLongestRun] = useState(0);
	const [mockTotalRuns, setMockTotalRuns] = useState(0);
	const [mockBadgeHistory, setMockBadgeHistory] = useState<{ level: number; unlockedAt: number }[]>(
		[]
	);
	const [showStandingOvation, setShowStandingOvation] = useState(false);
	const [ovationBadgeLevel, setOvationBadgeLevel] = useState(1);
	const [ovationIsNewRecord, setOvationIsNewRecord] = useState(false);
	const [showKeyboardMasteryCelebration, setShowKeyboardMasteryCelebration] = useState(false);
	const [keyboardMasteryLevel, setKeyboardMasteryLevel] = useState(1);

	const mockAutoRunStats: AutoRunStats = {
		cumulativeTimeMs: mockCumulativeTime,
		longestRunMs: mockLongestRun,
		longestRunTimestamp: Date.now(),
		totalRuns: mockTotalRuns,
		currentBadgeLevel: getBadgeForTime(mockCumulativeTime)?.level || 0,
		lastBadgeUnlockLevel:
			mockBadgeHistory.length > 0 ? mockBadgeHistory[mockBadgeHistory.length - 1].level : 0,
		lastAcknowledgedBadgeLevel:
			mockBadgeHistory.length > 0 ? mockBadgeHistory[mockBadgeHistory.length - 1].level : 0,
		badgeHistory: mockBadgeHistory,
	};

	const setToBadgeLevel = useCallback((level: number) => {
		const badge = CONDUCTOR_BADGES.find((candidate) => candidate.level === level);
		if (badge) {
			setMockCumulativeTime(badge.requiredTimeMs);
			const history = CONDUCTOR_BADGES.filter((candidate) => candidate.level <= level).map(
				(candidate) => ({
					level: candidate.level,
					unlockedAt: Date.now() - (level - candidate.level) * 86400000,
				})
			);
			setMockBadgeHistory(history);
		}
	}, []);

	const triggerOvation = useCallback(() => {
		const badge = CONDUCTOR_BADGES.find((candidate) => candidate.level === ovationBadgeLevel);
		if (badge) {
			setShowStandingOvation(true);
		}
	}, [ovationBadgeLevel]);

	const closeStandingOvation = useCallback(() => {
		setShowStandingOvation(false);
	}, []);

	const triggerKeyboardMastery = useCallback(() => {
		setShowKeyboardMasteryCelebration(true);
	}, []);

	const closeKeyboardMastery = useCallback(() => {
		setShowKeyboardMasteryCelebration(false);
	}, []);

	const resetMockData = useCallback(() => {
		setMockCumulativeTime(0);
		setMockLongestRun(0);
		setMockTotalRuns(0);
		setMockBadgeHistory([]);
	}, []);

	return {
		mockCumulativeTime,
		setMockCumulativeTime,
		mockLongestRun,
		setMockLongestRun,
		mockTotalRuns,
		setMockTotalRuns,
		mockAutoRunStats,
		showStandingOvation,
		ovationBadgeLevel,
		setOvationBadgeLevel,
		ovationIsNewRecord,
		setOvationIsNewRecord,
		showKeyboardMasteryCelebration,
		keyboardMasteryLevel,
		setKeyboardMasteryLevel,
		setToBadgeLevel,
		triggerOvation,
		closeStandingOvation,
		triggerKeyboardMastery,
		closeKeyboardMastery,
		resetMockData,
	};
}

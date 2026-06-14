import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAchievementPlayground } from '../../../../../renderer/components/PlaygroundPanel/hooks';

describe('useAchievementPlayground', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('builds default mock Auto Run stats', () => {
		const { result } = renderHook(() => useAchievementPlayground());

		expect(result.current.mockAutoRunStats).toMatchObject({
			cumulativeTimeMs: 0,
			longestRunMs: 0,
			totalRuns: 0,
			currentBadgeLevel: 0,
			lastBadgeUnlockLevel: 0,
			lastAcknowledgedBadgeLevel: 0,
			badgeHistory: [],
		});
	});

	it('sets badge level stats and badge history', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
		const { result } = renderHook(() => useAchievementPlayground());

		act(() => {
			result.current.setToBadgeLevel(2);
		});

		expect(result.current.mockAutoRunStats.currentBadgeLevel).toBe(2);
		expect(result.current.mockAutoRunStats.cumulativeTimeMs).toBeGreaterThan(0);
		expect(result.current.mockAutoRunStats.badgeHistory.map((entry) => entry.level)).toEqual([
			1, 2,
		]);
	});

	it('preserves the current state when the None badge button action is invoked', () => {
		const { result } = renderHook(() => useAchievementPlayground());

		act(() => {
			result.current.setToBadgeLevel(1);
		});
		const cumulativeTime = result.current.mockCumulativeTime;

		act(() => {
			result.current.setToBadgeLevel(0);
		});

		expect(result.current.mockCumulativeTime).toBe(cumulativeTime);
		expect(result.current.mockAutoRunStats.currentBadgeLevel).toBe(1);
	});

	it('tracks manual stats and resets mock data', () => {
		const { result } = renderHook(() => useAchievementPlayground());

		act(() => {
			result.current.setMockCumulativeTime(900000);
			result.current.setMockLongestRun(60000);
			result.current.setMockTotalRuns(42);
		});
		expect(result.current.mockAutoRunStats).toMatchObject({
			cumulativeTimeMs: 900000,
			longestRunMs: 60000,
			totalRuns: 42,
		});

		act(() => {
			result.current.resetMockData();
		});
		expect(result.current.mockAutoRunStats).toMatchObject({
			cumulativeTimeMs: 0,
			longestRunMs: 0,
			totalRuns: 0,
			badgeHistory: [],
		});
	});

	it('opens and closes standing ovation state with the selected flags', () => {
		const { result } = renderHook(() => useAchievementPlayground());

		act(() => {
			result.current.setOvationBadgeLevel(2);
			result.current.setOvationIsNewRecord(true);
		});
		act(() => {
			result.current.triggerOvation();
		});

		expect(result.current.showStandingOvation).toBe(true);
		expect(result.current.ovationBadgeLevel).toBe(2);
		expect(result.current.ovationIsNewRecord).toBe(true);

		act(() => {
			result.current.closeStandingOvation();
		});
		expect(result.current.showStandingOvation).toBe(false);
	});

	it('opens and closes keyboard mastery state', () => {
		const { result } = renderHook(() => useAchievementPlayground());

		act(() => {
			result.current.setKeyboardMasteryLevel(3);
			result.current.triggerKeyboardMastery();
		});

		expect(result.current.keyboardMasteryLevel).toBe(3);
		expect(result.current.showKeyboardMasteryCelebration).toBe(true);

		act(() => {
			result.current.closeKeyboardMastery();
		});
		expect(result.current.showKeyboardMasteryCelebration).toBe(false);
	});
});

import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: loggerMock,
}));

import { useContributorStats } from '../../renderer/hooks/symphony/useContributorStats';

const baseStats = {
	totalContributions: 1,
	totalMerged: 0,
	totalTasksCompleted: 10,
	totalTokensUsed: 999,
	totalTimeSpent: 5 * 60 * 1000,
	estimatedCostDonated: 1.5,
	repositoriesContributed: ['owner/repo'],
	currentStreak: 1,
	longestStreak: 1,
	firstContributionAt: undefined,
} as any;

const completedContribution = {
	id: 'contribution-1',
	repo: { slug: 'owner/repo' },
	completedAt: '2026-05-14T12:00:00.000Z',
} as any;

describe('useContributorStats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		window.maestro = {
			symphony: {
				getStats: vi.fn().mockResolvedValue({ stats: baseStats }),
				getCompleted: vi.fn().mockResolvedValue({ contributions: [completedContribution] }),
			},
		} as any;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('loads contributor stats, recent contributions, formatted values, and partial achievements', async () => {
		const { result, unmount } = renderHook(() => useContributorStats());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(window.maestro.symphony.getStats).toHaveBeenCalledTimes(1);
		expect(window.maestro.symphony.getCompleted).toHaveBeenCalledWith(10);
		expect(result.current.stats).toEqual(baseStats);
		expect(result.current.recentContributions).toEqual([completedContribution]);
		expect(result.current.formattedTotalCost).toBe('$1.50');
		expect(result.current.formattedTotalTokens).toBe('999');
		expect(result.current.formattedTotalTime).toBe('5m');
		expect(result.current.uniqueRepos).toBe(1);
		expect(result.current.currentStreakWeeks).toBe(1);
		expect(result.current.longestStreakWeeks).toBe(1);
		expect(result.current.achievements.find((a) => a.id === 'first-contribution')).toMatchObject({
			earned: true,
			progress: 100,
		});
		expect(result.current.achievements.find((a) => a.id === 'ten-contributions')).toMatchObject({
			earned: false,
			progress: 10,
		});
		expect(result.current.achievements.find((a) => a.id === 'early-adopter')).toMatchObject({
			earned: false,
			progress: 100,
		});

		unmount();
	});

	it('uses default display values and unearned achievements when stats are unavailable', async () => {
		vi.mocked(window.maestro.symphony.getStats).mockResolvedValueOnce({});
		vi.mocked(window.maestro.symphony.getCompleted).mockResolvedValueOnce({});

		const { result } = renderHook(() => useContributorStats());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.stats).toBeNull();
		expect(result.current.recentContributions).toEqual([]);
		expect(result.current.formattedTotalCost).toBe('$0.00');
		expect(result.current.formattedTotalTokens).toBe('0');
		expect(result.current.formattedTotalTime).toBe('0s');
		expect(result.current.uniqueRepos).toBe(0);
		expect(result.current.currentStreakWeeks).toBe(0);
		expect(result.current.longestStreakWeeks).toBe(0);
		expect(result.current.achievements.every((achievement) => !achievement.earned)).toBe(true);
		expect(result.current.achievements.every((achievement) => achievement.progress === 0)).toBe(
			true
		);
	});

	it('marks threshold achievements and formats large tokens and hour durations', async () => {
		vi.mocked(window.maestro.symphony.getStats).mockResolvedValueOnce({
			stats: {
				...baseStats,
				totalContributions: 12,
				totalMerged: 2,
				totalTasksCompleted: 1200,
				totalTokensUsed: 12_300_000,
				totalTimeSpent: 2 * 60 * 60 * 1000 + 5 * 60 * 1000,
				estimatedCostDonated: 42,
				repositoriesContributed: ['a', 'b', 'c', 'd', 'e'],
				currentStreak: 3,
				longestStreak: 8,
				firstContributionAt: '2025-01-15T00:00:00.000Z',
			},
		});

		const { result } = renderHook(() => useContributorStats());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.formattedTotalCost).toBe('$42.00');
		expect(result.current.formattedTotalTokens).toBe('12.3M');
		expect(result.current.formattedTotalTime).toBe('2h 5m');
		expect(result.current.uniqueRepos).toBe(5);
		expect(
			result.current.achievements.filter((achievement) => achievement.earned).map((a) => a.id)
		).toEqual([
			'first-contribution',
			'ten-contributions',
			'first-merge',
			'multi-repo',
			'streak-week',
			'token-millionaire',
			'thousand-tasks',
			'early-adopter',
		]);
	});

	it('formats thousands of tokens and refreshes on demand', async () => {
		vi.mocked(window.maestro.symphony.getStats)
			.mockResolvedValueOnce({ stats: { ...baseStats, totalTokensUsed: 1_500 } })
			.mockResolvedValueOnce({ stats: { ...baseStats, totalTokensUsed: 2_500 } });
		const { result } = renderHook(() => useContributorStats());

		await waitFor(() => expect(result.current.formattedTotalTokens).toBe('1.5K'));

		await act(async () => {
			await result.current.refresh();
		});

		expect(result.current.formattedTotalTokens).toBe('2.5K');
		expect(window.maestro.symphony.getStats).toHaveBeenCalledTimes(2);
	});

	it('polls for updated stats and clears the interval on unmount', async () => {
		let pollCallback: (() => void) | undefined;
		const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((callback) => {
			pollCallback = callback as () => void;
			return 123 as any;
		});
		const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
		const { result, unmount } = renderHook(() => useContributorStats());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.isLoading).toBe(false);

		await act(async () => {
			pollCallback?.();
			await Promise.resolve();
		});

		expect(window.maestro.symphony.getStats).toHaveBeenCalledTimes(2);
		unmount();
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
		expect(clearIntervalSpy).toHaveBeenCalledWith(123);
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
	});

	it('logs failed IPC calls and leaves previous display defaults intact', async () => {
		const failure = new Error('stats unavailable');
		vi.mocked(window.maestro.symphony.getStats).mockRejectedValueOnce(failure);

		const { result } = renderHook(() => useContributorStats());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Failed to fetch contributor stats:',
			undefined,
			failure
		);
		expect(result.current.stats).toBeNull();
		expect(result.current.formattedTotalCost).toBe('$0.00');
	});
});

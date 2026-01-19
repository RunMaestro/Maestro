/**
 * @fileoverview Tests for useAchievements hook
 *
 * Tests the achievement system hook including:
 * - useAchievements() hook state calculation
 * - dismissAchievement() callback
 * - getBadgeByLevel() lookup
 * - queueAchievement() utility function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAchievements,
	queueAchievement,
	type AchievementState,
	type PendingAchievement,
	type UseAchievementsReturn,
} from '../../../renderer/hooks';
import { CONDUCTOR_BADGES } from '../../../renderer/constants/conductorBadges';
import type { AutoRunStats } from '../../../renderer/types';

// Time constants for readability
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

// Helper to create AutoRunStats
function createStats(overrides: Partial<AutoRunStats> = {}): AutoRunStats {
	return {
		totalRuns: 0,
		cumulativeTimeMs: 0,
		longestRunMs: 0,
		lastRunDate: undefined,
		...overrides,
	};
}

describe('useAchievements', () => {
	describe('hook initialization and state shape', () => {
		it('returns correct shape', () => {
			const { result } = renderHook(() => useAchievements(createStats()));

			expect(result.current).toHaveProperty('state');
			expect(result.current).toHaveProperty('pendingAchievements');
			expect(result.current).toHaveProperty('dismissAchievement');
			expect(result.current).toHaveProperty('getBadgeByLevel');
			expect(result.current).toHaveProperty('allBadges');
		});

		it('state has all required properties', () => {
			const { result } = renderHook(() => useAchievements(createStats()));

			const { state } = result.current;
			expect(state).toHaveProperty('currentBadge');
			expect(state).toHaveProperty('nextBadge');
			expect(state).toHaveProperty('progressPercent');
			expect(state).toHaveProperty('timeRemaining');
			expect(state).toHaveProperty('cumulativeTimeFormatted');
			expect(state).toHaveProperty('longestRunFormatted');
			expect(state).toHaveProperty('totalRuns');
		});

		it('returns empty pendingAchievements initially', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(result.current.pendingAchievements).toEqual([]);
		});

		it('returns all 11 badges in allBadges', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(result.current.allBadges).toHaveLength(11);
			expect(result.current.allBadges).toBe(CONDUCTOR_BADGES);
		});
	});

	describe('currentBadge calculation', () => {
		it('returns null for zero time', () => {
			const { result } = renderHook(() => useAchievements(createStats({ cumulativeTimeMs: 0 })));
			expect(result.current.state.currentBadge).toBeNull();
		});

		it('returns level 1 badge for 15+ minutes', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 15 * MINUTE }))
			);
			expect(result.current.state.currentBadge?.level).toBe(1);
		});

		it('returns level 2 badge for 1+ hour', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 1 * HOUR }))
			);
			expect(result.current.state.currentBadge?.level).toBe(2);
		});

		it('returns max level badge for 10+ years', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 10 * YEAR }))
			);
			expect(result.current.state.currentBadge?.level).toBe(11);
		});
	});

	describe('nextBadge calculation', () => {
		it('returns first badge when no current badge', () => {
			const { result } = renderHook(() => useAchievements(createStats({ cumulativeTimeMs: 0 })));
			expect(result.current.state.nextBadge?.level).toBe(1);
		});

		it('returns level 2 after level 1', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 15 * MINUTE }))
			);
			expect(result.current.state.nextBadge?.level).toBe(2);
		});

		it('returns null at max level', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 10 * YEAR }))
			);
			expect(result.current.state.nextBadge).toBeNull();
		});
	});

	describe('progressPercent calculation', () => {
		it('returns 0% at start', () => {
			const { result } = renderHook(() => useAchievements(createStats({ cumulativeTimeMs: 0 })));
			expect(result.current.state.progressPercent).toBe(0);
		});

		it('returns 50% at midpoint to first badge', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 7.5 * MINUTE }))
			);
			expect(result.current.state.progressPercent).toBe(50);
		});

		it('returns 100% at max level', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 10 * YEAR }))
			);
			expect(result.current.state.progressPercent).toBe(100);
		});
	});

	describe('timeRemaining formatting', () => {
		it('shows time remaining for first badge', () => {
			const { result } = renderHook(() => useAchievements(createStats({ cumulativeTimeMs: 0 })));
			expect(result.current.state.timeRemaining).toMatch(/\d+m remaining/);
		});

		it('shows "Maximum level achieved!" at max level', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 10 * YEAR }))
			);
			expect(result.current.state.timeRemaining).toBe('Maximum level achieved!');
		});
	});

	describe('cumulativeTimeFormatted', () => {
		it('formats zero time as 0s', () => {
			const { result } = renderHook(() => useAchievements(createStats({ cumulativeTimeMs: 0 })));
			expect(result.current.state.cumulativeTimeFormatted).toBe('0s');
		});

		it('formats hours correctly', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 2 * HOUR + 30 * MINUTE }))
			);
			expect(result.current.state.cumulativeTimeFormatted).toBe('2h 30m');
		});

		it('formats days correctly', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 3 * DAY + 12 * HOUR }))
			);
			expect(result.current.state.cumulativeTimeFormatted).toBe('3d 12h 0m');
		});
	});

	describe('longestRunFormatted', () => {
		it('formats zero as 0s', () => {
			const { result } = renderHook(() => useAchievements(createStats({ longestRunMs: 0 })));
			expect(result.current.state.longestRunFormatted).toBe('0s');
		});

		it('formats longest run correctly', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ longestRunMs: 45 * MINUTE }))
			);
			expect(result.current.state.longestRunFormatted).toBe('45m 0s');
		});
	});

	describe('totalRuns passthrough', () => {
		it('returns totalRuns from stats', () => {
			const { result } = renderHook(() => useAchievements(createStats({ totalRuns: 42 })));
			expect(result.current.state.totalRuns).toBe(42);
		});

		it('handles zero runs', () => {
			const { result } = renderHook(() => useAchievements(createStats({ totalRuns: 0 })));
			expect(result.current.state.totalRuns).toBe(0);
		});

		it('handles large run counts', () => {
			const { result } = renderHook(() => useAchievements(createStats({ totalRuns: 10000 })));
			expect(result.current.state.totalRuns).toBe(10000);
		});
	});

	describe('dismissAchievement', () => {
		it('is a function', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(typeof result.current.dismissAchievement).toBe('function');
		});

		it('is a stable reference (useCallback)', () => {
			const { result, rerender } = renderHook(() => useAchievements(createStats()));
			const firstRef = result.current.dismissAchievement;
			rerender();
			expect(result.current.dismissAchievement).toBe(firstRef);
		});

		it('handles call with empty queue gracefully', () => {
			const { result } = renderHook(() => useAchievements(createStats()));

			// Should not throw
			act(() => {
				result.current.dismissAchievement();
			});

			expect(result.current.pendingAchievements).toEqual([]);
		});
	});

	describe('getBadgeByLevel', () => {
		it('returns badge for valid level', () => {
			const { result } = renderHook(() => useAchievements(createStats()));

			expect(result.current.getBadgeByLevel(1)?.id).toBe('apprentice-conductor');
			expect(result.current.getBadgeByLevel(5)?.name).toBe('Principal Guest Conductor');
			expect(result.current.getBadgeByLevel(11)?.name).toBe('Titan of the Baton');
		});

		it('returns undefined for level 0', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(result.current.getBadgeByLevel(0)).toBeUndefined();
		});

		it('returns undefined for level 12', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(result.current.getBadgeByLevel(12)).toBeUndefined();
		});

		it('returns undefined for negative level', () => {
			const { result } = renderHook(() => useAchievements(createStats()));
			expect(result.current.getBadgeByLevel(-1)).toBeUndefined();
		});

		it('is a stable reference (useCallback)', () => {
			const { result, rerender } = renderHook(() => useAchievements(createStats()));
			const firstRef = result.current.getBadgeByLevel;
			rerender();
			expect(result.current.getBadgeByLevel).toBe(firstRef);
		});
	});

	describe('state updates on stats change', () => {
		it('recalculates when stats change', () => {
			const { result, rerender } = renderHook(({ stats }) => useAchievements(stats), {
				initialProps: { stats: createStats({ cumulativeTimeMs: 0 }) },
			});

			expect(result.current.state.currentBadge).toBeNull();

			rerender({ stats: createStats({ cumulativeTimeMs: 15 * MINUTE }) });

			expect(result.current.state.currentBadge?.level).toBe(1);
		});

		it('updates nextBadge when leveling up', () => {
			const { result, rerender } = renderHook(({ stats }) => useAchievements(stats), {
				initialProps: { stats: createStats({ cumulativeTimeMs: 14 * MINUTE }) },
			});

			expect(result.current.state.nextBadge?.level).toBe(1);

			rerender({ stats: createStats({ cumulativeTimeMs: 15 * MINUTE }) });

			expect(result.current.state.nextBadge?.level).toBe(2);
		});

		it('progress resets when crossing badge boundary', () => {
			const { result, rerender } = renderHook(({ stats }) => useAchievements(stats), {
				initialProps: { stats: createStats({ cumulativeTimeMs: 14 * MINUTE }) },
			});

			// 14/15 = ~93% progress
			expect(result.current.state.progressPercent).toBeGreaterThan(90);

			rerender({ stats: createStats({ cumulativeTimeMs: 15 * MINUTE }) });

			// Now at 0% progress toward level 2
			expect(result.current.state.progressPercent).toBe(0);
		});
	});

	describe('edge cases', () => {
		it('handles very large cumulative times', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 100 * YEAR }))
			);

			expect(result.current.state.currentBadge?.level).toBe(11);
			expect(result.current.state.progressPercent).toBe(100);
		});

		it('handles fractional times', () => {
			const { result } = renderHook(() =>
				useAchievements(createStats({ cumulativeTimeMs: 1234.567 }))
			);

			expect(result.current.state.cumulativeTimeFormatted).toBe('1s');
		});

		it('handles all stats being zero', () => {
			const { result } = renderHook(() =>
				useAchievements(
					createStats({
						cumulativeTimeMs: 0,
						longestRunMs: 0,
						totalRuns: 0,
					})
				)
			);

			expect(result.current.state.currentBadge).toBeNull();
			expect(result.current.state.cumulativeTimeFormatted).toBe('0s');
			expect(result.current.state.longestRunFormatted).toBe('0s');
			expect(result.current.state.totalRuns).toBe(0);
		});
	});
});

describe('queueAchievement', () => {
	it('is a function', () => {
		expect(typeof queueAchievement).toBe('function');
	});

	it('adds achievement to end of queue', () => {
		const setState = vi.fn();
		const achievement: PendingAchievement = { type: 'badge_unlock' };

		queueAchievement(setState, achievement);

		expect(setState).toHaveBeenCalledTimes(1);

		// Get the updater function and call it
		const updater = setState.mock.calls[0][0];
		const newState = updater([]);

		expect(newState).toEqual([achievement]);
	});

	it('appends to existing queue', () => {
		const setState = vi.fn();
		const existing: PendingAchievement = { type: 'badge_unlock' };
		const newAchievement: PendingAchievement = { type: 'new_record' };

		queueAchievement(setState, newAchievement);

		const updater = setState.mock.calls[0][0];
		const newState = updater([existing]);

		expect(newState).toEqual([existing, newAchievement]);
		expect(newState).toHaveLength(2);
	});

	it('works with badge_unlock type', () => {
		const setState = vi.fn();
		const badge = CONDUCTOR_BADGES[0];
		const achievement: PendingAchievement = {
			type: 'badge_unlock',
			badge,
		};

		queueAchievement(setState, achievement);

		const updater = setState.mock.calls[0][0];
		const newState = updater([]);

		expect(newState[0].type).toBe('badge_unlock');
		expect(newState[0].badge).toBe(badge);
	});

	it('works with new_record type', () => {
		const setState = vi.fn();
		const achievement: PendingAchievement = {
			type: 'new_record',
			elapsedTimeMs: 3600000,
		};

		queueAchievement(setState, achievement);

		const updater = setState.mock.calls[0][0];
		const newState = updater([]);

		expect(newState[0].type).toBe('new_record');
		expect(newState[0].elapsedTimeMs).toBe(3600000);
	});

	it('accumulates multiple achievements', () => {
		const setState = vi.fn();
		const achievements: PendingAchievement[] = [
			{ type: 'badge_unlock', badge: CONDUCTOR_BADGES[0] },
			{ type: 'new_record', elapsedTimeMs: 1000 },
			{ type: 'badge_unlock', badge: CONDUCTOR_BADGES[1] },
		];

		// Queue them one by one
		let queue: PendingAchievement[] = [];
		achievements.forEach((ach) => {
			queueAchievement(setState, ach);
			const updater = setState.mock.calls[setState.mock.calls.length - 1][0];
			queue = updater(queue);
		});

		expect(queue).toHaveLength(3);
		expect(queue[0].type).toBe('badge_unlock');
		expect(queue[1].type).toBe('new_record');
		expect(queue[2].type).toBe('badge_unlock');
	});

	it('does not mutate previous array', () => {
		const setState = vi.fn();
		const original: PendingAchievement[] = [{ type: 'badge_unlock' }];
		const achievement: PendingAchievement = { type: 'new_record' };

		queueAchievement(setState, achievement);

		const updater = setState.mock.calls[0][0];
		const newState = updater(original);

		expect(original).toHaveLength(1); // Original unchanged
		expect(newState).toHaveLength(2);
		expect(newState).not.toBe(original);
	});
});

describe('Type exports', () => {
	it('AchievementState type is usable', () => {
		const state: AchievementState = {
			currentBadge: null,
			nextBadge: null,
			progressPercent: 0,
			timeRemaining: '15m remaining',
			cumulativeTimeFormatted: '0s',
			longestRunFormatted: '0s',
			totalRuns: 0,
		};
		expect(state.progressPercent).toBe(0);
	});

	it('PendingAchievement type supports badge_unlock', () => {
		const achievement: PendingAchievement = {
			type: 'badge_unlock',
			badge: CONDUCTOR_BADGES[0],
		};
		expect(achievement.type).toBe('badge_unlock');
	});

	it('PendingAchievement type supports new_record', () => {
		const achievement: PendingAchievement = {
			type: 'new_record',
			elapsedTimeMs: 3600000,
		};
		expect(achievement.type).toBe('new_record');
	});

	it('UseAchievementsReturn type matches hook return', () => {
		const { result } = renderHook(() => useAchievements(createStats()));
		const hookReturn: UseAchievementsReturn = result.current;

		expect(hookReturn.state).toBeDefined();
		expect(hookReturn.pendingAchievements).toBeDefined();
		expect(hookReturn.dismissAchievement).toBeDefined();
		expect(hookReturn.getBadgeByLevel).toBeDefined();
		expect(hookReturn.allBadges).toBeDefined();
	});
});

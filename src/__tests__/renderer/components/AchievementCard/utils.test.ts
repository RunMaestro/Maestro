import { describe, expect, it } from 'vitest';
import {
	createAchievementCardViewModel,
	getBadgeHistoryRows,
	getProgressRingSegmentColor,
	getProgressionSegmentColor,
	getProgressionSegmentStyle,
	getTooltipPosition,
	interpolateColor,
	shouldShowBadgeHistory,
} from '../../../../renderer/components/AchievementCard/utils';
import { CONDUCTOR_BADGES } from '../../../../renderer/constants/conductorBadges';
import {
	DAY,
	HOUR,
	MINUTE,
	firstBadgeStats,
	level5Stats,
	makeAutoRunStats,
	maxLevelStats,
	mockTheme,
} from './_fixtures';

describe('AchievementCard utils', () => {
	describe('createAchievementCardViewModel', () => {
		it('derives the no-badge state', () => {
			const model = createAchievementCardViewModel(makeAutoRunStats());

			expect(model.currentBadge).toBeNull();
			expect(model.nextBadge?.level).toBe(1);
			expect(model.currentLevel).toBe(0);
			expect(model.progressPercent).toBe(0);
			expect(model.cumulativeTimeFormatted).toBe('0s');
			expect(model.longestRunFormatted).toBe('0s');
			expect(model.unlockedCountLabel).toBe('0/11 unlocked');
			expect(model.hasMaxLevel).toBe(false);
			expect(model.allBadges).toBe(CONDUCTOR_BADGES);
		});

		it('derives the first-badge state and formatted stats', () => {
			const model = createAchievementCardViewModel(firstBadgeStats);

			expect(model.currentBadge?.level).toBe(1);
			expect(model.nextBadge?.level).toBe(2);
			expect(model.currentLevel).toBe(1);
			expect(model.cumulativeTimeFormatted).toBe('15m 0s');
			expect(model.longestRunFormatted).toBe('10m 0s');
			expect(model.totalRuns).toBe(3);
			expect(model.timeRemaining).toMatch(/remaining|Ready to unlock/);
		});

		it('derives a mid-level state', () => {
			const model = createAchievementCardViewModel(level5Stats);

			expect(model.currentBadge?.level).toBe(5);
			expect(model.nextBadge?.level).toBe(6);
			expect(model.unlockedCountLabel).toBe('5/11 unlocked');
			expect(model.progressPercent).toBeGreaterThanOrEqual(0);
			expect(model.progressPercent).toBeLessThanOrEqual(100);
		});

		it('derives the max-level state', () => {
			const model = createAchievementCardViewModel(maxLevelStats);

			expect(model.currentBadge?.level).toBe(11);
			expect(model.nextBadge).toBeNull();
			expect(model.progressPercent).toBe(100);
			expect(model.hasMaxLevel).toBe(true);
			expect(model.unlockedCountLabel).toBe('11/11 unlocked');
		});

		it('calculates progress between two badges', () => {
			const model = createAchievementCardViewModel(
				makeAutoRunStats({
					cumulativeTimeMs: 37.5 * MINUTE,
					longestRunMs: 15 * MINUTE,
					totalRuns: 5,
				})
			);

			expect(model.currentBadge?.level).toBe(1);
			expect(model.nextBadge?.level).toBe(2);
			expect(model.progressPercent).toBe(50);
		});
	});

	describe('badgeStyles', () => {
		it('returns tooltip positions for edge and middle levels', () => {
			expect(getTooltipPosition(1)).toBe('left');
			expect(getTooltipPosition(2)).toBe('left');
			expect(getTooltipPosition(5)).toBe('center');
			expect(getTooltipPosition(10)).toBe('right');
			expect(getTooltipPosition(11)).toBe('right');
		});

		it('interpolates colors', () => {
			expect(interpolateColor('#000000', '#ffffff', 0)).toBe('#000000');
			expect(interpolateColor('#000000', '#ffffff', 1)).toBe('#ffffff');
			expect(interpolateColor('#000000', '#ffffff', 0.5)).toBe('#808080');
			expect(interpolateColor('#000', '#fff', 0.5)).toBe('#808080');
			expect(interpolateColor('#000000', '#ffffff', -1)).toBe('#000000');
			expect(interpolateColor('#000000', '#ffffff', 2)).toBe('#ffffff');
			expect(interpolateColor('not-a-color', '#abc', Number.NaN)).toBe('#aabbcc');
			expect(interpolateColor('not-a-color', 'also-bad', 0.5)).toBe('#000000');
		});

		it('uses ring colors for locked and unlocked levels', () => {
			expect(getProgressRingSegmentColor(1, true, mockTheme)).toBe(mockTheme.colors.accent);
			expect(getProgressRingSegmentColor(5, true, mockTheme)).toMatch(/^#/);
			expect(getProgressRingSegmentColor(9, true, mockTheme)).toMatch(/^#/);
			expect(getProgressRingSegmentColor(9, false, mockTheme)).toBe(mockTheme.colors.border);
		});

		it('uses progression bar color bands', () => {
			expect(getProgressionSegmentColor(1, true, mockTheme)).toBe(mockTheme.colors.accent);
			expect(getProgressionSegmentColor(4, true, mockTheme)).toBe('#FFD700');
			expect(getProgressionSegmentColor(8, true, mockTheme)).toBe('#FF6B35');
			expect(getProgressionSegmentColor(8, false, mockTheme)).toBe(mockTheme.colors.border);
		});

		it('marks current and locked progression segments', () => {
			const currentStyle = getProgressionSegmentStyle(3, 3, mockTheme);
			const lockedStyle = getProgressionSegmentStyle(4, 3, mockTheme);

			expect(currentStyle.boxShadow).toContain('#FFD700');
			expect(lockedStyle.border).toBe(`1px dashed ${mockTheme.colors.textDim}`);
			expect(lockedStyle.opacity).toBe(0.5);
		});
	});

	describe('badgeHistory', () => {
		it('sorts and filters badge history rows', () => {
			const rows = getBadgeHistoryRows([
				{ level: 3, unlockedAt: Date.UTC(2026, 0, 3, 12) },
				{ level: 99, unlockedAt: Date.UTC(2026, 0, 4, 12) },
				{ level: 1, unlockedAt: Date.UTC(2026, 0, 1, 12) },
				{ level: 2, unlockedAt: Date.UTC(2026, 0, 2, 12) },
			]);

			expect(rows.map((row) => row.level)).toEqual([1, 2, 3]);
			expect(rows[0].badge.level).toBe(1);
			expect(rows[0].dateLabel).toContain('2026');
		});

		it('only shows history when multiple records exist', () => {
			expect(shouldShowBadgeHistory(undefined)).toBe(false);
			expect(shouldShowBadgeHistory([])).toBe(false);
			expect(shouldShowBadgeHistory([{ level: 1, unlockedAt: Date.now() }])).toBe(false);
			expect(
				shouldShowBadgeHistory([
					{ level: 1, unlockedAt: Date.now() },
					{ level: 2, unlockedAt: Date.now() },
				])
			).toBe(true);
		});

		it('keeps large formatted durations available through the view model', () => {
			const model = createAchievementCardViewModel(
				makeAutoRunStats({
					cumulativeTimeMs: 2 * DAY + 12 * HOUR,
					longestRunMs: HOUR,
				})
			);

			expect(model.cumulativeTimeFormatted).toBe('2d 12h 0m');
			expect(model.longestRunFormatted).toBe('1h 0m');
		});
	});
});

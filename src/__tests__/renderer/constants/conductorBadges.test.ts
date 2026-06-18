/**
 * Tests for conductorBadges constants and utility functions
 */

import { describe, it, expect } from 'vitest';
import {
	CONDUCTOR_BADGES,
	getBadgeForTime,
	getNextBadge,
	getProgressToNextBadge,
	formatTimeRemaining,
	formatCumulativeTime,
} from '../../../renderer/constants/conductorBadges';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

describe('conductorBadges', () => {
	describe('CONDUCTOR_BADGES constant', () => {
		it('should have badges in ascending order by level and time', () => {
			for (let i = 1; i < CONDUCTOR_BADGES.length; i++) {
				expect(CONDUCTOR_BADGES[i].level).toBeGreaterThan(CONDUCTOR_BADGES[i - 1].level);
				expect(CONDUCTOR_BADGES[i].requiredTimeMs).toBeGreaterThan(
					CONDUCTOR_BADGES[i - 1].requiredTimeMs
				);
			}
		});

		it('should have all required properties on each badge', () => {
			for (const badge of CONDUCTOR_BADGES) {
				expect(badge.id).toBeTruthy();
				expect(badge.name).toBeTruthy();
				expect(badge.shortName).toBeTruthy();
				expect(badge.description).toBeTruthy();
				expect(badge.requiredTimeMs).toBeGreaterThan(0);
				expect(badge.exampleConductor.name).toBeTruthy();
				expect(badge.exampleConductor.wikipediaUrl).toMatch(/^https:\/\/en\.wikipedia\.org/);
			}
		});

		it('should have unique IDs and levels', () => {
			const ids = CONDUCTOR_BADGES.map((b) => b.id);
			const levels = CONDUCTOR_BADGES.map((b) => b.level);
			expect(new Set(ids).size).toBe(CONDUCTOR_BADGES.length);
			expect(new Set(levels).size).toBe(CONDUCTOR_BADGES.length);
		});
	});

	describe('getBadgeForTime', () => {
		it('should return null for time below first badge', () => {
			expect(getBadgeForTime(0)).toBeNull();
			expect(getBadgeForTime(14 * MINUTE)).toBeNull();
		});

		it('should return correct badge at exact boundaries', () => {
			for (const badge of CONDUCTOR_BADGES) {
				expect(getBadgeForTime(badge.requiredTimeMs)?.level).toBe(badge.level);
			}
		});

		it('should return highest qualifying badge', () => {
			expect(getBadgeForTime(30 * MINUTE)?.level).toBe(1); // Between L1 (15min) and L2 (1hr)
			expect(getBadgeForTime(10 * YEAR)?.level).toBe(11);
			expect(getBadgeForTime(100 * YEAR)?.level).toBe(11);
		});
	});

	describe('getNextBadge', () => {
		it('should return first badge when currentBadge is null', () => {
			expect(getNextBadge(null)?.level).toBe(1);
		});

		it('should return next badge in sequence', () => {
			for (let i = 0; i < CONDUCTOR_BADGES.length - 1; i++) {
				expect(getNextBadge(CONDUCTOR_BADGES[i])?.level).toBe(CONDUCTOR_BADGES[i + 1].level);
			}
		});

		it('should return null for last badge', () => {
			expect(getNextBadge(CONDUCTOR_BADGES[CONDUCTOR_BADGES.length - 1])).toBeNull();
		});
	});

	describe('getProgressToNextBadge', () => {
		it('should return 100 when nextBadge is null', () => {
			expect(getProgressToNextBadge(10 * YEAR, CONDUCTOR_BADGES[10], null)).toBe(100);
		});

		it('should return 0 at start, 50 at midpoint, 100 at end', () => {
			const next = CONDUCTOR_BADGES[0]; // 15 minutes
			expect(getProgressToNextBadge(0, null, next)).toBe(0);
			expect(getProgressToNextBadge(7.5 * MINUTE, null, next)).toBe(50);
			expect(getProgressToNextBadge(15 * MINUTE, null, next)).toBe(100);
		});
	});

	describe('formatTimeRemaining', () => {
		it('should return "Maximum level achieved!" when nextBadge is null', () => {
			expect(formatTimeRemaining(0, null)).toBe('Maximum level achieved!');
		});

		it('should return "Ready to unlock!" when time exceeds requirement', () => {
			expect(formatTimeRemaining(20 * MINUTE, CONDUCTOR_BADGES[0])).toBe('Ready to unlock!');
		});

		it('should format remaining time appropriately', () => {
			expect(formatTimeRemaining(0, CONDUCTOR_BADGES[0])).toMatch(/\d+m remaining/);
			expect(formatTimeRemaining(0, CONDUCTOR_BADGES[10])).toMatch(/\d+y \d+d remaining/);
		});
	});

	describe('formatCumulativeTime', () => {
		it('should format time in appropriate units', () => {
			expect(formatCumulativeTime(0)).toBe('0s');
			expect(formatCumulativeTime(30 * 1000)).toBe('30s');
			expect(formatCumulativeTime(90 * 1000)).toBe('1m 30s');
			expect(formatCumulativeTime(2 * HOUR + 30 * MINUTE)).toBe('2h 30m');
			expect(formatCumulativeTime(2 * DAY + 12 * HOUR)).toBe('2d 12h 0m');
			expect(formatCumulativeTime(2 * YEAR + 100 * DAY)).toBe('2y 100d');
		});
	});
});

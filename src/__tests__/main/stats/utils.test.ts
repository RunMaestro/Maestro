import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsTimeRange } from '../../../shared/stats-types';

const mocks = vi.hoisted(() => ({
	loggerDebug: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: mocks.loggerDebug,
	},
}));

import {
	generateId,
	getTimeRangeStart,
	normalizePath,
	perfMetrics,
	StatementCache,
} from '../../../main/stats/utils';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('stats utils', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-17T12:00:00Z').getTime());
		mocks.loggerDebug.mockClear();
		perfMetrics.clearMetrics();
		perfMetrics.setEnabled(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		perfMetrics.clearMetrics();
		perfMetrics.setEnabled(false);
	});

	it('generates IDs from the current timestamp and a random suffix', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);

		expect(generateId()).toBe(`${Date.now()}-i`);
	});

	describe('getTimeRangeStart', () => {
		it.each([
			['day', 1],
			['week', 7],
			['month', 30],
			['quarter', 90],
			['year', 365],
		] as const)('calculates the %s range from the current timestamp', (range, days) => {
			const now = Date.now();

			expect(getTimeRangeStart(range)).toBe(now - days * DAY_MS);
		});

		it('returns zero for the all range', () => {
			expect(getTimeRangeStart('all')).toBe(0);
		});

		it('returns zero for an unexpected range value', () => {
			expect(getTimeRangeStart('unexpected' as StatsTimeRange)).toBe(0);
		});
	});

	describe('normalizePath', () => {
		it('normalizes Windows paths to forward slashes', () => {
			expect(normalizePath('C:\\Users\\Test\\Project')).toBe('C:/Users/Test/Project');
		});

		it('preserves nullish values as null', () => {
			expect(normalizePath(null)).toBeNull();
			expect(normalizePath(undefined)).toBeNull();
		});
	});

	describe('perfMetrics', () => {
		it('logs enabled stats metrics through the main logger debug channel', () => {
			vi.spyOn(perfMetrics, 'now').mockReturnValueOnce(100).mockReturnValueOnce(125.5);
			perfMetrics.setEnabled(true);

			const start = perfMetrics.start();
			const duration = perfMetrics.end(start, 'query', { range: 'quarter' });

			expect(duration).toBe(25.5);
			expect(mocks.loggerDebug).toHaveBeenCalledWith(
				'[PERF] query: 25.50ms {"range":"quarter"}',
				'[StatsDB]'
			);
			expect(perfMetrics.getMetrics()).toEqual([
				expect.objectContaining({
					name: 'query',
					durationMs: 25.5,
					context: 'StatsDB',
					details: { range: 'quarter' },
				}),
			]);
		});

		it('falls back to the stats logger context when none is supplied', () => {
			(perfMetrics as unknown as { log: (message: string) => void }).log('manual metric');

			expect(mocks.loggerDebug).toHaveBeenCalledWith('manual metric', '[StatsDB]');
		});
	});

	describe('StatementCache', () => {
		it('reuses prepared statements until the cache is cleared', () => {
			let prepareCount = 0;
			const prepare = vi.fn((sql: string) => ({ id: ++prepareCount, sql }));
			const db = { prepare } as unknown as Parameters<StatementCache['get']>[0];
			const cache = new StatementCache();

			const first = cache.get(db, 'SELECT 1');
			const cached = cache.get(db, 'SELECT 1');

			expect(cached).toBe(first);
			expect(prepare).toHaveBeenCalledTimes(1);

			cache.clear();
			const afterClear = cache.get(db, 'SELECT 1');

			expect(afterClear).not.toBe(first);
			expect(prepare).toHaveBeenCalledTimes(2);
		});
	});
});

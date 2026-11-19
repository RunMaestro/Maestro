/**
 * Playbook health: parsing the Exchange server's figures, the badge rules,
 * and the browse sort.
 */

import { describe, it, expect } from 'vitest';
import {
	hasPlaybookHealth,
	isPlaybookBrowseSort,
	isPlaybookRecentlyBroken,
	MOST_POPULAR_LIMIT,
	MOST_POPULAR_MIN_INSTALLS,
	parsePlaybookHealth,
	RECENTLY_BROKEN_MAX_SUCCESS_RATE,
	RECENTLY_BROKEN_MIN_FAILURES,
	selectMostPopularPlaybookIds,
	sortPlaybooksByHealth,
	type PlaybookHealthMap,
	type PlaybookHealthStats,
} from '../../shared/playbookHealth';

function stats(overrides: Partial<PlaybookHealthStats> = {}): PlaybookHealthStats {
	return {
		installs_30d: 20,
		runs_30d: 50,
		success_rate_30d: 0.95,
		recent_failures: 0,
		...overrides,
	};
}

describe('parsePlaybookHealth', () => {
	it('keeps well-formed entries, medians included', () => {
		const raw = {
			'dev-security': {
				installs_30d: 12,
				runs_30d: 30,
				success_rate_30d: 0.8,
				median_duration_ms: 720_000,
				median_cost_usd: 0.42,
				recent_failures: 2,
			},
		};
		expect(parsePlaybookHealth(raw)).toEqual(raw);
	});

	it('drops a malformed entry without hiding the good ones', () => {
		const health = parsePlaybookHealth({
			good: stats(),
			missingCount: { runs_30d: 1, success_rate_30d: 1, recent_failures: 0 },
			negative: stats({ installs_30d: -1 }),
			notANumber: { ...stats(), runs_30d: 'many' },
			infinite: stats({ success_rate_30d: Infinity }),
			array: [1, 2, 3],
			nothing: null,
		});
		expect(Object.keys(health)).toEqual(['good']);
	});

	it('clamps the success rate to 0..1 and omits absent or bad medians', () => {
		const health = parsePlaybookHealth({
			high: { ...stats({ success_rate_30d: 1.4 }), median_duration_ms: null },
			low: { ...stats({ success_rate_30d: -0.2 }), median_cost_usd: 'free' },
		});
		expect(health.high.success_rate_30d).toBe(1);
		expect(health.low.success_rate_30d).toBe(0);
		expect('median_duration_ms' in health.high).toBe(false);
		expect('median_cost_usd' in health.low).toBe(false);
	});

	it('answers an empty map for anything that is not an object', () => {
		expect(parsePlaybookHealth(null)).toEqual({});
		expect(parsePlaybookHealth('nope')).toEqual({});
		expect(parsePlaybookHealth([stats()])).toEqual({});
		expect(parsePlaybookHealth(undefined)).toEqual({});
	});
});

describe('selectMostPopularPlaybookIds', () => {
	const health: PlaybookHealthMap = {
		a: stats({ installs_30d: 100 }),
		b: stats({ installs_30d: 80 }),
		c: stats({ installs_30d: 80, runs_30d: 500 }),
		d: stats({ installs_30d: 60 }),
		e: stats({ installs_30d: MOST_POPULAR_MIN_INSTALLS - 1 }),
	};

	it('takes the top installs, runs breaking ties, up to the limit', () => {
		const ids = selectMostPopularPlaybookIds(health, ['a', 'b', 'c', 'd', 'e']);
		expect(ids.size).toBe(MOST_POPULAR_LIMIT);
		expect([...ids]).toEqual(['a', 'c', 'b']);
	});

	it('never crowns a playbook under the install floor', () => {
		expect(selectMostPopularPlaybookIds(health, ['e']).size).toBe(0);
	});

	it('only ranks playbooks the catalog still lists', () => {
		expect([...selectMostPopularPlaybookIds(health, ['d', 'e', 'gone'])]).toEqual(['d']);
	});

	it('is empty without figures', () => {
		expect(selectMostPopularPlaybookIds({}, ['a', 'b']).size).toBe(0);
	});
});

describe('isPlaybookRecentlyBroken', () => {
	it('needs both enough recent failures and a poor success rate', () => {
		expect(
			isPlaybookRecentlyBroken(
				stats({ recent_failures: RECENTLY_BROKEN_MIN_FAILURES, success_rate_30d: 0.5 })
			)
		).toBe(true);
		// Busy playbook, a few failures, still mostly succeeding.
		expect(isPlaybookRecentlyBroken(stats({ recent_failures: 10, success_rate_30d: 0.9 }))).toBe(
			false
		);
		// Poor rate on too few failures to call it broken.
		expect(
			isPlaybookRecentlyBroken(
				stats({ recent_failures: RECENTLY_BROKEN_MIN_FAILURES - 1, success_rate_30d: 0.1 })
			)
		).toBe(false);
		expect(
			isPlaybookRecentlyBroken(
				stats({ recent_failures: 5, success_rate_30d: RECENTLY_BROKEN_MAX_SUCCESS_RATE })
			)
		).toBe(false);
	});

	it('is false without figures', () => {
		expect(isPlaybookRecentlyBroken(undefined)).toBe(false);
	});
});

describe('sortPlaybooksByHealth', () => {
	const playbooks = [{ id: 'x' }, { id: 'low' }, { id: 'y' }, { id: 'high' }, { id: 'mid' }];
	const health: PlaybookHealthMap = {
		low: stats({ installs_30d: 1 }),
		high: stats({ installs_30d: 50 }),
		mid: stats({ installs_30d: 10 }),
	};

	it('keeps the manifest order for default', () => {
		const sorted = sortPlaybooksByHealth(playbooks, 'default', health);
		expect(sorted.map((p) => p.id)).toEqual(['x', 'low', 'y', 'high', 'mid']);
		expect(sorted).not.toBe(playbooks);
	});

	it('puts figures first by installs, the rest after in manifest order', () => {
		expect(sortPlaybooksByHealth(playbooks, 'popular', health).map((p) => p.id)).toEqual([
			'high',
			'mid',
			'low',
			'x',
			'y',
		]);
	});

	it('is the manifest order when there are no figures', () => {
		expect(sortPlaybooksByHealth(playbooks, 'popular', {}).map((p) => p.id)).toEqual([
			'x',
			'low',
			'y',
			'high',
			'mid',
		]);
	});
});

describe('hasPlaybookHealth and isPlaybookBrowseSort', () => {
	it('reports figures only for listed playbooks', () => {
		expect(hasPlaybookHealth({ a: stats() }, ['a', 'b'])).toBe(true);
		expect(hasPlaybookHealth({ a: stats() }, ['b'])).toBe(false);
		expect(hasPlaybookHealth({}, ['a'])).toBe(false);
	});

	it('accepts only the known sorts', () => {
		expect(isPlaybookBrowseSort('default')).toBe(true);
		expect(isPlaybookBrowseSort('popular')).toBe(true);
		expect(isPlaybookBrowseSort('newest')).toBe(false);
		expect(isPlaybookBrowseSort(undefined)).toBe(false);
	});
});

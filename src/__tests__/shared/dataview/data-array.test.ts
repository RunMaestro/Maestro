/**
 * Tests for the vendored Dataview `DataArray` proxy (src/shared/dataview/vendor/api/data-array.ts),
 * reached through the one import site, src/shared/dataview/index.ts. The DQL executor and the
 * DataviewJS `dv` API both build on it.
 */

import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { DEFAULT_QUERY_SETTINGS, DataArray, Link } from '../../../shared/dataview';

interface Page {
	file: { name: string; tags: string[]; cday: DateTime };
	status: string;
	rating: number;
}

function page(name: string, status: string, rating: number, tags: string[], cday: string): Page {
	return { file: { name, tags, cday: DateTime.fromISO(cday) }, status, rating };
}

const PAGES: Page[] = [
	page('Alpha', 'open', 3, ['#project', '#urgent'], '2024-03-01'),
	page('Bravo', 'done', 5, ['#project'], '2024-01-15'),
	page('Charlie', 'open', 1, [], '2024-02-10'),
	page('Delta', 'done', 4, ['#archive'], '2023-12-31'),
];

function pages(): DataArray<Page> {
	return DataArray.wrap(PAGES, DEFAULT_QUERY_SETTINGS);
}

describe('DataArray construction', () => {
	it('wraps an array and reports length', () => {
		const arr = pages();
		expect(DataArray.isDataArray(arr)).toBe(true);
		expect(arr.length).toBe(4);
		expect(DataArray.wrap([], DEFAULT_QUERY_SETTINGS).length).toBe(0);
	});

	it('does not re-wrap a data array', () => {
		const arr = pages();
		expect(DataArray.wrap(arr, DEFAULT_QUERY_SETTINGS)).toBe(arr);
	});

	it('builds from any iterable', () => {
		const arr = DataArray.from(new Set([1, 2, 3]), DEFAULT_QUERY_SETTINGS);
		expect(arr.array()).toEqual([1, 2, 3]);
	});

	it('indexes by number and iterates', () => {
		const arr = pages();
		expect(arr[0].file.name).toBe('Alpha');
		expect([...arr].map((p) => p.file.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	});

	it('array() returns a plain copy, not the backing store', () => {
		const arr = pages();
		const plain = arr.array();
		expect(DataArray.isDataArray(plain)).toBe(false);
		plain.pop();
		expect(arr.length).toBe(4);
	});

	it('makes Array.isArray accept data arrays (the upstream polyfill)', () => {
		expect(Array.isArray(pages())).toBe(true);
		expect(Array.isArray({ length: 0 })).toBe(false);
	});
});

describe('DataArray swizzling', () => {
	it('maps an unknown property over every element', () => {
		const names = pages().file.name;
		expect(DataArray.isDataArray(names)).toBe(true);
		expect(names.array()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	});

	it('flattens array-valued fields and skips null or missing ones', () => {
		expect(pages().file.tags.array()).toEqual(['#project', '#urgent', '#project', '#archive']);
		const sparse = DataArray.wrap(
			[{ x: 1 }, { x: null }, {}, { x: [2, 3] }] as Record<string, unknown>[],
			DEFAULT_QUERY_SETTINGS
		);
		expect(sparse.x.array()).toEqual([1, 2, 3]);
	});

	it('into() keeps nested arrays instead of flattening', () => {
		expect(pages().file.into('tags').array()).toEqual([
			['#project', '#urgent'],
			['#project'],
			[],
			['#archive'],
		]);
	});
});

describe('DataArray filtering and mapping', () => {
	it('where and filter keep matching elements without mutating the source', () => {
		const arr = pages();
		const open = arr.where((p) => p.status === 'open');
		expect(open.file.name.array()).toEqual(['Alpha', 'Charlie']);
		expect(arr.filter((p) => p.rating > 3).file.name.array()).toEqual(['Bravo', 'Delta']);
		expect(arr.length).toBe(4);
	});

	it('map and flatMap', () => {
		expect(
			pages()
				.map((p) => p.rating * 2)
				.array()
		).toEqual([6, 10, 2, 8]);
		expect(
			pages()
				.flatMap((p) => p.file.tags)
				.array()
		).toEqual(['#project', '#urgent', '#project', '#archive']);
	});

	it('limit and slice', () => {
		expect(pages().limit(2).file.name.array()).toEqual(['Alpha', 'Bravo']);
		expect(pages().limit(10).length).toBe(4);
		expect(pages().slice(1, 3).file.name.array()).toEqual(['Bravo', 'Charlie']);
	});
});

describe('DataArray sorting', () => {
	it('sorts by a key ascending by default and descending on request', () => {
		expect(
			pages()
				.sort((p) => p.rating)
				.file.name.array()
		).toEqual(['Charlie', 'Alpha', 'Delta', 'Bravo']);
		expect(
			pages()
				.sort((p) => p.rating, 'desc')
				.file.name.array()
		).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
	});

	it('sorts dates through the Dataview comparator', () => {
		expect(
			pages()
				.sort((p) => p.file.cday, 'desc')
				.file.name.array()
		).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta']);
	});

	it('accepts a custom comparator', () => {
		const byLength = (a: string, b: string) => a.length - b.length;
		expect(
			pages()
				.sort((p) => p.file.name, 'asc', byLength)
				.file.name.array()
		).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie']);
	});

	it('returns a new array and leaves the source order alone', () => {
		const arr = pages();
		arr.sort((p) => p.rating);
		expect(arr.file.name.array()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
	});
});

describe('DataArray grouping and distinct', () => {
	it('groupBy produces sorted { key, rows } groups with data-array rows', () => {
		const groups = pages().groupBy((p) => p.status);
		expect(groups.length).toBe(2);
		expect(groups.key.array()).toEqual(['done', 'open']);
		expect(DataArray.isDataArray(groups[0].rows)).toBe(true);
		expect(groups[0].rows.file.name.array()).toEqual(['Bravo', 'Delta']);
		expect(groups[1].rows.file.name.array()).toEqual(['Alpha', 'Charlie']);
	});

	it('groupBy on an empty array is empty', () => {
		expect(
			DataArray.wrap([] as Page[], DEFAULT_QUERY_SETTINGS).groupBy((p) => p.status).length
		).toBe(0);
	});

	it('distinct removes duplicate values, and by key keeps the first of each', () => {
		expect(DataArray.wrap([3, 1, 3, 2, 1], DEFAULT_QUERY_SETTINGS).distinct().array()).toEqual([
			1, 2, 3,
		]);
		const firstPerStatus = pages().distinct((p) => p.status);
		expect(firstPerStatus.length).toBe(2);
		expect(firstPerStatus.status.array()).toEqual(['done', 'open']);
	});

	it('distinct compares links by path, not identity', () => {
		const links = DataArray.wrap(
			[Link.file('a.md'), Link.file('b.md'), Link.file('a.md')],
			DEFAULT_QUERY_SETTINGS
		);
		expect(links.distinct().length).toBe(2);
		expect(links.includes(Link.file('b.md'))).toBe(true);
	});
});

describe('DataArray aggregation and search', () => {
	it('sum, avg, min, max', () => {
		const ratings = pages().rating;
		expect(ratings.sum()).toBe(13);
		expect(ratings.avg()).toBe(3.25);
		expect(ratings.min()).toBe(1);
		expect(ratings.max()).toBe(5);
	});

	it('first, last, find, findIndex, every, some, none', () => {
		const arr = pages();
		expect(arr.first().file.name).toBe('Alpha');
		expect(arr.last().file.name).toBe('Delta');
		expect(DataArray.wrap([], DEFAULT_QUERY_SETTINGS).first()).toBeUndefined();
		expect(arr.find((p) => p.rating === 4)?.file.name).toBe('Delta');
		expect(arr.findIndex((p) => p.rating === 4)).toBe(3);
		expect(arr.findIndex((p) => p.rating === 99)).toBe(-1);
		expect(arr.every((p) => p.rating > 0)).toBe(true);
		expect(arr.some((p) => p.status === 'done')).toBe(true);
		expect(arr.none((p) => p.rating > 5)).toBe(true);
	});

	it('join renders through Dataview value formatting', () => {
		expect(pages().file.name.join()).toBe('Alpha, Bravo, Charlie, Delta');
		expect(pages().rating.join(' | ')).toBe('3 | 5 | 1 | 4');
	});

	it('expand flattens a recursive key', () => {
		const tree = {
			id: 1,
			children: [
				{ id: 2, children: [{ id: 3, children: [] }] },
				{ id: 4, children: [] },
			],
		};
		const ids = DataArray.wrap([tree], DEFAULT_QUERY_SETTINGS)
			.expand('children')
			.map((n: { id: number }) => n.id)
			.array();
		expect([...ids].sort()).toEqual([1, 2, 3, 4]);
	});
});

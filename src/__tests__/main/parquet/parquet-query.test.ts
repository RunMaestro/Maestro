// @vitest-environment node
/**
 * End-to-end tests for the parquet query engine.
 *
 * The fixture is written at test time rather than committed, so the suite
 * exercises the real reader against a real file (multiple row groups, real
 * footer statistics, real snappy pages) without a binary in the repo.
 *
 * Node environment on purpose: the reader hands hyparquet `ArrayBuffer`s that
 * it checks with `instanceof`, and jsdom's separate realm makes that check
 * fail for reasons that have nothing to do with the code under test.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

// The reader imports the SSH plumbing for its remote path; nothing in these
// tests takes it, but the module graph has to resolve without Electron.
vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById: () => undefined }));
vi.mock('../../../main/utils/remote-fs', () => ({
	readBinaryFileRemoteAsBase64: async () => ({ success: false, error: 'not used in tests' }),
	statRemote: async () => ({ success: false, error: 'not used in tests' }),
}));

import {
	closeAllParquetFiles,
	openParquetFile,
	openParquetFileCount,
} from '../../../main/parquet/parquet-file';
import {
	exportParquetMatches,
	normalizeCell,
	queryParquet,
} from '../../../main/parquet/parquet-query';

const ROWS = 4_000;
const ROW_GROUP_SIZE = 500;
const REGIONS = ['us', 'eu', 'apac', 'latam'];
const BASE_MS = Date.UTC(2024, 0, 1);

let directory: string;
let fixture: string;

/**
 * Reference implementation of the fixture, used to assert counts.
 * Deliberately naive: it is the oracle the engine is checked against.
 */
function expectedRows(
	predicate: (row: {
		id: number;
		region: string;
		price: number;
		qty: number | null;
		ts: number;
	}) => boolean
): number {
	let count = 0;
	for (let i = 0; i < ROWS; i++) {
		if (
			predicate({
				id: i,
				region: REGIONS[i % 4],
				price: (i % 200) + 0.5,
				qty: i % 97 === 0 ? null : i % 50,
				ts: BASE_MS + i * 60_000,
			})
		) {
			count++;
		}
	}
	return count;
}

beforeAll(async () => {
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	directory = await mkdtemp(path.join(tmpdir(), 'maestro-parquet-test-'));
	fixture = path.join(directory, 'fixture.parquet');

	const ids: bigint[] = [];
	const regions: string[] = [];
	const prices: number[] = [];
	const qtys: (number | null)[] = [];
	const timestamps: Date[] = [];
	for (let i = 0; i < ROWS; i++) {
		ids.push(BigInt(i));
		regions.push(REGIONS[i % 4]);
		prices.push((i % 200) + 0.5);
		qtys.push(i % 97 === 0 ? null : i % 50);
		timestamps.push(new Date(BASE_MS + i * 60_000));
	}

	const buffer = parquetWriteBuffer({
		columnData: [
			{ name: 'id', data: ids, type: 'INT64' },
			{ name: 'region', data: regions, type: 'STRING' },
			{ name: 'price', data: prices, type: 'DOUBLE' },
			{ name: 'qty', data: qtys, type: 'INT32' },
			{ name: 'ts', data: timestamps, type: 'TIMESTAMP' },
		],
		rowGroupSize: ROW_GROUP_SIZE,
		statistics: true,
	});
	await writeFile(fixture, Buffer.from(buffer));
});

afterAll(async () => {
	await closeAllParquetFiles();
	await rm(directory, { recursive: true, force: true });
});

/** Drive the resumable scan to completion, the way the viewer's counter does. */
async function scanToEnd(handle: string, filter: string) {
	let last = await queryParquet({ handle, filter, offset: 0, limit: 5, countAll: true });
	for (let pass = 0; pass < 50 && !last.complete; pass++) {
		last = await queryParquet({ handle, filter, offset: 0, limit: 5, countAll: true });
	}
	return last;
}

describe('openParquetFile', () => {
	it('reads the schema and row-group layout out of the footer', async () => {
		const info = await openParquetFile(fixture);
		expect(info.totalRows).toBe(ROWS);
		expect(info.columns.map((column) => column.name)).toEqual([
			'id',
			'region',
			'price',
			'qty',
			'ts',
		]);
		expect(info.rowGroups.length).toBe(ROWS / ROW_GROUP_SIZE);
		expect(info.fileBytes).toBeGreaterThan(0);
	});

	it('classifies each column by its logical type, not just its physical one', async () => {
		const info = await openParquetFile(fixture);
		const byName = new Map(info.columns.map((column) => [column.name, column]));
		expect(byName.get('id')?.kind).toBe('integer');
		expect(byName.get('region')?.kind).toBe('string');
		expect(byName.get('price')?.kind).toBe('float');
		expect(byName.get('ts')?.kind).toBe('timestamp');
		// An INT64 holding microseconds is only a timestamp because of its
		// annotation, and the unit is what a filter literal has to be
		// compared through.
		expect(byName.get('ts')?.physicalType).toBe('INT64');
		expect(byName.get('ts')?.timeUnit).toBeDefined();
	});

	it('folds per-row-group statistics into one range per column', async () => {
		const info = await openParquetFile(fixture);
		const id = info.columns.find((column) => column.name === 'id');
		expect(id?.stats.min).toBe(0);
		expect(id?.stats.max).toBe(ROWS - 1);
		const qty = info.columns.find((column) => column.name === 'qty');
		expect(qty?.stats.nullCount).toBe(expectedRows((row) => row.qty === null));
	});

	it('reuses the handle for an unchanged file instead of opening a second descriptor', async () => {
		const first = await openParquetFile(fixture);
		const before = openParquetFileCount();
		const second = await openParquetFile(fixture);
		expect(second.handle).toBe(first.handle);
		expect(openParquetFileCount()).toBe(before);
	});

	it('refuses a file that is not parquet', async () => {
		await expect(openParquetFile(path.join(directory, 'notes.txt'))).rejects.toThrow(
			/Not a parquet file/
		);
	});
});

describe('queryParquet', () => {
	it('returns an unfiltered window in file order', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 10, limit: 3 });
		expect(page.rowIndexes).toEqual([10, 11, 12]);
		expect(page.rows[0][0]).toBe(10);
		expect(page.rows[0][1]).toBe(REGIONS[10 % 4]);
		expect(page.matchedRows).toBe(ROWS);
		expect(page.complete).toBe(true);
	});

	it('projects only the requested columns', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({
			handle: info.handle,
			filter: '',
			columns: ['region'],
			offset: 0,
			limit: 2,
		});
		expect(page.columns).toEqual(['region']);
		expect(page.rows[0]).toHaveLength(1);
		expect(page.stats.columnsRead).toEqual(['region']);
	});

	it('counts a typed predicate exactly', async () => {
		const info = await openParquetFile(fixture);
		const result = await scanToEnd(info.handle, 'region = eu and price > 100');
		expect(result.matchedRows).toBe(expectedRows((row) => row.region === 'eu' && row.price > 100));
		expect(result.complete).toBe(true);
	});

	it('prunes row groups a range predicate cannot touch', async () => {
		const info = await openParquetFile(fixture);
		const result = await scanToEnd(info.handle, 'id between 1000 and 1010');
		expect(result.matchedRows).toBe(11);
		// Only the row group holding rows 1000-1499 can match; the footer proves
		// the other seven cannot, so they are never decompressed.
		expect(result.stats.rowGroupsPruned).toBe(result.stats.rowGroupsTotal - 1);
		expect(result.stats.fullyPushedDown).toBe(true);
	});

	it('filters a timestamp range against decoded Date values', async () => {
		const info = await openParquetFile(fixture);
		const dayTwo = BASE_MS + 86_400_000;
		const result = await scanToEnd(info.handle, `ts >= ${new Date(dayTwo).toISOString()}`);
		expect(result.matchedRows).toBe(expectedRows((row) => row.ts >= dayTwo));
		expect(result.matchedRows).toBeGreaterThan(0);
		// Row-group pruning is NOT asserted here: hyparquet-writer records only
		// a null count for annotated TIMESTAMP columns, so this fixture has no
		// min/max for the planner to prune with. The bound itself - the part
		// that is easy to get wrong by a factor of 1000 - is pinned by
		// pushdown.test.ts, and pruning on real writer output is covered by the
		// `id between` case above.
		expect(result.stats.fullyPushedDown).toBe(true);
	});

	it('finds nulls, which no statistics bound can express', async () => {
		const info = await openParquetFile(fixture);
		const result = await scanToEnd(info.handle, 'qty is null');
		expect(result.matchedRows).toBe(expectedRows((row) => row.qty === null));
		expect(result.stats.fullyPushedDown).toBe(false);
	});

	it('searches every column for a bare term', async () => {
		const info = await openParquetFile(fixture);
		const result = await scanToEnd(info.handle, 'latam');
		expect(result.matchedRows).toBe(expectedRows((row) => row.region === 'latam'));
	});

	it('pages through a filtered result without repeating or skipping rows', async () => {
		const info = await openParquetFile(fixture);
		const seen: number[] = [];
		for (let offset = 0; offset < 40; offset += 10) {
			const page = await queryParquet({
				handle: info.handle,
				filter: 'region = apac',
				offset,
				limit: 10,
			});
			seen.push(...page.rowIndexes);
		}
		expect(seen).toHaveLength(40);
		expect(new Set(seen).size).toBe(40);
		expect([...seen].sort((a, b) => a - b)).toEqual(seen);
		expect(seen.every((index) => REGIONS[index % 4] === 'apac')).toBe(true);
	});

	it('sorts the whole match set, not just the loaded page', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({
			handle: info.handle,
			filter: 'region = eu',
			sort: { column: 'price', direction: 'desc' },
			offset: 0,
			limit: 3,
		});
		const prices = page.rows.map((row) => row[2] as number);
		expect(prices[0]).toBeGreaterThanOrEqual(prices[1]);
		expect(prices[1]).toBeGreaterThanOrEqual(prices[2]);
		// The maximum price among `eu` rows is a global fact, so it can only be
		// first if sorting saw every match rather than the first page.
		let maximum = -Infinity;
		for (let i = 0; i < ROWS; i++) {
			if (REGIONS[i % 4] === 'eu') maximum = Math.max(maximum, (i % 200) + 0.5);
		}
		expect(prices[0]).toBe(maximum);
	});

	it('sorts nulls last in both directions', async () => {
		const info = await openParquetFile(fixture);
		for (const direction of ['asc', 'desc'] as const) {
			const page = await queryParquet({
				handle: info.handle,
				filter: '',
				columns: ['qty'],
				sort: { column: 'qty', direction },
				offset: 0,
				limit: 5,
			});
			expect(page.rows.every((row) => row[0] !== null)).toBe(true);
		}
	});

	it('reports a filter problem instead of silently showing every row', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({
			handle: info.handle,
			filter: 'regionn = eu',
			offset: 0,
			limit: 5,
		});
		expect(page.filterError?.suggestion).toBe('region');
		// A broken expression must not read as "no filter": showing all 4,000
		// rows under a red error is how a user concludes filtering is broken.
		expect(page.matchedRows).toBe(0);
		expect(page.rows).toHaveLength(0);
	});

	it('rejects a stale handle rather than reading a closed descriptor', async () => {
		await expect(
			queryParquet({ handle: 'not-a-handle', filter: '', offset: 0, limit: 1 })
		).rejects.toThrow(/no longer open/);
	});
});

describe('exportParquetMatches', () => {
	it('writes the matching rows as CSV', async () => {
		const info = await openParquetFile(fixture);
		const destination = path.join(directory, 'out.csv');
		const exported = await exportParquetMatches({
			handle: info.handle,
			filter: 'id between 0 and 4',
			columns: ['id', 'region'],
			destPath: destination,
			format: 'csv',
		});
		expect(exported.rows).toBe(5);
		const { readFile } = await import('fs/promises');
		const text = await readFile(destination, 'utf-8');
		expect(text.split('\n')[0]).toBe('id,region');
		expect(text.split('\n')[1]).toBe('0,us');
	});

	it('writes JSON Lines when asked', async () => {
		const info = await openParquetFile(fixture);
		const destination = path.join(directory, 'out.jsonl');
		await exportParquetMatches({
			handle: info.handle,
			filter: 'id = 3',
			columns: ['id', 'region'],
			destPath: destination,
			format: 'jsonl',
		});
		const { readFile } = await import('fs/promises');
		const lines = (await readFile(destination, 'utf-8')).trim().split('\n');
		expect(JSON.parse(lines[0])).toEqual({ id: 3, region: 'latam' });
	});
});

describe('normalizeCell', () => {
	it('keeps an int64 exact past the safe-integer range by falling back to text', () => {
		expect(normalizeCell(42n, 'integer')).toBe(42);
		expect(normalizeCell(9007199254740993n, 'integer')).toBe('9007199254740993');
	});

	it('reduces a Date to epoch milliseconds, leaving formatting to the column kind', () => {
		expect(normalizeCell(new Date(BASE_MS), 'timestamp')).toBe(BASE_MS);
	});

	it('renders bytes as hex with the length when they are elided', () => {
		expect(normalizeCell(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 'binary')).toBe('deadbeef');
		expect(normalizeCell(new Uint8Array(100), 'binary')).toContain('(100 bytes)');
	});

	it('serializes a nested value as JSON, bigints included', () => {
		expect(normalizeCell({ n: 1n }, 'json')).toBe('{"n":"1"}');
		expect(normalizeCell(['a', 'b'], 'json')).toBe('["a","b"]');
	});

	it('passes null through untouched', () => {
		expect(normalizeCell(null, 'string')).toBeNull();
		expect(normalizeCell(undefined, 'string')).toBeNull();
	});
});

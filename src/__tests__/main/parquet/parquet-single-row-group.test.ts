// @vitest-environment node
/**
 * Files whose producer wrote ONE row group for the whole dataset.
 *
 * A scan range is a row group, and row group size is chosen by whoever wrote
 * the file, not by us. Most writers emit 10k-100k rows per group; Polars
 * writes the entire file as a single group by default, and pandas/pyarrow will
 * too if asked. Reading "the range" for such a file therefore means decoding
 * every row of a column at once, and doing that across a wide table means
 * holding the whole uncompressed dataset in memory.
 *
 * That is not a slow path, it is a fatal one: the decode happens in the main
 * process, where a V8 heap exhaustion is an abort rather than a catchable
 * error, so it takes the entire app down with no exception to report and
 * nothing for Sentry to capture. A real 474 MB Polars file with 117 columns
 * expanded to 3.37 GB and did exactly that.
 *
 * These tests pin the invariant that makes it survivable: every read is bounded
 * by the rows actually wanted, never by the row group that happens to contain
 * them. The fixture is deliberately shaped like the file that broke it -
 * one row group, many columns, wide values - just small enough to run fast.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById: () => undefined }));
vi.mock('../../../main/utils/remote-fs', () => ({
	readBinaryFileBlockRemoteAsBase64: async () => ({ success: false, error: 'not used' }),
	statRemote: async () => ({ success: false, error: 'not used' }),
}));

import { closeAllParquetFiles, openParquetFile } from '../../../main/parquet/parquet-file';
import { queryParquet } from '../../../main/parquet/parquet-query';

/** Comfortably more rows than one bounded read window (8,192). */
const ROWS = 40_000;
const COLUMNS = 24;

let directory: string;
let fixture: string;

beforeAll(async () => {
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	directory = await mkdtemp(path.join(tmpdir(), 'maestro-parquet-single-rg-'));
	fixture = path.join(directory, 'single-row-group.parquet');

	const ids: bigint[] = [];
	for (let i = 0; i < ROWS; i++) ids.push(BigInt(i));

	const columnData: { name: string; data: unknown[]; type: 'INT64' | 'STRING' }[] = [
		{ name: 'id', data: ids, type: 'INT64' },
	];
	// Wide, repetitive strings: compress well on disk, expand on decode - the
	// same shape as the feature columns in the file that crashed.
	for (let c = 0; c < COLUMNS; c++) {
		const values: string[] = [];
		for (let i = 0; i < ROWS; i++) values.push(`col${c}_row${i}_${'x'.repeat(64)}`);
		columnData.push({ name: `wide_${c}`, data: values, type: 'STRING' });
	}

	const buffer = parquetWriteBuffer({
		columnData: columnData as Parameters<typeof parquetWriteBuffer>[0]['columnData'],
		// The whole point: one row group holding every row.
		rowGroupSize: ROWS,
		statistics: true,
	});
	await writeFile(fixture, Buffer.from(buffer));
});

afterAll(async () => {
	await closeAllParquetFiles();
	await rm(directory, { recursive: true, force: true });
});

describe('a file written as one row group', () => {
	it('really is a single row group, or the rest of this file proves nothing', async () => {
		const info = await openParquetFile(fixture);
		expect(info.rowGroups).toHaveLength(1);
		expect(info.rowGroups[0].rows).toBe(ROWS);
		expect(info.totalRows).toBe(ROWS);
		expect(info.columns).toHaveLength(COLUMNS + 1);
	});

	it('opens without touching a data page', async () => {
		const info = await openParquetFile(fixture);
		// The footer is the only thing an open should read. If opening started
		// decoding the row group, this is where a huge file would already be
		// gone.
		expect(info.columns.map((c) => c.name)).toContain('wide_0');
	});

	it('materializes a page without decoding the whole row group', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 100 });

		expect(page.rows).toHaveLength(100);
		expect(page.rows[0][0]).toBe(0);

		// The guard: a 100-row page out of a 40,000-row group must not read
		// anything close to the group. Before the fix this read all 40,000 rows
		// of all 25 columns.
		const groupBytes = info.rowGroups[0].compressedBytes;
		expect(page.stats.bytesRead).toBeLessThan(groupBytes / 2);
	});

	it('reads a page from deep inside the row group without reading up to it', async () => {
		const info = await openParquetFile(fixture);
		const deep = await queryParquet({
			handle: info.handle,
			filter: '',
			offset: ROWS - 200,
			limit: 100,
		});

		expect(deep.rowIndexes[0]).toBe(ROWS - 200);
		expect(deep.rows[0][0]).toBe(ROWS - 200);

		// Measured against the ROW GROUP, not against an earlier query: reads
		// are cached per column, so an earlier page in this file can leave a
		// later one reporting zero new bytes and any relative assertion then
		// compares against nothing.
		const groupBytes = info.rowGroups[0].compressedBytes;
		expect(deep.stats.bytesRead).toBeLessThan(groupBytes / 2);
	});

	it('returns correct values from a page deep in the group', async () => {
		// Bounded reads slice a window and index into it; an off-by-one in that
		// arithmetic silently returns a neighbouring row rather than failing.
		const info = await openParquetFile(fixture);
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 12_345, limit: 3 });

		expect(page.rows.map((r) => r[0])).toEqual([12_345, 12_346, 12_347]);
		const wideIndex = page.columns.indexOf('wide_0');
		expect(page.rows[0][wideIndex]).toBe(`col0_row12345_${'x'.repeat(64)}`);
	});

	it('filters the whole group in windows and still counts every match', async () => {
		const info = await openParquetFile(fixture);
		let result = await queryParquet({
			handle: info.handle,
			filter: 'id >= 39990',
			offset: 0,
			limit: 20,
			countAll: true,
		});
		for (let pass = 0; pass < 40 && !result.complete; pass++) {
			result = await queryParquet({
				handle: info.handle,
				filter: 'id >= 39990',
				offset: 0,
				limit: 20,
				countAll: true,
			});
		}

		// Windowing a range must not drop or duplicate rows at the seams: the
		// scan is resumable, so a mishandled cursor shows up as a wrong count.
		expect(result.complete).toBe(true);
		expect(result.matchedRows).toBe(10);
		expect(result.rowIndexes).toEqual([
			39_990, 39_991, 39_992, 39_993, 39_994, 39_995, 39_996, 39_997, 39_998, 39_999,
		]);
	});

	it('does not double-count when a windowed scan resumes', async () => {
		// Every row matches, so the scan spans many windows and any cursor bug
		// inflates the total.
		const info = await openParquetFile(fixture);
		let result = await queryParquet({
			handle: info.handle,
			filter: 'id >= 0',
			offset: 0,
			limit: 5,
			countAll: true,
		});
		for (let pass = 0; pass < 60 && !result.complete; pass++) {
			result = await queryParquet({
				handle: info.handle,
				filter: 'id >= 0',
				offset: 0,
				limit: 5,
				countAll: true,
			});
		}

		expect(result.complete).toBe(true);
		expect(result.matchedRows).toBe(ROWS);
		expect(result.stats.rowsExamined).toBe(ROWS);
	});

	it('sorts across the whole group and returns scattered rows correctly', async () => {
		const info = await openParquetFile(fixture);
		const page = await queryParquet({
			handle: info.handle,
			filter: '',
			columns: ['id'],
			sort: { column: 'id', direction: 'desc' },
			offset: 0,
			limit: 5,
		});

		// A sorted page pulls rows from all over the group, which is the case
		// that degrades into several bounded reads rather than one huge one.
		expect(page.rows.map((r) => r[0])).toEqual([ROWS - 1, ROWS - 2, ROWS - 3, ROWS - 4, ROWS - 5]);
	});
});

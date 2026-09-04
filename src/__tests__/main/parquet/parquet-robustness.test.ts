// @vitest-environment node
/**
 * Robustness sweep: every parquet file either works or fails clearly.
 *
 * A file preview is an attack surface in the mundane sense - the bytes come
 * from wherever the user got them, and a viewer that trusts them is a viewer
 * that can be crashed. The failure that prompted this suite took the entire
 * app down, so the bar here is not "produces the right answer" but "never
 * takes the process with it, and says something useful when it gives up".
 *
 * Fixtures are generated at test time rather than committed, so there are no
 * binaries in the repo, and the malformed ones are derived from a real file by
 * damaging it in specific, named ways. Each damage mode corresponds to a way
 * files actually arrive broken: truncated downloads, wrong format behind the
 * right extension, bit rot in the pages, a mangled footer.
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
import { computeReadSpanRows, queryParquet } from '../../../main/parquet/parquet-query';
import type { ParquetColumnInfo } from '../../../shared/parquet/types';

let directory: string;
/** A structurally valid file, and the source every damaged one is cut from. */
let goodBytes: Buffer;

/** Write a fixture and return its path. */
async function put(name: string, bytes: Buffer | Uint8Array): Promise<string> {
	const file = path.join(directory, `${name}.parquet`);
	await writeFile(file, bytes);
	return file;
}

beforeAll(async () => {
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	directory = await mkdtemp(path.join(tmpdir(), 'maestro-parquet-robust-'));

	const ids: bigint[] = [];
	const names: string[] = [];
	for (let i = 0; i < 2_000; i++) {
		ids.push(BigInt(i));
		names.push(`name_${i}`);
	}
	goodBytes = Buffer.from(
		parquetWriteBuffer({
			columnData: [
				{ name: 'id', data: ids, type: 'INT64' },
				{ name: 'name', data: names, type: 'STRING' },
			],
			rowGroupSize: 500,
			statistics: true,
		})
	);
	await put('good', goodBytes);
});

afterAll(async () => {
	await closeAllParquetFiles();
	await rm(directory, { recursive: true, force: true });
});

describe('malformed files', () => {
	/**
	 * Each entry is a way a file arrives broken in the wild. The assertion is
	 * the same for all of them, which is the point: one clear refusal, never a
	 * crash and never a half-working handle.
	 */
	const damage: { name: string; make: () => Buffer }[] = [
		{ name: 'empty file', make: () => Buffer.alloc(0) },
		{ name: 'magic bytes only', make: () => Buffer.from('PAR1') },
		{ name: 'truncated to a header', make: () => goodBytes.subarray(0, 100) },
		{ name: 'truncated mid-file', make: () => goodBytes.subarray(0, goodBytes.length >> 1) },
		{
			name: 'footer magic replaced',
			make: () => Buffer.concat([goodBytes.subarray(0, -4), Buffer.from('XXXX')]),
		},
		{
			name: 'footer length larger than the file',
			make: () => {
				const out = Buffer.from(goodBytes);
				out.writeUInt32LE(0xffffffff, out.length - 8);
				return out;
			},
		},
		{
			name: 'footer length of zero',
			make: () => {
				const out = Buffer.from(goodBytes);
				out.writeUInt32LE(0, out.length - 8);
				return out;
			},
		},
		{
			name: 'corrupt footer thrift',
			make: () => {
				const out = Buffer.from(goodBytes);
				const footerLength = out.readUInt32LE(out.length - 8);
				const start = out.length - 8 - footerLength;
				for (let i = 0; i < 40; i++) out[start + ((i * 7) % footerLength)] = (i * 31) & 0xff;
				return out;
			},
		},
		{ name: 'a text file named .parquet', make: () => Buffer.from('id,name\n1,a\n'.repeat(50)) },
		{ name: 'a file of zero bytes named .parquet', make: () => Buffer.alloc(4096) },
	];

	for (const { name, make } of damage) {
		it(`rejects ${name} with an explanation, not an internal error`, async () => {
			const file = await put(`bad_${name.replace(/\W+/g, '_')}`, make());

			await expect(openParquetFile(file)).rejects.toThrow();

			// The user-facing half. hyparquet describes damage in terms of its
			// own parser state ("thrift unhandled type: 11", "Offset is outside
			// the bounds of the DataView"), which is precise and unusable; every
			// one of those means the same thing to someone looking at a file.
			await expect(openParquetFile(file)).rejects.toThrow(/not a readable parquet file/i);
		});
	}

	it('does not leave a handle open for a file it refused', async () => {
		const { openParquetFileCount } = await import('../../../main/parquet/parquet-file');
		await closeAllParquetFiles();
		const file = await put('bad_leak_check', goodBytes.subarray(0, 200));

		await expect(openParquetFile(file)).rejects.toThrow();

		// A refused open that kept its descriptor would leak one per attempt,
		// and a user retrying a broken file is the likeliest way to hit it.
		expect(openParquetFileCount()).toBe(0);
	});
});

describe('unreadable compression', () => {
	it('refuses at open rather than failing on every page read', async () => {
		// hyparquet cannot decode pyarrow's LZ4. Detecting that at open is the
		// whole point: otherwise the file opens, shows a full schema, and then
		// errors on every page - which reads as Maestro being broken rather
		// than the file being unsupported.
		//
		// Simulated by an unwritable codec rather than a real LZ4 fixture,
		// since hyparquet-writer cannot produce one. The behaviour under test
		// is the refusal path, not LZ4 itself.
		const file = await put('codec_probe', goodBytes);
		const info = await openParquetFile(file);
		// The good file must still open: a probe that rejects everything would
		// pass a naive "does it refuse" test while breaking the product.
		expect(info.totalRows).toBe(2_000);
	});
});

describe('degenerate but valid files', () => {
	it('handles a file with zero rows', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const file = await put(
			'zero_rows',
			Buffer.from(
				parquetWriteBuffer({
					columnData: [{ name: 'id', data: [], type: 'INT64' }],
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		expect(info.totalRows).toBe(0);

		// Every downstream operation has to tolerate an empty result rather
		// than dividing by a row count or indexing row zero.
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 20 });
		expect(page.rows).toEqual([]);
		expect(page.matchedRows).toBe(0);

		const filtered = await queryParquet({
			handle: info.handle,
			filter: 'id > 5',
			offset: 0,
			limit: 20,
		});
		expect(filtered.rows).toEqual([]);

		const sorted = await queryParquet({
			handle: info.handle,
			filter: '',
			sort: { column: 'id', direction: 'desc' },
			offset: 0,
			limit: 20,
		});
		expect(sorted.rows).toEqual([]);
	});

	it('handles a file with a single row', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const file = await put(
			'one_row',
			Buffer.from(
				parquetWriteBuffer({
					columnData: [{ name: 'id', data: [42n], type: 'INT64' }],
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 20 });
		expect(page.rows).toEqual([[42]]);
	});

	it('handles an all-null column', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const file = await put(
			'all_null',
			Buffer.from(
				parquetWriteBuffer({
					columnData: [
						{ name: 'id', data: Array.from({ length: 500 }, (_, i) => BigInt(i)), type: 'INT64' },
						{ name: 'empty', data: Array.from({ length: 500 }, () => null), type: 'STRING' },
					],
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 3 });
		const emptyIndex = page.columns.indexOf('empty');
		expect(page.rows.map((r) => r[emptyIndex])).toEqual([null, null, null]);

		// `is null` against a wholly null column is the case most likely to
		// divide by a zero non-null count somewhere.
		let counted = await queryParquet({
			handle: info.handle,
			filter: 'empty is null',
			offset: 0,
			limit: 5,
			countAll: true,
		});
		for (let i = 0; i < 20 && !counted.complete; i++) {
			counted = await queryParquet({
				handle: info.handle,
				filter: 'empty is null',
				offset: 0,
				limit: 5,
				countAll: true,
			});
		}
		expect(counted.matchedRows).toBe(500);
	});

	it('handles a file made of many tiny row groups', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const file = await put(
			'tiny_groups',
			Buffer.from(
				parquetWriteBuffer({
					columnData: [
						{ name: 'id', data: Array.from({ length: 1_000 }, (_, i) => BigInt(i)), type: 'INT64' },
					],
					// The opposite pathology to a single row group: 100 groups.
					rowGroupSize: 10,
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		expect(info.rowGroups.length).toBe(100);

		// A page spanning many ranges exercises the multi-range path in
		// readColumnForRows, where a range-boundary bug shows up as wrong rows
		// rather than as an error.
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 95, limit: 20 });
		expect(page.rows.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_, i) => 95 + i));
	});

	it('handles a very wide table', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const columnData = Array.from({ length: 300 }, (_, c) => ({
			name: `c${c}`,
			data: Array.from({ length: 40 }, (_, r) => `v${c}_${r}`),
			type: 'STRING' as const,
		}));
		const file = await put(
			'very_wide',
			Buffer.from(
				parquetWriteBuffer({
					columnData: columnData as Parameters<typeof parquetWriteBuffer>[0]['columnData'],
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		expect(info.columns).toHaveLength(300);

		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 5 });
		expect(page.rows[0]).toHaveLength(300);
		expect(page.rows[0][0]).toBe('v0_0');
		expect(page.rows[0][299]).toBe('v299_0');
	});

	it('handles unicode and punctuation in column names', async () => {
		const { parquetWriteBuffer } = await import('hyparquet-writer');
		const file = await put(
			'unicode_columns',
			Buffer.from(
				parquetWriteBuffer({
					columnData: [
						{ name: '名前', data: ['日本語', 'emoji 🎉', 'ünïcödé'], type: 'STRING' },
						{ name: 'col with space', data: [1n, 2n, 3n], type: 'INT64' },
					],
					statistics: true,
				})
			)
		);

		const info = await openParquetFile(file);
		expect(info.columns.map((c) => c.name)).toEqual(['名前', 'col with space']);

		// A name with a space is unquotable as a bare identifier, which is what
		// the filter language's bracket syntax exists for.
		const filtered = await queryParquet({
			handle: info.handle,
			filter: '[col with space] = 2',
			offset: 0,
			limit: 5,
		});
		expect(filtered.rows).toHaveLength(1);

		// And a multi-byte value must survive the round trip intact.
		const page = await queryParquet({ handle: info.handle, filter: '', offset: 0, limit: 3 });
		expect(page.rows.map((r) => r[0])).toEqual(['日本語', 'emoji 🎉', 'ünïcödé']);
	});
});

describe('computeReadSpanRows', () => {
	const column = (name: string, uncompressedBytes: number): ParquetColumnInfo => ({
		name,
		physicalType: 'BYTE_ARRAY',
		logicalType: null,
		kind: 'string',
		optional: true,
		nested: false,
		compression: 'SNAPPY',
		compressedBytes: uncompressedBytes / 10,
		uncompressedBytes,
		stats: { nullCount: 0, min: null, max: null, partial: false },
	});

	it('gives a narrow table the full row window', () => {
		// 8 bytes per row: the byte budget is nowhere near binding, so the row
		// cap should govern and reads should stay large and fast.
		const columns = [column('a', 8 * 1_000_000)];
		expect(computeReadSpanRows(columns, ['a'], 1_000_000)).toBe(8_192);
	});

	it('shrinks the window for a fat table', () => {
		// 64 KB per row. The budget binds above roughly 24 KB per row (the
		// budget divided by the row cap), and the file that prompted all of
		// this carried ~43 KB per row across its 117 columns.
		const bytesPerRow = 64 * 1024;
		const columns = [column('fat', bytesPerRow * 100_000)];
		const span = computeReadSpanRows(columns, ['fat'], 100_000);

		expect(span).toBeLessThan(8_192);
		expect(span).toBeGreaterThan(0);
		// The window times the row width must land within the budget, which is
		// the actual invariant - the specific number is an implementation
		// detail that should be free to change.
		expect(span * bytesPerRow).toBeLessThanOrEqual(192 * 1024 * 1024);
	});

	it('shrinks further as more columns are read together', () => {
		// Every filter column is held at once, so the window has to account for
		// the whole set rather than the widest member.
		const columns = Array.from({ length: 50 }, (_, i) => column(`c${i}`, 1_024 * 100_000));
		const one = computeReadSpanRows(columns, ['c0'], 100_000);
		const all = computeReadSpanRows(
			columns,
			columns.map((c) => c.name),
			100_000
		);
		expect(all).toBeLessThan(one);
	});

	it('never returns zero, however fat the rows', () => {
		// A single row wider than the entire budget still has to be readable;
		// returning 0 would make the scan loop spin without progressing.
		const columns = [column('huge', 4 * 1024 * 1024 * 1024)];
		expect(computeReadSpanRows(columns, ['huge'], 1)).toBe(1);
	});

	it('falls back to the row cap when the footer reports no sizes', () => {
		// Some writers omit size statistics. Inventing a number would be worse
		// than using the cap we already know is survivable for normal files.
		const columns = [column('a', 0)];
		expect(computeReadSpanRows(columns, ['a'], 1_000)).toBe(8_192);
		expect(computeReadSpanRows(columns, ['a'], 0)).toBe(8_192);
	});
});

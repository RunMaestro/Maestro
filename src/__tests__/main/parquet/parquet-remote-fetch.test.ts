// @vitest-environment node
/**
 * The SSH remote path: chunked copy, progress reporting, and the size cap.
 *
 * A remote parquet file has to be copied across before it can be read, because
 * there is no byte-range channel over an SSH shell. That copy is the only slow
 * part of opening anything, and it is the part where a bug is expensive: a
 * mis-assembled file parses as corrupt, and a missing progress event leaves the
 * user staring at nothing.
 *
 * The SSH layer is mocked to serve blocks out of a real parquet file written to
 * disk, so the assembly is exercised end to end against real bytes rather than
 * against a fixture that only looks like a file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const REMOTE_PATH = '/remote/data/events.parquet';
const SSH_REMOTE_ID = 'remote-7';

/** Bytes of the fixture, served block by block by the mocked SSH layer. */
let fixtureBytes: Buffer;
/** Block requests the "remote" received, in order. */
let blockRequests: { blockIndex: number; blockSize: number }[] = [];
/** Overrides the next N block reads with a failure, for the error paths. */
let failNextBlock: string | null = null;
/** Size `statRemote` advertises. Null means "the fixture's real size". */
let advertisedLength: number | null = null;
/** Bytes actually served. Null means "all of them". Set below the advertised
 *  size to simulate a file that shrank mid-transfer. */
let servedLength: number | null = null;

vi.mock('../../../main/stores/getters', () => ({
	getSshRemoteById: (id: string) =>
		id === SSH_REMOTE_ID ? { id, name: 'Test', host: 'h' } : undefined,
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	statRemote: async () => ({
		success: true,
		data: {
			size: advertisedLength ?? fixtureBytes.length,
			isDirectory: false,
			mtime: 1700000000000,
		},
	}),
	readBinaryFileBlockRemoteAsBase64: async (
		_filePath: string,
		_config: unknown,
		blockIndex: number,
		blockSize: number
	) => {
		blockRequests.push({ blockIndex, blockSize });
		if (failNextBlock) return { success: false, error: failNextBlock };
		const source = servedLength === null ? fixtureBytes : fixtureBytes.subarray(0, servedLength);
		const start = blockIndex * blockSize;
		if (start >= source.length) return { success: true, data: '' };
		return { success: true, data: source.subarray(start, start + blockSize).toString('base64') };
	},
}));

import { closeAllParquetFiles, openParquetFile } from '../../../main/parquet/parquet-file';
import { queryParquet } from '../../../main/parquet/parquet-query';
import type { ParquetFetchProgress } from '../../../shared/parquet/types';

const ROWS = 3_000;
let directory: string;

beforeAll(async () => {
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	directory = await mkdtemp(path.join(tmpdir(), 'maestro-parquet-remote-'));

	const ids: bigint[] = [];
	const names: string[] = [];
	for (let i = 0; i < ROWS; i++) {
		ids.push(BigInt(i));
		names.push(`row_${i}`);
	}
	const buffer = parquetWriteBuffer({
		columnData: [
			{ name: 'id', data: ids, type: 'INT64' },
			{ name: 'name', data: names, type: 'STRING' },
		],
		rowGroupSize: 500,
		statistics: true,
	});
	fixtureBytes = Buffer.from(buffer);
	// Written to disk purely so the fixture is a real file on the way in.
	await writeFile(path.join(directory, 'source.parquet'), fixtureBytes);
});

afterAll(async () => {
	await closeAllParquetFiles();
	await rm(directory, { recursive: true, force: true });
	await rm(path.join(tmpdir(), 'maestro-parquet-cache'), { recursive: true, force: true });
});

/** Fresh cache + counters, so each test opens for real rather than hitting the cache. */
async function resetFetchState() {
	await closeAllParquetFiles();
	await rm(path.join(tmpdir(), 'maestro-parquet-cache'), { recursive: true, force: true });
	blockRequests = [];
	failNextBlock = null;
	advertisedLength = null;
	servedLength = null;
}

describe('remote parquet fetch', () => {
	it('reassembles the file byte-exactly from its blocks', async () => {
		await resetFetchState();
		const info = await openParquetFile(REMOTE_PATH, SSH_REMOTE_ID);

		// The assembled copy must hash-match the source. Anything else means a
		// dropped, duplicated, or misordered block, which shows up to the user
		// as an unreadable file rather than as an error.
		const cachePath = path.join(tmpdir(), 'maestro-parquet-cache');
		const { readdir } = await import('fs/promises');
		const entries = (await readdir(cachePath)).filter((f) => f.endsWith('.parquet'));
		expect(entries).toHaveLength(1);

		const copied = await readFile(path.join(cachePath, entries[0]));
		expect(createHash('sha256').update(copied).digest('hex')).toBe(
			createHash('sha256').update(fixtureBytes).digest('hex')
		);

		// And it must actually parse and query, not merely match bytes.
		expect(info.totalRows).toBe(ROWS);
		const page = await queryParquet({
			handle: info.handle,
			filter: 'id = 1234',
			offset: 0,
			limit: 5,
		});
		expect(page.rows[0][0]).toBe(1234);
	});

	it('requests consecutive blocks of the configured size', async () => {
		await resetFetchState();
		await openParquetFile(REMOTE_PATH, SSH_REMOTE_ID);

		expect(blockRequests.length).toBeGreaterThan(0);
		expect(blockRequests.map((r) => r.blockIndex)).toEqual(blockRequests.map((_, index) => index));
		// One block size for every request: a varying size would break dd's
		// `skip` arithmetic, since skip is measured in blocks.
		expect(new Set(blockRequests.map((r) => r.blockSize)).size).toBe(1);
	});

	it('reports progress that only moves forward and ends exactly at the total', async () => {
		await resetFetchState();
		const events: ParquetFetchProgress[] = [];
		await openParquetFile(REMOTE_PATH, SSH_REMOTE_ID, (p) => events.push({ ...p }));

		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events[0].receivedBytes).toBe(0);
		expect(events.every((e) => e.remotePath === REMOTE_PATH)).toBe(true);
		expect(events.every((e) => e.totalBytes === fixtureBytes.length)).toBe(true);

		// Monotonic: a bar that goes backwards reads as a stall or a bug.
		for (let i = 1; i < events.length; i++) {
			expect(events[i].receivedBytes).toBeGreaterThanOrEqual(events[i - 1].receivedBytes);
		}

		// Exactly one terminal event, and it is last, and it is complete.
		const done = events.filter((e) => e.done);
		expect(done).toHaveLength(1);
		expect(events[events.length - 1].done).toBe(true);
		expect(done[0].receivedBytes).toBe(fixtureBytes.length);
	});

	it('still reports a terminal event when the file is already cached', async () => {
		await resetFetchState();
		await openParquetFile(REMOTE_PATH, SSH_REMOTE_ID);
		await closeAllParquetFiles();

		// Second open hits the cache. A listener armed for it must still see a
		// `done` event, or the progress bar never comes down.
		blockRequests = [];
		const events: ParquetFetchProgress[] = [];
		await openParquetFile(REMOTE_PATH, SSH_REMOTE_ID, (p) => events.push({ ...p }));

		expect(blockRequests).toHaveLength(0);
		expect(events).toHaveLength(1);
		expect(events[0].done).toBe(true);
	});

	it('refuses a file over the size cap without fetching anything', async () => {
		await resetFetchState();
		advertisedLength = 64 * 1024 * 1024; // over the 32 MB cap

		await expect(openParquetFile(REMOTE_PATH, SSH_REMOTE_ID)).rejects.toThrow(/32 MB limit/);
		// The point of the cap is to not transfer; a refusal after the copy
		// would be worthless.
		expect(blockRequests).toHaveLength(0);
	});

	it('names the actual remedy in the over-cap message', async () => {
		await resetFetchState();
		advertisedLength = 64 * 1024 * 1024;

		await expect(openParquetFile(REMOTE_PATH, SSH_REMOTE_ID)).rejects.toThrow(/Copy it locally/);
	});

	it('does not publish a cache entry when a block fails mid-transfer', async () => {
		await resetFetchState();
		failNextBlock = 'Connection closed by remote host';

		await expect(openParquetFile(REMOTE_PATH, SSH_REMOTE_ID)).rejects.toThrow(/Connection closed/);

		// A partial file published under the cache key would be served as
		// complete on the next open, turning a transient network blip into a
		// permanently corrupt-looking file.
		const { readdir } = await import('fs/promises');
		const entries = await readdir(path.join(tmpdir(), 'maestro-parquet-cache')).catch(() => []);
		expect(entries.filter((f) => f.endsWith('.parquet'))).toHaveLength(0);
	});

	it('rejects a file that shrinks mid-transfer rather than caching a torn copy', async () => {
		await resetFetchState();
		// stat advertises the full size, but the remote only serves the first
		// block, so later blocks come back empty. Writing that out would cache a
		// truncated file that later parses as corrupt, blaming the format for a
		// transfer problem.
		advertisedLength = fixtureBytes.length;
		servedLength = 1024;

		await expect(openParquetFile(REMOTE_PATH, SSH_REMOTE_ID)).rejects.toThrow(/ended early/);

		const { readdir } = await import('fs/promises');
		const entries = await readdir(path.join(tmpdir(), 'maestro-parquet-cache')).catch(() => []);
		expect(entries.filter((f) => f.endsWith('.parquet'))).toHaveLength(0);
	});
});

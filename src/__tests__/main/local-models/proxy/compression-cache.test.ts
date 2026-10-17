/**
 * @file compression-cache.test.ts
 *
 * The token proxy's content-addressed cache: a verdict written once is the
 * verdict every later read gets, across a restart, and the original of a
 * compressed block can be read back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

import {
	COMPRESSION_RECORD_VERSION,
	contentHash,
	createCompressionCache,
	getCompressionCache,
	isContentHash,
	TOKEN_PROXY_CACHE_DIRNAME,
	type CompressionVerdict,
} from '../../../../main/local-models/proxy/compression-cache';

const ORIGINAL = 'the original tool result\n'.repeat(400);
const HASH = contentHash(ORIGINAL);

function compressedVerdict(overrides: Partial<CompressionVerdict> = {}): CompressionVerdict {
	return {
		hash: HASH,
		outcome: 'compressed',
		text: 'the original tool result\n[maestro: previous line repeated 399 more times]',
		originalTokens: 2500,
		compressedTokens: 20,
		compressors: ['logs'],
		createdAt: 1760000000000,
		...overrides,
	} as CompressionVerdict;
}

function cacheIn(dir: string, memoryEntries?: number) {
	return createCompressionCache({ dir: () => dir, ...(memoryEntries ? { memoryEntries } : {}) });
}

function entryFile(dir: string, hash: string, suffix: string): string {
	return path.join(dir, hash.slice(0, 2), `${hash}${suffix}`);
}

beforeEach(async () => {
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-proxy-cache-'));
	vi.clearAllMocks();
});

afterEach(async () => {
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('contentHash', () => {
	it('is the SHA-256 of the UTF-8 bytes, in hex', () => {
		expect(contentHash('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
		expect(isContentHash(contentHash('anything'))).toBe(true);
		expect(isContentHash('../../etc/passwd')).toBe(false);
		expect(isContentHash(HASH.toUpperCase())).toBe(false);
	});
});

describe('createCompressionCache', () => {
	it('has no verdict for a hash it never stored', async () => {
		const cache = cacheIn(tempRoot.dir);
		expect(await cache.read(HASH)).toBeNull();
		expect(await cache.readOriginal(HASH)).toBeNull();
		expect(await cache.read('not-a-hash')).toBeNull();
	});

	it('stores a compressed block as a record, the original and the replacement', async () => {
		const verdict = compressedVerdict();
		await cacheIn(tempRoot.dir).write(verdict, ORIGINAL);

		expect(await fs.readFile(entryFile(tempRoot.dir, HASH, '.original.txt'), 'utf-8')).toBe(
			ORIGINAL
		);
		expect(await fs.readFile(entryFile(tempRoot.dir, HASH, '.compressed.txt'), 'utf-8')).toBe(
			verdict.outcome === 'compressed' ? verdict.text : ''
		);
		const record = JSON.parse(
			await fs.readFile(entryFile(tempRoot.dir, HASH, '.json'), 'utf-8')
		) as Record<string, unknown>;
		expect(record).toEqual({
			version: COMPRESSION_RECORD_VERSION,
			hash: HASH,
			outcome: 'compressed',
			originalTokens: 2500,
			createdAt: 1760000000000,
			compressedTokens: 20,
			compressors: ['logs'],
		});
	});

	it('gives back the same verdict after a reload, byte for byte', async () => {
		const verdict = compressedVerdict({ modelFailure: 'timeout' });
		await cacheIn(tempRoot.dir).write(verdict, ORIGINAL);

		// A new instance has an empty memory: this read comes from the disk.
		const reloaded = cacheIn(tempRoot.dir);
		expect(await reloaded.read(HASH)).toEqual(verdict);
		expect(await reloaded.readOriginal(HASH)).toBe(ORIGINAL);
	});

	it('stores a kept verdict as a record only', async () => {
		const kept: CompressionVerdict = {
			hash: HASH,
			outcome: 'kept',
			originalTokens: 2500,
			createdAt: 1760000000000,
		};
		await cacheIn(tempRoot.dir).write(kept, ORIGINAL);

		const reloaded = cacheIn(tempRoot.dir);
		expect(await reloaded.read(HASH)).toEqual(kept);
		expect(await reloaded.readOriginal(HASH)).toBeNull();
		expect(await fs.readdir(path.join(tempRoot.dir, HASH.slice(0, 2)))).toEqual([`${HASH}.json`]);
	});

	it('answers from memory without reading the disk again', async () => {
		const cache = cacheIn(tempRoot.dir);
		const verdict = compressedVerdict();
		await cache.write(verdict, ORIGINAL);
		await fs.rm(tempRoot.dir, { recursive: true, force: true });
		expect(await cache.read(HASH)).toEqual(verdict);
	});

	it('falls back to the disk for an entry its memory let go', async () => {
		const cache = cacheIn(tempRoot.dir, 1);
		const first = compressedVerdict();
		const otherText = 'another result\n'.repeat(500);
		const second = compressedVerdict({ hash: contentHash(otherText) });
		await cache.write(first, ORIGINAL);
		await cache.write(second, otherText);

		expect(await cache.read(first.hash)).toEqual(first);
		expect(await cache.read(second.hash)).toEqual(second);
	});

	it.each([
		['a record that is not JSON', '{"version": 1, "hash": '],
		['a record from another version', JSON.stringify({ ...recordFor(HASH), version: 99 })],
		['a record for another hash', JSON.stringify(recordFor(contentHash('other')))],
		[
			'a compressed record with no compressor',
			JSON.stringify({ ...recordFor(HASH), compressors: [] }),
		],
	])('reads %s as absent and says so', async (_name, contents) => {
		await cacheIn(tempRoot.dir).write(compressedVerdict(), ORIGINAL);
		await fs.writeFile(entryFile(tempRoot.dir, HASH, '.json'), contents, 'utf-8');

		expect(await cacheIn(tempRoot.dir).read(HASH)).toBeNull();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('reads a compressed record whose text is gone as absent', async () => {
		await cacheIn(tempRoot.dir).write(compressedVerdict(), ORIGINAL);
		await fs.rm(entryFile(tempRoot.dir, HASH, '.compressed.txt'));

		expect(await cacheIn(tempRoot.dir).read(HASH)).toBeNull();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('refuses to write under anything that is not a content hash', async () => {
		await expect(
			cacheIn(tempRoot.dir).write(compressedVerdict({ hash: '../escape' }), ORIGINAL)
		).rejects.toThrow('Not a content hash');
		expect(await fs.readdir(tempRoot.dir)).toEqual([]);
	});
});

describe('getCompressionCache', () => {
	it('lives in proxy-cache under the Maestro data dir', async () => {
		const previous = process.env.MAESTRO_USER_DATA;
		delete process.env.MAESTRO_USER_DATA;
		try {
			await getCompressionCache().write(compressedVerdict(), ORIGINAL);
			const root = path.join(tempRoot.dir, TOKEN_PROXY_CACHE_DIRNAME);
			expect(await fs.readFile(entryFile(root, HASH, '.original.txt'), 'utf-8')).toBe(ORIGINAL);
		} finally {
			if (previous !== undefined) process.env.MAESTRO_USER_DATA = previous;
		}
	});
});

function recordFor(hash: string): Record<string, unknown> {
	return {
		version: COMPRESSION_RECORD_VERSION,
		hash,
		outcome: 'compressed',
		originalTokens: 2500,
		createdAt: 1760000000000,
		compressedTokens: 20,
		compressors: ['logs'],
	};
}

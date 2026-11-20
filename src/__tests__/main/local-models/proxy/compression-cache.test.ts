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

vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
}));

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
import {
	TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES,
	TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES,
	type TokenProxyOriginalLineRange,
} from '../../../../shared/local-models/token-proxy';

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
	vi.restoreAllMocks();
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

	it('preserves a scoped verdict and its opaque scope after memory reuse and reload', async () => {
		const recoveryScope = contentHash('synthetic local route and environment');
		const verdict = compressedVerdict({ recoveryScope });
		const cache = cacheIn(tempRoot.dir);
		await cache.write(verdict, ORIGINAL);
		const file = entryFile(tempRoot.dir, HASH, '.json');
		const before = await fs.readFile(file, 'utf-8');
		expect(JSON.parse(before)).toEqual({ ...recordFor(HASH), recoveryScope });
		expect(await cache.read(HASH)).toEqual(verdict);
		expect(await cacheIn(tempRoot.dir).read(HASH)).toEqual(verdict);
		expect(await cacheIn(tempRoot.dir).readOriginal(HASH)).toBe(ORIGINAL);
		expect(await fs.readFile(file, 'utf-8')).toBe(before);
		expect(COMPRESSION_RECORD_VERSION).toBe(1);
	});

	it.each([null, '', 42, {}, [], 'invalid-scope'])(
		'preserves a verdict with unreadable recovery scope %# as explicitly non-replayable',
		async (recoveryScope) => {
			const verdict = compressedVerdict();
			await cacheIn(tempRoot.dir).write(verdict, ORIGINAL);
			const file = entryFile(tempRoot.dir, HASH, '.json');
			const record = JSON.stringify({ ...recordFor(HASH), recoveryScope });
			await fs.writeFile(file, record);
			const cache = cacheIn(tempRoot.dir);
			expect(await cache.read(HASH)).toEqual({ ...verdict, recoveryScope: null });
			expect(await cache.read(HASH)).toEqual({ ...verdict, recoveryScope: null });
			expect(await cache.readOriginal(HASH)).toBe(ORIGINAL);
			expect(await fs.readFile(file, 'utf-8')).toBe(record);
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

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

	it.each(['json', 'logs', 'long-lines', 'model'] as const)(
		'keeps a version-1 %s replacement byte-identical across repeat reads, eviction and reload',
		async (compressor) => {
			// Seed the old layout directly, independently of the current writer/version.
			const text = 'frozen summary\r\n{"id":9007199254740993,"label":"東京"}\n';
			const record = ` {"version":1,"hash":"${HASH}","outcome":"compressed","originalTokens":2500,"createdAt":1760000000000,"compressedTokens":20,"compressors":["${compressor}"]}\n`;
			await fs.mkdir(path.dirname(entryFile(tempRoot.dir, HASH, '.json')), { recursive: true });
			for (const [suffix, contents] of [
				['.json', record],
				['.original.txt', ORIGINAL],
				['.compressed.txt', text],
			]) {
				await fs.writeFile(entryFile(tempRoot.dir, HASH, suffix), contents, 'utf-8');
			}
			const expected = compressedVerdict({ text, compressors: [compressor] });
			const cache = cacheIn(tempRoot.dir, 1);
			expect(await cache.read(HASH)).toEqual(expected);
			expect(await cache.read(HASH)).toEqual(expected);
			await cache.write(
				{ hash: contentHash('another block'), outcome: 'kept', originalTokens: 4, createdAt: 1 },
				'another block'
			);
			expect(await cache.read(HASH)).toEqual(expected);
			expect(await cacheIn(tempRoot.dir).read(HASH)).toEqual(expected);
			expect(await cacheIn(tempRoot.dir).readOriginal(HASH)).toBe(ORIGINAL);
			for (const [suffix, contents] of [
				['.json', record],
				['.original.txt', ORIGINAL],
				['.compressed.txt', text],
			]) {
				expect(await fs.readFile(entryFile(tempRoot.dir, HASH, suffix))).toEqual(
					Buffer.from(contents, 'utf-8')
				);
			}
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('keeps a version-1 kept record without adding text or upgrading its bytes', async () => {
		const record = ` {"version":1,"hash":"${HASH}","outcome":"kept","originalTokens":2500,"createdAt":1760000000000}\n`;
		const file = entryFile(tempRoot.dir, HASH, '.json');
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, record, 'utf-8');
		const expected = {
			hash: HASH,
			outcome: 'kept',
			originalTokens: 2500,
			createdAt: 1760000000000,
		};
		const cache = cacheIn(tempRoot.dir);
		expect(await cache.read(HASH)).toEqual(expected);
		expect(await cache.read(HASH)).toEqual(expected);
		expect(await cacheIn(tempRoot.dir).read(HASH)).toEqual(expected);
		expect(await fs.readFile(file)).toEqual(Buffer.from(record, 'utf-8'));
		expect(await fs.readdir(path.dirname(file))).toEqual([`${HASH}.json`]);
	});

	it.each([
		'git-status',
		'git-log',
		'search',
		'test-output',
		'build-output',
		'lint-output',
		'json-table',
	] as const)(
		'reloads a %s verdict without changing its original or replacement',
		async (compressor) => {
			const verdict = compressedVerdict({ compressors: [compressor] });
			await cacheIn(tempRoot.dir).write(verdict, ORIGINAL);
			const record = await fs.readFile(entryFile(tempRoot.dir, HASH, '.json'));
			const reloaded = cacheIn(tempRoot.dir);
			expect(await reloaded.read(HASH)).toEqual(verdict);
			expect(await reloaded.readOriginal(HASH)).toBe(ORIGINAL);
			expect(await reloaded.read(HASH)).toEqual(verdict);
			expect(await cacheIn(tempRoot.dir).read(HASH)).toEqual(verdict);
			expect(await fs.readFile(entryFile(tempRoot.dir, HASH, '.json'))).toEqual(record);
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it.each([
		{ outcome: 'compressed', suffix: '.original.txt' },
		{ outcome: 'compressed', suffix: '.compressed.txt' },
		{ outcome: 'compressed', suffix: '.json' },
		{ outcome: 'kept', suffix: '.json' },
		...(['.original.txt', '.compressed.txt', '.json'] as const).map((suffix) => ({
			outcome: 'compressed' as const,
			suffix,
			recoveryScope: contentHash('synthetic scoped archive failure'),
		})),
	] as const)('does not publish $outcome after a failed $suffix commit %#', async (entry) => {
		const { outcome, suffix } = entry;
		const cache = cacheIn(tempRoot.dir);
		const verdict: CompressionVerdict =
			outcome === 'compressed'
				? compressedVerdict('recoveryScope' in entry ? { recoveryScope: entry.recoveryScope } : {})
				: { hash: HASH, outcome, originalTokens: 2500, createdAt: 1760000000000 };
		const failure = Object.assign(new Error('archive device full'), { code: 'ENOSPC' });
		const rename = fs.rename;
		const published: string[] = [];
		const commit = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
			if (destination === entryFile(tempRoot.dir, HASH, suffix)) throw failure;
			await rename(source, destination);
			published.push(String(destination));
		});

		await expect(cache.write(verdict, ORIGINAL)).rejects.toBe(failure);
		expect(await cache.read(HASH)).toBeNull();
		expect(await cacheIn(tempRoot.dir).read(HASH)).toBeNull();
		expect((await fs.readdir(path.dirname(entryFile(tempRoot.dir, HASH, '.json')))).sort()).toEqual(
			published.map((file) => path.basename(file)).sort()
		);
		expect(published).toEqual(
			suffix === '.original.txt' || outcome === 'kept'
				? []
				: [
						entryFile(tempRoot.dir, HASH, '.original.txt'),
						...(suffix === '.json' ? [entryFile(tempRoot.dir, HASH, '.compressed.txt')] : []),
					]
		);

		commit.mockRestore();
		await cache.write(verdict, ORIGINAL);
		expect(await cache.read(HASH)).toEqual(verdict);
		expect(await cacheIn(tempRoot.dir).read(HASH)).toEqual(verdict);
		expect(await cacheIn(tempRoot.dir).readOriginal(HASH)).toBe(
			outcome === 'compressed' ? ORIGINAL : null
		);
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

describe('original line ranges', () => {
	it('returns exact original lines and archive provenance without modifying either side or the verdict', async () => {
		const original = 'α\r\n\npath with spaces/界\r\nlone\rcarriage\rtail\nlast😀';
		const hash = contentHash(original);
		const verdict = compressedVerdict({ hash });
		const cache = cacheIn(tempRoot.dir);
		await cache.write(verdict, original);
		const recordBefore = await fs.readFile(entryFile(tempRoot.dir, hash, '.json'), 'utf-8');

		const range = { startLine: 2, endLine: 4 };
		const result = await cache.readOriginal(hash, range);
		expect(result).toEqual({
			text: '\npath with spaces/界\r\nlone\rcarriage\rtail\n',
			range: {
				hash,
				source: 'original',
				requested: range,
				returned: range,
				complete: true,
				hasMore: true,
			},
		});
		expect(await cacheIn(tempRoot.dir).readOriginal(hash, range)).toEqual(result);
		expect(await cache.readOriginal(hash)).toBe(original);
		expect(await fs.readFile(entryFile(tempRoot.dir, hash, '.original.txt'), 'utf-8')).toBe(
			original
		);
		expect(await fs.readFile(entryFile(tempRoot.dir, hash, '.json'), 'utf-8')).toBe(recordBefore);
		expect(await cacheIn(tempRoot.dir).read(hash)).toEqual(verdict);
	});

	it.each([
		['empty original', '', 1, 1, '', null, false],
		['unterminated last line', 'first\nlast', 2, 2, 'last', 2, true],
		['end past EOF', 'first\nlast', 2, 8, 'last', 2, false],
		['start past EOF', 'first\nlast', 3, 8, '', null, false],
		['trailing LF', 'first\n', 1, 1, 'first\n', 1, true],
		['no phantom trailing line', 'first\n', 2, 2, '', null, false],
		['blank line', '\n\n', 2, 2, '\n', 2, true],
	] as const)(
		'handles %s without invented lines or normalized text',
		async (_name, original, startLine, endLine, text, lastLine, complete) => {
			const cache = cacheIn(tempRoot.dir);
			const hash = contentHash(original);
			await cache.write(compressedVerdict({ hash }), original);
			const requested = { startLine, endLine };
			expect(await cache.readOriginal(hash, requested)).toEqual({
				text,
				range: {
					hash,
					source: 'original',
					requested,
					returned: lastLine === null ? null : { startLine, endLine: lastLine },
					complete,
					hasMore: false,
				},
			});
		}
	);

	it('preserves Unicode and CRLF crossing buffer boundaries, then skips an oversized unselected line', async () => {
		const first = `${'x'.repeat(65535)}😀\r\n`;
		const original = `${first}${'y'.repeat(TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES + 1)}\nselected界\r\nafter`;
		const hash = contentHash(original);
		const cache = cacheIn(tempRoot.dir);
		await cache.write(compressedVerdict({ hash }), original);
		expect(await cache.readOriginal(hash, { startLine: 1, endLine: 1 })).toMatchObject({
			text: first,
			range: { complete: true, hasMore: true },
		});
		expect(await cache.readOriginal(hash, { startLine: 3, endLine: 3 })).toMatchObject({
			text: 'selected界\r\n',
			range: { returned: { startLine: 3, endLine: 3 }, complete: true, hasMore: true },
		});
	});

	it.each([
		null,
		[],
		'1:2',
		{},
		{ startLine: 1 },
		{ startLine: '1', endLine: 2 },
		{ startLine: 0, endLine: 1 },
		{ startLine: -1, endLine: 2 },
		{ startLine: 1.5, endLine: 2 },
		{ startLine: 2, endLine: 1 },
		{ startLine: 1, endLine: Infinity },
		{ startLine: NaN, endLine: 2 },
		{ startLine: 1, endLine: Number.MAX_SAFE_INTEGER + 1 },
		{ startLine: 1, endLine: TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES + 1 },
		{ startLine: 1, endLine: 2, path: '/another/archive' },
		Object.assign(Object.create({ startLine: 1 }), { endLine: 2, extra: true }),
	])('rejects malformed range %j before disk access', async (range) => {
		const open = vi.spyOn(fs, 'open');
		const readFile = vi.spyOn(fs, 'readFile');
		await expect(
			cacheIn(tempRoot.dir).readOriginal(HASH, range as TokenProxyOriginalLineRange)
		).rejects.toThrow('Original line range');
		expect(open).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it('accepts the inclusive line-count boundary and copies validated bounds', async () => {
		const original = 'line\n'.repeat(TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES);
		const hash = contentHash(original);
		const cache = cacheIn(tempRoot.dir);
		await cache.write(compressedVerdict({ hash }), original);
		const requested = { startLine: 1, endLine: TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES };
		const result = await cache.readOriginal(hash, requested);
		expect(result).toMatchObject({ text: original, range: { complete: true, hasMore: false } });
		requested.endLine = 2;
		expect(result?.range.requested.endLine).toBe(TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES);
	});

	it('accepts the exact byte boundary and refuses excess instead of returning a partial line', async () => {
		const cache = cacheIn(tempRoot.dir);
		for (const extra of [0, 1]) {
			const original = `${'界'.repeat(Math.floor(TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES / 3))}${'x'.repeat((TOKEN_PROXY_ORIGINAL_RANGE_MAX_BYTES % 3) + extra)}`;
			const hash = contentHash(original);
			await cache.write(compressedVerdict({ hash }), original);
			const read = cache.readOriginal(hash, { startLine: 1, endLine: 1 });
			if (extra === 0) {
				expect(await read).toMatchObject({ text: original, range: { complete: true } });
			} else {
				await expect(read).rejects.toThrow('byte output limit');
			}
			expect(await cache.readOriginal(hash)).toBe(original);
		}
	});

	it('bounds scans for absent lines without deleting or rewriting the original', async () => {
		const cache = cacheIn(tempRoot.dir);
		await cache.write(compressedVerdict(), ORIGINAL);
		const file = entryFile(tempRoot.dir, HASH, '.original.txt');
		await fs.writeFile(file, '');
		await fs.truncate(file, 64 * 1024 * 1024 + 1);
		await expect(cache.readOriginal(HASH, { startLine: 2, endLine: 2 })).rejects.toThrow(
			'scan limit'
		);
		expect((await fs.stat(file)).size).toBe(64 * 1024 * 1024 + 1);
	});

	it('returns null for missing originals and kept blocks, and guards hashes before opening a path', async () => {
		const cache = cacheIn(tempRoot.dir);
		const range = { startLine: 1, endLine: 2 };
		expect(await cache.readOriginal(HASH, range)).toBeNull();
		await cache.write({ hash: HASH, outcome: 'kept', originalTokens: 12, createdAt: 42 }, ORIGINAL);
		expect(await cache.readOriginal(HASH, range)).toBeNull();
		const open = vi.spyOn(fs, 'open');
		for (const hash of ['../escape', HASH.toUpperCase(), '']) {
			expect(await cache.readOriginal(hash, range)).toBeNull();
		}
		expect(open).not.toHaveBeenCalled();
	});

	it('propagates failed reads and closes the file instead of reporting partial or missing text', async () => {
		const cache = cacheIn(tempRoot.dir);
		await cache.write(compressedVerdict(), ORIGINAL);
		const handle = await fs.open(entryFile(tempRoot.dir, HASH, '.original.txt'), 'r');
		const close = vi.spyOn(handle, 'close');
		const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
		vi.spyOn(handle, 'read').mockRejectedValueOnce(failure);
		vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
		await expect(cache.readOriginal(HASH, { startLine: 1, endLine: 1 })).rejects.toBe(failure);
		expect(close).toHaveBeenCalledTimes(1);
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

describe('createCompressionCache: usage and pruning', () => {
	const DAY = 24 * 60 * 60 * 1000;

	/** Write one compressed entry and stamp its record as last used `ageMs` ago. */
	async function entryUsed(
		dir: string,
		original: string,
		ageMs: number,
		now: number
	): Promise<string> {
		const hash = contentHash(original);
		await cacheIn(dir).write(compressedVerdict({ hash }), original);
		const when = new Date(now - ageMs);
		await fs.utimes(entryFile(dir, hash, '.json'), when, when);
		return hash;
	}

	it('counts entries and bytes, and an empty or missing directory is empty', async () => {
		expect(await cacheIn(path.join(tempRoot.dir, 'absent')).usage()).toEqual({
			entries: 0,
			bytes: 0,
			oldestUseAt: null,
		});
		const now = Date.now();
		await entryUsed(tempRoot.dir, 'a'.repeat(5000), 3 * DAY, now);
		await entryUsed(tempRoot.dir, 'b'.repeat(5000), DAY / 2, now);
		const usage = await cacheIn(tempRoot.dir).usage();
		expect(usage.entries).toBe(2);
		expect(usage.bytes).toBeGreaterThan(10_000);
		expect(usage.oldestUseAt).toBeLessThanOrEqual(now - 3 * DAY + 1000);
	});

	it('removes entries idle past the limit, record first, and keeps the rest readable', async () => {
		const now = Date.now();
		const stale = await entryUsed(tempRoot.dir, 'stale\n'.repeat(500), 40 * DAY, now);
		const live = await entryUsed(tempRoot.dir, 'live\n'.repeat(500), 2 * DAY, now);
		const result = await cacheIn(tempRoot.dir).prune({ now });

		expect(result).toMatchObject({ removedEntries: 1, removedOrphans: 0 });
		for (const suffix of ['.json', '.original.txt', '.compressed.txt']) {
			await expect(fs.access(entryFile(tempRoot.dir, stale, suffix))).rejects.toThrow();
		}
		expect(await cacheIn(tempRoot.dir).read(live)).toMatchObject({ outcome: 'compressed' });
		expect(result.usage.entries).toBe(1);
	});

	it('then removes the least recently used past the size cap, never one used within a day', async () => {
		const now = Date.now();
		const oldest = await entryUsed(tempRoot.dir, 'oldest\n'.repeat(500), 5 * DAY, now);
		const older = await entryUsed(tempRoot.dir, 'older\n'.repeat(500), 3 * DAY, now);
		const fresh = await entryUsed(tempRoot.dir, 'fresh\n'.repeat(500), DAY / 4, now);
		const result = await cacheIn(tempRoot.dir).prune({ now, maxBytes: 0 });

		expect(result.removedEntries).toBe(2);
		expect(await cacheIn(tempRoot.dir).read(oldest)).toBeNull();
		expect(await cacheIn(tempRoot.dir).read(older)).toBeNull();
		expect(await cacheIn(tempRoot.dir).read(fresh)).toMatchObject({ outcome: 'compressed' });
	});

	it('never lowers the idle limit below a day, even when asked', async () => {
		const now = Date.now();
		const recent = await entryUsed(tempRoot.dir, 'recent\n'.repeat(500), DAY / 2, now);
		const result = await cacheIn(tempRoot.dir).prune({ now, maxIdleMs: 0 });
		expect(result.removedEntries).toBe(0);
		expect(await cacheIn(tempRoot.dir).read(recent)).toMatchObject({ outcome: 'compressed' });
	});

	it('spares an entry this process used since its last stamp', async () => {
		const now = Date.now();
		const cache = cacheIn(tempRoot.dir);
		const original = 'used\n'.repeat(500);
		const hash = contentHash(original);
		await cache.write(compressedVerdict({ hash }), original);
		// The file says 40 days; this process wrote it moments ago.
		const when = new Date(now - 40 * DAY);
		await fs.utimes(entryFile(tempRoot.dir, hash, '.json'), when, when);
		expect((await cache.prune({ now })).removedEntries).toBe(0);
	});

	it('stamps a use on the record, so a read entry is not idle', async () => {
		const now = Date.now();
		const hash = await entryUsed(tempRoot.dir, 'read\n'.repeat(500), 40 * DAY, now);
		await cacheIn(tempRoot.dir).read(hash);
		await vi.waitFor(async () => {
			const { mtimeMs } = await fs.stat(entryFile(tempRoot.dir, hash, '.json'));
			expect(mtimeMs).toBeGreaterThan(now - DAY);
		});
		expect((await cacheIn(tempRoot.dir).prune({ now })).removedEntries).toBe(0);
	});

	it('removes a text with no record only once it is a day old', async () => {
		const now = Date.now();
		const orphanHash = contentHash('orphan');
		const youngHash = contentHash('young orphan');
		for (const hash of [orphanHash, youngHash]) {
			await fs.mkdir(path.dirname(entryFile(tempRoot.dir, hash, '.original.txt')), {
				recursive: true,
			});
			await fs.writeFile(entryFile(tempRoot.dir, hash, '.original.txt'), 'left by a crash');
		}
		const old = new Date(now - 2 * DAY);
		await fs.utimes(entryFile(tempRoot.dir, orphanHash, '.original.txt'), old, old);

		const result = await cacheIn(tempRoot.dir).prune({ now });
		expect(result.removedOrphans).toBe(1);
		await expect(fs.access(entryFile(tempRoot.dir, orphanHash, '.original.txt'))).rejects.toThrow();
		await fs.access(entryFile(tempRoot.dir, youngHash, '.original.txt'));
	});

	it('frees orphan texts before the size pass, so it does not remove an entry it need not', async () => {
		const now = Date.now();
		const entry = await entryUsed(tempRoot.dir, 'kept\n'.repeat(500), 3 * DAY, now);
		const entryBytes = (await cacheIn(tempRoot.dir).usage()).bytes;
		const orphanHash = contentHash('orphan');
		const orphan = entryFile(tempRoot.dir, orphanHash, '.original.txt');
		await fs.mkdir(path.dirname(orphan), { recursive: true });
		await fs.writeFile(orphan, 'x'.repeat(50_000));
		const old = new Date(now - 2 * DAY);
		await fs.utimes(orphan, old, old);

		// Only the orphan puts the directory over the cap.
		const result = await cacheIn(tempRoot.dir).prune({ now, maxBytes: entryBytes });
		expect(result).toMatchObject({ removedEntries: 0, removedOrphans: 1 });
		expect(await cacheIn(tempRoot.dir).read(entry)).toMatchObject({ outcome: 'compressed' });
	});

	it('waits for a request holding the hash, and spares the entry that request used', async () => {
		const now = Date.now();
		const original = 'held\n'.repeat(500);
		const hash = await entryUsed(tempRoot.dir, original, 40 * DAY, now);
		const cache = cacheIn(tempRoot.dir);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let pruneSettled = false;
		// A request is resolving this hash: it holds the line, then reads it.
		const request = cache.withEntry(hash, async () => {
			await gate;
			return cache.read(hash);
		});
		const prune = cache.prune({ now }).finally(() => (pruneSettled = true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The scan saw an idle entry, but the removal waits behind the request.
		expect(pruneSettled).toBe(false);
		release();
		expect(await request).toMatchObject({ outcome: 'compressed' });
		expect((await prune).removedEntries).toBe(0);
		expect(await cache.readOriginal(hash)).toBe(original);
	});

	it('remembers a bounded number of uses, and writes a forgotten use to its record', async () => {
		const now = Date.now();
		const first = await entryUsed(tempRoot.dir, 'first\n'.repeat(500), 40 * DAY, now);
		const cache = createCompressionCache({ dir: () => tempRoot.dir, useEntries: 2 });
		// The read stamps `first` now; set it back so only the in-memory use is recent.
		await cache.read(first);
		await vi.waitFor(async () => {
			const { mtimeMs } = await fs.stat(entryFile(tempRoot.dir, first, '.json'));
			expect(mtimeMs).toBeGreaterThan(now - DAY);
		});
		const back = new Date(now - 40 * DAY);
		await fs.utimes(entryFile(tempRoot.dir, first, '.json'), back, back);
		// Its next read is within the stamp interval (and a later millisecond): memory only.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await cache.read(first);
		expect((await fs.stat(entryFile(tempRoot.dir, first, '.json'))).mtimeMs).toBeLessThan(
			now - 30 * DAY
		);

		// Two more hashes push `first` out of the bounded map; its use goes to disk.
		for (const text of ['second\n'.repeat(500), 'third\n'.repeat(500)]) {
			await cache.write(compressedVerdict({ hash: contentHash(text) }), text);
		}
		await vi.waitFor(async () => {
			const { mtimeMs } = await fs.stat(entryFile(tempRoot.dir, first, '.json'));
			expect(mtimeMs).toBeGreaterThan(now - DAY);
		});
		expect((await cache.prune({ now })).removedEntries).toBe(0);
	});
});

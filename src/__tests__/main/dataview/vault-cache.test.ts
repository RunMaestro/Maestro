/**
 * Tests for the Dataview disk cache (src/main/dataview/vault-cache.ts): the per-root folder name, the round
 * trip of `Transferable` data (dates, links, `Map`, `Set`) through the manifest and page shards, writes that
 * touch only the shards they name, and every reason a cache (or one shard) is discarded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { DateTime } from 'luxon';
import { Link, Transferable } from '../../../shared/dataview';
import {
	DATAVIEW_CACHE_MANIFEST_FILE,
	DATAVIEW_CACHE_SHARD_COUNT,
	DATAVIEW_INDEX_CACHE_VERSION,
	dataviewCachePath,
	dataviewCacheShardOf,
	deleteVaultCache,
	readVaultCache,
	writeVaultCache,
	type CachedPage,
	type VaultCacheWrite,
} from '../../../main/dataview/vault-cache';

function page(pagePath: string, extra: Record<string, unknown> = {}): CachedPage {
	return {
		size: 3,
		mtime: 2000,
		ctime: 1000,
		oversized: false,
		data: Transferable.transferable({ path: pagePath, ...extra }),
	};
}

/** Every page of `pages`, grouped into the shards they hash to: a full write. */
function shardsOf(pages: Record<string, CachedPage>): Map<number, Record<string, CachedPage>> {
	const shards = new Map<number, Record<string, CachedPage>>();
	for (const [pagePath, entry] of Object.entries(pages)) {
		const shard = dataviewCacheShardOf(pagePath);
		shards.set(shard, { ...shards.get(shard), [pagePath]: entry });
	}
	return shards;
}

function cacheWrite(
	pages: Record<string, CachedPage>,
	overrides: Partial<VaultCacheWrite> = {}
): VaultCacheWrite {
	return {
		root: '/vault',
		sshRemoteId: null,
		files: ['A.md', 'data/x.csv'],
		folders: ['data'],
		stars: ['A.md'],
		shards: shardsOf(pages),
		...overrides,
	};
}

const pageA = (): CachedPage =>
	page('A.md', {
		fields: new Map<string, unknown>([
			['due', DateTime.fromISO('2026-09-05T00:00:00')],
			['owner', Link.file('People/Pedram Amini.md')],
		]),
		tags: new Set(['#meeting']),
	});

/** Two paths that hash to different shards. */
function pathsInTwoShards(): [string, string] {
	const first = 'A.md';
	for (let i = 0; ; i++) {
		const other = `B${i}.md`;
		if (dataviewCacheShardOf(other) !== dataviewCacheShardOf(first)) return [first, other];
	}
}

describe('vault cache', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-cache-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('names one folder per root and remote, by SHA-1', () => {
		const local = dataviewCachePath(dir, '/vault', null);
		expect(path.dirname(local)).toBe(dir);
		expect(path.basename(local)).toMatch(/^[0-9a-f]{40}$/);
		expect(dataviewCachePath(dir, '/vault', null)).toBe(local);
		expect(dataviewCachePath(dir, '/vault', 'remote-1')).not.toBe(local);
		expect(dataviewCachePath(dir, '/other', null)).not.toBe(local);
	});

	it('puts every path in one stable shard within the shard count', () => {
		for (const pagePath of ['A.md', 'People/Pedram Amini.md', 'é/ü.md', '']) {
			const shard = dataviewCacheShardOf(pagePath);
			expect(Number.isInteger(shard)).toBe(true);
			expect(shard).toBeGreaterThanOrEqual(0);
			expect(shard).toBeLessThan(DATAVIEW_CACHE_SHARD_COUNT);
			expect(dataviewCacheShardOf(pagePath)).toBe(shard);
		}
		const spread = new Set(
			Array.from({ length: 2000 }, (_, i) => dataviewCacheShardOf(`Notes/note-${i}.md`))
		);
		expect(spread.size).toBeGreaterThan(DATAVIEW_CACHE_SHARD_COUNT * 0.9);
	});

	it('round-trips Transferable data, Map and Set included, through atomic writes', async () => {
		const cachePath = path.join(dir, 'nested', 'root');
		await writeVaultCache(cachePath, cacheWrite({ 'A.md': pageA() }));

		expect(fs.readdirSync(cachePath).some((name) => name.endsWith('.tmp'))).toBe(false);
		const loaded = await readVaultCache(cachePath, '/vault', null);
		expect(loaded).not.toBeNull();
		expect(loaded!.version).toBe(DATAVIEW_INDEX_CACHE_VERSION);
		expect(loaded!.files).toEqual(['A.md', 'data/x.csv']);
		expect(loaded!.stars).toEqual(['A.md']);

		const data = Transferable.value(loaded!.pages['A.md'].data);
		expect(data.tags).toEqual(new Set(['#meeting']));
		expect(data.fields).toBeInstanceOf(Map);
		expect(DateTime.isDateTime(data.fields.get('due'))).toBe(true);
		expect(data.fields.get('due').toISODate()).toBe('2026-09-05');
		expect(data.fields.get('owner').equals(Link.file('People/Pedram Amini.md'))).toBe(true);
	});

	it('rewrites only the shards a write names, and empties a shard written empty', async () => {
		const [a, b] = pathsInTwoShards();
		const cachePath = path.join(dir, 'root');
		await writeVaultCache(cachePath, cacheWrite({ [a]: page(a), [b]: page(b) }));
		const shardOfB = path.join(
			cachePath,
			`pages-${String(dataviewCacheShardOf(b)).padStart(3, '0')}.json`
		);
		const before = fs.statSync(shardOfB).mtimeMs;

		await writeVaultCache(
			cachePath,
			cacheWrite({}, { shards: new Map([[dataviewCacheShardOf(a), {}]]) })
		);
		const loaded = await readVaultCache(cachePath, '/vault', null);
		expect(Object.keys(loaded!.pages)).toEqual([b]);
		expect(fs.statSync(shardOfB).mtimeMs).toBe(before);
	});

	it('replaces every shard when asked, so a shard the index did not write is gone', async () => {
		const [a, b] = pathsInTwoShards();
		const cachePath = path.join(dir, 'root');
		await writeVaultCache(cachePath, cacheWrite({ [a]: page(a), [b]: page(b) }));
		await writeVaultCache(cachePath, cacheWrite({ [a]: page(a) }, { replace: true }));
		const loaded = await readVaultCache(cachePath, '/vault', null);
		expect(Object.keys(loaded!.pages)).toEqual([a]);
	});

	it('removes the version 1 single-file cache on the first write', async () => {
		const cachePath = path.join(dir, 'root');
		fs.writeFileSync(`${cachePath}.json`, '{"version":1}');
		await writeVaultCache(cachePath, cacheWrite({ 'A.md': pageA() }));
		expect(fs.existsSync(`${cachePath}.json`)).toBe(false);
	});

	it('returns null for a missing cache', async () => {
		expect(await readVaultCache(path.join(dir, 'none'), '/vault', null)).toBeNull();
	});

	it('discards a cache written by another version or shard count', async () => {
		const cachePath = path.join(dir, 'old');
		await writeVaultCache(cachePath, cacheWrite({ 'A.md': pageA() }));
		const manifestFile = path.join(cachePath, DATAVIEW_CACHE_MANIFEST_FILE);
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

		fs.writeFileSync(
			manifestFile,
			JSON.stringify({ ...manifest, version: DATAVIEW_INDEX_CACHE_VERSION - 1 })
		);
		expect(await readVaultCache(cachePath, '/vault', null)).toBeNull();

		fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, shardCount: 16 }));
		expect(await readVaultCache(cachePath, '/vault', null)).toBeNull();
	});

	it('discards a cache that belongs to another root or remote', async () => {
		const cachePath = path.join(dir, 'other');
		await writeVaultCache(cachePath, cacheWrite({ 'A.md': pageA() }));
		expect(await readVaultCache(cachePath, '/elsewhere', null)).toBeNull();
		expect(await readVaultCache(cachePath, '/vault', 'remote-1')).toBeNull();
	});

	it('discards a corrupt or malformed manifest', async () => {
		const corrupt = path.join(dir, 'corrupt');
		fs.mkdirSync(corrupt);
		fs.writeFileSync(path.join(corrupt, DATAVIEW_CACHE_MANIFEST_FILE), '{"version": 2, "files": ');
		expect(await readVaultCache(corrupt, '/vault', null)).toBeNull();

		const malformed = path.join(dir, 'malformed');
		fs.mkdirSync(malformed);
		fs.writeFileSync(
			path.join(malformed, DATAVIEW_CACHE_MANIFEST_FILE),
			JSON.stringify({ version: DATAVIEW_INDEX_CACHE_VERSION, root: '/vault' })
		);
		expect(await readVaultCache(malformed, '/vault', null)).toBeNull();
	});

	it('drops only the pages of a corrupt shard', async () => {
		const [a, b] = pathsInTwoShards();
		const cachePath = path.join(dir, 'root');
		await writeVaultCache(cachePath, cacheWrite({ [a]: page(a), [b]: page(b) }));
		fs.writeFileSync(
			path.join(cachePath, `pages-${String(dataviewCacheShardOf(a)).padStart(3, '0')}.json`),
			'{"version": 2, "pages": '
		);
		const loaded = await readVaultCache(cachePath, '/vault', null);
		expect(Object.keys(loaded!.pages)).toEqual([b]);
	});

	it('deletes a cache after the write queued before it, and tolerates a missing one', async () => {
		const cachePath = path.join(dir, 'rebuild');
		fs.writeFileSync(`${cachePath}.json`, '{"version":1}');
		const write = writeVaultCache(cachePath, cacheWrite({ 'A.md': pageA() }));
		const remove = deleteVaultCache(cachePath);
		await Promise.all([write, remove]);

		expect(fs.existsSync(cachePath)).toBe(false);
		expect(fs.existsSync(`${cachePath}.json`)).toBe(false);
		await expect(deleteVaultCache(cachePath)).resolves.toBeUndefined();
	});
});

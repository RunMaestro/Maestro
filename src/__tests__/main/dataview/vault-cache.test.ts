/**
 * Tests for the Dataview disk cache file (src/main/dataview/vault-cache.ts): the per-root file name, the
 * round trip of `Transferable` data (dates, links, `Map`, `Set`), and every reason a cache is discarded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { DateTime } from 'luxon';
import { Link, Transferable } from '../../../shared/dataview';
import {
	DATAVIEW_INDEX_CACHE_VERSION,
	dataviewCacheFilePath,
	deleteVaultCache,
	readVaultCache,
	writeVaultCache,
	type VaultCacheFile,
} from '../../../main/dataview/vault-cache';

function cacheFile(overrides: Partial<VaultCacheFile> = {}): VaultCacheFile {
	return {
		version: DATAVIEW_INDEX_CACHE_VERSION,
		root: '/vault',
		sshRemoteId: null,
		savedAt: 1,
		files: ['A.md', 'data/x.csv'],
		folders: ['data'],
		stars: ['A.md'],
		pages: {
			'A.md': {
				size: 3,
				mtime: 2000,
				ctime: 1000,
				oversized: false,
				data: Transferable.transferable({
					path: 'A.md',
					fields: new Map<string, unknown>([
						['due', DateTime.fromISO('2026-09-05T00:00:00')],
						['owner', Link.file('People/Pedram Amini.md')],
					]),
					tags: new Set(['#meeting']),
				}),
			},
		},
		...overrides,
	};
}

describe('vault cache', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-cache-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('names one file per root and remote, by SHA-1', () => {
		const local = dataviewCacheFilePath(dir, '/vault', null);
		expect(path.dirname(local)).toBe(dir);
		expect(path.basename(local)).toMatch(/^[0-9a-f]{40}\.json$/);
		expect(dataviewCacheFilePath(dir, '/vault', null)).toBe(local);
		expect(dataviewCacheFilePath(dir, '/vault', 'remote-1')).not.toBe(local);
		expect(dataviewCacheFilePath(dir, '/other', null)).not.toBe(local);
	});

	it('round-trips Transferable data, Map and Set included, through an atomic write', async () => {
		const file = path.join(dir, 'nested', 'cache.json');
		await writeVaultCache(file, cacheFile());

		expect(fs.existsSync(`${file}.tmp`)).toBe(false);
		const loaded = await readVaultCache(file, '/vault', null);
		expect(loaded).not.toBeNull();
		expect(loaded!.files).toEqual(['A.md', 'data/x.csv']);
		expect(loaded!.stars).toEqual(['A.md']);

		const page = Transferable.value(loaded!.pages['A.md'].data);
		expect(page.tags).toEqual(new Set(['#meeting']));
		expect(page.fields).toBeInstanceOf(Map);
		expect(DateTime.isDateTime(page.fields.get('due'))).toBe(true);
		expect(page.fields.get('due').toISODate()).toBe('2026-09-05');
		expect(page.fields.get('owner').equals(Link.file('People/Pedram Amini.md'))).toBe(true);
	});

	it('returns null for a missing file', async () => {
		expect(await readVaultCache(path.join(dir, 'none.json'), '/vault', null)).toBeNull();
	});

	it('discards a cache written by another version', async () => {
		const file = path.join(dir, 'old.json');
		await writeVaultCache(file, cacheFile({ version: DATAVIEW_INDEX_CACHE_VERSION - 1 }));
		expect(await readVaultCache(file, '/vault', null)).toBeNull();
	});

	it('discards a cache that belongs to another root or remote', async () => {
		const file = path.join(dir, 'other.json');
		await writeVaultCache(file, cacheFile());
		expect(await readVaultCache(file, '/elsewhere', null)).toBeNull();
		expect(await readVaultCache(file, '/vault', 'remote-1')).toBeNull();
	});

	it('discards a corrupt or malformed cache', async () => {
		const corrupt = path.join(dir, 'corrupt.json');
		fs.writeFileSync(corrupt, '{"version": 1, "pages": ');
		expect(await readVaultCache(corrupt, '/vault', null)).toBeNull();

		const malformed = path.join(dir, 'malformed.json');
		fs.writeFileSync(
			malformed,
			JSON.stringify({ version: DATAVIEW_INDEX_CACHE_VERSION, root: '/vault' })
		);
		expect(await readVaultCache(malformed, '/vault', null)).toBeNull();
	});

	it('deletes a cache after the write queued before it, and tolerates a missing file', async () => {
		const file = path.join(dir, 'rebuild.json');
		const write = writeVaultCache(file, cacheFile());
		const remove = deleteVaultCache(file);
		await Promise.all([write, remove]);

		expect(fs.existsSync(file)).toBe(false);
		await expect(deleteVaultCache(file)).resolves.toBeUndefined();
	});
});

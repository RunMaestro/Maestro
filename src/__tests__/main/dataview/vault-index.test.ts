/**
 * Tests for the main-process `VaultIndex` (src/main/dataview/vault-index.ts): the full scan over a temp copy
 * of the fixture vault, the `FullIndex` members the vendored engine reads, source resolution, the disk
 * cache, and incremental updates from watcher batches and the remote poll.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('../../../main/utils/remote-fs', () => ({
	listFilesWithStatsRemote: vi.fn(),
	readFileRemote: vi.fn(),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { EXPRESSION, PageIndex } from '../../../shared/dataview';
import type { Source } from '../../../shared/dataview';
import {
	createLocalVaultFs,
	type VaultFs,
	type VaultListing,
} from '../../../main/dataview/vault-fs';
import {
	DATAVIEW_MAX_INDEXED_FILE_BYTES,
	DATAVIEW_PARSE_BATCH_SIZE,
	DATAVIEW_REMOTE_POLL_MS,
	VaultIndex,
	type VaultIndexChange,
} from '../../../main/dataview/vault-index';
import {
	DATAVIEW_CACHE_MANIFEST_FILE,
	DATAVIEW_INDEX_CACHE_VERSION,
	dataviewCacheShardOf,
} from '../../../main/dataview/vault-cache';

const FIXTURE_VAULT = path.resolve(__dirname, '..', '..', 'fixtures', 'dataview-vault');

const source = (text: string): Source => EXPRESSION.source.tryParse(text);
const sorted = (paths: Iterable<string>) => [...paths].sort();

/** The markdown files a full scan of the fixture vault indexes (dot folders skipped, README counted). */
function fixturePages(dir = FIXTURE_VAULT): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...fixturePages(full));
		else if (entry.name.endsWith('.md'))
			out.push(path.relative(FIXTURE_VAULT, full).split(path.sep).join('/'));
	}
	return out;
}

/** An in-memory `VaultFs` for the unit cases. */
function memoryFs(files: Record<string, string>, overrides: Partial<VaultFs> = {}): VaultFs {
	return {
		root: '/vault',
		sshRemoteId: null,
		async list(): Promise<VaultListing> {
			const stats = new Map();
			for (const [file, text] of Object.entries(files)) {
				if (file.endsWith('.md')) stats.set(file, { size: text.length, mtime: 2000, ctime: 1000 });
			}
			return { files: Object.keys(files).filter((f) => !f.startsWith('.')), folders: [], stats };
		},
		async readText(relPath) {
			if (!(relPath in files)) throw new Error(`ENOENT: ${relPath}`);
			return files[relPath];
		},
		async readTextInRoot(relPath) {
			return relPath in files ? files[relPath] : null;
		},
		...overrides,
	};
}

describe('VaultIndex over the fixture vault', () => {
	let tempDir: string;
	let index: VaultIndex;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-vault-index-'));
		fs.cpSync(FIXTURE_VAULT, tempDir, { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.obsidian', 'bookmarks.json'),
			JSON.stringify({
				items: [
					{
						type: 'group',
						title: 'People',
						items: [{ type: 'file', path: 'People/Rami Example.md', title: '' }],
					},
				],
			})
		);
		index = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {} });
		await index.scan();
	});

	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('indexes every markdown page outside dot folders', () => {
		expect(sorted(index.pages.keys())).toEqual(sorted(fixturePages()));
		expect(index.getPage('.trash/Deleted.md')).toBeUndefined();
		expect(index.lastScan).toMatchObject({ pageCount: fixturePages().length, failedCount: 0 });
		expect(index.revision).toBe(1);
		expect(index.root).toBe(tempDir);
	});

	it('resolves a tag source through the tag index, nested tags included', () => {
		const meeting = index.pagesForSource(source('#meeting'));
		expect(meeting.successful && sorted(meeting.value)).toEqual([
			'Notes/Standup.md',
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-20 Unrelated.md',
		]);
		const alpha = index.pagesForSource(source('#project'));
		expect(alpha.successful && sorted(alpha.value)).toEqual(['Projects/Alpha/Design/Spec.md']);
	});

	it('resolves folder sources recursively and joins sources with or, and, and negation', () => {
		const folder = index.pagesForSource(source('"Projects"'));
		expect(folder.successful && sorted(folder.value)).toEqual([
			'Projects/Alpha/Design/Spec.md',
			'Projects/Alpha/Other.md',
			'Projects/Links.md',
		]);

		const either = index.pagesForSource(source('#meeting or "meetings"'));
		expect(either.successful && sorted(either.value)).toEqual([
			'Notes/Standup.md',
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-15 Review.md',
			'meetings/2026-09-20 Unrelated.md',
		]);

		const both = index.pagesForSource(source('#meeting and "meetings"'));
		expect(both.successful && sorted(both.value)).toEqual([
			'meetings/2026-09-01 Kickoff.md',
			'meetings/2026-09-20 Unrelated.md',
		]);

		const notMeeting = index.pagesForSource(source('-#meeting'));
		expect(notMeeting.successful && notMeeting.value.has('Notes/Standup.md')).toBe(false);
		expect(notMeeting.successful && notMeeting.value.size).toBe(index.pages.size - 3);
	});

	it('resolves [[link]] to its inlinks and outgoing([[link]]) to its resolved outlinks', () => {
		const incoming = index.pagesForSource(source('[[Pedram Amini]]'));
		expect(incoming.successful && incoming.value).toEqual(
			new Set(index.inlinks('People/Pedram Amini.md'))
		);
		expect(incoming.successful && sorted(incoming.value)).toEqual(
			expect.arrayContaining([
				'Notes/Standup.md',
				'People/Dana Sample.md',
				'People/Rami Example.md',
				'meetings/2026-09-01 Kickoff.md',
				'meetings/2026-09-15 Review.md',
			])
		);
		expect(incoming.successful && incoming.value.has('.trash/Deleted.md')).toBe(false);

		const outgoing = index.pagesForSource(source('outgoing([[Markdown Link]])'));
		expect(outgoing.successful && sorted(outgoing.value)).toEqual(['Notes/Other.md']);
	});

	it('falls back to unresolved links for a missing target, and fails outgoing() on one', () => {
		const missing = index.pagesForSource(source('[[Missing Note]]'));
		expect(missing.successful && sorted(missing.value)).toEqual(['Projects/Links.md']);

		const outgoing = index.pagesForSource(source('outgoing([[Nope Nope]])'));
		expect(outgoing.successful).toBe(true);
		expect(outgoing.successful && outgoing.value.size).toBe(0);
	});

	it('gives every page a resolvedLinks entry and resolves link paths like Obsidian', () => {
		const resolved = index.metadataCache.resolvedLinks;
		expect(sorted(Object.keys(resolved))).toEqual(sorted(index.pages.keys()));
		expect(resolved['Notes/Markdown Link.md']).toEqual({ 'Notes/Other.md': 1 });
		expect(index.metadataCache.getFirstLinkpathDest('Pedram Amini', 'Notes/Standup.md')).toEqual({
			path: 'People/Pedram Amini.md',
		});
		expect(
			index.metadataCache.getFirstLinkpathDest('Missing Note', 'Projects/Links.md')
		).toBeNull();
		expect(index.metadataCache.getFirstLinkpathDest('views/sample/view.js', '')).toEqual({
			path: 'views/sample/view.js',
		});
	});

	it('exposes the folder index, markdown files, and stars the way the engine reads them', () => {
		expect(index.prefix.nodeExists('Projects/Alpha')).toBe(true);
		expect(index.prefix.pathExists('data/people.csv')).toBe(true);
		expect(index.prefix.pathExists('.obsidian/app.json')).toBe(false);
		expect(sorted(index.vault.getMarkdownFiles().map((f) => f.path))).toEqual(
			sorted(index.pages.keys())
		);
		expect(index.starred.starred('People/Rami Example.md')).toBe(true);
		expect(index.starred.starred('People/Pedram Amini.md')).toBe(false);
		expect(index.getPage('People/Rami Example.md')!.serialize(index).file.starred).toBe(true);
	});

	it('takes the DataviewJS snapshot the guest rebuilds the same index from (D4)', () => {
		const snapshot = index.jsSnapshot();
		expect(snapshot.revision).toBe(index.revision);
		expect(sorted(snapshot.files)).toEqual(sorted(index.prefix.allFiles()));
		expect(sorted(snapshot.folders)).toEqual(sorted(index.prefix.allFolders()));
		expect(snapshot.stars).toEqual(['People/Rami Example.md']);
		expect(sorted(snapshot.pages.map((page) => page.path))).toEqual(sorted(index.pages.keys()));

		const guest = PageIndex.fromSnapshot(snapshot, (relPath) => index.fs.readText(relPath));
		for (const text of ['#meeting or "meetings"', '"Projects"', '[[Pedram Amini]]']) {
			const want = index.pagesForSource(source(text));
			const got = guest.pagesForSource(source(text));
			expect(got.successful && sorted(got.value), text).toEqual(
				want.successful && sorted(want.value)
			);
		}
	});

	it('serializes file.inlinks from the inlink index', () => {
		const other = index.getPage('Notes/Other.md')!.serialize(index);
		expect(other.file.inlinks.map((link: { path: string }) => link.path)).toContain(
			'Notes/Markdown Link.md'
		);
	});

	it('loads a vault-local CSV source and refuses URLs and paths outside the vault', async () => {
		const rows = await index.csv.get('data/people.csv');
		expect(rows.successful && rows.value.length).toBeGreaterThan(0);

		const url = await index.csv.get('https://example.com/data.csv');
		expect(url.successful).toBe(false);
		expect(!url.successful && url.error).toContain('not supported in Maestro');

		const outside = await index.csv.get('../secrets.csv');
		expect(outside).toMatchObject({
			successful: false,
			error: "Failed to load data from path '../secrets.csv'.",
		});

		const csvSource = index.pagesForSource(source('csv("people.csv")'), 'data/Note.md');
		expect(csvSource.successful && sorted(csvSource.value)).toEqual(['data/people.csv']);
	});
});

describe('VaultIndex scan behavior', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('indexes pages over the size cap with file.* fields only and never reads them', async () => {
		const big = 'Key:: value\n#tag\n'.padEnd(DATAVIEW_MAX_INDEXED_FILE_BYTES + 1, 'x');
		const vaultFs = memoryFs({ 'Big.md': big, 'Small.md': 'Key:: value' });
		const readText = vi.spyOn(vaultFs, 'readText');
		const index = new VaultIndex(vaultFs);

		const stats = await index.scan();

		expect(stats.oversizedCount).toBe(1);
		expect(readText).not.toHaveBeenCalledWith('Big.md');
		const page = index.getPage('Big.md')!;
		expect(page.size).toBe(big.length);
		expect(page.fields.size).toBe(0);
		expect(page.tags.size).toBe(0);
		expect(index.getPage('Small.md')!.fields.get('key')).toBe('value');
	});

	it('skips a page whose read fails and counts it', async () => {
		const index = new VaultIndex(
			memoryFs(
				{ 'A.md': 'a', 'B.md': 'b' },
				{
					readText: async (relPath) => {
						if (relPath === 'B.md') throw new Error('EACCES');
						if (relPath === 'A.md') return 'a';
						throw new Error('ENOENT');
					},
				}
			)
		);

		const stats = await index.scan();

		expect(stats).toMatchObject({ pageCount: 1, failedCount: 1 });
		expect(index.getPage('B.md')).toBeUndefined();
	});

	it('yields to the event loop between parse batches', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < DATAVIEW_PARSE_BATCH_SIZE * 2 + 1; i++) files[`N${i}.md`] = `n:: ${i}`;
		const index = new VaultIndex(memoryFs(files));
		let immediates = 0;
		const tick = () => {
			immediates++;
		};
		const scan = index.scan();
		// setImmediate callbacks queued after the scan starts run between its batches.
		for (let i = 0; i < 5; i++) setImmediate(tick);
		await scan;

		expect(index.pages.size).toBe(DATAVIEW_PARSE_BATCH_SIZE * 2 + 1);
		expect(immediates).toBeGreaterThan(0);
	});

	it('reports one change per scan with every set or removed page, and bumps the revision', async () => {
		const files: Record<string, string> = { 'A.md': 'a', 'B.md': 'b' };
		const index = new VaultIndex(memoryFs(files));
		const changes: VaultIndexChange[] = [];
		const unsubscribe = index.onChange((change) => changes.push(change));

		await index.scan();
		delete files['B.md'];
		files['C.md'] = 'c';
		await index.scan();
		// Nothing differs from the index, so the third scan is not a change at all.
		await index.scan();
		unsubscribe();
		files['A.md'] = 'a, edited';
		await index.scan();

		expect(changes).toHaveLength(2);
		expect(changes[0]).toEqual({ revision: 1, changedPaths: ['A.md', 'B.md'] });
		// A.md is unchanged (same mtime and size), so it is neither re-parsed nor reported.
		expect(changes[1].revision).toBe(2);
		expect(sorted(changes[1].changedPaths)).toEqual(['B.md', 'C.md']);
		expect(index.revision).toBe(3);
		expect(index.lastScan?.parsedCount).toBe(1);
		expect(index.getPage('B.md')).toBeUndefined();
		expect(index.links.get('B.md').size).toBe(0);
	});

	it('shares one scan between concurrent callers', async () => {
		const vaultFs = memoryFs({ 'A.md': 'a' });
		const list = vi.spyOn(vaultFs, 'list');
		const index = new VaultIndex(vaultFs);

		const [first, second] = await Promise.all([index.scan(), index.scan()]);

		expect(first).toBe(second);
		expect(list).toHaveBeenCalledTimes(1);
		expect(index.revision).toBe(1);
	});

	it('keeps notifying other listeners when one throws', async () => {
		const index = new VaultIndex(memoryFs({ 'A.md': 'a' }));
		const after = vi.fn();
		index.onChange(() => {
			throw new Error('boom');
		});
		index.onChange(after);

		await index.scan();

		expect(after).toHaveBeenCalledTimes(1);
	});

	it('propagates a failure to list the root', async () => {
		const index = new VaultIndex(
			memoryFs({}, { list: async () => Promise.reject(new Error('Directory not found')) })
		);

		await expect(index.scan()).rejects.toThrow('Directory not found');
		expect(index.revision).toBe(0);
	});
});

describe('VaultIndex disk cache (DV-5)', () => {
	let cacheDir: string;

	beforeEach(() => {
		cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-index-cache-'));
	});

	afterEach(() => {
		fs.rmSync(cacheDir, { recursive: true, force: true });
	});

	const markdownReads = (spy: { mock: { calls: unknown[][] } }) =>
		spy.mock.calls.map(([relPath]) => relPath as string).filter((p) => p.endsWith('.md'));

	it('writes the cache, then serves it on the next open without reading unchanged pages', async () => {
		const files = { 'A.md': 'Links to [[B]]. #tag', 'B.md': 'b' };
		const first = new VaultIndex(memoryFs(files), { cacheDir, watch: false });
		await first.open();
		expect(first.cacheHit).toBe(false);
		await first.dispose();
		expect(fs.existsSync(path.join(first.cachePath!, DATAVIEW_CACHE_MANIFEST_FILE))).toBe(true);

		const vaultFs = memoryFs(files);
		const readText = vi.spyOn(vaultFs, 'readText');
		const second = new VaultIndex(vaultFs, { cacheDir, watch: false });
		await second.open();

		expect(second.cacheHit).toBe(true);
		expect(sorted(second.pages.keys())).toEqual(['A.md', 'B.md']);
		expect(second.inlinks('B.md')).toEqual(['A.md']);
		expect(second.getPage('A.md')!.tags).toEqual(new Set(['#tag']));
		expect(second.getPage('A.md')!.links.map((link) => link.path)).toEqual(['B.md']);
		expect(second.revision).toBe(1);

		// The background reconcile is the in-flight scan; it finds nothing to re-parse.
		const stats = await second.scan();
		expect(stats.parsedCount).toBe(0);
		expect(second.revision).toBe(1);
		expect(markdownReads(readText)).toEqual([]);
		await second.dispose();
	});

	it('re-parses in the background only the pages that changed while the index was closed', async () => {
		const files: Record<string, string> = { 'A.md': '[[B]]', 'B.md': 'b' };
		const first = new VaultIndex(memoryFs(files), { cacheDir, watch: false });
		await first.open();
		await first.dispose();

		files['B.md'] = 'b grew a #tag';
		const vaultFs = memoryFs(files);
		const readText = vi.spyOn(vaultFs, 'readText');
		const second = new VaultIndex(vaultFs, { cacheDir, watch: false });
		const changes: VaultIndexChange[] = [];
		second.onChange((change) => changes.push(change));
		await second.open();
		await second.scan();

		expect(markdownReads(readText)).toEqual(['B.md']);
		expect(second.lastScan!.parsedCount).toBe(1);
		expect(second.getPage('B.md')!.tags).toEqual(new Set(['#tag']));
		expect(changes.map((change) => change.revision)).toEqual([1, 2]);
		expect(changes[1].changedPaths).toEqual(['B.md']);
		await second.dispose();
	});

	it('discards a cache written by an older version and scans instead', async () => {
		const files = { 'A.md': 'a' };
		const first = new VaultIndex(memoryFs(files), { cacheDir, watch: false });
		await first.open();
		await first.dispose();
		const manifestFile = path.join(first.cachePath!, DATAVIEW_CACHE_MANIFEST_FILE);
		const cached = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		fs.writeFileSync(
			manifestFile,
			JSON.stringify({ ...cached, version: DATAVIEW_INDEX_CACHE_VERSION - 1 })
		);

		const second = new VaultIndex(memoryFs(files), { cacheDir, watch: false });
		await second.open();

		expect(second.cacheHit).toBe(false);
		expect(second.lastScan!.parsedCount).toBe(1);
		expect(sorted(second.pages.keys())).toEqual(['A.md']);
		await second.dispose();
	});

	it('rewrites only the shard of a changed page, and serves the change on the next open', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 40; i++) files[`Note ${i}.md`] = `note ${i}`;
		const first = new VaultIndex(memoryFs(files), { cacheDir, watch: false });
		await first.open();
		await first.flushCache();
		const shardFiles = () =>
			new Map(
				fs
					.readdirSync(first.cachePath!)
					.filter((name) => name.startsWith('pages-'))
					.map((name) => [name, fs.readFileSync(path.join(first.cachePath!, name), 'utf8')])
			);
		const before = shardFiles();
		expect(before.size).toBeGreaterThan(1);

		files['Note 7.md'] = 'note 7 grew a #tag';
		await first.scan();
		await first.flushCache();
		const after = shardFiles();
		const rewritten = [...after].filter(([name, text]) => before.get(name) !== text);
		expect(rewritten.map(([name]) => name)).toEqual([
			`pages-${String(dataviewCacheShardOf('Note 7.md')).padStart(3, '0')}.json`,
		]);
		await first.dispose();

		const vaultFs = memoryFs(files);
		const readText = vi.spyOn(vaultFs, 'readText');
		const second = new VaultIndex(vaultFs, { cacheDir, watch: false });
		await second.open();
		await second.scan();
		expect(second.cacheHit).toBe(true);
		expect(markdownReads(readText)).toEqual([]);
		expect(second.getPage('Note 7.md')!.tags).toEqual(new Set(['#tag']));
		await second.dispose();
	});

	it('keeps nothing on disk without a cache folder', async () => {
		const index = new VaultIndex(memoryFs({ 'A.md': 'a' }), { watch: false });
		await index.open();
		expect(index.cachePath).toBeNull();
		await index.dispose();
		expect(fs.readdirSync(cacheDir)).toEqual([]);
	});
});

describe('VaultIndex incremental updates (DV-5)', () => {
	let tempDir: string;
	let index: VaultIndex;
	const file = (relPath: string) => path.join(tempDir, ...relPath.split('/'));

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-vault-updates-'));
		fs.cpSync(FIXTURE_VAULT, tempDir, { recursive: true });
		index = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {}, watch: false });
		await index.open();
	});

	afterEach(async () => {
		await index.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('re-parses an edited page, bumps the revision, and reports the page', async () => {
		const changes: VaultIndexChange[] = [];
		index.onChange((change) => changes.push(change));
		const review = 'meetings/2026-09-15 Review.md';
		fs.appendFileSync(file(review), '\nAlso #meeting.\n');

		await index.applyChangedPaths([review]);

		expect(index.revision).toBe(2);
		expect(changes).toHaveLength(1);
		expect(changes[0].changedPaths).toContain(review);
		const meeting = index.pagesForSource(source('#meeting'));
		expect(meeting.successful && meeting.value.has(review)).toBe(true);
	});

	it('ignores a batch whose pages did not change', async () => {
		await index.applyChangedPaths([
			'People/Lee Outsider.md',
			'.obsidian/app.json',
			'node_modules/x.md',
		]);
		expect(index.revision).toBe(1);
	});

	it('drops a deleted page and its outlinks from the inlink index', async () => {
		const kickoff = 'meetings/2026-09-01 Kickoff.md';
		expect(index.inlinks('People/Pedram Amini.md')).toContain(kickoff);
		fs.rmSync(file(kickoff));

		await index.applyChangedPaths([kickoff]);

		expect(index.getPage(kickoff)).toBeUndefined();
		expect(index.prefix.pathExists(kickoff)).toBe(false);
		expect(index.inlinks('People/Pedram Amini.md')).not.toContain(kickoff);
	});

	it('moves inlinks with a renamed page', async () => {
		fs.renameSync(file('Notes/Standup.md'), file('Notes/Daily.md'));

		await index.applyChangedPaths(['Notes/Standup.md', 'Notes/Daily.md']);

		const inlinks = index.inlinks('People/Pedram Amini.md');
		expect(inlinks).toContain('Notes/Daily.md');
		expect(inlinks).not.toContain('Notes/Standup.md');
		const meeting = index.pagesForSource(source('#meeting'));
		expect(meeting.successful && meeting.value.has('Notes/Daily.md')).toBe(true);
		expect(meeting.successful && meeting.value.has('Notes/Standup.md')).toBe(false);
	});

	// Projects/Links.md also links to itself (`[[#Links]]`), which pins the IndexMap.set workaround.
	it('resolves links again when the file they name appears or vanishes', async () => {
		const linkPaths = () => index.getPage('Projects/Links.md')!.links.map((link) => link.path);
		expect(linkPaths()).toContain('Missing Note');
		const changes: VaultIndexChange[] = [];
		index.onChange((change) => changes.push(change));

		fs.writeFileSync(file('Missing Note.md'), 'Found.');
		await index.applyChangedPaths(['Missing Note.md']);

		expect(linkPaths()).toContain('Missing Note.md');
		expect(index.inlinks('Missing Note.md')).toEqual(['Projects/Links.md']);
		expect(changes[0].changedPaths).toEqual(
			expect.arrayContaining(['Missing Note.md', 'Projects/Links.md'])
		);

		fs.rmSync(file('Missing Note.md'));
		await index.applyChangedPaths(['Missing Note.md']);

		expect(linkPaths()).toContain('Missing Note');
		expect(index.inlinks('Missing Note.md')).toEqual([]);
	});

	it('drops every page under a deleted folder', async () => {
		fs.rmSync(file('meetings'), { recursive: true });

		await index.applyChangedPaths(['meetings']);

		expect([...index.pages.keys()].filter((p) => p.startsWith('meetings/'))).toEqual([]);
		expect(index.prefix.nodeExists('meetings')).toBe(false);
		expect(index.inlinks('People/Pedram Amini.md')).not.toContain('meetings/2026-09-15 Review.md');
	});

	it('re-reads the bookmarks when they change', async () => {
		expect(index.starred.starred('People/Lee Outsider.md')).toBe(false);
		fs.writeFileSync(
			file('.obsidian/bookmarks.json'),
			JSON.stringify({ items: [{ type: 'file', path: 'People/Lee Outsider.md', title: '' }] })
		);

		await index.applyChangedPaths(['.obsidian/bookmarks.json']);

		expect(index.starred.starred('People/Lee Outsider.md')).toBe(true);
		expect(index.revision).toBe(2);
	});

	it('picks up a change on disk through the chokidar watcher', async () => {
		const watched = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {} });
		await watched.open();
		expect(watched.watchMode).toBe('chokidar');
		await watched.watcherReady;

		fs.writeFileSync(file('Notes/Watched.md'), 'Seen by the watcher. #meeting');

		await vi.waitFor(() => expect(watched.getPage('Notes/Watched.md')).toBeDefined(), {
			timeout: 5000,
			interval: 50,
		});
		await watched.dispose();
		expect(watched.watchMode).toBe('none');
	});
});

describe('VaultIndex remote poll (DV-5, DV-6)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it(`reconciles a remote root every ${DATAVIEW_REMOTE_POLL_MS / 1000} s instead of watching it`, async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const files: Record<string, string> = { 'A.md': 'a' };
		const index = new VaultIndex(memoryFs(files, { sshRemoteId: 'remote-1' }), { watch: true });
		await index.open();
		expect(index.watchMode).toBe('poll');

		files['A.md'] = 'a, edited #tag';
		const scan = vi.spyOn(index, 'scan');
		vi.advanceTimersByTime(DATAVIEW_REMOTE_POLL_MS);
		expect(scan).toHaveBeenCalledTimes(1);
		await scan.mock.results[0].value;

		expect(index.revision).toBe(2);
		expect(index.getPage('A.md')!.tags).toEqual(new Set(['#tag']));

		await index.dispose();
		expect(index.watchMode).toBe('none');
		vi.advanceTimersByTime(DATAVIEW_REMOTE_POLL_MS);
		expect(scan).toHaveBeenCalledTimes(1);
	});
});

/**
 * The shared `PageIndex` (src/shared/dataview/pageIndex.ts) built from a sandbox snapshot, against the
 * main-process `VaultIndex` over the same fixture vault. The DataviewJS guest answers `dv.pages()` and
 * `dv.page()` from the snapshot index (DATAVIEW-07 task 2), so every source must match the same pages and
 * every link must resolve to the same file in both.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { EXPRESSION, PageIndex, type SandboxIndexSnapshot } from '../../../shared/dataview';
import { createLocalVaultFs } from '../../../main/dataview/vault-fs';
import { VaultIndex } from '../../../main/dataview/vault-index';
import {
	DATAVIEW_FIXTURE_VAULT,
	fixtureSnapshot,
	fixtureText,
	withFixtureCreatedTimes,
} from '../../helpers/dataviewFixtureVault';

const THIS_PATH = 'People/Pedram Amini.md';

let tempDir: string;
let vaultIndex: VaultIndex;
let snapshot: SandboxIndexSnapshot;
let snapshotIndex: PageIndex;
const reads: string[] = [];

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-page-index-'));
	fs.cpSync(DATAVIEW_FIXTURE_VAULT, tempDir, { recursive: true });
	vaultIndex = new VaultIndex(withFixtureCreatedTimes(createLocalVaultFs(tempDir)), {
		onWarning: () => {},
		watch: false,
	});
	await vaultIndex.scan();
	snapshot = fixtureSnapshot(7);
	snapshotIndex = PageIndex.fromSnapshot(snapshot, async (relPath) => {
		reads.push(relPath);
		return fixtureText(relPath);
	});
});

afterAll(async () => {
	await vaultIndex.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

describe('PageIndex.fromSnapshot', () => {
	it('holds the pages, files, and revision the snapshot carries', () => {
		expect(snapshotIndex.revision).toBe(7);
		expect(sorted(snapshotIndex.pages.keys())).toEqual(sorted(vaultIndex.pages.keys()));
		expect(sorted(snapshotIndex.prefix.allFiles())).toEqual(sorted(vaultIndex.prefix.allFiles()));
		expect(snapshotIndex.pages.has('.trash/Deleted.md')).toBe(false);
	});

	it.each([
		'#meeting',
		'"People"',
		'#meeting or "meetings"',
		'"meetings" and #meeting',
		'-"People"',
		'#project/alpha',
		'[[Pedram Amini]]',
		'outgoing([[Projects/Links]])',
		'[[Missing Note]]',
		'"People/Rami Example"',
	])('matches the pages a VaultIndex matches for %s', (query) => {
		const source = EXPRESSION.source.tryParse(query);
		const fromSnapshot = snapshotIndex.pagesForSource(source, THIS_PATH);
		const fromVault = vaultIndex.pagesForSource(source, THIS_PATH);
		expect(fromSnapshot.successful).toBe(true);
		expect(sorted(fromSnapshot.orElseThrow())).toEqual(sorted(fromVault.orElseThrow()));
	});

	it('resolves links and inlinks as the VaultIndex does', () => {
		for (const [linkpath, origin] of [
			['Other', 'Projects/Links.md'],
			['Alpha/Other', 'Projects/Links.md'],
			['Rami Example', 'Notes/Standup.md'],
			['views/sample/view.js', THIS_PATH],
			['Missing Note', 'Projects/Links.md'],
		]) {
			expect(snapshotIndex.resolveLink(linkpath, origin)).toBe(
				vaultIndex.resolveLink(linkpath, origin)
			);
		}
		expect(sorted(snapshotIndex.inlinks(THIS_PATH))).toEqual(sorted(vaultIndex.inlinks(THIS_PATH)));
		expect(snapshotIndex.metadataCache.resolvedLinks).toEqual(
			vaultIndex.metadataCache.resolvedLinks
		);
		const page = snapshotIndex.getPage('meetings/2026-09-01 Kickoff.md')!;
		expect(page.links.map((link) => link.path)).toContain(THIS_PATH);
	});

	it('reads stars from the snapshot', () => {
		const starred = PageIndex.fromSnapshot({ ...snapshot, stars: [THIS_PATH] }, async () => '');
		expect(starred.starred.starred(THIS_PATH)).toBe(true);
		expect(snapshotIndex.starred.starred(THIS_PATH)).toBe(false);
	});

	it('loads a vault CSV through its reader, and refuses URLs and paths outside the file set', async () => {
		const rows = await snapshotIndex.csv.get('data/people.csv');
		expect(rows.successful).toBe(true);
		expect(rows.orElseThrow().map((row) => row.name)).toEqual(['Rami Example', 'Dana Sample']);

		reads.length = 0;
		const url = await snapshotIndex.csv.get('https://example.com/people.csv');
		expect(url.successful).toBe(false);
		const missing = await snapshotIndex.csv.get('data/missing.csv');
		expect(missing.successful).toBe(false);
		expect(reads).toEqual([]);
	});

	it('does not change the snapshot it was built from', () => {
		const before = JSON.stringify(fixtureSnapshot(7).pages.map((page) => Object.keys(page.data)));
		PageIndex.fromSnapshot(snapshot, async () => '');
		expect(JSON.stringify(snapshot.pages.map((page) => Object.keys(page.data)))).toBe(before);
	});
});

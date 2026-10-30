/**
 * The shared Dataview fixture vault (src/__tests__/fixtures/dataview-vault/) and the creation-time
 * rule its README sets: file creation time on disk is not stable, so tests stub `file.ctime` (and so
 * `file.cday`) from each note's frontmatter `created` date.
 */

import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import type { VaultFs } from '../../main/dataview/vault-fs';
import {
	Transferable,
	VaultPaths,
	dataviewJsonReplacer,
	isMarkdownPagePath,
	parseRawPage,
	type SandboxIndexSnapshot,
	type SandboxSnapshotPayload,
} from '../../shared/dataview';

export const DATAVIEW_FIXTURE_VAULT = path.resolve(__dirname, '..', 'fixtures', 'dataview-vault');

/** The note's `created` date read from its raw text, so a note whose YAML is broken still gets one. */
export function fixtureCreatedTime(content: string): number {
	const match = /^created: (\d{4}-\d{2}-\d{2})$/m.exec(content);
	if (!match) throw new Error('fixture note has no frontmatter created date');
	return DateTime.fromISO(match[1]).toMillis();
}

/**
 * Wrap a `VaultFs` so every listed page's `ctime` is its frontmatter `created` date. A page without
 * one (the vault README) keeps the time the file system reported.
 */
export function withFixtureCreatedTimes(vaultFs: VaultFs): VaultFs {
	return {
		...vaultFs,
		async list() {
			const listing = await vaultFs.list();
			for (const [relPath, stat] of listing.stats) {
				const content = await vaultFs.readText(relPath);
				if (/^created: /m.test(content)) stat.ctime = fixtureCreatedTime(content);
			}
			return listing;
		},
	};
}

/**
 * The fixture vault as the index snapshot a DataviewJS `run` message carries (D4): every file and folder
 * the index keeps (no dot segment, no `node_modules`, as `isIndexedVaultPath()` decides), and each page's
 * raw parse encoded as the disk cache keeps it. `ctime` follows the `created` rule; a page without one (the
 * vault README) gets 0.
 */
export function fixtureSnapshot(revision = 1): SandboxIndexSnapshot {
	const files: string[] = [];
	const walk = (folder: string) => {
		const entries = fs.readdirSync(path.join(DATAVIEW_FIXTURE_VAULT, folder), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			const relPath = folder ? `${folder}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(relPath);
			else files.push(relPath);
		}
	};
	walk('');
	const paths = new VaultPaths(files);
	const pages = files.filter(isMarkdownPagePath).map((relPath) => {
		const content = fixtureText(relPath);
		const ctime = /^created: /m.test(content) ? fixtureCreatedTime(content) : 0;
		const raw = parseRawPage(
			{ path: relPath, content, ctime, mtime: ctime, size: Buffer.byteLength(content) },
			{ onWarning: () => {} }
		);
		return { path: relPath, data: Transferable.transferable(raw) as Record<string, unknown> };
	});
	return { revision, files: paths.allFiles(), folders: paths.allFolders(), stars: [], pages };
}

/**
 * A snapshot as the payload `dataview:jsSnapshot` answers and a `run` or `eval` message carries: its JSON
 * text. Synchronous, for tests; main encodes with `encodeSandboxSnapshot()`, which decodes to the same value.
 */
export function snapshotPayload(snapshot: SandboxIndexSnapshot): SandboxSnapshotPayload {
	return {
		revision: snapshot.revision,
		...(snapshot.omittedListPages === undefined
			? {}
			: { omittedListPages: snapshot.omittedListPages }),
		json: JSON.stringify(snapshot, dataviewJsonReplacer),
	};
}

/** A fixture vault file's text, by vault-relative path. */
export function fixtureText(relPath: string): string {
	return fs.readFileSync(path.join(DATAVIEW_FIXTURE_VAULT, relPath), 'utf8');
}

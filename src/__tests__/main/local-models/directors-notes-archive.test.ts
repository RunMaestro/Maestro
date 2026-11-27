/**
 * @vitest-environment node
 *
 * The semantic index's archive of Director's Notes synopses, against a real
 * temp directory: a synopsis is stored nowhere else, so what is under test is
 * that one survives a round trip to disk as the text a person reads, that the
 * file stays bounded, and that nothing is written while Semantic search is off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	DIRECTORS_NOTES_ARCHIVE_FILENAME,
	MAX_ARCHIVED_SYNOPSES,
	SEMANTIC_INDEX_DIRNAME,
	archiveDirectorNotesSynopsis,
	directorNotesArchivePath,
	onDirectorNotesArchived,
	readDirectorNotesArchive,
	synopsisIndexText,
} from '../../../main/local-models/directors-notes-archive';
import { BGE_SMALL_EN_ID } from '../../../shared/local-models/model-catalog';

const NARRATIVE_JSON = JSON.stringify({
	version: 1,
	sections: [
		{
			kind: 'accomplishments',
			title: 'Accomplishments',
			items: [{ text: 'Fixed the login timeout', agent: 'backend' }],
		},
	],
});

describe("Director's Notes archive", () => {
	let dir: string;
	const enabled = { isEnabled: () => true };

	beforeEach(() => {
		settings.clear();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-notes-archive-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('lives under semantic-index in the data dir', () => {
		expect(directorNotesArchivePath(dir)).toBe(
			path.join(dir, SEMANTIC_INDEX_DIRNAME, DIRECTORS_NOTES_ARCHIVE_FILENAME)
		);
	});

	it('reads a missing archive as empty', async () => {
		await expect(readDirectorNotesArchive(dir)).resolves.toEqual([]);
	});

	it('stores a synopsis and reads it back, oldest first', async () => {
		const first = await archiveDirectorNotesSynopsis(
			{
				synopsis: 'Shipped the login fix.',
				lookbackDays: 7,
				provider: 'claude-code',
				generatedAt: 10,
			},
			{ dataDir: dir, ...enabled }
		);
		await archiveDirectorNotesSynopsis(
			{ synopsis: 'Started the indexer.', lookbackDays: 1, generatedAt: 20 },
			{ dataDir: dir, ...enabled }
		);

		const records = await readDirectorNotesArchive(dir);
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual({
			id: first?.id,
			generatedAt: 10,
			lookbackDays: 7,
			provider: 'claude-code',
			text: 'Shipped the login fix.',
		});
		expect(records[1]).toMatchObject({ text: 'Started the indexer.', lookbackDays: 1 });
		expect(records[1]).not.toHaveProperty('provider');
		expect(records[0].id).not.toBe(records[1].id);
	});

	it('stores the narrative as prose, not as the JSON the agent emitted', async () => {
		const record = await archiveDirectorNotesSynopsis(
			{ synopsis: NARRATIVE_JSON, lookbackDays: 7 },
			{ dataDir: dir, ...enabled }
		);
		expect(record?.text).toContain('## Accomplishments');
		expect(record?.text).toContain('Fixed the login timeout');
		expect(record?.text).not.toContain('"sections"');
	});

	it('keeps prose output as it is, and prefers a narrative the caller already parsed', () => {
		expect(synopsisIndexText('  # Report\n\nAll good.  ')).toBe('# Report\n\nAll good.');
		const parsed = synopsisIndexText('not json at all', {
			version: 1,
			sections: [{ kind: 'progress', title: 'Recovered', items: [{ text: 'salvaged bullet' }] }],
		});
		expect(parsed).toContain('## Recovered');
		expect(parsed).toContain('salvaged bullet');
	});

	it('writes nothing for a blank synopsis', async () => {
		await expect(
			archiveDirectorNotesSynopsis(
				{ synopsis: '   ', lookbackDays: 7 },
				{ dataDir: dir, ...enabled }
			)
		).resolves.toBeNull();
		expect(fs.existsSync(directorNotesArchivePath(dir))).toBe(false);
	});

	it('keeps only the newest synopses', async () => {
		for (let i = 0; i < MAX_ARCHIVED_SYNOPSES + 3; i++) {
			await archiveDirectorNotesSynopsis(
				{ synopsis: `synopsis ${i}`, lookbackDays: 7, generatedAt: i },
				{ dataDir: dir, ...enabled }
			);
		}
		const records = await readDirectorNotesArchive(dir);
		expect(records).toHaveLength(MAX_ARCHIVED_SYNOPSES);
		expect(records[0].text).toBe('synopsis 3');
		expect(records[records.length - 1].text).toBe(`synopsis ${MAX_ARCHIVED_SYNOPSES + 2}`);
	});

	it('lands every synopsis when several finish together', async () => {
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				archiveDirectorNotesSynopsis(
					{ synopsis: `parallel ${i}`, lookbackDays: 7 },
					{ dataDir: dir, ...enabled }
				)
			)
		);
		const texts = (await readDirectorNotesArchive(dir)).map((record) => record.text).sort();
		expect(texts).toEqual(Array.from({ length: 8 }, (_, i) => `parallel ${i}`));
	});

	it('skips a line that does not parse and keeps the rest', async () => {
		await archiveDirectorNotesSynopsis(
			{ synopsis: 'good one', lookbackDays: 7 },
			{ dataDir: dir, ...enabled }
		);
		fs.appendFileSync(directorNotesArchivePath(dir), '{"id": "torn\n{"id":"no-text"}\n');
		const records = await readDirectorNotesArchive(dir);
		expect(records.map((record) => record.text)).toEqual(['good one']);
	});

	it('tells listeners about a stored synopsis, and survives one that throws', async () => {
		const heard = vi.fn();
		const releaseBad = onDirectorNotesArchived(() => {
			throw new Error('listener bug');
		});
		const release = onDirectorNotesArchived(heard);

		const record = await archiveDirectorNotesSynopsis(
			{ synopsis: 'heard', lookbackDays: 7 },
			{ dataDir: dir, ...enabled }
		);
		expect(heard).toHaveBeenCalledWith(record);

		release();
		releaseBad();
		await archiveDirectorNotesSynopsis(
			{ synopsis: 'unheard', lookbackDays: 7 },
			{ dataDir: dir, ...enabled }
		);
		expect(heard).toHaveBeenCalledTimes(1);
	});

	describe('the Semantic search gate', () => {
		it('writes nothing while the task is off, which is the default', async () => {
			const heard = vi.fn();
			const release = onDirectorNotesArchived(heard);

			await expect(
				archiveDirectorNotesSynopsis({ synopsis: 'not kept', lookbackDays: 7 }, { dataDir: dir })
			).resolves.toBeNull();

			expect(fs.existsSync(path.join(dir, SEMANTIC_INDEX_DIRNAME))).toBe(false);
			expect(heard).not.toHaveBeenCalled();
			release();
		});

		it('writes once the task is assigned a source', async () => {
			settings.set('localModelAssignments', {
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			const record = await archiveDirectorNotesSynopsis(
				{ synopsis: 'kept', lookbackDays: 7 },
				{ dataDir: dir }
			);
			expect(record?.text).toBe('kept');
			expect(await readDirectorNotesArchive(dir)).toHaveLength(1);
		});
	});
});

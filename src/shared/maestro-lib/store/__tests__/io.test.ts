import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	GROUPS_REGISTRY,
	KNOWN_STORE_SCHEMA_VERSION,
	SESSIONS_BACKUP_FILENAME,
	SESSIONS_REGISTRY,
	STORE_SCHEMA_KEY,
	StoreWriteError,
	backupRegistryBeforeWipe,
	quarantineStoreFile,
	readStoreDocument,
	serializeStoreDocument,
	storeSchemaVersion,
	writeStoreDocument,
} from '../io';

/**
 * A sessions file as a newer (rc) build writes it: the format conf produces
 * (tab indent, no trailing newline) with keys this build has never heard of at
 * the document, agent, and tab level, in an order a re-sort would disturb.
 */
const RC_SESSIONS = {
	zebraDocumentKey: { nested: [1, 2, { deep: true }] },
	sessions: [
		{
			id: 'agent-1',
			name: 'Maestro',
			toolType: 'claude-code',
			rcOnlyAgentField: ['x', { y: 1 }],
			aiTabs: [{ id: 'tab-1', name: 'Main', rcOnlyTabField: 7, logs: [{ id: 'l1', text: 'hi' }] }],
		},
		{ id: 'agent-2', name: 'Docs', toolType: 'codex', aiTabs: [] },
	],
	alphaDocumentKey: 'after sessions',
};

const RC_TEXT = JSON.stringify(RC_SESSIONS, null, '\t');
const BOM = String.fromCharCode(0xfeff);

describe('store I/O', () => {
	let dir: string;
	let sessionsFile: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-store-io-'));
		sessionsFile = path.join(dir, 'maestro-sessions.json');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function readDoc(file = sessionsFile): Promise<Record<string, any>> {
		const result = await readStoreDocument<Record<string, any>>(file);
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		return result.data;
	}

	describe('format and round trip (DD-5)', () => {
		it('serializes in conf format: tab indent, no BOM, no trailing newline', () => {
			const text = serializeStoreDocument({ a: { b: 1 } });
			expect(text).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}');
		});

		it('writes an rc-shaped file back byte-identical when nothing changed', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			await writeStoreDocument(sessionsFile, await readDoc());
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe(RC_TEXT);
		});

		it('changes only the edited key and keeps every unknown key in place', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			const doc = await readDoc();
			doc.sessions[1].name = 'Documentation';
			await writeStoreDocument(sessionsFile, doc);

			const written = fs.readFileSync(sessionsFile, 'utf-8');
			expect(written).toBe(RC_TEXT.replace('"name": "Docs"', '"name": "Documentation"'));
			const reread = await readDoc();
			expect(reread.zebraDocumentKey).toEqual(RC_SESSIONS.zebraDocumentKey);
			expect(reread.sessions[0].rcOnlyAgentField).toEqual(['x', { y: 1 }]);
			expect(reread.sessions[0].aiTabs[0].rcOnlyTabField).toBe(7);
			expect(Object.keys(reread)).toEqual(['zebraDocumentKey', 'sessions', 'alphaDocumentKey']);
		});

		it('tolerates a BOM on read and writes none', async () => {
			fs.writeFileSync(sessionsFile, `${BOM}${RC_TEXT}`);
			await writeStoreDocument(sessionsFile, await readDoc());
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe(RC_TEXT);
		});

		it('normalizes a hand-edited file to conf format on its first write', async () => {
			fs.writeFileSync(sessionsFile, '{"sessions":[{"id":"a","name":"A","toolType":"codex"}]}');
			await writeStoreDocument(sessionsFile, await readDoc());
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe(
				'{\n\t"sessions": [\n\t\t{\n\t\t\t"id": "a",\n\t\t\t"name": "A",\n\t\t\t"toolType": "codex"\n\t\t}\n\t]\n}'
			);
		});

		it('creates the file when none exists', async () => {
			const result = await writeStoreDocument(sessionsFile, { sessions: [] });
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe('{\n\t"sessions": []\n}');
			expect(result.bytes).toBe(fs.statSync(sessionsFile).size);
			expect(result.backup).toEqual({ status: 'skipped' });
		});

		it('refuses a payload that cannot be serialized and leaves the file alone', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			await expect(writeStoreDocument(sessionsFile, undefined)).rejects.toThrow(
				/Refusing to write/
			);
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe(RC_TEXT);
			expect(fs.readdirSync(dir)).toEqual(['maestro-sessions.json']);
		});

		it('serializes concurrent writes to one file into whole documents', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			await Promise.all(
				Array.from({ length: 20 }, (_, i) =>
					writeStoreDocument(sessionsFile, { sessions: [{ id: `a${i}`, name: `n${i}` }] })
				)
			);
			const final = await readDoc();
			expect(final.sessions[0].id).toBe('a19');
			expect(fs.readdirSync(dir)).toEqual(['maestro-sessions.json']);
		});
	});

	describe('schema marker (DD-6)', () => {
		it('reads an absent marker as version 1 and ignores a garbled one', () => {
			expect(storeSchemaVersion({ sessions: [] })).toBe(1);
			expect(storeSchemaVersion({ [STORE_SCHEMA_KEY]: 'two' })).toBe(1);
			expect(storeSchemaVersion({ [STORE_SCHEMA_KEY]: 3 })).toBe(3);
			expect(storeSchemaVersion(null)).toBe(1);
		});

		it('never stamps a marker on its own', async () => {
			await writeStoreDocument(sessionsFile, { sessions: [] });
			expect(fs.readFileSync(sessionsFile, 'utf-8')).not.toContain(STORE_SCHEMA_KEY);
		});

		it('writes a document at the known version', async () => {
			const doc = { [STORE_SCHEMA_KEY]: KNOWN_STORE_SCHEMA_VERSION, sessions: [] };
			await writeStoreDocument(sessionsFile, doc);
			expect((await readDoc())[STORE_SCHEMA_KEY]).toBe(KNOWN_STORE_SCHEMA_VERSION);
		});

		it('refuses a document whose marker is newer, naming the file and version', async () => {
			const doc = { [STORE_SCHEMA_KEY]: 2, sessions: [] };
			const failure = await writeStoreDocument(sessionsFile, doc).catch((e) => e);
			expect(failure).toBeInstanceOf(StoreWriteError);
			expect(failure.code).toBe('store-too-new');
			expect(failure.version).toBe(2);
			expect(failure.message).toContain('maestro-sessions.json');
			expect(failure.message).toContain('2');
			expect(fs.existsSync(sessionsFile)).toBe(false);
		});

		it('refuses to overwrite a file a newer build stamped after this process read it', async () => {
			const stamped = JSON.stringify(
				{ [STORE_SCHEMA_KEY]: 5, sessions: [{ id: 'x' }] },
				null,
				'\t'
			);
			fs.writeFileSync(sessionsFile, stamped);

			await expect(writeStoreDocument(sessionsFile, { sessions: [] })).rejects.toBeInstanceOf(
				StoreWriteError
			);
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe(stamped);
			expect(fs.readdirSync(dir)).toEqual(['maestro-sessions.json']);
		});

		it('finds the marker in a file that is not in conf layout', async () => {
			fs.writeFileSync(sessionsFile, `{"sessions":[],"${STORE_SCHEMA_KEY}":9}`);
			await expect(writeStoreDocument(sessionsFile, { sessions: [] })).rejects.toBeInstanceOf(
				StoreWriteError
			);
		});

		it('is not fooled by marker text inside a string value', async () => {
			const tricky = { sessions: [{ id: 'a', note: `\n\t"${STORE_SCHEMA_KEY}": 9` }] };
			fs.writeFileSync(sessionsFile, JSON.stringify(tricky, null, '\t'));
			await expect(writeStoreDocument(sessionsFile, tricky)).resolves.toBeDefined();
		});

		it('honors a per-call known version', async () => {
			await expect(
				writeStoreDocument(
					sessionsFile,
					{ [STORE_SCHEMA_KEY]: 2, sessions: [] },
					{
						knownSchemaVersion: 2,
					}
				)
			).resolves.toBeDefined();
		});
	});

	describe('wipe backup', () => {
		const backupFile = () => path.join(dir, SESSIONS_BACKUP_FILENAME);

		it('snapshots a non-empty registry before an empty one replaces it', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			const result = await writeStoreDocument(
				sessionsFile,
				{ sessions: [] },
				{ registry: SESSIONS_REGISTRY }
			);

			expect(result.backup).toMatchObject({ status: 'backed-up', count: 2, path: backupFile() });
			const backup = JSON.parse(fs.readFileSync(backupFile(), 'utf-8'));
			expect(backup.reason).toBe('registry-emptied');
			expect(backup.entries).toEqual(RC_SESSIONS.sessions);
			expect((await readDoc()).sessions).toEqual([]);
		});

		it('does not back up when the incoming list still has entries', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			await writeStoreDocument(sessionsFile, RC_SESSIONS, { registry: SESSIONS_REGISTRY });
			expect(fs.existsSync(backupFile())).toBe(false);
		});

		it('does not back up when there was nothing stored to lose', async () => {
			fs.writeFileSync(sessionsFile, '{\n\t"sessions": []\n}');
			const result = await writeStoreDocument(
				sessionsFile,
				{ sessions: [] },
				{ registry: SESSIONS_REGISTRY }
			);
			expect(result.backup).toEqual({ status: 'skipped' });
			expect(fs.existsSync(backupFile())).toBe(false);
		});

		it('backs up groups under their own file name', async () => {
			const groupsFile = path.join(dir, 'maestro-groups.json');
			fs.writeFileSync(
				groupsFile,
				JSON.stringify({ groups: [{ id: 'g', name: 'G' }] }, null, '\t')
			);
			await writeStoreDocument(groupsFile, { groups: [] }, { registry: GROUPS_REGISTRY });
			expect(fs.existsSync(path.join(dir, 'maestro-groups.backup.json'))).toBe(true);
		});

		it('reports a backup that cannot be written but still saves the change', async () => {
			fs.writeFileSync(sessionsFile, RC_TEXT);
			// A directory where the backup file belongs makes the rename fail.
			fs.mkdirSync(backupFile());

			const result = await writeStoreDocument(
				sessionsFile,
				{ sessions: [] },
				{ registry: SESSIONS_REGISTRY }
			);

			expect(result.backup.status).toBe('failed');
			expect((await readDoc()).sessions).toEqual([]);
		}, 10_000);

		it('backupRegistryBeforeWipe decides on the lists alone', async () => {
			const options = { storePath: sessionsFile, backupFilename: SESSIONS_BACKUP_FILENAME };
			expect(await backupRegistryBeforeWipe({ ...options, existing: [1], incoming: [2] })).toEqual({
				status: 'skipped',
			});
			expect(await backupRegistryBeforeWipe({ ...options, existing: [], incoming: [] })).toEqual({
				status: 'skipped',
			});
			expect(
				await backupRegistryBeforeWipe({ ...options, existing: undefined, incoming: null })
			).toEqual({
				status: 'skipped',
			});
			expect(fs.existsSync(backupFile())).toBe(false);
		});
	});

	describe('reading', () => {
		it('reports a missing file without creating it', async () => {
			expect(await readStoreDocument(sessionsFile)).toEqual({
				status: 'missing',
				file: sessionsFile,
			});
			expect(fs.existsSync(sessionsFile)).toBe(false);
		});

		it('reports a corrupt file and leaves its bytes where they are', async () => {
			fs.writeFileSync(sessionsFile, '{"sessions": [');
			const result = await readStoreDocument(sessionsFile);
			expect(result.status).toBe('corrupt');
			expect(fs.readFileSync(sessionsFile, 'utf-8')).toBe('{"sessions": [');
		});

		it('applies the caller shape check', async () => {
			fs.writeFileSync(sessionsFile, '{"sessions": 5}');
			const result = await readStoreDocument(sessionsFile, (v) =>
				Array.isArray(v.sessions) ? null : '"sessions" is not an array'
			);
			expect(result).toEqual({
				status: 'corrupt',
				file: sessionsFile,
				reason: '"sessions" is not an array',
			});
		});

		it('quarantines a corrupt file to a stamped sidecar only when asked', async () => {
			fs.writeFileSync(sessionsFile, '{"sessions": [');
			const target = await quarantineStoreFile(sessionsFile, new Date(2026, 8, 22, 7, 15, 30));
			expect(target).toBe(path.join(dir, 'maestro-sessions.corrupt-20260922-071530.json'));
			expect(fs.existsSync(sessionsFile)).toBe(false);
			expect(fs.readFileSync(target, 'utf-8')).toBe('{"sessions": [');
		});
	});
});

import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import { boardMigrationSourceKey } from '../../../main/board/board-migration';
import { discoverBoardSources } from '../../../main/board/board-source-host';
import { listBoardWorkers } from '../../../main/board/board-workspace-storage';

let dir = '';
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
it('discovers asynchronously outside transactions and preserves filesystem errors', async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/source-async-'));
	const root = path.join(dir, 'root');
	fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(root, '.maestro/board.yaml'), '{"boards":[]}');
	const file = path.join(dir, 'file');
	fs.writeFileSync(file, 'not a directory');
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	try {
		const storage = new BoardStorageFacade(db);
		const realpath = fs.promises.realpath.bind(fs.promises);
		const readFile = fs.promises.readFile.bind(fs.promises);
		const realpathSpy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
			expect(db.inTransaction).toBe(false);
			return realpath(...args);
		});
		const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
			expect(db.inTransaction).toBe(false);
			return readFile(...args);
		});
		await discoverBoardSources(storage, [
			{ id: 'missing', dir: path.join(dir, 'missing') },
			{ id: 'not-dir', dir: path.join(file, 'child') },
			{ id: 'worker', dir: root, boardWorker: true },
		]);
		expect(realpathSpy).toHaveBeenCalled();
		expect(readSpy).toHaveBeenCalled();
		expect(storage.query().sources.map((source) => source.location?.path)).toEqual([root]);
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 1 });

		const badRoot = path.join(dir, 'bad');
		fs.mkdirSync(path.join(badRoot, '.maestro', 'board.yaml'), { recursive: true });
		await expect(
			discoverBoardSources(storage, [{ id: 'bad', dir: badRoot }])
		).rejects.toMatchObject({
			code: 'EISDIR',
		});
		expect(storage.query().sources.map((source) => source.location?.path)).toEqual([root]);
	} finally {
		db.close();
	}
});
it('cold-discovers registered repositories and legacy input, retains closed sources, and edits roles centrally', async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/source-host-'));
	const roots = ['a', 'b'].map((name) => {
		const root = path.join(dir, name);
		fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
		execFileSync('git', ['init', '--quiet', root]);
		return root;
	});
	const original = Buffer.from(
		JSON.stringify({ boards: [{ id: 'board', name: 'Legacy', cards: [] }] })
	);
	fs.writeFileSync(path.join(roots[0], '.maestro/board.yaml'), original);
	const profiles = Buffer.from(
		JSON.stringify({ profiles: [{ id: 'legacy-role', name: 'Legacy role' }] })
	);
	fs.writeFileSync(path.join(roots[0], '.maestro/profiles.yaml'), profiles);
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	try {
		const storage = new BoardStorageFacade(db);
		const sessions = roots.map((root, i) => ({ id: `worker-${i}`, dir: root, boardWorker: true }));
		await discoverBoardSources(storage, sessions);
		const first = storage.query();
		expect(first.sources.map((s) => s.location?.path).sort()).toEqual(roots);
		expect(first.collections).toHaveLength(1);
		expect(storage.captureCatalog().repositories).toHaveLength(2);
		expect(
			listBoardWorkers(db).map((w) =>
				Array.isArray(w.payload.allowedRepositoryIds) ? w.payload.allowedRepositoryIds.length : null
			)
		).toEqual([1, 1]);
		const role = storage.upsertRole(roots[0], { id: 'central-role', name: 'Central role' });
		expect(
			storage
				.captureCatalog()
				.profiles.find((p) => p.namespace === role.namespace && p.profile.id === role.profileId)
				?.profile.name
		).toBe('Central role');
		await discoverBoardSources(storage, []);
		await discoverBoardSources(storage, [...sessions].reverse());
		expect(storage.query().collections).toEqual(first.collections);
		expect(storage.captureCatalog().profiles).toHaveLength(2);
		expect(fs.readFileSync(path.join(roots[0], '.maestro/board.yaml'))).toEqual(original);
		expect(fs.readFileSync(path.join(roots[0], '.maestro/profiles.yaml'))).toEqual(profiles);
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
	} finally {
		db.close();
	}
});

it('never treats an SSH session directory as a local migration source', async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/source-remote-'));
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	try {
		const storage = new BoardStorageFacade(db);
		await discoverBoardSources(storage, [
			{ id: 'remote', dir, boardWorker: true, sessionSshRemoteConfig: { enabled: true } },
		]);
		expect(storage.query().sources).toMatchObject([
			{ location: { location: { kind: 'ssh', remoteId: '' }, path: dir } },
		]);
		expect(storage.captureCatalog().repositories).toMatchObject([
			{ validated: false, diagnostic: expect.stringContaining('remote identity') },
		]);
		expect(listBoardWorkers(db)).toEqual([]);
	} finally {
		db.close();
	}
});

it('completes repository discovery when the first collection was created before the first catalog read', async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/source-bootstrap-'));
	execFileSync('git', ['init', '--quiet', dir]);
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	try {
		const storage = new BoardStorageFacade(db);
		const sourceKey = boardMigrationSourceKey({ location: { kind: 'local' }, path: dir });
		storage.workspace.createCollection({
			sourceKey,
			collectionKey: 'first',
			legacyBoardId: 'first',
			expectedRevision: null,
			set: { name: 'First' },
		});
		await discoverBoardSources(storage, [{ id: 'creator', dir }]);
		expect(storage.captureCatalog().repositories).toEqual([
			{ id: `source:${sourceKey}`, workingDirectory: dir, validated: true },
		]);
		expect(storage.query().sources[0].location?.path).toBe(dir);
		expect(storage.query().collections[0].board.name).toBe('First');
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual([]);
	} finally {
		db.close();
	}
});

it('explicitly revalidates unresolved imported sources without rewriting original bytes, blockers, holds or runs', async () => {
	dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/source-repair-'));
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	try {
		const storage = new BoardStorageFacade(db);
		fs.mkdirSync(path.join(dir, '.maestro'));
		fs.writeFileSync(
			path.join(dir, '.maestro/board.yaml'),
			JSON.stringify({
				boards: [
					{
						id: 'b',
						name: 'Imported',
						cards: [
							{
								id: 'c',
								title: 'Uncertain',
								body: '',
								parents: [],
								status: 'running',
								runs: [{ attempt: 1, workerAgentId: 'worker', startedAt: '2026-10-01' }],
							},
						],
					},
				],
			})
		);
		await discoverBoardSources(storage, [{ id: 'worker', dir, boardWorker: true }]);
		const sourceKey = storage.query().sources[0].sourceKey;
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 31, 100)').run('unproven-owner');
		const run = db.prepare('SELECT run_id, collection_key, card_id FROM runs').get() as {
			run_id: string;
			collection_key: string;
			card_id: string;
		};
		db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?)').run(
			'worker',
			run.collection_key,
			run.card_id,
			run.run_id,
			31,
			12,
			'uncertain'
		);

		const frozen = () =>
			[
				'migrations',
				'migration_blockers',
				'migration_worker_holds',
				'runs',
				'cards',
				'runtime_owner',
				'reservations',
			].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
		const original = frozen();
		const { executeBoardSourceCommand } = await import('../../../main/board/board-source-host');
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage)
		).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		execFileSync('git', ['init', '--quiet', dir]);
		// Changed legacy files are never a repair source and never silently reimported.
		fs.writeFileSync(path.join(dir, '.maestro/board.yaml'), 'broken: [');
		expect(await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage)).toEqual({
			ok: true,
		});
		expect(new BoardStorageFacade(db).captureCatalog().repositories).toEqual([
			{ id: `source:${sourceKey}`, workingDirectory: dir, validated: true },
		]);
		expect(frozen()).toEqual(original);
		fs.renameSync(path.join(dir, '.git'), path.join(dir, 'old-git'));
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage)
		).toMatchObject({ ok: false });
		expect(storage.captureCatalog().repositories[0].validated).toBe(false);
		expect(frozen()).toEqual(original);
	} finally {
		db.close();
	}
});

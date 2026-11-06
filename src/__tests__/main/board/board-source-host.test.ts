import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade, configureBoardStorage } from '../../../main/board/board-storage';
import { boardMigrationSourceKey } from '../../../main/board/board-migration';
import {
	configureIsolatedBoardSourceHost,
	discoverBoardSources,
	refreshBoardSources,
} from '../../../main/board/board-source-host';
import {
	discoverLocalBoardSources,
	discoverRemoteBoardSources,
	executeBoardSourceOperation,
} from '../../../main/board/board-source-core';
import type { BoardRemoteTransport } from '../../../main/board/board-remote-source';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { listBoardWorkers } from '../../../main/board/board-workspace-storage';

const isolation = createBoardIsolationFixture();
const refuseTransport = vi.fn((): never => {
	throw new Error('Unexpected SSH/network transport');
});
const remote: BoardRemoteTransport = {
	config: refuseTransport,
	read: refuseTransport,
	git: refuseTransport,
	shell: refuseTransport,
};
let dir = '';
beforeAll(() => {
	isolation.install();
	configureIsolatedBoardSourceHost(isolation.contract);
});
afterAll(async () => isolation.cleanup());
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(isolation.contract.db + suffix, { force: true });
	refuseTransport.mockClear();
});
it('discovers asynchronously outside transactions and preserves filesystem errors', async () => {
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'maestro-board-source-async-'));
	const root = path.join(dir, 'root');
	fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(root, '.maestro/board.yaml'), '{"boards":[]}');
	const file = path.join(dir, 'file');
	fs.writeFileSync(file, 'not a directory');
	const db = openBoardDb(isolation.contract.db);
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
		await discoverLocalBoardSources(storage, [
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
			discoverLocalBoardSources(storage, [{ id: 'bad', dir: badRoot }])
		).rejects.toMatchObject({
			code: 'EISDIR',
		});
		expect(storage.query().sources.map((source) => source.location?.path)).toEqual([root]);
	} finally {
		db.close();
	}
});
it('cold-discovers registered repositories and legacy input, retains closed sources, and edits roles centrally', async () => {
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'maestro-board-source-host-'));
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
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		const sessions = roots.map((root, i) => ({ id: `worker-${i}`, dir: root, boardWorker: true }));
		await discoverLocalBoardSources(storage, sessions);
		const first = storage.query();
		const snapshots = db.prepare('SELECT * FROM migrations ORDER BY source_key').all();
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
		await discoverLocalBoardSources(storage, []);
		await discoverLocalBoardSources(storage, [...sessions].reverse());
		expect(storage.query().collections).toEqual(first.collections);
		expect(storage.captureCatalog().profiles).toHaveLength(2);
		expect(fs.readFileSync(path.join(roots[0], '.maestro/board.yaml'))).toEqual(original);
		expect(fs.readFileSync(path.join(roots[0], '.maestro/profiles.yaml'))).toEqual(profiles);
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
		expect(db.prepare('SELECT * FROM migrations ORDER BY source_key').all()).toEqual(snapshots);
	} finally {
		db.close();
	}
});

it('captures local workers and grants before asynchronous filesystem discovery can mutate the inputs', async () => {
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'local-snapshot-'));
	execFileSync('git', ['init', '--quiet', dir]);
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		const sessions = [{ id: 'original-worker', dir, boardWorker: true }];
		const realpath = fs.promises.realpath.bind(fs.promises);
		vi.spyOn(fs.promises, 'realpath').mockImplementationOnce(async (...args) => {
			expect(db.inTransaction).toBe(false);
			sessions[0].id = 'forged-worker';
			sessions[0].dir = isolation.sources.two;
			sessions.push({ ...sessions[0], id: 'late-worker' });
			return realpath(...args);
		});
		await discoverLocalBoardSources(storage, sessions);
		const sourceKey = boardMigrationSourceKey({ location: { kind: 'local' }, path: dir });
		expect(listBoardWorkers(db)).toMatchObject([
			{ agentId: 'original-worker', payload: { allowedRepositoryIds: [`source:${sourceKey}`] } },
		]);
		expect(listBoardWorkers(db)).toHaveLength(1);
		expect(storage.query().sources.map((source) => source.sourceKey)).toEqual([sourceKey]);
	} finally {
		db.close();
	}
});

it('discovers actual admitted local roots through the host and replays immutable input without network', async () => {
	const root = isolation.sources.one;
	const inputDir = path.join(root, '.maestro');
	fs.mkdirSync(inputDir);
	fs.writeFileSync(
		path.join(inputDir, 'board.yaml'),
		JSON.stringify({ boards: [{ id: 'host', name: 'Admitted host', cards: [] }] })
	);
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		configureBoardStorage(storage);
		await refreshBoardSources();
		expect(
			storage
				.query()
				.sources.map((source) => source.location?.path)
				.sort()
		).toEqual(Object.values(isolation.sources).sort());
		expect(storage.query().collections.map((entry) => entry.board.name)).toEqual(['Admitted host']);
		const before = db.prepare('SELECT * FROM migrations').all();
		expect(before).toHaveLength(1);
		fs.writeFileSync(path.join(inputDir, 'board.yaml'), 'broken: [');
		await refreshBoardSources();
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual(before);
		expect(storage.query().collections.map((entry) => entry.board.name)).toEqual(['Admitted host']);
	} finally {
		db.close();
		fs.rmSync(inputDir, { recursive: true });
	}
});

it('refuses an unadmitted provider or transport before any source read or write', async () => {
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		const before = storage.query();
		const read = vi.spyOn(fs.promises, 'readFile');
		await expect(
			discoverBoardSources(
				storage,
				[{ id: 'ssh', dir: isolation.sources.one, sshRemoteId: 'unadmitted' }],
				remote
			)
		).rejects.toThrow('not admitted');
		expect(read).not.toHaveBeenCalled();
		expect(refuseTransport).not.toHaveBeenCalled();
		expect(storage.query()).toEqual(before);
	} finally {
		db.close();
	}
});

it('checks retained registry admission before opening implicit storage', () => {
	const file = isolation.contract.sourceRegistry;
	const original = fs.readFileSync(file);
	try {
		const changed = JSON.parse(original.toString('utf8'));
		changed.sources.reverse();
		fs.writeFileSync(file, JSON.stringify(changed));
		expect(() => refreshBoardSources()).toThrow('not admitted');
		expect(fs.existsSync(isolation.contract.db)).toBe(false);
	} finally {
		fs.writeFileSync(file, original);
	}
});

it.each(['other-admitted-root', 'outside-admitted-roots'])(
	'refuses post-realpath identity changes to %s before input reads',
	async (target) => {
		dir = fs.mkdtempSync(path.join(isolation.contract.root, 'unregistered-root-'));
		const db = openBoardDb(isolation.contract.db);
		try {
			const storage = new BoardStorageFacade(db);
			configureBoardStorage(storage);
			const read = vi.spyOn(fs.promises, 'readFile');
			vi.spyOn(fs.promises, 'realpath').mockResolvedValueOnce(
				target === 'other-admitted-root' ? isolation.sources.two : dir
			);
			await expect(refreshBoardSources()).rejects.toThrow('source physical identity changed');
			expect(read).not.toHaveBeenCalled();
			expect(storage.query().sources).toEqual([]);
		} finally {
			db.close();
		}
	}
);

it('retains the host input-path guard when an admitted root contains a filesystem alias', async () => {
	const alias = path.join(isolation.sources.one, '.maestro');
	fs.symlinkSync(isolation.contract.worktree, alias, 'junction');
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		configureBoardStorage(storage);
		const read = vi.spyOn(fs.promises, 'readFile');
		await expect(refreshBoardSources()).rejects.toThrow('Board isolation');
		expect(read).not.toHaveBeenCalled();
		expect(storage.query().sources).toEqual([]);
	} finally {
		db.close();
		fs.unlinkSync(alias);
	}
});

it('never treats an SSH session directory as a local migration source', async () => {
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'maestro-board-source-remote-'));
	const db = openBoardDb(isolation.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		const sessions = [
			{ id: 'remote', dir, boardWorker: true, sessionSshRemoteConfig: { enabled: true } },
		];
		await discoverRemoteBoardSources(storage, sessions, remote);
		await discoverLocalBoardSources(storage, sessions);
		expect(refuseTransport).not.toHaveBeenCalled();
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
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'maestro-board-source-bootstrap-'));
	// Windows os.tmpdir() can contain RUNNER~1. Both host paths must hash the
	// identical physical spelling before creating or discovering any source.
	expect(dir).toBe(fs.realpathSync(dir));
	expect(dir).toBe(await fs.promises.realpath(dir));
	execFileSync('git', ['init', '--quiet', dir]);
	const db = openBoardDb(isolation.contract.db);
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
		await discoverLocalBoardSources(storage, [{ id: 'creator', dir }]);
		expect(storage.sourceKeys(dir)).toEqual([sourceKey]);
		expect(await storage.prepareQuery({ projectRoot: dir })).toEqual({ projectRoot: dir });
		expect((await storage.queryAsync({ projectRoot: dir })).sources).toMatchObject([{ sourceKey }]);
		expect(storage.query().sources).toHaveLength(1);
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
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'maestro-board-source-repair-'));
	const db = openBoardDb(isolation.contract.db);
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
		await discoverLocalBoardSources(storage, [{ id: 'worker', dir, boardWorker: true }]);
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
		expect(
			await executeBoardSourceOperation({ action: 'revalidate', sourceKey }, storage, [], remote)
		).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
		execFileSync('git', ['init', '--quiet', dir]);
		// Changed legacy files are never a repair source and never silently reimported.
		fs.writeFileSync(path.join(dir, '.maestro/board.yaml'), 'broken: [');
		expect(
			await executeBoardSourceOperation({ action: 'revalidate', sourceKey }, storage, [], remote)
		).toEqual({
			ok: true,
		});
		expect(new BoardStorageFacade(db).captureCatalog().repositories).toEqual([
			{ id: `source:${sourceKey}`, workingDirectory: dir, validated: true },
		]);
		expect(frozen()).toEqual(original);
		fs.renameSync(path.join(dir, '.git'), path.join(dir, 'old-git'));
		expect(
			await executeBoardSourceOperation({ action: 'revalidate', sourceKey }, storage, [], remote)
		).toMatchObject({ ok: false });
		expect(storage.captureCatalog().repositories[0].validated).toBe(false);
		expect(frozen()).toEqual(original);
	} finally {
		db.close();
	}
});

it.each(['syntax', 'shape', 'repository-conflict'])(
	'isolates expected %s migration failures per local source and retries repaired input',
	async (failure) => {
		dir = fs.mkdtempSync(path.join(isolation.contract.root, 'source-failure-'));
		const roots = ['broken', 'healthy'].map((name) => {
			const root = path.join(dir, name);
			fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
			execFileSync('git', ['init', '--quiet', root]);
			return root;
		});
		const valid = JSON.stringify({ boards: [{ id: 'legacy', name: 'Legacy', cards: [] }] });
		const broken =
			failure === 'syntax' ? 'boards: [' : failure === 'shape' ? '{"boards":{}}' : valid;
		fs.writeFileSync(path.join(roots[0], '.maestro/board.yaml'), broken);
		fs.writeFileSync(path.join(roots[1], '.maestro/board.yaml'), valid);
		const db = openBoardDb(isolation.contract.db);
		try {
			const storage = new BoardStorageFacade(db);
			const key = boardMigrationSourceKey({ location: { kind: 'local' }, path: roots[0] });
			if (failure === 'repository-conflict')
				db.prepare('INSERT INTO repositories VALUES (?, ?)').run(
					`source:${key}`,
					JSON.stringify({
						id: `source:${key}`,
						workingDirectory: path.join(dir, 'different'),
						validated: true,
					})
				);
			const workers = roots.map((root, i) => ({ id: `worker-${i}`, dir: root, boardWorker: true }));
			await discoverLocalBoardSources(storage, workers);
			expect(storage.query().sources).toHaveLength(2);
			expect(storage.query().collections).toHaveLength(1);
			expect(
				storage.captureCatalog().repositories.find((repo) => repo.id === `source:${key}`)
			).toMatchObject({ validated: false, diagnostic: expect.stringMatching(/legacy|conflict/) });
			expect(db.prepare('SELECT 1 FROM migrations WHERE source_key=?').get(key)).toBeUndefined();
			expect(fs.readFileSync(path.join(roots[0], '.maestro/board.yaml'), 'utf8')).toBe(broken);
			const healthy = db.prepare('SELECT * FROM migrations').all();
			fs.writeFileSync(path.join(roots[0], '.maestro/board.yaml'), valid);
			if (failure === 'repository-conflict')
				db.prepare('DELETE FROM repositories WHERE id=?').run(`source:${key}`);
			await discoverLocalBoardSources(storage, workers);
			expect(storage.query().collections).toHaveLength(2);
			expect(
				storage.captureCatalog().repositories.find((repo) => repo.id === `source:${key}`)
			).toMatchObject({ validated: true });
			expect(db.prepare('SELECT * FROM migrations WHERE source_key<>?').all(key)).toEqual(healthy);
		} finally {
			db.close();
		}
	}
);

it('propagates unexpected migration storage corruption rather than diagnosing it as bad legacy input', async () => {
	dir = fs.mkdtempSync(path.join(isolation.contract.root, 'source-corruption-'));
	execFileSync('git', ['init', '--quiet', dir]);
	fs.mkdirSync(path.join(dir, '.maestro'));
	fs.writeFileSync(path.join(dir, '.maestro/board.yaml'), '{"boards":[]}');
	const db = openBoardDb(isolation.contract.db);
	try {
		const key = boardMigrationSourceKey({ location: { kind: 'local' }, path: dir });
		db.prepare('INSERT INTO repositories VALUES (?, ?)').run(
			`source:${key}`,
			'corrupted-storage-json'
		);
		await expect(
			discoverLocalBoardSources(new BoardStorageFacade(db), [{ id: 'worker', dir }])
		).rejects.toThrow();
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual([]);
	} finally {
		db.close();
	}
});

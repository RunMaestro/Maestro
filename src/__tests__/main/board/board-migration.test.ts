import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';

import {
	listBoardWorkers,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';

const fixture = createBoardIsolationFixture();
const root = fixture.contract.root;
beforeAll(() => fixture.install());
afterAll(async () => fixture.cleanup());
let dir: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
});

describe('central board migration with SQLite', () => {
	it('rolls back atomically, preserves central state on retry and fences uncertain runs', () => {
		dir = fs.mkdtempSync(path.join(root, 'migration-test-'));
		const file = fixture.contract.db;
		const input = (name: string, running = false) => {
			const project = path.join(dir, name);
			fs.mkdirSync(project, { recursive: true });
			const card = {
				id: 'card',
				title: 'Work',
				body: '',
				status: running ? 'running' : 'todo',
				parents: [],
				heldByUser: true,
				assigneeAgentId: 'worker',
				unknown: { retained: true },
				runs: running
					? [{ attempt: 1, startedAt: 'then', workerAgentId: 'worker' }]
					: [{ attempt: 1, startedAt: 'then', outcome: 'done' }],
			};
			return {
				source: { location: { kind: 'local' as const }, path: project },
				repository: { id: name, workingDirectory: project, validated: true },
				boardBytes: Buffer.from(JSON.stringify({ boards: [{ id: 'board', name, cards: [card] }] })),
				profileBytes: Buffer.from(JSON.stringify({ profiles: [{ id: 'role', name: 'Role' }] })),
				workers: [{ id: 'worker', dir: project, boardWorker: true }],
			};
		};
		const a = planBoardMigration(input('a'));
		const b = planBoardMigration(input('b', true));
		let db = openBoardDb(file);
		try {
			expect(() =>
				applyBoardMigration(db, a, {
					beforeCommit: () => {
						throw new Error('injected');
					},
				})
			).toThrow('injected');
			for (const table of ['collections', 'cards', 'runs', 'workers', 'migrations'])
				expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
			db.prepare('INSERT INTO workers VALUES (?,0,1,?)').run('worker', '{"central":true}');
			const first = applyBoardMigration(db, a);
			const second = applyBoardMigration(db, b);
			expect(first.status).toBe('imported');
			expect(second.mapping.boards[0].collectionKey).not.toBe(
				first.mapping.boards[0].collectionKey
			);
			expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 2 });
			expect(
				db
					.prepare('SELECT enabled, paused, payload_json FROM workers WHERE agent_id=?')
					.get('worker')
			).toEqual({ enabled: 0, paused: 1, payload_json: '{"central":true}' });
			expect(db.prepare('SELECT count(*) AS n FROM migration_worker_holds').get()).toEqual({
				n: 1,
			});
			const key = first.mapping.boards[0].collectionKey;
			const row = db.prepare('SELECT payload_json FROM cards WHERE collection_key=?').get(key) as {
				payload_json: string;
			};
			const edited = { ...JSON.parse(row.payload_json), title: 'Central edit', heldByUser: true };
			db.prepare('UPDATE cards SET payload_json=? WHERE collection_key=?').run(
				JSON.stringify(edited),
				key
			);
			db.close();
			db = openBoardDb(file);
			const again = applyBoardMigration(db, a);
			expect(again.status).toBe('already-imported');
			expect(again.mapping).toEqual(first.mapping);
			expect(applyBoardMigration(db, b).status).toBe('already-imported');
			const changed = input('a');
			changed.boardBytes = Buffer.from('{"boards":[]}');
			expect(applyBoardMigration(db, planBoardMigration(changed)).status).toBe('source-changed');
			expect(
				JSON.parse(
					(
						db.prepare('SELECT payload_json FROM cards WHERE collection_key=?').get(key) as {
							payload_json: string;
						}
					).payload_json
				)
			).toEqual(edited);
			expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 2 });
			expect(db.pragma('foreign_key_check')).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe('cross-source legacy worker access', () => {
	it.each([
		['a', 'b'],
		['b', 'a'],
	])('aggregates migration grants in order %s, %s', (first, second) => {
		dir = fs.mkdtempSync(path.join(root, 'migration-order-'));
		const db = openBoardDb(fixture.contract.db);
		try {
			const workers = ['a', 'b'].map((name) => ({
				id: name,
				dir: path.join(dir, name),
				boardWorker: true,
			}));
			for (const worker of workers) fs.mkdirSync(worker.dir);
			const plan = (name: string) =>
				planBoardMigration({
					source: { location: { kind: 'local' }, path: path.join(dir, name) },
					repository: { id: name, workingDirectory: path.join(dir, name), validated: true },
					boardBytes: null,
					profileBytes: Buffer.from(JSON.stringify({ profiles: [{ id: 'role', name: 'Role' }] })),
					workers,
				});
			applyBoardMigration(db, plan(first));
			setBoardWorkerPaused(db, second, true);
			applyBoardMigration(db, plan(second));
			for (const worker of listBoardWorkers(db)) {
				expect(worker.payload.allowedRepositoryIds).toEqual([worker.agentId]);
				expect(worker.payload.roleRefs).toEqual([
					{ namespace: plan(worker.agentId).profileNamespace, profileId: 'role' },
				]);
				expect(worker.paused).toBe(worker.agentId === second);
				expect(
					Object.keys(
						(worker.payload.migration as { sources: Record<string, unknown> }).sources
					).sort()
				).toEqual([plan(first).sourceKey, plan(second).sourceKey].sort());
			}
			expect(applyBoardMigration(db, plan(second)).status).toBe('already-imported');
		} finally {
			db.close();
		}
	});

	it('preserves intentional empty access and central registration during later imports', () => {
		dir = fs.mkdtempSync(path.join(root, 'migration-access-'));
		const db = openBoardDb(fixture.contract.db);
		try {
			const workers = [
				{ id: 'worker', dir: dir, boardWorker: true },
				{ id: 'central', dir: dir, boardWorker: true },
			];
			const plan = (name: string) =>
				planBoardMigration({
					source: { location: { kind: 'local' }, path: path.join(dir, name) },
					repository: { id: name, workingDirectory: dir, validated: true },
					boardBytes: null,
					profileBytes: null,
					workers,
				});
			db.prepare('INSERT INTO workers VALUES (?, 0, 1, ?)').run(
				'central',
				JSON.stringify({ roleRefs: [], allowedRepositoryIds: [] })
			);
			applyBoardMigration(db, plan('a'));
			setBoardWorkerAccess(db, 'worker', [], []);
			setBoardWorkerPaused(db, 'worker', true);
			applyBoardMigration(db, plan('b'));
			expect(
				listBoardWorkers(db).map((w) => ({
					id: w.agentId,
					enabled: w.enabled,
					paused: w.paused,
					access: w.payload.allowedRepositoryIds,
				}))
			).toEqual([
				{ id: 'central', enabled: false, paused: true, access: [] },
				{ id: 'worker', enabled: true, paused: true, access: [] },
			]);
		} finally {
			db.close();
		}
	});
});

it('does not expand older unmarked central restrictions when their intent cannot be reconstructed', () => {
	dir = fs.mkdtempSync(path.join(root, 'migration-unmarked-'));
	const db = openBoardDb(fixture.contract.db);
	try {
		const payload = {
			roleRefs: [],
			allowedRepositoryIds: [],
			migration: { sourceKey: 'old', raw: {} },
		};
		db.prepare('INSERT INTO workers VALUES (?, 1, 1, ?)').run(
			'old-worker',
			JSON.stringify(payload)
		);
		applyBoardMigration(
			db,
			planBoardMigration({
				source: { location: { kind: 'local' }, path: dir },
				repository: { id: 'repo', workingDirectory: dir, validated: true },
				boardBytes: null,
				profileBytes: null,
				workers: [{ id: 'old-worker', dir, boardWorker: true }],
			})
		);
		expect(listBoardWorkers(db)).toEqual([
			{ agentId: 'old-worker', enabled: true, paused: true, payload },
		]);
	} finally {
		db.close();
	}
});

it.each([
	['/repo', '/repo/../outside', '/repo/./inside'],
	['C:\\repo', 'C:\\repo\\..\\outside', 'C:\\repo\\.\\inside'],
	['\\\\host\\share\\repo', '\\\\host\\share\\repo\\..\\outside', '\\\\host\\share\\repo\\inside'],
])(
	'refuses unresolved physical repository %s without creating a ledger or grants',
	(project, outside, inside) => {
		dir = fs.mkdtempSync(path.join(root, 'migration-missing-'));
		const missing = path.join(dir, 'missing');
		const realpath = fs.realpathSync.native.bind(fs.realpathSync);
		// These spellings are plan inputs, not real machine/network locations.
		// Obtain a real missing-directory error within our owned fixture instead
		// of asking Windows to resolve an invented UNC host (which can yield UNKNOWN).
		const probe = vi
			.spyOn(fs.realpathSync, 'native')
			.mockImplementation((file, options) => realpath(file === project ? missing : file, options));
		const db = openBoardDb(fixture.contract.db);
		try {
			const before = snapshotSqlite(db);
			probe.mockClear();
			expect(() =>
				applyBoardMigration(
					db,
					planBoardMigration({
						source: { location: { kind: 'local' }, path: project },
						repository: { id: 'repo', workingDirectory: project, validated: true },
						boardBytes: null,
						profileBytes: null,
						workers: [
							{ id: 'outside', dir: outside, boardWorker: true },
							{ id: 'inside', dir: inside, boardWorker: true },
						],
					})
				)
			).toThrow('Board migration physical directory unresolved');
			expect(probe).toHaveBeenCalledExactlyOnceWith(project);
			for (const table of ['workers', 'migrations', 'cards', 'profiles', 'runs'])
				expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
			expect(snapshotSqlite(db)).toEqual(before);
		} finally {
			db.close();
		}
	}
);

it.each(['UNKNOWN', 'EIO'])(
	'propagates unexpected native realpath %s unchanged without migration writes',
	(code) => {
		dir = fs.mkdtempSync(path.join(root, 'migration-unexpected-'));
		const failure = Object.assign(new Error(`native realpath ${code}`), {
			code,
			syscall: 'realpath',
			path: dir,
		});
		const realpath = fs.realpathSync.native.bind(fs.realpathSync);
		const probe = vi.spyOn(fs.realpathSync, 'native').mockImplementation((file, options) => {
			if (file === dir) throw failure;
			return realpath(file, options);
		});
		const db = openBoardDb(fixture.contract.db);
		try {
			const before = snapshotSqlite(db);
			probe.mockClear();
			let thrown: unknown;
			try {
				applyBoardMigration(
					db,
					planBoardMigration({
						source: { location: { kind: 'local' }, path: dir },
						repository: { id: 'repo', workingDirectory: dir, validated: true },
						boardBytes: null,
						profileBytes: null,
						workers: [{ id: 'worker', dir, boardWorker: true }],
					})
				);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBe(failure);
			expect(probe).toHaveBeenCalledExactlyOnceWith(dir);
			expect(snapshotSqlite(db)).toEqual(before);
		} finally {
			db.close();
		}
	}
);

it('resolves local migration worker aliases without granting symlink escapes and retains raw evidence', () => {
	dir = fs.mkdtempSync(path.join(root, 'migration-alias-'));
	const project = path.join(dir, 'repo');
	const outside = path.join(dir, 'outside');
	const inside = path.join(project, 'inside');
	fs.mkdirSync(inside, { recursive: true });
	fs.mkdirSync(outside);
	const escape = path.join(project, 'escape');
	const alias = path.join(outside, 'inside-alias');
	fs.symlinkSync(outside, escape, 'junction');
	fs.symlinkSync(inside, alias, 'junction');
	const input = {
		source: { location: { kind: 'local' as const }, path: project },
		repository: { id: 'repo', workingDirectory: project, validated: true },
		boardBytes: null,
		profileBytes: null,
		workers: [
			{ id: 'escape', dir: escape, boardWorker: true },
			{ id: 'alias', dir: alias, boardWorker: true },
		],
	};
	const plan = planBoardMigration(input);
	const original = JSON.stringify(plan.snapshot.workers);
	const db = openBoardDb(fixture.contract.db);
	try {
		applyBoardMigration(db, plan);
		expect(
			listBoardWorkers(db).find((w) => w.agentId === 'escape')!.payload.allowedRepositoryIds
		).toEqual([]);
		expect(
			listBoardWorkers(db).find((w) => w.agentId === 'alias')!.payload.allowedRepositoryIds
		).toEqual(['repo']);
		expect(JSON.stringify(plan.snapshot.workers)).toBe(original);
		const saved = db.prepare('SELECT snapshot FROM migrations').get() as { snapshot: Uint8Array };
		expect(JSON.parse(Buffer.from(saved.snapshot).toString()).snapshot.workers).toEqual(
			input.workers
		);
	} finally {
		db.close();
	}
});

it('normalizes SSH containment decisions without rewriting raw migration evidence or managed access', () => {
	const db = openBoardDb(fixture.contract.db);
	try {
		const workers = [
			{ id: 'inside', dir: '/remote/repo/./inside', boardWorker: true, sshRemoteId: 'remote' },
			{ id: 'escape', dir: '/remote/repo/../outside', boardWorker: true, sshRemoteId: 'remote' },
			{ id: 'sibling', dir: '/remote/repository', boardWorker: true, sshRemoteId: 'remote' },
			{ id: 'managed', dir: '/remote/repo/inside', boardWorker: true, sshRemoteId: 'remote' },
		];
		db.prepare('INSERT INTO workers VALUES (?, 1, 0, ?)').run(
			'managed',
			'{"accessManaged":true,"allowedRepositoryIds":[],"roleRefs":[]}'
		);
		const plan = planBoardMigration({
			source: { location: { kind: 'ssh', remoteId: 'remote' }, path: '/remote/repo' },
			repository: {
				id: 'repo',
				workingDirectory: '/remote/repo',
				validated: true,
				location: { kind: 'ssh', remoteId: 'remote' },
			},
			boardBytes: null,
			profileBytes: null,
			workers,
		});
		applyBoardMigration(db, plan);
		const registered = listBoardWorkers(db);
		expect(
			registered.find((worker) => worker.agentId === 'inside')!.payload.allowedRepositoryIds
		).toEqual(['repo']);
		for (const id of ['escape', 'sibling', 'managed'])
			expect(
				registered.find((worker) => worker.agentId === id)!.payload.allowedRepositoryIds
			).toEqual([]);
		const saved = db.prepare('SELECT snapshot FROM migrations').get() as { snapshot: Uint8Array };
		expect(JSON.parse(Buffer.from(saved.snapshot).toString('utf8')).snapshot.workers).toEqual(
			workers
		);
		const before = snapshotSqlite(db);
		applyBoardMigration(db, plan);
		expect(snapshotSqlite(db)).toEqual(before);
	} finally {
		db.close();
	}
});

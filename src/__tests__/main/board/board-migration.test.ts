import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';

import {
	listBoardWorkers,
	setBoardWorkerAccess,
	setBoardWorkerPaused,
} from '../../../main/board/board-workspace-storage';

const root = path.resolve('.maestro/board-global-workers-20261031');
let dir: string;
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('central board migration with SQLite', () => {
	it('rolls back atomically, preserves central state on retry and fences uncertain runs', () => {
		dir = fs.mkdtempSync(path.join(root, 'migration-test-'));
		const file = path.join(dir, 'board.sqlite');
		const input = (name: string, running = false) => {
			const project = path.join(dir, name);
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
		const db = openBoardDb(path.join(dir, 'board.sqlite'));
		try {
			const workers = ['a', 'b'].map((name) => ({
				id: name,
				dir: path.join(dir, name),
				boardWorker: true,
			}));
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
		const db = openBoardDb(path.join(dir, 'board.sqlite'));
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
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
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

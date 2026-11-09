import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { usesOwnBoardRepository } from '../../../shared/board/worker-options';
import { canonicalJson } from '../../../shared/canonicalJson';
import { openBoardDb } from '../../../main/board/board-db';
import {
	listBoardWorkers,
	listBoardWorkerAccessOptions,
	registerBoardWorker,
	setBoardWorkerPaused,
	setBoardWorkerEnabled,
	setBoardWorkerAccess,
	setBoardWorkerOptions,
} from '../../../main/board/board-workspace-storage';

const fixture = createBoardIsolationFixture();
beforeAll(() => fixture.install());
afterAll(async () => fixture.cleanup());
afterEach(() => {
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
});

describe('Board worker registry', () => {
	it('preserves restrictions and pause on registration retry and after reopen', () => {
		const file = fixture.contract.db;
		let db = openBoardDb(file);
		try {
			expect(registerBoardWorker(db, 'agent')).toBe(true);
			const payload = JSON.stringify({
				roleRefs: [{ namespace: 'n', profileId: 'r' }],
				allowedRepositoryIds: ['repo'],
				migration: { sourceKey: 'source' },
			});
			db.prepare('UPDATE workers SET payload_json = ? WHERE agent_id = ?').run(payload, 'agent');
			setBoardWorkerPaused(db, 'agent', true);
			setBoardWorkerEnabled(db, 'agent', false);
			expect(registerBoardWorker(db, 'agent')).toBe(false);
			db.close();
			db = openBoardDb(file);
			expect(listBoardWorkers(db)).toEqual([
				{ agentId: 'agent', enabled: false, paused: true, payload: JSON.parse(payload) },
			]);
			setBoardWorkerEnabled(db, 'agent', true);
			expect(() => setBoardWorkerEnabled(db, 'agent', 'false' as unknown as boolean)).toThrow(
				'Invalid'
			);
			expect(() => setBoardWorkerEnabled(db, 'missing', true)).toThrow('not found');
			setBoardWorkerPaused(db, 'agent', false);
			expect(listBoardWorkers(db)[0].paused).toBe(false);
			expect(() => setBoardWorkerPaused(db, 'missing', true)).toThrow('not found');
			expect(() => setBoardWorkerPaused(db, 'agent', 'false' as unknown as boolean)).toThrow(
				'Invalid Board worker pause'
			);
			expect(listBoardWorkers(db)[0].paused).toBe(false);
			expect(() => registerBoardWorker(db, 'bad\0id')).toThrow('agent ID');
		} finally {
			db.close();
		}
	});

	it('updates access without discarding provenance or changing a pause', () => {
		const db = openBoardDb(fixture.contract.db);
		try {
			registerBoardWorker(db, 'agent');
			db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?)').run('n', 'role', '{}', 'source');
			db.prepare('INSERT INTO repositories VALUES (?, ?)').run('repo', '{}');
			expect(listBoardWorkerAccessOptions(db)).toEqual({
				roles: [
					{ namespace: 'n', profileId: 'role', name: 'role', profile: {}, sourceKey: 'source' },
				],
				repositories: [{ id: 'repo', name: 'repo' }],
			});
			db.prepare('UPDATE workers SET payload_json = ? WHERE agent_id = ?').run(
				JSON.stringify({ migration: { sourceKey: 'original' } }),
				'agent'
			);
			setBoardWorkerPaused(db, 'agent', true);
			setBoardWorkerAccess(db, 'agent', [{ namespace: 'n', profileId: 'role' }], ['repo']);
			expect(listBoardWorkers(db)[0]).toEqual({
				agentId: 'agent',
				enabled: true,
				paused: true,
				payload: {
					migration: { sourceKey: 'original' },
					accessManaged: true,
					roleRefs: [{ namespace: 'n', profileId: 'role' }],
					allowedRepositoryIds: ['repo'],
				},
			});
			expect(() => setBoardWorkerAccess(db, 'agent', [], [''])).toThrow('Invalid');
			expect(() =>
				setBoardWorkerAccess(db, 'agent', [{ namespace: 'n', profileId: 'missing' }], ['repo'])
			).toThrow('role not found');
			expect(() => setBoardWorkerAccess(db, 'agent', [], ['missing'])).toThrow(
				'repository not found'
			);
			expect(listBoardWorkers(db)[0].payload.allowedRepositoryIds).toEqual(['repo']);
			db.prepare('DELETE FROM profiles WHERE profile_namespace = ? AND id = ?').run('n', 'role');
			db.prepare('DELETE FROM repositories WHERE id = ?').run('repo');
			setBoardWorkerAccess(db, 'agent', [{ namespace: 'n', profileId: 'role' }], ['repo']);
			expect(listBoardWorkers(db)[0].payload.allowedRepositoryIds).toEqual(['repo']);
			expect(() => setBoardWorkerAccess(db, 'missing', [], [])).toThrow('not found');
		} finally {
			db.close();
		}
	});
	it('patches options with a stale-write fence while preserving unknown options, origins, access and availability', () => {
		const file = fixture.contract.db;
		const db = openBoardDb(file);
		try {
			registerBoardWorker(db, 'a');
			registerBoardWorker(db, 'b');
			const payload = {
				roleRefs: [{ namespace: 'n', profileId: 'p' }],
				allowedRepositoryIds: ['repo'],
				accessManaged: false,
				futurePayload: { keep: 1 },
				migration: { sources: { s1: { original: true }, s2: { original: false } } },
				executionOptions: { futureOption: { keep: 2 }, customModel: 'original' },
			};
			db.prepare('UPDATE workers SET payload_json=?, paused=1, enabled=0 WHERE agent_id=?').run(
				canonicalJson(payload),
				'a'
			);
			const before = canonicalJson(payload);
			setBoardWorkerOptions(db, 'a', before, {
				customModel: 'A',
				customEffort: 'high',
				appendSystemPrompt: 'role',
				customArgs: '--arg',
			});
			expect(() => setBoardWorkerOptions(db, 'a', before, { customModel: 'lost-update' })).toThrow(
				'changed'
			);
			let a = listBoardWorkers(db)[0];
			expect(a).toMatchObject({
				enabled: false,
				paused: true,
				payload: {
					...payload,
					executionOptions: {
						...payload.executionOptions,
						customModel: 'A',
						customEffort: 'high',
						appendSystemPrompt: 'role',
						customArgs: '--arg',
					},
				},
			});
			setBoardWorkerOptions(db, 'a', canonicalJson(a.payload), {
				customModel: null,
				customArgs: '',
			});
			a = listBoardWorkers(db)[0];
			expect(a.payload.executionOptions).toEqual({
				futureOption: { keep: 2 },
				customEffort: 'high',
				appendSystemPrompt: 'role',
				customArgs: '',
			});
			for (const patch of [
				{ futureOption: 3 },
				{ customEffort: 1 },
				{ customModel: '' },
				{ customArgs: 'bad\0arg' },
				[],
			]) {
				expect(() =>
					setBoardWorkerOptions(db, 'a', canonicalJson(a.payload), patch as never)
				).toThrow('Invalid');
			}
			expect(listBoardWorkers(db)[0]).toEqual(a);
			expect(listBoardWorkers(db)[1]).toEqual({
				agentId: 'b',
				enabled: true,
				paused: false,
				payload: { roleRefs: [], allowedRepositoryIds: [] },
			});
			const reader = openBoardDb(file);
			try {
				expect(listBoardWorkers(reader)[0]).toEqual(a);
			} finally {
				reader.close();
			}
		} finally {
			db.close();
		}
	});
});

it('preserves explicit legacy restrictions and retains automatic own access when adding a default worker grant', () => {
	let db = openBoardDb(fixture.contract.db);
	try {
		registerBoardWorker(db, 'default');
		registerBoardWorker(db, 'legacy');
		db.prepare('INSERT INTO repositories VALUES (?,?)').run(
			'extra',
			canonicalJson({ id: 'extra', workingDirectory: 'synthetic-extra' })
		);
		const legacy = canonicalJson({
			roleRefs: [],
			allowedRepositoryIds: [],
			accessManaged: true,
			migration: { sourceKey: 'original' },
		});
		db.prepare('UPDATE workers SET payload_json=? WHERE agent_id=?').run(legacy, 'legacy');
		expect(
			usesOwnBoardRepository(
				listBoardWorkers(db).find((worker) => worker.agentId === 'default')!.payload
			)
		).toBe(true);
		setBoardWorkerAccess(db, 'default', [], ['extra']);
		setBoardWorkerAccess(db, 'legacy', [], []);
		db.close();
		db = openBoardDb(fixture.contract.db);
		const workers = listBoardWorkers(db);
		expect(
			usesOwnBoardRepository(workers.find((worker) => worker.agentId === 'default')!.payload)
		).toBe(true);
		expect(workers.find((worker) => worker.agentId === 'default')!.payload).toMatchObject({
			allowedRepositoryIds: ['extra'],
			repositoryAccess: 'own-and-grants',
		});
		expect(canonicalJson(workers.find((worker) => worker.agentId === 'legacy')!.payload)).toBe(
			legacy
		);
		expect(
			usesOwnBoardRepository(workers.find((worker) => worker.agentId === 'legacy')!.payload)
		).toBe(false);
		expect(usesOwnBoardRepository({ allowedRepositoryIds: ['extra'] })).toBe(false);
		expect(
			usesOwnBoardRepository({ allowedRepositoryIds: [], repositoryAccess: 'unknown-mode' })
		).toBe(false);
		expect(
			usesOwnBoardRepository({
				repositoryAccess: 'own-and-grants',
				allowedRepositoryIds: 'invalid',
			})
		).toBe(false);
	} finally {
		db.close();
	}
});

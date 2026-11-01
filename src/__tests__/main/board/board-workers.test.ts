import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openBoardDb } from '../../../main/board/board-db';
import {
	listBoardWorkers,
	listBoardWorkerAccessOptions,
	registerBoardWorker,
	setBoardWorkerPaused,
	setBoardWorkerEnabled,
	setBoardWorkerAccess,
} from '../../../main/board/board-workspace-storage';

let dir = '';
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Board worker registry', () => {
	it('preserves restrictions and pause on registration retry and after reopen', () => {
		dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/workers-'));
		const file = path.join(dir, 'board.sqlite');
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
		dir = fs.mkdtempSync(path.resolve('.maestro/board-global-workers-20261031/workers-'));
		const db = openBoardDb(path.join(dir, 'board.sqlite'));
		try {
			registerBoardWorker(db, 'agent');
			db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?)').run('n', 'role', '{}', 'source');
			db.prepare('INSERT INTO repositories VALUES (?, ?)').run('repo', '{}');
			expect(listBoardWorkerAccessOptions(db)).toEqual({
				roles: [{ namespace: 'n', profileId: 'role', name: 'role' }],
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
});

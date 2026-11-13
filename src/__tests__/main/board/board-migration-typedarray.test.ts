import { expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import { compareSqliteSnapshots, snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import {
	discoverLocalBoardSources,
	discoverRemoteBoardSources,
} from '../../../main/board/board-source-core';
import type { BoardRemoteTransport } from '../../../main/board/board-remote-source';

it('reopens and replays Uint8Array BLOBs through migration, source discovery and older source projection', async () => {
	const fixture = createBoardIsolationFixture();
	fixture.install();
	const constructor = nodeSqliteBetterSqlite3Mock().default as unknown as typeof Database;
	const file = fixture.contract.db;
	let db = openBoardDb(file, constructor);
	try {
		const plans = [
			{ location: { kind: 'local' as const }, path: fixture.sources.one },
			{ location: { kind: 'ssh' as const, remoteId: 'fixture-remote' }, path: '/fixture/remote' },
		].map((source) =>
			planBoardMigration({
				source,
				repository: null,
				workers: [],
				profileBytes: null,
				boardBytes: Buffer.from('{"boards": [{"id":"same", "name":"Fixture", "cards":[]}]}'),
			})
		);
		for (const plan of plans) applyBoardMigration(db, plan);
		// A pre-v6 import has its identity in the BLOB but no dedicated location row.
		db.exec('DELETE FROM board_source_locations');
		const row = db.prepare('SELECT snapshot FROM migrations LIMIT 1').get() as {
			snapshot: Uint8Array;
		};
		expect(row.snapshot).toBeInstanceOf(Uint8Array);
		expect(Buffer.isBuffer(row.snapshot)).toBe(false);
		const before = snapshotSqlite(db);
		db.close();
		db = openBoardDb(file, constructor);
		for (const plan of plans) expect(applyBoardMigration(db, plan).status).toBe('already-imported');
		const storage = new BoardStorageFacade(db);
		expect(storage.query().sources.map((entry) => entry.location)).toEqual(
			expect.arrayContaining(plans.map((plan) => plan.source))
		);
		const sessions = [
			{ id: 'local', dir: fixture.sources.one },
			{ id: 'remote', dir: '/fixture/remote', sshRemoteId: 'fixture-remote' },
		];
		const refuse = vi.fn((): never => {
			throw new Error('Unexpected SSH transport');
		});
		const transport: BoardRemoteTransport = {
			config: refuse,
			read: refuse,
			git: refuse,
			shell: refuse,
		};
		await discoverLocalBoardSources(storage, sessions);
		await discoverRemoteBoardSources(storage, sessions, transport);
		expect(refuse).not.toHaveBeenCalled();
		expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
	} finally {
		db.close();
		await fixture.cleanup();
	}
});

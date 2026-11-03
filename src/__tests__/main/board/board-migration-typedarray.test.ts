import { expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import * as path from 'node:path';
import { createScratchDir } from '../../shared/maestro-lib/run/fakeAgent';
import { nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import { compareSqliteSnapshots, snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import { discoverBoardSources } from '../../../main/board/board-source-host';

it('reopens and replays Uint8Array BLOBs through migration, source discovery and older source projection', async () => {
	const scratch = createScratchDir('board-byte-replay', { canonical: true });
	const constructor = nodeSqliteBetterSqlite3Mock().default as unknown as typeof Database;
	const file = path.join(scratch.dir, 'board.sqlite');
	let db = openBoardDb(file, constructor);
	try {
		const plans = [
			{ location: { kind: 'local' as const }, path: scratch.dir },
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
		await discoverBoardSources(storage, [
			{ id: 'local', dir: scratch.dir },
			{ id: 'remote', dir: '/fixture/remote', sshRemoteId: 'fixture-remote' },
		]);
		expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toEqual([]);
	} finally {
		db.close();
		scratch.cleanup();
	}
});

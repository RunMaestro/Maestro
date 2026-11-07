import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade } from '../../../main/board/board-storage';
import * as fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { requireBoardIsolation } from '../../../main/board/board-isolation';
import {
	exportBoardSourceCleanup,
	previewBoardSourceCleanup,
	restoreBoardSource,
	suppressBoardSource,
} from '../../../main/board/board-source-cleanup';

const fixture = createBoardIsolationFixture();
beforeAll(() => fixture.install());
afterAll(() => fixture.cleanup());

describe('isolated Board cleanup boundary', () => {
	it('rejects an unadmitted connection before database or backup file access', () => {
		const contract = requireBoardIsolation();
		const db = {
			name: contract.db,
			transaction: vi.fn(),
			prepare: vi.fn(),
		} as unknown as Database.Database;
		const backup = path.join(contract.root, 'missing-backup.json');
		const receipt = {
			sourceKey: 'a'.repeat(64),
			backupSha256: '',
			archivedCollections: [],
			revision: 1,
		};
		expect(() => previewBoardSourceCleanup(db, receipt.sourceKey)).toThrow(
			'connection opened under the current contract'
		);
		expect(() => exportBoardSourceCleanup(db, receipt.sourceKey, backup)).toThrow(
			'connection opened under the current contract'
		);
		expect(() => suppressBoardSource(db, receipt.sourceKey, backup, '')).toThrow(
			'connection opened under the current contract'
		);
		expect(() => restoreBoardSource(db, receipt, backup)).toThrow(
			'connection opened under the current contract'
		);
		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.prepare).not.toHaveBeenCalled();
	});
	it('rejects backup paths outside the fixture before database or file access', () => {
		const contract = requireBoardIsolation();
		const outside = path.join(contract.worktree, 'production-profile', 'backup.json');
		const db = { transaction: vi.fn(), prepare: vi.fn() } as unknown as Database.Database;
		const receipt = {
			sourceKey: 'a'.repeat(64),
			backupSha256: '',
			archivedCollections: [],
			revision: 1,
		};
		expect(() => exportBoardSourceCleanup(db, receipt.sourceKey, outside)).toThrow(
			'escapes isolated root'
		);
		expect(() => suppressBoardSource(db, receipt.sourceKey, outside, '')).toThrow(
			'escapes isolated root'
		);
		expect(() => restoreBoardSource(db, receipt, outside)).toThrow('escapes isolated root');
		expect(db.transaction).not.toHaveBeenCalled();
		expect(db.prepare).not.toHaveBeenCalled();
	});
});

it('restores source archives whose SQLite ordering differs from locale ordering', () => {
	const db = openBoardDb(fixture.contract.db);
	try {
		const storage = new BoardStorageFacade(db);
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: fixture.sources.one },
			repository: null,
			boardBytes: null,
			profileBytes: null,
			workers: [],
		});
		applyBoardMigration(db, plan);
		const sourceKey = plan.sourceKey;
		for (const key of ['Z', 'a'])
			storage.workspace.createCollection({
				sourceKey,
				collectionKey: key,
				legacyBoardId: key,
				expectedRevision: null,
				set: { name: key },
			});
		const backup = path.join(fixture.contract.root, 'archive-order.json');
		const exported = exportBoardSourceCleanup(db, sourceKey, backup);
		const receipt = suppressBoardSource(db, sourceKey, backup, exported.sha256);
		expect(() => restoreBoardSource(db, receipt, backup)).not.toThrow();
		expect(storage.workspace.listCollections(sourceKey)).toHaveLength(2);
		fs.unlinkSync(backup);
	} finally {
		db.close();
		for (const suffix of ['', '-wal', '-shm'])
			fs.rmSync(fixture.contract.db + suffix, { force: true });
	}
});

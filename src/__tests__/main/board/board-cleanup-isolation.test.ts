import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { requireBoardIsolation } from '../../../main/board/board-isolation';
import {
	exportBoardSourceCleanup,
	previewBoardSourceCleanup,
	restoreBoardSource,
	suppressBoardSource,
} from '../../../main/board/board-source-cleanup';

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

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { compareSqliteSnapshots, snapshotSqlite, sqliteBlobDigest } from './sqliteSnapshot';

describe('bounded SQLite snapshot comparisons', () => {
	it('hashes Buffer, sliced TypedArray and both JSON byte forms identically', () => {
		const buffer = Buffer.from([0, 17, 255, 42]);
		const slice = new Uint8Array([99, ...buffer, 99]).subarray(1, 5);
		for (const value of [
			slice,
			JSON.parse(JSON.stringify(buffer)),
			JSON.parse(JSON.stringify(slice)),
		])
			expect(sqliteBlobDigest(value)).toBe(sqliteBlobDigest(buffer));
		expect(sqliteBlobDigest(new Uint8Array([0, 17, 254, 42]))).not.toBe(sqliteBlobDigest(buffer));
		expect(() => sqliteBlobDigest({ 0: 256 })).toThrow('Invalid BLOB byte');
		expect(() => sqliteBlobDigest({ 1: 5 })).toThrow('Invalid BLOB byte');
	});

	it('streams BLOBs, detects actual byte/scalar/row changes and caps diagnostics at 20', () => {
		const db = new Database(':memory:');
		try {
			db.exec('CREATE TABLE payloads (id INTEGER PRIMARY KEY, bytes BLOB, label TEXT)');
			const insert = db.prepare('INSERT INTO payloads VALUES (?, ?, ?)');
			for (let index = 0; index < 30; index++)
				insert.run(index, Buffer.alloc(65536, index), 'same');
			const before = snapshotSqlite(db);
			expect(compareSqliteSnapshots(before, JSON.parse(JSON.stringify(before)))).toEqual([]);
			db.prepare('UPDATE payloads SET bytes=? WHERE id=0').run(Buffer.alloc(65536, 255));
			expect(compareSqliteSnapshots(before, snapshotSqlite(db))).toHaveLength(1);
			db.exec("UPDATE payloads SET label='changed'");
			const diff = compareSqliteSnapshots(before, snapshotSqlite(db));
			expect(diff).toHaveLength(20);
			expect(diff.every((line) => line.length <= 138)).toBe(true);
			db.exec('DELETE FROM payloads WHERE id=0');
			expect(compareSqliteSnapshots(before, snapshotSqlite(db))[0]).toBe('payloads: row count');
		} finally {
			db.close();
		}
	});
});

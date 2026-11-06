import { expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { nodeSqliteBetterSqlite3Mock } from './nodeSqlite';

it('exposes the exact constructor filename as the database name', () => {
	const db = new (nodeSqliteBetterSqlite3Mock().default)(':memory:');
	try {
		expect(db.name).toBe(':memory:');
	} finally {
		db.close();
	}
});

it('models IMMEDIATE writes and nested rollback with SQLite savepoints', () => {
	const db = new (nodeSqliteBetterSqlite3Mock().default)(':memory:');
	try {
		db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY)');
		expect(db.inTransaction).toBe(false);
		db.transaction(() => {
			expect(db.inTransaction).toBe(true);
			db.prepare('INSERT INTO entries VALUES (?)').run(1);
			expect(() =>
				db
					.transaction(() => {
						db.prepare('INSERT INTO entries VALUES (?)').run(2);
						throw new Error('nested rollback');
					})
					.immediate()
			).toThrow('nested rollback');
			expect(db.prepare('SELECT count(*) AS n FROM entries').get()).toMatchObject({ n: 1 });
		}).immediate();
		expect(db.inTransaction).toBe(false);
		expect(() =>
			db
				.transaction(() => {
					db.transaction(() => db.prepare('INSERT INTO entries VALUES (?)').run(3))();
					throw new Error('outer rollback');
				})
				.immediate()
		).toThrow('outer rollback');
		expect(db.prepare('SELECT count(*) AS n FROM entries').get()).toMatchObject({ n: 1 });
	} finally {
		db.close();
	}
});

it('retains real nested transaction state when the Node 22.13 API has no isTransaction getter', () => {
	// Simulate only the absent versioned API; SQL and savepoints remain real.
	const db = new (nodeSqliteBetterSqlite3Mock().default)(':memory:');
	const internal = db as unknown as { db: DatabaseSync };
	internal.db = new Proxy(internal.db, {
		get(target, key) {
			if (key === 'isTransaction') return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	try {
		db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY)');
		expect(db.inTransaction).toBe(false);
		db.transaction(() => {
			expect(db.inTransaction).toBe(true);
			db.prepare('INSERT INTO entries VALUES (1)').run();
			expect(() =>
				db
					.transaction(() => {
						db.prepare('INSERT INTO entries VALUES (2)').run();
						throw new Error('nested rollback');
					})
					.immediate()
			).toThrow('nested rollback');
			expect(db.inTransaction).toBe(true);
			expect(db.prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }]);
		}).immediate();
		expect(db.inTransaction).toBe(false);
		expect(() =>
			db.transaction(() => {
				db.transaction(() => db.prepare('INSERT INTO entries VALUES (3)').run())();
				throw new Error('outer rollback');
			})()
		).toThrow('outer rollback');
		expect(db.inTransaction).toBe(false);
		expect(db.prepare('SELECT id FROM entries').all()).toEqual([{ id: 1 }]);
	} finally {
		db.close();
	}
});

import { expect, it } from 'vitest';
import { nodeSqliteBetterSqlite3Mock } from './nodeSqlite';

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

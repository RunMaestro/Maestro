import { describe, expect, it } from 'vitest';

import {
	SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE,
	SQLITE_DRY_RUN_NEEDS_EDITING_MESSAGE,
	SQLITE_DRY_RUN_PLAN_MESSAGE,
	SQLITE_DRY_RUN_READ_MESSAGE,
	classifySqliteStatement,
	formatSqliteDryRun,
	sqliteDryRunNotTried,
	sqliteDryRunRefusal,
	sqliteDryRunTried,
	sqliteDryRunUntransactedMessage,
	sqliteSchemaChanges,
	sqliteSchemaChangesText,
	sqliteStatementKindLabel,
	sqliteWriteChangesText,
} from '../../../shared/sqlite/dryRun';

describe('classifySqliteStatement', () => {
	it('reads the verb and target of a data change', () => {
		expect(classifySqliteStatement('DELETE FROM users WHERE id = 1', true)).toEqual({
			kind: 'data',
			verb: 'DELETE',
			target: 'users',
		});
		expect(classifySqliteStatement('update OR ignore "user list" SET a = 1', true)).toEqual({
			kind: 'data',
			verb: 'UPDATE',
			target: 'user list',
		});
		expect(classifySqliteStatement('INSERT OR REPLACE INTO main.[logs] VALUES (1)', true)).toEqual({
			kind: 'data',
			verb: 'INSERT',
			target: 'main.logs',
		});
		expect(classifySqliteStatement('REPLACE INTO t (a) VALUES (1)', true).target).toBe('t');
	});

	it('finds the verb past a WITH clause, outside the CTE bodies', () => {
		const sql =
			'-- prune\nWITH RECURSIVE old(id) AS (SELECT id FROM t WHERE x < 3 UNION SELECT 1) DELETE FROM t WHERE id IN old';
		expect(classifySqliteStatement(sql, true)).toEqual({
			kind: 'data',
			verb: 'DELETE',
			target: 't',
		});
		expect(classifySqliteStatement('WITH a AS (DELETE) SELECT * FROM a', false)).toEqual({
			kind: 'read',
			verb: 'SELECT',
			target: null,
		});
	});

	it('joins the object type to a schema verb and skips IF [NOT] EXISTS', () => {
		expect(
			classifySqliteStatement('CREATE TEMP TABLE IF NOT EXISTS logs (at INTEGER)', true)
		).toEqual({ kind: 'schema', verb: 'CREATE TABLE', target: 'logs' });
		expect(classifySqliteStatement('create unique index ix on t (a)', true)).toEqual({
			kind: 'schema',
			verb: 'CREATE UNIQUE INDEX',
			target: 'ix',
		});
		expect(classifySqliteStatement('DROP VIEW IF EXISTS v', true)).toEqual({
			kind: 'schema',
			verb: 'DROP VIEW',
			target: 'v',
		});
		expect(classifySqliteStatement('ALTER TABLE t ADD COLUMN b TEXT', true)).toEqual({
			kind: 'schema',
			verb: 'ALTER TABLE',
			target: 't',
		});
	});

	it('takes the kind from whether SQLite says it writes', () => {
		expect(classifySqliteStatement('PRAGMA user_version = 3', true)).toEqual({
			kind: 'setting',
			verb: 'PRAGMA',
			target: 'user_version',
		});
		expect(classifySqliteStatement('PRAGMA user_version', false).kind).toBe('read');
		expect(classifySqliteStatement('VACUUM', true)).toEqual({
			kind: 'maintenance',
			verb: 'VACUUM',
			target: null,
		});
		expect(classifySqliteStatement('REINDEX ix', true).kind).toBe('maintenance');
		expect(classifySqliteStatement('SELECT 1', false)).toEqual({
			kind: 'read',
			verb: 'SELECT',
			target: null,
		});
	});
});

describe('sqliteDryRunRefusal', () => {
	it('needs editing and refuses Plan', () => {
		expect(sqliteDryRunRefusal({ editing: false, plan: false })).toBe(
			SQLITE_DRY_RUN_NEEDS_EDITING_MESSAGE
		);
		expect(sqliteDryRunRefusal({ editing: true, plan: true })).toBe(SQLITE_DRY_RUN_PLAN_MESSAGE);
		expect(sqliteDryRunRefusal({ editing: true, plan: false })).toBeNull();
	});

	it('refuses inside an open transaction, whose write lock a trial would wait on', () => {
		expect(sqliteDryRunRefusal({ editing: true, plan: false, transaction: true })).toBe(
			SQLITE_DRY_RUN_IN_TRANSACTION_MESSAGE
		);
		expect(sqliteDryRunRefusal({ editing: true, plan: false, transaction: false })).toBeNull();
	});
});

describe('sqliteSchemaChangesText', () => {
	const changes = [
		{ change: 'created' as const, type: 'index', name: 'logs_at' },
		{ change: 'created' as const, type: 'table', name: 'logs' },
		{ change: 'dropped' as const, type: 'view', name: 'v' },
	];

	it('says what a dry run would do, one part per kind of change', () => {
		expect(sqliteSchemaChangesText(changes)).toEqual([
			'create index logs_at, table logs',
			'drop view v',
		]);
	});

	it('says what an open transaction did in the past tense', () => {
		expect(sqliteSchemaChangesText(changes, true)).toEqual([
			'created index logs_at, table logs',
			'dropped view v',
		]);
		expect(sqliteSchemaChangesText([], true)).toEqual([]);
	});
});

describe('sqliteWriteChangesText', () => {
	it('says the rows a write changed when it changed no schema, even none', () => {
		expect(sqliteWriteChangesText({ changes: 3, schemaChanges: [] })).toBe('changed 3 rows');
		expect(sqliteWriteChangesText({ changes: 1, schemaChanges: [] })).toBe('changed 1 row');
		expect(sqliteWriteChangesText({ changes: 0, schemaChanges: [] })).toBe('changed 0 rows');
	});

	it('says what a schema change did, in the past tense, without a zero row count', () => {
		expect(
			sqliteWriteChangesText({
				changes: 0,
				schemaChanges: [
					{ change: 'created', type: 'table', name: 'logs' },
					{ change: 'created', type: 'index', name: 'logs_at' },
				],
			})
		).toBe('created table logs, index logs_at');
	});

	it('keeps the row count beside a schema change that also changed rows', () => {
		expect(
			sqliteWriteChangesText({
				changes: 2,
				schemaChanges: [{ change: 'dropped', type: 'trigger', name: 'audit' }],
			})
		).toBe('changed 2 rows; dropped trigger audit');
	});
});

describe('sqliteSchemaChanges', () => {
	it('reports created, dropped, and altered objects by type and name', () => {
		const before = [
			{ type: 'table', name: 'users', sql: 'CREATE TABLE users (id)' },
			{ type: 'table', name: 'old', sql: 'CREATE TABLE old (id)' },
			{ type: 'index', name: 'sqlite_autoindex_users_1', sql: null },
		];
		const after = [
			{ type: 'table', name: 'users', sql: 'CREATE TABLE users (id, email)' },
			{ type: 'index', name: 'sqlite_autoindex_users_1', sql: null },
			{ type: 'table', name: 'logs', sql: 'CREATE TABLE logs (at)' },
			{ type: 'index', name: 'logs_at', sql: 'CREATE INDEX logs_at ON logs (at)' },
		];
		expect(sqliteSchemaChanges(before, after)).toEqual([
			{ change: 'created', type: 'index', name: 'logs_at' },
			{ change: 'created', type: 'table', name: 'logs' },
			{ change: 'dropped', type: 'table', name: 'old' },
			{ change: 'altered', type: 'table', name: 'users' },
		]);
		expect(sqliteSchemaChanges(before, before)).toEqual([]);
	});
});

describe('formatSqliteDryRun', () => {
	const classification = { kind: 'data' as const, verb: 'DELETE', target: 'users' };

	it('says what a tried data change would change and that it was rolled back', () => {
		const dryRun = sqliteDryRunTried(classification, {
			changes: 3,
			otherChanges: 2,
			schemaChanges: [],
		});
		expect(dryRun).toMatchObject({ tried: true, untriedReason: null, changes: 3 });
		expect(formatSqliteDryRun(dryRun)).toBe(
			'DELETE on users (changes rows) would change 3 rows; its triggers and foreign-key actions would change 2 other rows. Tried in a transaction and rolled back: nothing was changed.'
		);
		expect(
			formatSqliteDryRun(
				sqliteDryRunTried(classification, { changes: 1, otherChanges: 1, schemaChanges: [] })
			)
		).toContain(
			'would change 1 row; its triggers and foreign-key actions would change 1 other row.'
		);
	});

	it('lists schema changes instead of a zero row count', () => {
		const dryRun = sqliteDryRunTried(
			{ kind: 'schema', verb: 'ALTER TABLE', target: 'users' },
			{
				changes: 0,
				otherChanges: 0,
				schemaChanges: [
					{ change: 'created', type: 'table', name: 'users' },
					{ change: 'dropped', type: 'table', name: 'people' },
					{ change: 'altered', type: 'index', name: 'ix' },
				],
			}
		);
		expect(formatSqliteDryRun(dryRun)).toBe(
			'ALTER TABLE on users (changes the schema) would create table users and drop table people and alter index ix. Tried in a transaction and rolled back: nothing was changed.'
		);
		expect(
			formatSqliteDryRun({ ...dryRun, schemaChanges: [] }).startsWith(
				'ALTER TABLE on users (changes the schema) would change nothing.'
			)
		).toBe(true);
	});

	it('says why a dry run tried nothing', () => {
		const read = sqliteDryRunNotTried(
			{ kind: 'read', verb: 'SELECT', target: null },
			SQLITE_DRY_RUN_READ_MESSAGE
		);
		expect(read).toMatchObject({ tried: false, changes: null, otherChanges: null });
		expect(formatSqliteDryRun(read)).toBe(`SELECT (reads only): ${SQLITE_DRY_RUN_READ_MESSAGE}`);
		expect(
			formatSqliteDryRun(
				sqliteDryRunNotTried(
					{ kind: 'maintenance', verb: 'VACUUM', target: null },
					sqliteDryRunUntransactedMessage('VACUUM')
				)
			)
		).toBe(
			'VACUUM (database maintenance): SQLite runs VACUUM outside any transaction, so a dry run cannot try it and roll it back. Run applies it.'
		);
	});

	it('labels every kind', () => {
		expect(sqliteStatementKindLabel('setting')).toBe('changes a database setting');
	});
});

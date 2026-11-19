import { describe, expect, it } from 'vitest';

import {
	SQLITE_READ_ONLY_KEYWORDS,
	isSqliteReadOnlyKeyword,
	sqliteLeadingKeyword,
	sqliteQueryTimeoutMessage,
	sqliteReadOnlyRefusal,
} from '../../../shared/sqlite/query';

describe('sqliteLeadingKeyword', () => {
	it('reads the first keyword, upper case', () => {
		expect(sqliteLeadingKeyword('select * from t')).toBe('SELECT');
		expect(sqliteLeadingKeyword('  \n\tWith x AS (SELECT 1) SELECT * FROM x')).toBe('WITH');
	});

	it('skips line and block comments that could hide the real keyword', () => {
		expect(sqliteLeadingKeyword('-- a note\nDELETE FROM t')).toBe('DELETE');
		expect(sqliteLeadingKeyword('/* select */ DROP TABLE t')).toBe('DROP');
		expect(sqliteLeadingKeyword('/* a */ -- b\n /* c */ pragma table_info(t)')).toBe('PRAGMA');
	});

	it('is empty when no keyword starts the text', () => {
		expect(sqliteLeadingKeyword('')).toBe('');
		expect(sqliteLeadingKeyword('-- only a comment')).toBe('');
		expect(sqliteLeadingKeyword('/* unterminated')).toBe('');
		expect(sqliteLeadingKeyword(';SELECT 1')).toBe('');
	});
});

describe('sqliteReadOnlyRefusal', () => {
	it('lets every read-only statement kind through', () => {
		for (const keyword of SQLITE_READ_ONLY_KEYWORDS) {
			expect(isSqliteReadOnlyKeyword(keyword.toLowerCase())).toBe(true);
			expect(sqliteReadOnlyRefusal(`${keyword} 1`)).toBeNull();
		}
	});

	it('refuses writes by name, listing what is allowed', () => {
		const refusal = sqliteReadOnlyRefusal('delete from users');
		expect(refusal).toBe(
			'DELETE is not a read-only statement. Queries here are read-only: SELECT, WITH, PRAGMA, EXPLAIN, VALUES.'
		);
		for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'VACUUM INTO "x.db"']) {
			expect(sqliteReadOnlyRefusal(sql)).toMatch(/is not a read-only statement/);
		}
	});

	it('refuses ATTACH and DETACH, which open other files', () => {
		expect(sqliteReadOnlyRefusal("ATTACH '/etc/x.db' AS x")).toMatch(/^ATTACH opens or closes/);
		expect(sqliteReadOnlyRefusal('detach x')).toMatch(/^DETACH opens or closes/);
	});

	it('asks for a statement when there is none', () => {
		expect(sqliteReadOnlyRefusal('   ')).toBe('Write a statement to run.');
		expect(sqliteReadOnlyRefusal('-- nothing yet')).toMatch(/does not start with a statement/);
	});
});

describe('sqliteQueryTimeoutMessage', () => {
	it('names the timeout in seconds', () => {
		expect(sqliteQueryTimeoutMessage(60_000)).toMatch(/stopped after 60 s/);
	});
});

import { describe, expect, it, vi } from 'vitest';

import {
	registerSqliteRowVersion,
	SQLITE_ROW_VERSION_FUNCTION,
	sqliteRowVersion,
	sqliteRowVersionExpression,
	sqliteRowVersionParam,
} from '../../../main/sqlite/sqlite-row-version';

describe('sqliteRowVersion', () => {
	it('is 22 base64url characters and the same for the same values', () => {
		const values = [7n, 'ada', 2.5, null, Buffer.from([1, 2, 3])];
		const version = sqliteRowVersion(values);
		expect(version).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(sqliteRowVersion([7n, 'ada', 2.5, null, Buffer.from([1, 2, 3])])).toBe(version);
	});

	it('tells storage classes apart, so equal-looking values differ', () => {
		const versions = [
			sqliteRowVersion([7n]),
			sqliteRowVersion([7]),
			sqliteRowVersion(['7']),
			sqliteRowVersion([Buffer.from('7')]),
			sqliteRowVersion([null]),
			sqliteRowVersion(['']),
		];
		expect(new Set(versions).size).toBe(versions.length);
	});

	it('does not merge values across column boundaries', () => {
		expect(sqliteRowVersion(['ab', 'c'])).not.toBe(sqliteRowVersion(['a', 'bc']));
		expect(sqliteRowVersion([null, 'x'])).not.toBe(sqliteRowVersion(['x', null]));
		expect(sqliteRowVersion(['x'])).not.toBe(sqliteRowVersion(['x', null]));
	});

	it('sees a change past where a page cuts a value', () => {
		const head = 'a'.repeat(5000);
		expect(sqliteRowVersion([`${head}b`])).not.toBe(sqliteRowVersion([`${head}c`]));
	});

	it('hashes an INTEGER past 2^53 exactly', () => {
		expect(sqliteRowVersion([9007199254740993n])).not.toBe(sqliteRowVersion([9007199254740992n]));
	});

	it('refuses a value SQLite cannot hold', () => {
		expect(() => sqliteRowVersion([{}])).toThrow(`${SQLITE_ROW_VERSION_FUNCTION} cannot hash`);
	});
});

describe('registerSqliteRowVersion', () => {
	it('registers a deterministic, direct-only function that reads integers as BigInt', () => {
		const fn = vi.fn();
		registerSqliteRowVersion({ function: fn } as never);
		expect(fn).toHaveBeenCalledWith(
			SQLITE_ROW_VERSION_FUNCTION,
			{ varargs: true, deterministic: true, directOnly: true, safeIntegers: true },
			expect.any(Function)
		);
		const body = fn.mock.calls[0][2] as (...values: unknown[]) => string;
		expect(body(1n, 'a')).toBe(sqliteRowVersion([1n, 'a']));
	});
});

describe('sqliteRowVersionExpression', () => {
	it('calls the function over the columns, quoted, in order', () => {
		expect(sqliteRowVersionExpression(['id', 'e"mail', 'order'])).toBe(
			'maestro_row_version("id", "e""mail", "order")'
		);
	});

	it('hashes a very wide table in chunks, the outer call over the inner ones', () => {
		const columns = Array.from({ length: 250 }, (_, index) => `c${index}`);
		const expression = sqliteRowVersionExpression(columns);
		expect(expression.startsWith('maestro_row_version(maestro_row_version("c0", ')).toBe(true);
		expect(expression.match(/maestro_row_version\(/g)).toHaveLength(4);
		expect(expression).toContain('"c99"), maestro_row_version("c100", ');
		expect(expression).toContain('"c199"), maestro_row_version("c200", ');
		expect(expression.endsWith('"c249"))')).toBe(true);
	});
});

describe('sqliteRowVersionParam', () => {
	it('reads absent as "named by key alone"', () => {
		expect(sqliteRowVersionParam(undefined)).toBeNull();
		expect(sqliteRowVersionParam(null)).toBeNull();
	});

	it('passes a version through', () => {
		const version = sqliteRowVersion(['x']);
		expect(sqliteRowVersionParam(version)).toBe(version);
	});

	it.each(['', 'short', 'x'.repeat(23), 'has spaces in it okay!!', 42])(
		'refuses %j as no version',
		(value) => {
			expect(() => sqliteRowVersionParam(value)).toThrow('is not a row version');
		}
	);
});

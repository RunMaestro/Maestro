/**
 * @file better-sqlite3-shim.test.ts
 * @description Tests for what `better-sqlite3` resolves to inside the CLI bundle.
 *
 * Every command's bundle contains `cue-db.ts`, so importing the shim must not
 * load the native addon; only constructing a database may, and a failure
 * there must surface as the loader's own error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cli/utils/native-sqlite', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../cli/utils/native-sqlite')>()),
	loadBetterSqlite3: vi.fn(),
}));

import Database from '../../cli/better-sqlite3-shim';
import { loadBetterSqlite3, SqliteUnavailableError } from '../../cli/utils/native-sqlite';

const DatabaseShim = Database as unknown as new (filename: string, options?: object) => unknown;

beforeEach(() => {
	vi.mocked(loadBetterSqlite3).mockReset();
});

describe('better-sqlite3 shim', () => {
	it('loads nothing until a database is opened', () => {
		expect(loadBetterSqlite3).not.toHaveBeenCalled();
	});

	it('returns an instance of the real constructor, with the arguments passed through', () => {
		const opened: unknown[][] = [];
		class RealDatabase {
			constructor(...args: unknown[]) {
				opened.push(args);
			}
		}
		vi.mocked(loadBetterSqlite3).mockReturnValue(RealDatabase as never);

		const db = new DatabaseShim('/data/cue.db', { readonly: true });

		expect(db).toBeInstanceOf(RealDatabase);
		expect(opened).toEqual([['/data/cue.db', { readonly: true }]]);
	});

	it("lets the loader's error through unchanged", () => {
		const error = new SqliteUnavailableError('cannot be loaded', []);
		vi.mocked(loadBetterSqlite3).mockImplementation(() => {
			throw error;
		});

		expect(() => new DatabaseShim('/data/cue.db')).toThrow(error);
	});
});

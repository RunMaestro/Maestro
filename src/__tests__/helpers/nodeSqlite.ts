/**
 * Real SQLite for tests, without the native `better-sqlite3` binary.
 *
 * `better-sqlite3` ships a binding compiled against Electron's
 * NODE_MODULE_VERSION, so `new Database()` throws under vitest's plain-Node
 * runtime. Every Cue DB test so far worked around that by mocking SQL away
 * entirely (see `cue-db.test.ts`'s statement recorder and the in-memory mirror
 * in `cue-integration-test-helpers.ts`), which means no test has ever run a
 * real WHERE clause against the real schema.
 *
 * Node 22+ bundles SQLite as `node:sqlite`. This shim maps the three
 * better-sqlite3 methods `cue-db.ts` uses (`pragma`, `prepare`, `close`) onto
 * it, so a test can do:
 *
 *   vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
 *
 * and then drive `initCueDb(undefined, ':memory:')` and the real query
 * functions against a real database.
 *
 * Use it when the SQL itself is what's under test (filter predicates,
 * ordering, GROUP BY). For call-shape assertions the statement recorder in
 * `cue-db.test.ts` is still the lighter tool.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Whether `node:sqlite` is available in this runtime. Guard a suite with
 * `describe.skipIf(!canLoadNodeSqlite())` so an older Node degrades to a skip
 * instead of a module-resolution crash.
 */
export function canLoadNodeSqlite(): boolean {
	try {
		const probe = new DatabaseSync(':memory:');
		probe.close();
		return true;
	} catch {
		return false;
	}
}

/**
 * The subset of the better-sqlite3 `Database` surface that `cue-db.ts` calls,
 * backed by `node:sqlite`.
 */
class NodeSqliteDatabaseShim {
	private readonly db: DatabaseSync;

	/**
	 * Honors the better-sqlite3 options whose behavior a caller can depend on:
	 * `readonly` (a read-only open of a WAL store is observably different, it
	 * can create sidecar files it cannot remove), `fileMustExist`, and
	 * `timeout` as the busy timeout.
	 */
	constructor(
		filename: string,
		options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number } = {}
	) {
		const inMemory = filename === '' || filename === ':memory:';
		if (options.fileMustExist && !inMemory && !existsSync(filename)) {
			throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
		}
		this.db = new DatabaseSync(filename, { readOnly: options.readonly === true });
		if (options.timeout !== undefined) this.db.exec(`PRAGMA busy_timeout = ${options.timeout}`);
	}

	/**
	 * better-sqlite3 folds both pragma forms into one method. A setter
	 * (`journal_mode = WAL`) returns nothing useful; a getter
	 * (`table_info(cue_events)`) returns one row per column, which is what the
	 * additive-column migration reads.
	 */
	pragma(source: string): unknown {
		if (source.includes('=')) {
			this.db.exec(`PRAGMA ${source}`);
			return [];
		}
		return this.db.prepare(`PRAGMA ${source}`).all();
	}

	prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
		return this.db.prepare(sql);
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Module shape for `vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock())`.
 */
export function nodeSqliteBetterSqlite3Mock(): { default: typeof NodeSqliteDatabaseShim } {
	return { default: NodeSqliteDatabaseShim };
}

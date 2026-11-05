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
 * Node 22+ bundles SQLite as `node:sqlite`. This shim maps the four
 * better-sqlite3 methods `cue-db.ts` uses (`pragma`, `prepare`, `transaction`,
 * `close`) onto it, so a test can do:
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
	readonly name: string;
	private savepoint = 0;

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
		this.name = filename;
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
	pragma(source: string, options: { simple?: boolean } = {}): unknown {
		if (source.includes('=')) {
			this.db.exec(`PRAGMA ${source}`);
			return [];
		}
		const rows = this.db.prepare(`PRAGMA ${source}`).all();
		return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
		return this.db.prepare(sql);
	}

	/**
	 * better-sqlite3's `transaction(fn)` returns a function that runs `fn`
	 * between BEGIN and COMMIT and rolls back when it throws. Board uses both
	 * IMMEDIATE writes and nested read snapshots, modeled with real savepoints.
	 */
	transaction<Args extends unknown[], Result>(
		fn: (...args: Args) => Result
	): ((...args: Args) => Result) & { immediate: (...args: Args) => Result } {
		const run = (mode: string, args: Args) => {
			const savepoint = this.db.isTransaction ? `shim_${++this.savepoint}` : null;
			this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : mode);
			try {
				const result = fn(...args);
				this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
				return result;
			} catch (error) {
				if (savepoint) {
					this.db.exec(`ROLLBACK TO ${savepoint}`);
					this.db.exec(`RELEASE ${savepoint}`);
				} else this.db.exec('ROLLBACK');
				throw error;
			}
		};
		return Object.assign((...args: Args) => run('BEGIN', args), {
			immediate: (...args: Args) => run('BEGIN IMMEDIATE', args),
		});
	}

	get inTransaction(): boolean {
		return this.db.isTransaction;
	}

	function(name: string, fn: () => number): this {
		this.db.function(name, fn);
		return this;
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

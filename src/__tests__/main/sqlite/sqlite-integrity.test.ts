import { beforeEach, describe, expect, it, vi } from 'vitest';

// better-sqlite3's native binary is built for Electron's ABI and does not load
// under vitest, so the driver is a fake that records how the check's own
// connection was opened and answers the integrity pragma with rows set here.
// Under vitest no compiled worker sits beside sqlite-integrity.ts, so the
// check runs inline: these tests drive the same task the worker thread runs.
const driver = vi.hoisted(() => ({
	instances: [] as Array<{
		path: string;
		options: Record<string, unknown>;
		pragmas: string[];
		closed: boolean;
	}>,
	/** Rows the integrity pragma returns. */
	rows: [] as Array<Record<string, unknown>>,
	/** Error the integrity pragma throws instead, if any. */
	checkError: null as Error | null,
	/** Error the open's schema read throws, if any. */
	openError: null as Error | null,
}));

vi.mock('better-sqlite3', () => {
	class FakeDatabase {
		record: (typeof driver.instances)[number];
		constructor(filePath: string, options: Record<string, unknown>) {
			this.record = { path: filePath, options, pragmas: [], closed: false };
			driver.instances.push(this.record);
		}
		pragma(source: string) {
			this.record.pragmas.push(source);
			if (source === 'schema_version' && driver.openError) throw driver.openError;
			if (/^(quick|integrity)_check/.test(source)) {
				if (driver.checkError) throw driver.checkError;
				return driver.rows;
			}
			return 1;
		}
		close() {
			this.record.closed = true;
		}
	}
	return { default: FakeDatabase };
});

const releaseHooks = vi.hoisted(() => new Set<() => void>());
vi.mock('../../../main/sqlite/sqlite-database', () => ({
	getSqliteDatabase: (handle: string) => {
		if (handle !== 'h1') throw new Error('SQLite database handle is no longer open.');
		return { displayPath: '/data/app.db', releaseHooks };
	},
}));

import { checkSqliteIntegrity } from '../../../main/sqlite/sqlite-integrity';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../main/sqlite/sqlite-connection';
import { SQLITE_INTEGRITY_PROBLEM_CAP } from '../../../shared/sqlite/summary';

function sqliteError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

describe('checkSqliteIntegrity', () => {
	beforeEach(() => {
		driver.instances = [];
		driver.rows = [{ quick_check: 'ok' }];
		driver.checkError = null;
		driver.openError = null;
		releaseHooks.clear();
	});

	it('runs a quick check on a read-only connection of its own and closes it', async () => {
		const result = await checkSqliteIntegrity('h1', 'quick');
		expect(result).toMatchObject({ mode: 'quick', ok: true, problems: [], truncated: false });
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

		const [connection] = driver.instances;
		expect(connection.path).toBe('/data/app.db');
		expect(connection.options).toEqual({
			readonly: true,
			fileMustExist: true,
			timeout: SQLITE_BUSY_TIMEOUT_MS,
		});
		expect(connection.pragmas).toEqual([
			'trusted_schema = OFF',
			'schema_version',
			`quick_check(${SQLITE_INTEGRITY_PROBLEM_CAP})`,
		]);
		expect(connection.closed).toBe(true);
	});

	it('runs PRAGMA integrity_check for a full check', async () => {
		driver.rows = [{ integrity_check: 'ok' }];
		const result = await checkSqliteIntegrity('h1', 'full');
		expect(result).toMatchObject({ mode: 'full', ok: true });
		expect(driver.instances[0].pragmas).toContain(
			`integrity_check(${SQLITE_INTEGRITY_PROBLEM_CAP})`
		);
	});

	it('lists each problem SQLite reports, verbatim', async () => {
		driver.rows = [
			{
				quick_check:
					'*** in database main ***\nTree 3 page 5: btreeInitPage() returns error code 11',
			},
			{ quick_check: 'wrong # of entries in index tv' },
		];
		const result = await checkSqliteIntegrity('h1', 'quick');
		expect(result.ok).toBe(false);
		expect(result.problems).toEqual([
			'*** in database main ***\nTree 3 page 5: btreeInitPage() returns error code 11',
			'wrong # of entries in index tv',
		]);
		expect(result.truncated).toBe(false);
	});

	it('marks a reply that fills the cap as truncated', async () => {
		driver.rows = Array.from({ length: SQLITE_INTEGRITY_PROBLEM_CAP }, (_, index) => ({
			quick_check: `problem ${index}`,
		}));
		const result = await checkSqliteIntegrity('h1', 'quick');
		expect(result.problems).toHaveLength(SQLITE_INTEGRITY_PROBLEM_CAP);
		expect(result.truncated).toBe(true);
	});

	it('reports a file SQLite throws on as damaged, not as a failed call', async () => {
		driver.checkError = sqliteError('SQLITE_CORRUPT', 'database disk image is malformed');
		const result = await checkSqliteIntegrity('h1', 'full');
		expect(result.ok).toBe(false);
		expect(result.problems).toEqual(['/data/app.db is damaged: database disk image is malformed']);
		expect(driver.instances[0].closed).toBe(true);
	});

	it('reports a file that no longer opens as a database as a failed check', async () => {
		driver.openError = sqliteError('SQLITE_NOTADB', 'file is not a database');
		const result = await checkSqliteIntegrity('h1', 'quick');
		expect(result.ok).toBe(false);
		expect(result.problems[0]).toContain('is not a readable SQLite database');
	});

	it('rejects, saying another process has the database open, on a lock', async () => {
		driver.checkError = sqliteError('SQLITE_BUSY', 'database is locked');
		await expect(checkSqliteIntegrity('h1', 'quick')).rejects.toThrow(
			'Another process has this database open and kept it locked past the 1 s wait, so it could not be read just now.'
		);
		expect(driver.instances[0].closed).toBe(true);
	});

	it('shares one check in flight per database and mode, then runs afresh', async () => {
		const [first, second] = [
			checkSqliteIntegrity('h1', 'quick'),
			checkSqliteIntegrity('h1', 'quick'),
		];
		expect(second).toBe(first);
		const full = checkSqliteIntegrity('h1', 'full');
		expect(full).not.toBe(first);
		await Promise.all([first, full]);
		expect(driver.instances).toHaveLength(2);

		await checkSqliteIntegrity('h1', 'quick');
		expect(driver.instances).toHaveLength(3);
	});

	it('throws for a handle that is no longer open', () => {
		expect(() => checkSqliteIntegrity('gone', 'quick')).toThrow('no longer open');
	});
});

/**
 * @file native-sqlite.test.ts
 * @description Tests for loading better-sqlite3 from the `maestro-cli` bundle.
 *
 * The CLI runs either on the installed app's runtime (Electron with
 * ELECTRON_RUN_AS_NODE, bundle at `<resources>/maestro-cli.js`) or on plain
 * Node. The first must find the app's Electron-built copy under
 * `app.asar.unpacked`; the second, when no copy fits its ABI, must fail with
 * instructions instead of the raw dlopen error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';

import {
	loadBetterSqlite3,
	resetBetterSqlite3Cache,
	sqliteModuleCandidates,
	SqliteUnavailableError,
	SQLITE_PACKAGE,
	type SqliteRuntime,
} from '../../../cli/utils/native-sqlite';

const RESOURCES = path.join('/opt', 'Maestro', 'resources');
const APP_COPY = path.join(RESOURCES, 'app.asar.unpacked', 'node_modules', SQLITE_PACKAGE);

/** Node's real wording, including the line breaks that split the two ABI numbers. */
const ABI_MISMATCH_MESSAGE =
	"The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
	'was compiled against a different Node.js version using\n' +
	'NODE_MODULE_VERSION 145. This version of Node.js requires\n' +
	'NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n' +
	'the module (for instance, using `npm rebuild` or `npm install`).';

function moduleNotFound(id: string): Error {
	const error = new Error(
		`Cannot find module '${id}'\nRequire stack:\n- ${RESOURCES}/maestro-cli.js`
	) as NodeJS.ErrnoException;
	error.code = 'MODULE_NOT_FOUND';
	return error;
}

/** A better-sqlite3 whose addon loads: construction succeeds. */
function workingDatabase(): new (filename: string) => { close(): void } {
	return class {
		close(): void {}
	};
}

/** A better-sqlite3 whose JS loads but whose addon was built for another ABI. */
function abiMismatchDatabase(): new (filename: string) => { close(): void } {
	return class {
		constructor() {
			const error = new Error(ABI_MISMATCH_MESSAGE) as NodeJS.ErrnoException;
			error.code = 'ERR_DLOPEN_FAILED';
			throw error;
		}
		close(): void {}
	};
}

/** A runtime whose `require` answers from `modules`, and records what it was asked for. */
function runtime(
	overrides: Partial<SqliteRuntime>,
	modules: Record<string, unknown>
): SqliteRuntime & { requested: string[] } {
	const requested: string[] = [];
	return {
		cliDir: RESOURCES,
		nodeVersion: 'v22.22.1',
		moduleVersion: '127',
		...overrides,
		requested,
		require: (id: string) => {
			requested.push(id);
			if (!(id in modules)) throw moduleNotFound(id);
			return modules[id];
		},
	};
}

beforeEach(() => {
	resetBetterSqlite3Cache();
});

describe('sqliteModuleCandidates', () => {
	it("tries the installed app's unpacked copy first on Maestro's runtime", () => {
		const candidates = sqliteModuleCandidates(
			runtime({ electronVersion: '41.0.0', resourcesPath: RESOURCES }, {})
		);
		expect(candidates).toEqual([APP_COPY, SQLITE_PACKAGE]);
	});

	it('also looks beside the bundle when Electron reports another resources path', () => {
		const devResources = path.join('/repo', 'node_modules', 'electron', 'dist', 'resources');
		const candidates = sqliteModuleCandidates(
			runtime({ electronVersion: '41.0.0', resourcesPath: devResources }, {})
		);
		expect(candidates).toEqual([
			path.join(devResources, 'app.asar.unpacked', 'node_modules', SQLITE_PACKAGE),
			APP_COPY,
			SQLITE_PACKAGE,
		]);
	});

	it("never offers the app's Electron-built copy to plain Node", () => {
		expect(sqliteModuleCandidates(runtime({ resourcesPath: RESOURCES }, {}))).toEqual([
			SQLITE_PACKAGE,
		]);
	});
});

describe("loadBetterSqlite3 on Maestro's runtime", () => {
	it("uses the installed app's compatible copy", () => {
		const AppDatabase = workingDatabase();
		const rt = runtime(
			{ electronVersion: '41.0.0', resourcesPath: RESOURCES },
			{ [APP_COPY]: AppDatabase, [SQLITE_PACKAGE]: abiMismatchDatabase() }
		);

		expect(loadBetterSqlite3(rt)).toBe(AppDatabase);
		expect(rt.requested).toEqual([APP_COPY]);
	});

	it('falls back to ordinary resolution when there is no app copy (a source checkout)', () => {
		const CheckoutDatabase = workingDatabase();
		const rt = runtime(
			{ electronVersion: '41.0.0', resourcesPath: RESOURCES },
			{ [SQLITE_PACKAGE]: CheckoutDatabase }
		);

		expect(loadBetterSqlite3(rt)).toBe(CheckoutDatabase);
		expect(rt.requested).toEqual([APP_COPY, SQLITE_PACKAGE]);
	});

	it('accepts an ES-module-shaped export', () => {
		const AppDatabase = workingDatabase();
		const rt = runtime(
			{ electronVersion: '41.0.0', resourcesPath: RESOURCES },
			{ [APP_COPY]: { default: AppDatabase } }
		);

		expect(loadBetterSqlite3(rt)).toBe(AppDatabase);
	});

	it('points at reinstalling Maestro when its own copy is unusable', () => {
		const rt = runtime({ electronVersion: '41.0.0', resourcesPath: RESOURCES }, {});

		expect(() => loadBetterSqlite3(rt)).toThrow(/Reinstall or update Maestro/);
	});
});

describe('loadBetterSqlite3 under plain Node', () => {
	it('uses a copy built for this Node', () => {
		const NodeDatabase = workingDatabase();
		expect(loadBetterSqlite3(runtime({}, { [SQLITE_PACKAGE]: NodeDatabase }))).toBe(NodeDatabase);
	});

	it('turns an ABI mismatch into an actionable error', () => {
		const rt = runtime({ cliDir: '/usr/lib/maestro' }, { [SQLITE_PACKAGE]: abiMismatchDatabase() });

		let caught: unknown;
		try {
			loadBetterSqlite3(rt);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SqliteUnavailableError);
		const error = caught as SqliteUnavailableError;
		expect(error.message).toContain(
			"Maestro's database module (better-sqlite3) cannot be loaded under Node.js v22.22.1 (NODE_MODULE_VERSION 127)."
		);
		expect(error.message).toContain('compiled for NODE_MODULE_VERSION 145');
		expect(error.message).toContain('Settings > General > Maestro CLI');
		expect(error.message).toContain('npm install --prefix "/usr/lib/maestro" better-sqlite3');
		expect(error.attempts).toEqual([
			{ source: SQLITE_PACKAGE, error: expect.stringContaining('NODE_MODULE_VERSION 127') },
		]);
		// Each attempt is one line, so the dlopen text never runs on like a stack trace.
		expect(error.attempts[0].error).not.toContain('\n');
	});

	it('explains a missing package without the require stack', () => {
		const rt = runtime({}, {});

		expect(() => loadBetterSqlite3(rt)).toThrow(SqliteUnavailableError);
		try {
			loadBetterSqlite3(rt);
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain('No copy of better-sqlite3 could be found next to the CLI.');
			expect(message).toContain("Cannot find module 'better-sqlite3'");
			expect(message).not.toContain('Require stack');
		}
	});

	it('reports a failure the same way on every call without probing again', () => {
		const rt = runtime({}, { [SQLITE_PACKAGE]: abiMismatchDatabase() });

		expect(() => loadBetterSqlite3(rt)).toThrow(SqliteUnavailableError);
		expect(() => loadBetterSqlite3(rt)).toThrow(SqliteUnavailableError);
		expect(rt.requested).toEqual([SQLITE_PACKAGE]);
	});
});

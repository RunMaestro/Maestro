/**
 * Loading `better-sqlite3` (a native addon) from the `maestro-cli` bundle.
 *
 * The addon only loads in the runtime it was compiled for, and the CLI runs
 * in two different ones:
 *   - Through the installed `maestro-cli` command, the app's own Electron
 *     binary runs the bundle with `ELECTRON_RUN_AS_NODE=1` (see
 *     `MaestroCliManager.writeUnixShim`). The bundle sits at
 *     `<resources>/maestro-cli.js`, where plain module resolution finds no
 *     `node_modules`: the app's Electron-built copy lives in
 *     `<resources>/app.asar.unpacked/node_modules` (package.json `asarUnpack`).
 *   - Under plain `node`, that Electron-built copy (and a source checkout's
 *     `node_modules` copy, which `postinstall` rebuilds for Electron) fails to
 *     `dlopen` with a NODE_MODULE_VERSION mismatch.
 *
 * `loadBetterSqlite3()` tries the app's copy first when running on Electron,
 * then ordinary resolution, and proves each one by opening an in-memory
 * database (the `.node` file is only loaded by the first constructor call).
 * When none loads it throws `SqliteUnavailableError`, whose message says how
 * to fix it instead of surfacing the raw dlopen error and stack.
 *
 * The bundle reaches this through `src/cli/better-sqlite3-shim.ts`, which
 * `scripts/build-cli.mjs` aliases `better-sqlite3` to.
 */

import { createRequire } from 'module';
import * as path from 'path';

export const SQLITE_PACKAGE = 'better-sqlite3';

type SqliteConstructor = new (filename: string, options?: object) => { close(): unknown };

/** What the loader needs to know about the process it runs in. Injectable for tests. */
export interface SqliteRuntime {
	/** `process.versions.electron`: set under the app's runtime, even with ELECTRON_RUN_AS_NODE. */
	electronVersion?: string;
	/** `process.resourcesPath`, when Electron provides it. */
	resourcesPath?: string;
	/** Directory holding the running `maestro-cli.js` (the resources dir, once packaged). */
	cliDir: string;
	nodeVersion: string;
	/** `process.versions.modules`, the NODE_MODULE_VERSION this runtime accepts. */
	moduleVersion: string;
	/** Node's `require`, NOT the bundler's (which would resolve the alias back to the shim). */
	require: (id: string) => unknown;
}

export interface SqliteLoadAttempt {
	/** Package directory, or the bare package name for ordinary resolution. */
	source: string;
	error: string;
}

export class SqliteUnavailableError extends Error {
	readonly attempts: SqliteLoadAttempt[];

	constructor(message: string, attempts: SqliteLoadAttempt[]) {
		super(message);
		this.name = 'SqliteUnavailableError';
		this.attempts = attempts;
	}
}

export function defaultSqliteRuntime(): SqliteRuntime {
	return {
		electronVersion: process.versions.electron,
		resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
		cliDir: path.dirname(__filename),
		nodeVersion: process.version,
		moduleVersion: process.versions.modules,
		require: createRequire(__filename),
	};
}

/**
 * Where to look, in order. The app's unpacked copy is only offered on
 * Electron: it is built for Electron's ABI, so under plain Node it can only
 * fail and would bury the useful attempt in the error.
 */
export function sqliteModuleCandidates(runtime: SqliteRuntime): string[] {
	const candidates: string[] = [];
	if (runtime.electronVersion) {
		for (const base of [runtime.resourcesPath, runtime.cliDir]) {
			if (!base) continue;
			candidates.push(path.join(base, 'app.asar.unpacked', 'node_modules', SQLITE_PACKAGE));
		}
	}
	candidates.push(SQLITE_PACKAGE);
	return [...new Set(candidates)];
}

/**
 * One line per attempt. Node's dlopen mismatch spreads the two ABI numbers
 * over several lines, so they are joined rather than cut; a MODULE_NOT_FOUND
 * message's "Require stack" list is noise here and is dropped.
 */
function summarizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split('\nRequire stack:')[0].replace(/\s+/g, ' ').trim();
}

function tryLoad(runtime: SqliteRuntime, source: string): SqliteConstructor {
	const loaded = runtime.require(source) as SqliteConstructor | { default: SqliteConstructor };
	const Database = typeof loaded === 'function' ? loaded : loaded.default;
	new Database(':memory:').close();
	return Database;
}

/** The NODE_MODULE_VERSION an addon was built for, from Node's dlopen mismatch message. */
function builtForModuleVersion(attempts: SqliteLoadAttempt[]): string | null {
	for (const attempt of attempts) {
		const match = /NODE_MODULE_VERSION (\d+)\. This version/.exec(attempt.error);
		if (match) return match[1];
	}
	return null;
}

export function describeSqliteUnavailable(
	runtime: SqliteRuntime,
	attempts: SqliteLoadAttempt[]
): string {
	const runtimeName = runtime.electronVersion
		? `Maestro's runtime (Electron ${runtime.electronVersion}, NODE_MODULE_VERSION ${runtime.moduleVersion})`
		: `Node.js ${runtime.nodeVersion} (NODE_MODULE_VERSION ${runtime.moduleVersion})`;
	const builtFor = builtForModuleVersion(attempts);
	const reason = builtFor
		? `The ${SQLITE_PACKAGE} it found was compiled for NODE_MODULE_VERSION ${builtFor}, usually the Maestro desktop app's Electron.`
		: `No copy of ${SQLITE_PACKAGE} could be found next to the CLI.`;

	const fixes = runtime.electronVersion
		? [
				`  - Reinstall or update Maestro: this install's bundled ${SQLITE_PACKAGE} is missing or damaged.`,
			]
		: [
				`  - Run it through the Maestro app: in Maestro, open Settings > General > Maestro CLI and`,
				`    choose "Install / Update CLI", then use the \`maestro-cli\` command it installs. That`,
				`    command runs on the app's own runtime, which ships a compatible ${SQLITE_PACKAGE}.`,
				`  - Or install a ${SQLITE_PACKAGE} built for this Node.js next to the CLI:`,
				`      npm install --prefix "${runtime.cliDir}" ${SQLITE_PACKAGE}`,
			];

	return [
		`Maestro's database module (${SQLITE_PACKAGE}) cannot be loaded under ${runtimeName}.`,
		reason,
		'',
		'To fix this:',
		...fixes,
		'',
		'Tried:',
		...attempts.map((attempt) => `  - ${attempt.source}: ${attempt.error}`),
	].join('\n');
}

let cached: { Database: SqliteConstructor } | { error: SqliteUnavailableError } | null = null;

/**
 * The first `better-sqlite3` constructor whose native addon loads in this
 * runtime. The outcome is cached, so a failure is reported the same way on
 * every call without re-probing.
 */
export function loadBetterSqlite3(
	runtime: SqliteRuntime = defaultSqliteRuntime()
): SqliteConstructor {
	if (cached) {
		if ('error' in cached) throw cached.error;
		return cached.Database;
	}
	const attempts: SqliteLoadAttempt[] = [];
	for (const source of sqliteModuleCandidates(runtime)) {
		try {
			const Database = tryLoad(runtime, source);
			cached = { Database };
			return Database;
		} catch (error) {
			attempts.push({ source, error: summarizeError(error) });
		}
	}
	const error = new SqliteUnavailableError(describeSqliteUnavailable(runtime, attempts), attempts);
	cached = { error };
	throw error;
}

/** Forget the cached outcome. Tests only. */
export function resetBetterSqlite3Cache(): void {
	cached = null;
}

/** Capacity observation only: never initializes, migrates or binds a Board workspace. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { BOARD_SCHEMA_VERSION, boardDbPath } from './board-db';
import { boardWorkerCanStart } from './board-claims';
import {
	assertBoardIsolationPath,
	isBoardIsolationRequested,
	requireBoardIsolation,
} from './board-isolation';

/** Unreadable/unsupported evidence is not proof of free worker capacity. */
export class BoardCapacityReadError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`Board capacity unavailable: ${message}`, options);
		this.name = 'BoardCapacityReadError';
	}
}

/** Read current SQLite/WAL state at each final native admission, without a cached verdict.
 * Native readonly SQLite may coordinate WAL/SHM, but cannot initialize the main DB
 * or mutate logical Board state. Only initial canonical DB ENOENT proves absence. */
export function readBoardWorkerCapacity(agentId: string, pathOverride?: string): boolean {
	let dbPath: string;
	try {
		dbPath = pathOverride ?? boardDbPath();
		if (
			isBoardIsolationRequested() &&
			assertBoardIsolationPath(requireBoardIsolation(), dbPath) !== requireBoardIsolation().db
		)
			throw new Error('isolation database identity mismatch');
	} catch (error) {
		throw new BoardCapacityReadError(
			`cannot resolve database (${(error as NodeJS.ErrnoException).code ?? 'unknown'}): ${String(error)}`,
			{ cause: error }
		);
	}
	let main: fs.BigIntStats;
	try {
		main = fs.lstatSync(dbPath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw new BoardCapacityReadError(
			`cannot inspect database (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
			{ cause: error }
		);
	}
	let handle: Database.Database | undefined;
	try {
		if (!main.isFile() || main.isSymbolicLink() || main.nlink !== 1n)
			throw new Error('database is not a regular file');
		handle = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
		return handle.transaction(() => {
			if (handle!.pragma('user_version', { simple: true }) !== BOARD_SCHEMA_VERSION)
				throw new Error('unsupported Board schema; enable Board to migrate explicitly');
			const free = boardWorkerCanStart(handle!, agentId);
			const current = fs.lstatSync(dbPath, { bigint: true });
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.dev !== main.dev ||
				current.ino !== main.ino
			)
				throw new Error('database identity changed during observation');
			return free;
		})();
	} catch (error) {
		throw new BoardCapacityReadError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	} finally {
		handle?.close();
	}
}

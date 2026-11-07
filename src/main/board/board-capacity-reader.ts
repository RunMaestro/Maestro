/** Capacity observation only: never initializes, migrates or binds a Board workspace. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
 * Like Cue's status reader, refuse absent WAL/SHM instead of creating sidecars or
 * using a stale main-file snapshot. Only ENOENT at the canonical DB path permits absence. */
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
	const descriptors: number[] = [];
	try {
		if (!main.isFile() || main.isSymbolicLink() || main.nlink !== 1n)
			throw new Error('database is not a regular file');
		const fd = fs.openSync(dbPath, 'r');
		descriptors.push(fd);
		const header = Buffer.alloc(24);
		if (
			fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
			header.subarray(0, 16).toString() !== 'SQLite format 3\0'
		)
			throw new Error('invalid SQLite header');
		const wal = header[18] === 2 && header[19] === 2;
		if (!wal && (header[18] !== 1 || header[19] !== 1))
			throw new Error('unsupported SQLite format');
		const identities = new Map<string, fs.BigIntStats>([[dbPath, main]]);
		if (wal) {
			for (const suffix of ['-wal', '-shm']) {
				const file = dbPath + suffix;
				const stat = fs.lstatSync(file, { bigint: true });
				if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
					throw new Error('unsafe WAL sidecar');
				descriptors.push(fs.openSync(file, 'r'));
				identities.set(file, stat);
			}
			// This addon has no no-create WAL/SHM flag. Last-writer close can remove
			// names after stat. Only OS-enforced denial of directory entry creation
			// prevents recreation. Node's Windows access check cannot prove ACL denial.
			let creationDenied = false;
			if (process.platform !== 'win32') {
				try {
					fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== 'EACCES' && code !== 'EROFS') throw error;
					creationDenied = true;
				}
			}
			if (!creationDenied)
				throw new Error(
					'WAL no-create observation unsupported for this directory/platform; retain an admitted facade or retry with safely readable storage'
				);
		}
		/* The same identities must survive opening and reading the SQLite handle. */
		const verifyFiles = () => {
			const format = Buffer.alloc(2);
			if (
				fs.readSync(fd, format, 0, 2, 18) !== 2 ||
				format[0] !== header[18] ||
				format[1] !== header[19]
			)
				throw new Error('SQLite journal format changed during observation');
			for (const [file, expected] of identities) {
				const current = fs.lstatSync(file, { bigint: true });
				if (
					!current.isFile() ||
					current.isSymbolicLink() ||
					current.dev !== expected.dev ||
					current.ino !== expected.ino
				)
					throw new Error('database/sidecar identity changed during observation');
			}
		};
		verifyFiles();
		handle = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
		// Connection-local only, before schema access: a raced rollback -> WAL
		// transition must fail rather than enter the WAL VFS and create sidecars.
		// A rollback reader retains its read lock only until this handle closes.
		if (!wal) handle.pragma('locking_mode = EXCLUSIVE');
		// Opening the SQLite handle precedes schema access. Recheck sidecars before
		// that first access so an observed last-writer close is refused, not recovered.
		verifyFiles();
		const result = handle.transaction(() => {
			if (handle!.pragma('user_version', { simple: true }) !== BOARD_SCHEMA_VERSION)
				throw new Error('unsupported Board schema; enable Board to migrate explicitly');
			const free = boardWorkerCanStart(handle!, agentId);
			verifyFiles();
			return free;
		})();
		return result;
	} catch (error) {
		throw new BoardCapacityReadError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	} finally {
		try {
			handle?.close();
		} finally {
			for (const fd of descriptors) fs.closeSync(fd);
		}
	}
}

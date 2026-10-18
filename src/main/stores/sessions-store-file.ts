/**
 * `maestro-sessions.json` read and written straight off disk, for every caller
 * that runs without the desktop's electron-store: the CLI, the bundle exporter
 * and the bundle importer.
 *
 * The desktop owns this file while it runs (`stores/instances.ts` serves it
 * from an in-memory cache), so a writer here must only run when the desktop is
 * NOT running against the same data directory. The bundle importer checks
 * that before it calls `writeSessionsStoreFile`.
 *
 * No Electron import: the CLI and the standalone Cue engine load this.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo } from '../../shared/types';
import { atomicWriteJson } from '../utils/atomic-json-store';

export const SESSIONS_STORE_FILENAME = 'maestro-sessions.json';

/** The file's top level. Keys other than `sessions` are kept as they are. */
export interface SessionsStoreData {
	sessions?: SessionInfo[];
	/** Agent the desktop UI currently has selected. */
	activeSessionId?: string;
	[key: string]: unknown;
}

export interface SessionsStoreFile {
	/** The parsed file, or undefined when it does not exist. */
	data: SessionsStoreData | undefined;
	/** `data.sessions`, or empty when the file or the array is missing. */
	sessions: SessionInfo[];
}

/** The sessions file exists but is not a JSON object. */
export class SessionsStoreCorruptError extends Error {
	constructor(
		readonly filePath: string,
		cause: string
	) {
		super(`Could not read ${SESSIONS_STORE_FILENAME}: ${cause}`);
		this.name = 'SessionsStoreCorruptError';
	}
}

export function sessionsStorePath(dataDir: string): string {
	return path.join(dataDir, SESSIONS_STORE_FILENAME);
}

/**
 * Read the sessions file in `dataDir`. A missing file reads as empty; any other
 * read error is rethrown as is, and content that is not a JSON object throws
 * {@link SessionsStoreCorruptError}.
 */
export function readSessionsStoreFile(dataDir: string): SessionsStoreFile {
	const filePath = sessionsStorePath(dataDir);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { data: undefined, sessions: [] };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new SessionsStoreCorruptError(
			filePath,
			error instanceof Error ? error.message : String(error)
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new SessionsStoreCorruptError(filePath, 'the file is not a JSON object');
	}
	const data = parsed as SessionsStoreData;
	return { data, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
}

/**
 * Atomically replace the sessions file in `dataDir` with `data`. The caller
 * passes the whole top level (read with {@link readSessionsStoreFile}), so keys
 * it did not touch survive.
 */
export async function writeSessionsStoreFile(
	dataDir: string,
	data: SessionsStoreData
): Promise<void> {
	await atomicWriteJson(sessionsStorePath(dataDir), data);
}

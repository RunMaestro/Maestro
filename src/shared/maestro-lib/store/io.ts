/**
 * Store I/O without `electron-store` (gap L5).
 *
 * The desktop persists its documents through `electron-store`, which is `conf`
 * underneath. A headless runtime has no Electron, so it reads and writes the
 * same files itself, and the files must stay interchangeable: the desktop opens
 * what the runtime wrote, and the runtime opens what the desktop wrote.
 *
 * - **Format.** What conf writes: `JSON.stringify(doc, null, '\t')`, UTF-8, no
 *   BOM, no trailing newline.
 * - **Round trip (DD-5).** A caller changes only the keys it owns on the object
 *   it read and writes that object back. `JSON.parse` keeps string keys in file
 *   order, so a conf-written file comes back byte-identical outside the changed
 *   keys, and a key this build has never heard of survives.
 * - **Atomic.** Every write goes through `atomicWriteFile` (temp file in the
 *   same directory, then rename), after `assertSerializedJsonIsSafe`.
 * - **Schema (DD-6).** A document may carry a top-level integer
 *   `maestroSchemaVersion` (absent means 1). A write to a file whose marker is
 *   newer than this build knows is refused: a build that does not understand a
 *   shape must not rewrite it. The library never stamps the marker itself,
 *   because stamping would break byte identity and tell no current build
 *   anything.
 * - **Wipe backup.** Replacing a non-empty registry (sessions, groups) with an
 *   empty one first snapshots the old list beside the store.
 * - **Corrupt.** Reads report a corrupt file and leave it alone. Quarantining it
 *   is a separate, explicit act (`quarantineStoreFile`).
 *
 * Writes are serialized per file, so two commands racing on one document cannot
 * interleave a read-modify-write. Fencing (is this process still the writer?)
 * belongs to the caller: it runs before `writeStoreDocument`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { assertSerializedJsonIsSafe } from '../../jsonUtils';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import { atomicWriteFile, atomicWriteJson } from './atomic-write';
import { corruptStorePath, parseStoreJson } from './corrupt-store';
import { serializeWithMemoizedArray } from './memoized-serialize';
import {
	classifyReadError,
	classifyStoreContent,
	type ShapeCheck,
	type StoreReadResult,
} from './read-stores';

/** Top-level key of the optional schema marker. */
export const STORE_SCHEMA_KEY = 'maestroSchemaVersion';

/** The newest document schema this build knows. Absent in a file means 1. */
export const KNOWN_STORE_SCHEMA_VERSION = 1;

/** Written beside `maestro-sessions.json` when an empty registry replaces a non-empty one. */
export const SESSIONS_BACKUP_FILENAME = 'maestro-sessions.backup.json';

/** Written beside `maestro-groups.json` when an empty registry replaces a non-empty one. */
export const GROUPS_BACKUP_FILENAME = 'maestro-groups.backup.json';

/** A store whose list is the only copy of what it holds, and where its backup goes. */
export interface RegistrySpec {
	/** Top-level key holding the list (`sessions`, `groups`). */
	listKey: string;
	backupFilename: string;
}

export const SESSIONS_REGISTRY: RegistrySpec = {
	listKey: 'sessions',
	backupFilename: SESSIONS_BACKUP_FILENAME,
};

export const GROUPS_REGISTRY: RegistrySpec = {
	listKey: 'groups',
	backupFilename: GROUPS_BACKUP_FILENAME,
};

/** A write the library refuses because the file belongs to a newer build. */
export class StoreWriteError extends Error {
	readonly code = 'store-too-new';
	constructor(
		readonly file: string,
		/** The marker the file carries. */
		readonly version: number,
		/** The newest schema this build knows. */
		readonly knownVersion: number
	) {
		super(
			`${path.basename(file)} uses store schema ${version}, newer than this build knows ` +
				`(${knownVersion}). Update maestro-cli before writing it.`
		);
		this.name = 'StoreWriteError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A document's schema version: its `maestroSchemaVersion` marker, or 1 when it
 * has none. A marker that is not a finite number is ignored rather than trusted,
 * so a garbled value cannot lock the user out of their own store.
 */
export function storeSchemaVersion(doc: unknown): number {
	if (!isRecord(doc)) return 1;
	const marker = doc[STORE_SCHEMA_KEY];
	return typeof marker === 'number' && Number.isFinite(marker) ? Math.floor(marker) : 1;
}

/** The marker of a file's raw text, without parsing a multi-megabyte document. */
function schemaVersionOfText(content: string): number {
	// conf writes one key per line at one tab of indent, and a JSON string cannot
	// hold a raw newline, so this can only match the real top-level key.
	const match = /^\t"maestroSchemaVersion":\s*(-?\d+(?:\.\d+)?)/m.exec(content);
	if (match) return Math.floor(Number(match[1]));
	if (content.startsWith('{\n\t') || content.trim().length === 0) return 1;
	// Not in conf's layout (hand-edited): fall back to a real parse.
	const parsed = parseStoreJson<unknown>(content);
	return parsed.ok ? storeSchemaVersion(parsed.value) : 1;
}

/**
 * Serialize a document in the format electron-store writes. `memoKey` names an array whose elements are
 * serialized once and reused while the element object is unchanged (DG4); the text is the same.
 */
export function serializeStoreDocument(doc: unknown, memoKey?: string): string {
	const serialized =
		memoKey === undefined
			? JSON.stringify(doc, null, '\t')
			: serializeWithMemoizedArray(doc, memoKey);
	assertSerializedJsonIsSafe(serialized, 'store document');
	return serialized;
}

/**
 * Read and classify one store file. The async twin of the sync readers in
 * `read-stores.ts` (it shares their classification), for a runtime whose stores
 * run to megabytes. Never throws for a missing, unreadable, or corrupt file.
 */
export async function readStoreDocument<T>(
	file: string,
	checkShape: ShapeCheck = () => null
): Promise<StoreReadResult<T>> {
	let content: string;
	try {
		content = await fs.readFile(file, 'utf-8');
	} catch (error) {
		return classifyReadError(file, error);
	}
	return classifyStoreContent<T>(file, content, checkShape);
}

/** What happened to the outgoing registry. */
export type RegistryBackupOutcome =
	| { status: 'skipped' }
	| { status: 'backed-up'; path: string; count: number }
	| { status: 'failed'; path: string; error: Error };

export interface RegistryBackupOptions<T> {
	/** What is on disk right now. */
	existing: readonly T[] | undefined | null;
	/** What is about to be written. */
	incoming: readonly T[] | undefined | null;
	/** Path of the live store; the backup is written beside it. */
	storePath: string;
	backupFilename: string;
	now?: Date;
}

/**
 * Snapshot `existing` beside the store when `incoming` is empty and `existing`
 * is not. Deleting the last entry is a legitimate action, so this never blocks
 * the write: it keeps the outgoing registry first, which turns a permanent loss
 * (a sync folder that had not mounted read as "nothing stored", and the first
 * flush wrote that emptiness back as truth) into a recoverable one.
 *
 * A backup that cannot be written is reported, not thrown: it must not stop the
 * user's actual change from being saved.
 */
export async function backupRegistryBeforeWipe<T>(
	options: RegistryBackupOptions<T>
): Promise<RegistryBackupOutcome> {
	const { existing, incoming, storePath, backupFilename } = options;
	if (incoming && incoming.length > 0) return { status: 'skipped' };
	if (!existing || existing.length === 0) return { status: 'skipped' };

	const backupPath = path.join(path.dirname(storePath), backupFilename);
	try {
		await atomicWriteJson(backupPath, {
			savedAt: (options.now ?? new Date()).toISOString(),
			reason: 'registry-emptied',
			entries: existing,
		});
		return { status: 'backed-up', path: backupPath, count: existing.length };
	} catch (error) {
		return { status: 'failed', path: backupPath, error: error as Error };
	}
}

export interface WriteStoreOptions {
	/** Newest schema this build knows for the file. Defaults to {@link KNOWN_STORE_SCHEMA_VERSION}. */
	knownSchemaVersion?: number;
	/** Set for the registry stores so an emptying write is backed up first. */
	registry?: RegistrySpec;
	/**
	 * The document's big array (`'sessions'`): each element is serialized once and the text reused while
	 * the element object is unchanged, so a write costs what changed, not the whole file (DG4). The
	 * output is byte for byte the same.
	 */
	memoKey?: string;
}

export interface StoreWriteResult {
	file: string;
	bytes: number;
	/** `skipped` unless a registry write emptied a non-empty list. */
	backup: RegistryBackupOutcome;
}

/** One chain per file: two commands racing on one document cannot interleave. */
const writeQueue = createKeyedWriteQueue();

async function readExistingText(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Write a document to a store file in conf's format, atomically.
 *
 * Refuses with {@link StoreWriteError} when either the document or the file on
 * disk carries a schema marker newer than `knownSchemaVersion`. The on-disk check
 * is what catches a newer build that wrote the file after this process read it.
 */
export function writeStoreDocument(
	file: string,
	doc: unknown,
	options: WriteStoreOptions = {}
): Promise<StoreWriteResult> {
	const known = options.knownSchemaVersion ?? KNOWN_STORE_SCHEMA_VERSION;
	return writeQueue.enqueue(file, async () => {
		const incomingVersion = storeSchemaVersion(doc);
		if (incomingVersion > known) throw new StoreWriteError(file, incomingVersion, known);

		// Serialize first: a payload that cannot be written must fail before any
		// side effect (a wipe backup, a temp file).
		const serialized = serializeStoreDocument(doc, options.memoKey);

		const existingText = await readExistingText(file);
		if (existingText !== null) {
			const onDisk = schemaVersionOfText(existingText);
			if (onDisk > known) throw new StoreWriteError(file, onDisk, known);
		}

		let backup: RegistryBackupOutcome = { status: 'skipped' };
		const { registry } = options;
		if (registry && existingText !== null) {
			const incomingList = isRecord(doc) ? doc[registry.listKey] : undefined;
			if (!Array.isArray(incomingList) || incomingList.length === 0) {
				const existing = parseStoreJson<unknown>(existingText);
				const existingList =
					existing.ok && isRecord(existing.value) ? existing.value[registry.listKey] : undefined;
				backup = await backupRegistryBeforeWipe({
					existing: Array.isArray(existingList) ? existingList : undefined,
					incoming: Array.isArray(incomingList) ? incomingList : undefined,
					storePath: file,
					backupFilename: registry.backupFilename,
				});
			}
		}

		await atomicWriteFile(file, serialized);
		return { file, bytes: Buffer.byteLength(serialized, 'utf-8'), backup };
	});
}

/**
 * Move a store file that cannot be parsed to its stamped `.corrupt-` sidecar and
 * return the sidecar path. Only an explicit request calls this (RT8): a torn read
 * of a file another process is mid-write looks like corruption, and a surface
 * that silently started empty would write that emptiness back.
 */
export async function quarantineStoreFile(file: string, now: Date = new Date()): Promise<string> {
	const target = corruptStorePath(file, now);
	await fs.rename(file, target);
	return target;
}

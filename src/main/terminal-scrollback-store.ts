/**
 * Terminal Scrollback Store - one file per terminal tab holding the serialized
 * xterm buffer, so a terminal's history survives an app restart.
 *
 *   <userData>/terminal-scrollback/<agentId>-terminal-<tabId>.ansi
 *
 * The renderer serializes (it owns the xterm instance) and decides WHEN to
 * write (debounced on output); this module only validates, caps, and writes
 * atomically. Files are never deleted on tab close - a closed tab can be
 * reopened - so `prune()` runs once after startup restore and drops every file
 * whose tab no longer exists.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { atomicWriteText, createKeyedWriteQueue } from './utils/atomic-json-store';
import {
	TERMINAL_SCROLLBACK_MAX_CHARS,
	isValidTerminalScrollbackKey,
} from '../shared/terminalScrollback';

const FILE_EXTENSION = '.ansi';

const writeQueue = createKeyedWriteQueue();

function scrollbackDir(): string {
	return path.join(app.getPath('userData'), 'terminal-scrollback');
}

function scrollbackPath(key: string): string {
	return path.join(scrollbackDir(), `${key}${FILE_EXTENSION}`);
}

function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Write (or, for an empty snapshot, remove) a terminal's scrollback. Returns
 * false when the key or payload is refused.
 */
export async function saveTerminalScrollback(key: string, data: string): Promise<boolean> {
	if (!isValidTerminalScrollbackKey(key) || typeof data !== 'string') return false;
	if (data.length > TERMINAL_SCROLLBACK_MAX_CHARS) return false;
	return writeQueue.enqueue(key, async () => {
		if (data.length === 0) {
			await fsp.rm(scrollbackPath(key), { force: true });
			return true;
		}
		await fsp.mkdir(scrollbackDir(), { recursive: true });
		await atomicWriteText(scrollbackPath(key), data);
		return true;
	});
}

/** Read a terminal's saved scrollback, or null when there is none. */
export async function loadTerminalScrollback(key: string): Promise<string | null> {
	if (!isValidTerminalScrollbackKey(key)) return null;
	return writeQueue.enqueue(key, async () => {
		try {
			return await fsp.readFile(scrollbackPath(key), 'utf-8');
		} catch (err) {
			if (isMissing(err)) return null;
			throw err;
		}
	});
}

/**
 * Delete every snapshot whose key is not in `keepKeys` (tabs that were closed
 * or belonged to a deleted agent), plus any temp file a crash left behind.
 * Returns how many files were removed.
 */
export async function pruneTerminalScrollback(keepKeys: readonly string[]): Promise<number> {
	const keep = new Set(keepKeys.filter(isValidTerminalScrollbackKey));
	let names: string[];
	try {
		names = await fsp.readdir(scrollbackDir());
	} catch (err) {
		if (isMissing(err)) return 0;
		throw err;
	}
	let removed = 0;
	for (const name of names) {
		// `<key>.ansi.tmp` is atomicWriteText's temp file; one for a kept key may
		// be a write in flight, so it is left alone along with the snapshot.
		const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name;
		const key = base.endsWith(FILE_EXTENSION) ? base.slice(0, -FILE_EXTENSION.length) : null;
		if (key !== null && keep.has(key)) continue;
		await writeQueue.enqueue(key ?? name, () =>
			fsp.rm(path.join(scrollbackDir(), name), { force: true })
		);
		removed++;
	}
	return removed;
}

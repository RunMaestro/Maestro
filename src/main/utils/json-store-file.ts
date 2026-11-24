/**
 * One JSON file in the app's data directory, owned by the main process.
 *
 * For a store only this process writes (the SQLite viewer's query history and
 * statement log): the file is read once and kept in memory, every change goes
 * through one write queue, and each write replaces the file atomically (temp
 * file + rename), so a crash mid-write leaves the old file whole.
 *
 * A file that is not JSON is moved aside to a `.corrupt-<stamp>.json`
 * sidecar (`corruptStorePath()`) and the store starts empty, the way the app's
 * stores recover, rather than being overwritten by the next change. A file
 * that is JSON but not the store's shape is the store's own `parse` to judge.
 */

import { promises as fs } from 'fs';
import path from 'path';

import { corruptStorePath, parseStoreJson } from '../../shared/maestro-lib/store/corrupt-store';
import { atomicWriteJson, createKeyedWriteQueue } from './atomic-json-store';
import { logger } from './logger';

/** A store kept in one JSON file. */
export interface JsonStoreFile<S> {
	/** Read the store and answer from it. */
	read: <T>(pick: (store: S) => T) => Promise<T>;
	/**
	 * Change the store: `change` answers the next store (or null to leave the
	 * file untouched) and what the call resolves. Changes run one at a time.
	 */
	update: <T>(change: (store: S) => { store: S | null; result: T }) => Promise<T>;
}

export interface JsonStoreFileOptions<S> {
	/** The file, asked at first use (the data directory may not be known at import). */
	filePath: () => string;
	empty: () => S;
	/** Parsed JSON as a store; whatever does not fit is the store's to drop. */
	parse: (value: unknown) => S;
	/** Logged when a torn file is moved aside. */
	logContext: string;
}

const QUEUE_KEY = 'store';

export function createJsonStoreFile<S>(options: JsonStoreFileOptions<S>): JsonStoreFile<S> {
	const queue = createKeyedWriteQueue();
	let loaded: S | null = null;

	async function load(): Promise<S> {
		if (loaded) return loaded;
		const file = options.filePath();
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			loaded = options.empty();
			return loaded;
		}
		const parsed = parseStoreJson<unknown>(text);
		if (!parsed.ok) {
			const aside = corruptStorePath(file);
			logger.warn(`${path.basename(file)} is not JSON; moved it to ${aside}`, options.logContext, {
				error: parsed.error.message,
			});
			await fs.rename(file, aside);
			loaded = options.empty();
			return loaded;
		}
		loaded = options.parse(parsed.value);
		return loaded;
	}

	return {
		read: (pick) => queue.enqueue(QUEUE_KEY, async () => pick(await load())),
		update: (change) =>
			queue.enqueue(QUEUE_KEY, async () => {
				const { store, result } = change(await load());
				if (store !== null) {
					const file = options.filePath();
					await fs.mkdir(path.dirname(file), { recursive: true });
					await atomicWriteJson(file, store);
					loaded = store;
				}
				return result;
			}),
	};
}

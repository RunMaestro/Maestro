/**
 * Watching `maestro-settings.json` for changes made by someone else.
 *
 * The runtime does not write settings in Phase 5, but the CLI does
 * (`writeSettingValue`), and a TUI hosting in process should see that edit the
 * way a client of the desktop sees the desktop's own. So the runtime watches the
 * file, waits for the writes to settle, re-reads it, and reports the top-level
 * keys whose value differs from the last read.
 *
 * The directory is watched rather than the file: the stores are written by
 * rename, and a watch on a file follows the old inode, which is gone after the
 * first write. Nothing here keeps the process alive.
 */

import * as fs from 'fs';
import * as path from 'path';
import { valuesEqual } from '../client/mirror';
import { logger } from '../host';
import { readSettingsStore } from '../store/read-stores';

const LOG_CONTEXT = '[SettingsWatch]';

export const SETTINGS_WATCH_DEBOUNCE_MS = 250;

export interface FileWatcher {
	close(): void;
}

export type WatchDirectory = (
	dir: string,
	listener: (eventType: string, fileName: string | null) => void
) => FileWatcher;

export interface SettingsWatcherOptions {
	file: string;
	/** Called with the top-level keys whose values changed. Never with an empty list. */
	onChange(keys: string[]): void;
	debounceMs?: number;
	/** The settings values now, or undefined when the file cannot be read. Default: read the file. */
	read?(): Record<string, unknown> | undefined;
	/** Test seam. Default: `fs.watch`, unref'd. */
	watch?: WatchDirectory;
}

const watchWithFs: WatchDirectory = (dir, listener) => {
	const watcher = fs.watch(dir, { persistent: false }, (eventType, fileName) =>
		listener(eventType, fileName === null ? null : String(fileName))
	);
	// An error event with no listener would throw out of the event loop.
	watcher.on('error', (error) => {
		logger.warn(`Watching ${dir} failed: ${error.message}`, LOG_CONTEXT);
	});
	return watcher;
};

/** Keys present in either document whose values differ. */
export function changedTopLevelKeys(
	before: Record<string, unknown>,
	after: Record<string, unknown>
): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((key) => !valuesEqual(before[key], after[key]));
}

export function watchSettingsFile(options: SettingsWatcherOptions): FileWatcher {
	const debounceMs = options.debounceMs ?? SETTINGS_WATCH_DEBOUNCE_MS;
	const baseName = path.basename(options.file);
	const read =
		options.read ??
		((): Record<string, unknown> | undefined => {
			const result = readSettingsStore(options.file);
			if (result.status === 'ok') return result.data;
			return result.status === 'missing' ? {} : undefined;
		});

	let last = read() ?? {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	const settle = (): void => {
		timer = undefined;
		if (closed) return;
		const next = read();
		// A torn or unreadable read keeps the last good copy; the next event retries.
		if (!next) return;
		const keys = changedTopLevelKeys(last, next);
		last = next;
		if (keys.length > 0) options.onChange(keys);
	};

	let watcher: FileWatcher | undefined;
	try {
		watcher = (options.watch ?? watchWithFs)(path.dirname(options.file), (_event, fileName) => {
			// Some platforms report no name; the directory also holds other stores.
			if (fileName !== null && fileName !== baseName) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(settle, debounceMs);
			timer.unref?.();
		});
	} catch (error) {
		logger.warn(
			`Not watching ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
	}

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			watcher?.close();
		},
	};
}

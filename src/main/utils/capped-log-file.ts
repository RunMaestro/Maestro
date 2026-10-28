/**
 * An append-only log file with a size cap, for the output of a process Maestro
 * supervises.
 *
 * A write that would take the file past `maxBytes` first moves the file to
 * `<name>.1` (replacing the one before) and starts a new one, so at most two
 * files exist and a chatty process can take at most twice the cap. The file is
 * opened for append, so a restart of the process continues the same log.
 *
 * Writes are synchronous: they are a process's stdout chunks, small and
 * infrequent, and a synchronous write keeps the rotation free of races with a
 * stream that is still flushing. A failed write (a full disk, a folder removed)
 * is reported once through `onError` and every later write is dropped: losing a
 * log must never take the process, or its supervisor, down with it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** 5 MiB per file, so 10 MiB at most with the previous file. */
export const DEFAULT_CAPPED_LOG_BYTES = 5 * 1024 * 1024;

/** Suffix of the file the previous contents move to when the cap is reached. */
export const CAPPED_LOG_PREVIOUS_SUFFIX = '.1';

export interface CappedLogFileOptions {
	maxBytes?: number;
	/** Called once, on the first failed open, write, or rotation. */
	onError?: (error: unknown) => void;
}

export interface CappedLogFile {
	readonly path: string;
	write(text: string | Buffer): void;
	/** Close the file. Later writes are dropped. Safe to call twice. */
	close(): void;
}

export function openCappedLogFile(
	filePath: string,
	options: CappedLogFileOptions = {}
): CappedLogFile {
	const maxBytes = options.maxBytes ?? DEFAULT_CAPPED_LOG_BYTES;
	let fd: number | null = null;
	let size = 0;
	let done = false;

	const closeFd = (): void => {
		if (fd === null) return;
		try {
			fs.closeSync(fd);
		} catch {
			// Already gone; nothing left to release.
		}
		fd = null;
	};

	const fail = (error: unknown): void => {
		if (done) return;
		done = true;
		closeFd();
		options.onError?.(error);
	};

	const open = (): void => {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fd = fs.openSync(filePath, 'a');
		size = fs.fstatSync(fd).size;
	};

	const rotate = (): void => {
		closeFd();
		fs.renameSync(filePath, filePath + CAPPED_LOG_PREVIOUS_SUFFIX);
		open();
	};

	try {
		open();
	} catch (error) {
		fail(error);
	}

	return {
		path: filePath,
		write(text) {
			if (done || fd === null) return;
			let bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
			if (bytes.length === 0) return;
			// One chunk larger than the whole cap keeps its newest part.
			if (bytes.length > maxBytes) bytes = bytes.subarray(bytes.length - maxBytes);
			try {
				if (size > 0 && size + bytes.length > maxBytes) rotate();
				fs.writeSync(fd as number, bytes);
				size += bytes.length;
			} catch (error) {
				fail(error);
			}
		},
		close() {
			done = true;
			closeFd();
		},
	};
}

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
 *
 * With `linePrefix`, every line is written with that prefix (the
 * supervisor's wall-clock stamp, `logLineStamp()` in `shared/logSources.ts`),
 * added as the line starts so nothing is held back. Lines are found by byte, so
 * a chunk that splits a multi-byte character is never decoded on its own.
 */

import * as fs from 'fs';
import * as path from 'path';

/** 5 MiB per file, so 10 MiB at most with the previous file. */
export const DEFAULT_CAPPED_LOG_BYTES = 5 * 1024 * 1024;

/** Suffix of the file the previous contents move to when the cap is reached. */
export const CAPPED_LOG_PREVIOUS_SUFFIX = '.1';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface CappedLogFileOptions {
	maxBytes?: number;
	/** Called once, on the first failed open, write, or rotation. */
	onError?: (error: unknown) => void;
	/** Written at the start of every non-blank line, called as the line starts. */
	linePrefix?: () => string;
}

export interface CappedLogFile {
	readonly path: string;
	write(text: string | Buffer): void;
	/**
	 * Write one whole line of the supervisor's own. A line the process left
	 * unfinished is ended first, so the two never run together.
	 */
	writeLine(text: string): void;
	/** Close the file. Later writes are dropped. Safe to call twice. */
	close(): void;
}

export interface CappedLogTail {
	/** False when neither the file nor its previous file exists. */
	exists: boolean;
	/** The newest `maxBytes` of the log, the previous file's end first. */
	text: string;
	/** True when older text was left out to stay within `maxBytes`. */
	truncated: boolean;
	/** Size and modification time of the CURRENT file (0 when absent). */
	size: number;
	mtimeMs: number;
}

/** The size and modification time of a file, or null when it is absent. */
export async function statCappedLog(
	filePath: string
): Promise<{ size: number; mtimeMs: number } | null> {
	try {
		const stat = await fs.promises.stat(filePath);
		return { size: stat.size, mtimeMs: stat.mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/** The last `maxBytes` of one file (all of it when it is smaller). */
async function readFileTail(
	filePath: string,
	size: number,
	maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
	if (size === 0 || maxBytes <= 0) return { text: '', truncated: size > 0 };
	const truncated = size > maxBytes;
	// A cut read takes one byte more, the one before the cut: whatever runs up to
	// the first newline is then a partial line (or nothing, when the cut fell
	// right after a newline), and dropping it never drops a whole line.
	const length = truncated ? maxBytes + 1 : size;
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		let text = buffer.subarray(0, bytesRead).toString('utf8');
		if (truncated) {
			const newline = text.indexOf('\n');
			text = newline === -1 ? '' : text.slice(newline + 1);
		}
		return { text, truncated };
	} finally {
		await handle.close();
	}
}

/**
 * Read the newest part of a log written by {@link openCappedLogFile}: the end of
 * the current file and, when it is shorter than `maxBytes`, the end of the file
 * it rotated out of, so a rotation a moment ago does not empty the view.
 */
export async function readCappedLogTail(
	filePath: string,
	maxBytes: number
): Promise<CappedLogTail> {
	const current = await statCappedLog(filePath);
	const previousPath = filePath + CAPPED_LOG_PREVIOUS_SUFFIX;
	const previous = await statCappedLog(previousPath);
	if (!current && !previous) {
		return { exists: false, text: '', truncated: false, size: 0, mtimeMs: 0 };
	}

	const currentTail = current
		? await readFileTail(filePath, current.size, maxBytes)
		: { text: '', truncated: false };
	const left = maxBytes - (current?.size ?? 0);
	let text = currentTail.text;
	let truncated = currentTail.truncated;
	if (previous) {
		if (left > 0) {
			const previousTail = await readFileTail(previousPath, previous.size, left);
			text = previousTail.text + text;
			truncated = previousTail.truncated;
		} else {
			truncated = true;
		}
	}
	return {
		exists: true,
		text,
		truncated,
		size: current?.size ?? 0,
		mtimeMs: current?.mtimeMs ?? 0,
	};
}

export function openCappedLogFile(
	filePath: string,
	options: CappedLogFileOptions = {}
): CappedLogFile {
	const maxBytes = options.maxBytes ?? DEFAULT_CAPPED_LOG_BYTES;
	let fd: number | null = null;
	let size = 0;
	let done = false;
	// Whether the next byte starts a line. A file whose last line was left
	// unfinished by an earlier run is continued, not prefixed.
	let atLineStart = true;

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
		fd = fs.openSync(filePath, 'a+');
		size = fs.fstatSync(fd).size;
	};

	const readLastByteIsNewline = (): boolean => {
		if (fd === null || size === 0) return true;
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] === NEWLINE;
	};

	/** The chunk with `linePrefix` before each non-blank line that starts in it. */
	const prefixLines = (bytes: Buffer, prefix: () => string): Buffer => {
		const parts: Buffer[] = [];
		let start = 0;
		while (start < bytes.length) {
			const newline = bytes.indexOf(NEWLINE, start);
			const end = newline === -1 ? bytes.length : newline + 1;
			const blank =
				newline === start || (newline === start + 1 && bytes[start] === CARRIAGE_RETURN);
			if (atLineStart && !blank) parts.push(Buffer.from(prefix(), 'utf8'));
			parts.push(bytes.subarray(start, end));
			atLineStart = newline !== -1;
			start = end;
		}
		return Buffer.concat(parts);
	};

	const rotate = (): void => {
		closeFd();
		fs.renameSync(filePath, filePath + CAPPED_LOG_PREVIOUS_SUFFIX);
		open();
	};

	try {
		open();
		atLineStart = readLastByteIsNewline();
	} catch (error) {
		fail(error);
	}

	const write = (text: string | Buffer): void => {
		if (done || fd === null) return;
		let bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
		if (bytes.length === 0) return;
		if (options.linePrefix) bytes = prefixLines(bytes, options.linePrefix);
		else atLineStart = bytes[bytes.length - 1] === NEWLINE;
		// One chunk larger than the whole cap keeps its newest part.
		if (bytes.length > maxBytes) bytes = bytes.subarray(bytes.length - maxBytes);
		try {
			if (size > 0 && size + bytes.length > maxBytes) rotate();
			fs.writeSync(fd as number, bytes);
			size += bytes.length;
		} catch (error) {
			fail(error);
		}
	};

	return {
		path: filePath,
		write,
		writeLine(text) {
			write(`${atLineStart ? '' : '\n'}${text}\n`);
		},
		close() {
			done = true;
			closeFd();
		},
	};
}

/**
 * Stream a JSONL file one line at a time.
 *
 * Provider transcripts routinely reach hundreds of MB. Reading one with
 * `fs.readFile` + `split('\n')` holds the whole file as one string, a second
 * copy as the line array, and then every parsed record, all on the Electron
 * main thread. One read of a 207MB Claude transcript took the main heap past
 * 2.8GB, and four overlapping reads on a 1.2GB baseline aborted the process
 * with a V8 heap OOM (#1862). Streaming keeps one line alive at a time, so the
 * cost is bounded by the longest line rather than by the file.
 *
 * Blank lines are skipped, matching the `split('\n').filter((l) => l.trim())`
 * idiom this replaces. A missing or unreadable file rejects, as `readFile` did.
 */

import fsp from 'fs/promises';
import readline from 'readline';
import { once } from 'events';

/**
 * The non-blank lines of a file, in order. The file handle is closed before
 * the generator finishes, including when the consumer stops early or throws:
 * on Windows an open handle blocks the delete or rename a caller may do next.
 */
async function* jsonlLines(filePath: string): AsyncGenerator<string> {
	// Open first so a missing file rejects here, before any stream exists.
	const handle = await fsp.open(filePath, 'r');
	const input = handle.createReadStream({ encoding: 'utf8' });
	const lines = readline.createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (line.trim()) yield line;
		}
	} finally {
		lines.close();
		// autoClose: destroying the stream also closes the file handle, but
		// destroy() only starts the close, so wait for it to finish. A failure
		// here must not replace the error that brought us here.
		if (!input.closed) {
			const closed = once(input, 'close').catch(() => undefined);
			input.destroy();
			await closed;
		}
	}
}

export async function forEachJsonlLine(
	filePath: string,
	onLine: (line: string) => void
): Promise<void> {
	for await (const line of jsonlLines(filePath)) onLine(line);
}

/**
 * The first non-blank line of a file, or null when it has none. Reads only as
 * far as that line, so finding a transcript by its header does not load the
 * whole transcript.
 */
export async function readFirstJsonlLine(filePath: string): Promise<string | null> {
	for await (const line of jsonlLines(filePath)) return line;
	return null;
}

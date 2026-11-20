/**
 * How many bytes a directory occupies on disk, recursively.
 *
 * The one copy of this walk. Local Models had three (the model store, the
 * runtime store, and the runtime installer), each with its own idea of which
 * errors to swallow; the footprint a reclaim offer showed and the bytes its
 * delete freed could disagree for that reason alone.
 *
 * The rules:
 *   - A missing directory is zero, not an error. The footprint of something
 *     that was never installed is a legitimate question with an obvious answer.
 *   - A file that vanishes between the listing and the stat contributes nothing.
 *     A size report is not worth failing over a race with a delete.
 *   - Any other error (a permission problem, an I/O fault) is thrown. A report
 *     that silently reads a protected directory as empty is a wrong report.
 *   - Symbolic links are not followed: the bytes a link points at belong to
 *     wherever they live, and following one can count a file twice or loop.
 */

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';

function isGone(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Recursive byte total for `target`. Missing reads as zero. */
export async function directoryBytes(target: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(target, { withFileTypes: true });
	} catch (error) {
		if (isGone(error)) return 0;
		throw error;
	}

	let total = 0;
	for (const entry of entries) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			total += await directoryBytes(child);
			continue;
		}
		if (!entry.isFile()) continue;
		try {
			total += (await fs.stat(child)).size;
		} catch (error) {
			if (!isGone(error)) throw error;
		}
	}
	return total;
}

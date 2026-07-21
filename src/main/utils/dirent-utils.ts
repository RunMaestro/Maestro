/**
 * Dirent helpers for working with `fs.readdir({ withFileTypes: true })` entries.
 *
 * `Dirent.isDirectory()` and `Dirent.isFile()` return `false` for symbolic links,
 * so symlinks are silently dropped when callers filter on those flags. These
 * helpers resolve the link target via `fs.stat()` so symlinks get classified as
 * the kind of entry they point to.
 */

import type { Dirent } from 'fs';
import fs from 'fs/promises';

/**
 * Resolved type information for a directory entry, with symlinks followed.
 */
export interface ResolvedDirentType {
	/** True if the entry (or its symlink target) is a directory. */
	isDirectory: boolean;
	/** True if the entry (or its symlink target) is a regular file. */
	isFile: boolean;
	/**
	 * True if the entry is a symlink whose target could not be stat'd
	 * (broken link, permission denied, etc.). `isDirectory` and `isFile`
	 * will both be `false` in this case - callers decide how to present
	 * broken links (skip, treat as file, treat as error).
	 */
	isBrokenSymlink: boolean;
}

/**
 * Resolve a Dirent's type, following symlinks so symlinked files/directories
 * are classified by their target rather than being dropped.
 *
 * @param entry A Dirent from `fs.readdir(dir, { withFileTypes: true })`
 * @param fullPath The absolute path to the entry (needed to stat the target)
 */
export async function resolveDirentType(
	entry: Dirent,
	fullPath: string
): Promise<ResolvedDirentType> {
	if (!entry.isSymbolicLink()) {
		return {
			isDirectory: entry.isDirectory(),
			isFile: entry.isFile(),
			isBrokenSymlink: false,
		};
	}

	try {
		const targetStat = await fs.stat(fullPath);
		return {
			isDirectory: targetStat.isDirectory(),
			isFile: targetStat.isFile(),
			isBrokenSymlink: false,
		};
	} catch {
		return {
			isDirectory: false,
			isFile: false,
			isBrokenSymlink: true,
		};
	}
}

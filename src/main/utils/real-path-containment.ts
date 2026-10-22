/**
 * Real-path containment for the main process: whether a path stays inside a root once the file system has
 * resolved its symlinks. The lexical check for an UNTRUSTED relative path is `normalizeRootRelativePath()` in
 * `src/shared/pathContainment.ts` (no `..` escape, nothing absolute); this is the check after it, the one a
 * symlink inside the root cannot get past. Used by the web bridge's protected-path guard and by Dataview's
 * `dataview:readInRoot` (`dv.io.load`).
 */

import * as fs from 'fs';
import * as path from 'path';

/** Error codes that mean "nothing readable there", not a broken file system. */
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

/** `p` case-folded on the platforms whose file systems are case-insensitive by default (macOS, Windows). */
export function foldPathCase(p: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve symlinks through the nearest existing ancestor (sync), so a not-yet-created file under a symlinked
 * folder resolves to where it would land. `p` unchanged when nothing on it resolves.
 */
export function realpathThroughAncestor(p: string): string {
	let current = p;
	const rest: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			const real = fs.realpathSync.native(current);
			return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return p;
			rest.push(path.basename(current));
			current = parent;
		}
	}
	return p;
}

/** Whether absolute path `child` is `parent` or inside it, compared as given (fold and resolve first). */
export function isPathWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = path.relative(parent, child);
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Where a root-relative path really points. */
export type RealPathInRoot =
	/** `realRelativePath`: `realPath` relative to the real root, `/`-separated (where a symlink landed). */
	| { kind: 'inside'; realPath: string; realRelativePath: string }
	| { kind: 'outside'; realPath: string }
	/** Nothing there, a dangling link, or a link loop. */
	| { kind: 'missing' };

/**
 * Where `relativePath` (a `/`-separated path already inside the root lexically) really points beneath
 * `root`: the root and the path are both resolved with `realpath`, so a symlink anywhere on the path counts
 * by its target, and the real path must stay inside the real root. Read `realPath`, never the joined path, so
 * what was checked is what is read. Throws when the root itself cannot be resolved.
 */
export async function resolvePathInRealRoot(
	root: string,
	relativePath: string,
	platform: NodeJS.Platform = process.platform
): Promise<RealPathInRoot> {
	const realRoot = await fs.promises.realpath(root);
	let realPath: string;
	try {
		realPath = await fs.promises.realpath(path.join(root, ...relativePath.split('/')));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code && MISSING_PATH_CODES.has(code)) return { kind: 'missing' };
		throw error;
	}
	const inside = isPathWithin(foldPathCase(realPath, platform), foldPathCase(realRoot, platform));
	if (!inside) return { kind: 'outside', realPath };
	const realRelativePath = path.relative(realRoot, realPath).split(path.sep).join('/');
	return { kind: 'inside', realPath, realRelativePath };
}

/**
 * Turning a markdown file reference into a path something can open.
 *
 * `remarkFileLinks` emits whatever it resolved against the file tree, which is
 * a path RELATIVE to the project root for most hits and absolute for anything
 * outside it. Every surface that renders markdown therefore has to do the same
 * two steps before it can read the file: strip a trailing `:line:col` suffix
 * (agents quote `src/foo.ts:42` constantly) and join a relative reference onto
 * the root. Doing it per surface is how Director's Notes ended up handing a
 * bare `Notes/Thing.md` to a reader expecting an absolute path, which silently
 * opened nothing.
 */

import { isAbsolutePath, joinPath } from '../../../shared/formatters';

/** Remove a `:42` / `:42:7` line-column suffix from a file reference. */
export function stripLineColumnSuffix(filePath: string): string {
	return filePath.replace(/:(\d+)(?::\d+)?$/, '');
}

/**
 * Resolve a clicked file reference to a full path.
 *
 * An absolute reference is used verbatim; anything else is joined onto
 * `projectRoot` using the separator that root already speaks, so SSH remotes
 * (always POSIX) and Windows both stay correct.
 */
export function resolveFileReference(projectRoot: string, fileReference: string): string {
	const normalized = stripLineColumnSuffix(fileReference.trim());
	if (isAbsolutePath(normalized)) return normalized;
	return joinPath(projectRoot, normalized);
}

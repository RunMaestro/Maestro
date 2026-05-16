import type { FileChangeType } from '../types';
import type { GitFileChange } from '../hooks';

/**
 * Map a 2-char git porcelain status code (XY) to a {@link FileChangeType}.
 *
 * - `??` (untracked) → `added`
 * - any `D` in either position (deleted, AD, MD, RD…) → `deleted`
 *   (covers cases where the file is no longer on disk regardless of staging)
 * - any `A` in either position → `added`
 * - everything else (M, R, C, T, U…) → `modified`
 *
 * Designed to be permissive: unknown codes fall through as `modified` so a
 * dirty file is still surfaced rather than silently dropped.
 */
export function classifyGitStatus(status: string): FileChangeType {
	if (status === '??') return 'added';
	if (status.includes('D')) return 'deleted';
	if (status.includes('A')) return 'added';
	return 'modified';
}

/**
 * Build a `path → FileChangeType` lookup from {@link GitFileChange} entries.
 *
 * Paths are kept verbatim (relative to the repo root, matching the porcelain
 * output), so callers should match against the same relative path produced by
 * their file-tree walker.
 */
export function buildFileChangeMap(
	fileChanges: readonly GitFileChange[] | undefined
): Map<string, FileChangeType> {
	const map = new Map<string, FileChangeType>();
	if (!fileChanges) return map;
	for (const change of fileChanges) {
		if (!change.path) continue;
		map.set(change.path, classifyGitStatus(change.status));
	}
	return map;
}

/**
 * From a set of changed file paths, derive every ancestor directory path that
 * contains a change. Used to highlight folders whose descendants are dirty.
 *
 * Example: input `['src/foo/bar.ts', 'README.md']`
 *          output `Set { 'src', 'src/foo' }`
 */
export function buildChangedAncestors(paths: Iterable<string>): Set<string> {
	const ancestors = new Set<string>();
	for (const path of paths) {
		if (!path) continue;
		let idx = path.indexOf('/');
		while (idx !== -1) {
			ancestors.add(path.substring(0, idx));
			idx = path.indexOf('/', idx + 1);
		}
	}
	return ancestors;
}

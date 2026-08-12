/**
 * Pure matching logic shared by both the remark plugin (Rich tier) and the
 * markdown-it plugin (Fast tier). All functions here are framework-agnostic
 * - no mdast, no markdown-it tokens, just strings and indices.
 *
 * The Rich-path remarkFileLinks plugin and the Fast-tier markdownItAdapter
 * both import these helpers so that link resolution behavior is byte-for-byte
 * identical regardless of which preview tier is active.
 */

import type { FileNode } from '../../types/fileTree';
import { buildFileIndex, type FilePathEntry } from '../../../shared/treeUtils';

/**
 * Pre-built indices for O(1) file lookup. Build once per fileTree change
 * (FilePreview already memoizes this) and pass to every matcher call.
 */
export interface FileTreeIndices {
	/** Set of every relative path in the tree. */
	allPaths: Set<string>;
	/** Map from filename → array of full relative paths containing that filename. */
	filenameIndex: Map<string, string[]>;
}

/**
 * Construct a FileTreeIndices from a FileNode tree. Wraps the shared
 * buildFileIndex utility so plugins don't need to know about the tree shape.
 */
export function buildFileTreeIndices(fileTree: FileNode[]): FileTreeIndices {
	const entries = buildFileIndex(fileTree);
	const allPaths = new Set(entries.map((e) => e.relativePath));
	const filenameIndex = buildFilenameIndex(entries);
	return { allPaths, filenameIndex };
}

function buildFilenameIndex(entries: FilePathEntry[]): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const entry of entries) {
		const paths = index.get(entry.filename) || [];
		paths.push(entry.relativePath);
		index.set(entry.filename, paths);

		// Also index without .md extension so [[Note]] resolves to Note.md.
		if (entry.filename.endsWith('.md')) {
			const withoutExt = entry.filename.slice(0, -3);
			const alt = index.get(withoutExt) || [];
			alt.push(entry.relativePath);
			index.set(withoutExt, alt);
		}
	}
	return index;
}

/**
 * Calculate path proximity - how "close" a candidate file is to the cwd.
 * Lower score = closer. Used as the tiebreaker when multiple files share
 * a basename (e.g. multiple README.md across the tree).
 */
export function calculateProximity(filePath: string, cwd: string): number {
	const fileSegments = filePath.split('/');
	const cwdSegments = cwd.split('/').filter(Boolean);

	let commonLength = 0;
	for (let i = 0; i < Math.min(fileSegments.length, cwdSegments.length); i++) {
		if (fileSegments[i] === cwdSegments[i]) commonLength++;
		else break;
	}

	const stepsUp = cwdSegments.length - commonLength;
	const stepsDown = fileSegments.length - commonLength;
	return stepsUp + stepsDown;
}

/**
 * Resolve a wiki-style reference (`[[Note]]`, `[[Folder/Note]]`) to a path
 * in the file tree. Returns null when the reference cannot be resolved.
 *
 * Algorithm:
 *   1. Exact path match (with or without `.md`).
 *   2. Filename-only match - if unique, return it.
 *   3. Filename-only match with multiple candidates - filter by partial path,
 *      then break ties using cwd proximity.
 */
export function findClosestMatch(
	reference: string,
	indices: FileTreeIndices,
	cwd: string
): string | null {
	const { allPaths, filenameIndex } = indices;

	if (allPaths.has(reference)) return reference;
	if (allPaths.has(`${reference}.md`)) return `${reference}.md`;

	const refParts = reference.split('/');
	const filename = refParts[refParts.length - 1];

	let candidates = filenameIndex.get(filename) || [];
	if (candidates.length === 0 && !filename.endsWith('.md')) {
		candidates = filenameIndex.get(`${filename}.md`) || [];
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	if (refParts.length > 1) {
		const filtered = candidates.filter(
			(c) => c.endsWith(reference) || c.endsWith(`${reference}.md`)
		);
		if (filtered.length === 1) return filtered[0];
		if (filtered.length > 1) candidates = filtered;
	}

	let closest = candidates[0];
	let closestScore = calculateProximity(candidates[0], cwd);
	for (let i = 1; i < candidates.length; i++) {
		const score = calculateProximity(candidates[i], cwd);
		if (score < closestScore) {
			closestScore = score;
			closest = candidates[i];
		}
	}
	return closest;
}

/**
 * Resolve a plain path reference (e.g. `Folder/File.md`) to a path in the
 * file tree. Stricter than findClosestMatch - only exact path matches succeed.
 */
export function validatePathReference(reference: string, indices: FileTreeIndices): string | null {
	if (indices.allPaths.has(reference)) return reference;
	if (indices.allPaths.has(`${reference}.md`)) return `${reference}.md`;
	return null;
}

/**
 * Convert an absolute path under projectRoot into a project-relative path.
 * Returns null when the path is outside projectRoot or projectRoot is unset.
 */
export function toRelativePath(absPath: string, projectRoot: string | undefined): string | null {
	if (!projectRoot) return null;
	const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot;
	if (absPath.startsWith(root + '/')) {
		return absPath.slice(root.length + 1);
	}
	return null;
}

/**
 * Finding the file a markdown embed points at.
 *
 * An embed (`![caption](path)` or a tree-resolved `![[name.png]]`) names a file
 * the way its AUTHOR's tool resolves it, and the tools disagree:
 *
 * - Standard markdown (GitHub, VS Code) reads a relative path from the note's
 *   own folder: `img/a.png` inside `docs/readme.md` is `docs/img/a.png`.
 * - Obsidian's "Absolute path in vault" link format writes the path from the
 *   vault root: `Body/_attachments/a.jpg` inside `Body/note.md`.
 * - Obsidian's "Shortest path when possible" format writes only as much as it
 *   needs to be unique, often a bare `a.jpg`, and finds it anywhere in the
 *   vault, nearest folder first.
 * - Agents and shells write `~/...` and `file://...`.
 * - A bare name may live in an attachment folder (`_attachments/`,
 *   `attachments/`, `assets/`, `images/`) beside the note or at the root.
 *
 * Nothing in the reference says which convention wrote it, so
 * `resolveEmbedCandidates` returns every legitimate reading, most likely
 * first, and the caller takes the first one that exists. A reading the file
 * tree already confirms moves to the front, which saves the misses a disk probe
 * would otherwise pay for. A reading the tree does not know is still offered:
 * the tree can be stale, depth-limited, or filtered.
 *
 * Pure: no IPC. `findFirstExistingPath` is the async half that probes.
 */

import { isAbsolutePath } from '../../../shared/formatters';
import { findClosestMatch, toRelativePath, type FileTreeIndices } from './matcher';

export interface EmbedResolutionContext {
	/** Absolute path of the markdown file that holds the embed. */
	markdownFilePath: string;
	/** Root the file tree and vault-root paths are relative to, when known. */
	projectRoot?: string;
	/** The user's home folder, for `~/` references. */
	homeDir?: string;
	/** File tree indices relative to `projectRoot`, for the nearest-match lookup. */
	indices?: FileTreeIndices | null;
}

const SEPARATOR = /[/\\]/;

/**
 * Folders tools commonly drop attachments into, tried for a bare file name
 * under the note's folder and under the project root. `_attachments` is the
 * Obsidian convention Maestro's own wiki-embed fallback has always assumed.
 */
const ATTACHMENT_FOLDERS = ['_attachments', 'attachments', 'assets', 'images'];

/** Index of the last `/` or `\` in a path, or -1. */
function lastSeparator(path: string): number {
	return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/**
 * Collapse `.` and `..` segments and repeated separators. Keeps the leading
 * root (`/`, `\`, or a `C:` drive) and writes the result with the separator the
 * path already speaks, so Windows and POSIX (including SSH remote) paths both
 * survive.
 */
function resolveDotSegments(path: string): string {
	const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
	const drive = path.match(/^[a-zA-Z]:/)?.[0] ?? '';
	const rest = path.slice(drive.length);
	const rooted = /^[/\\]/.test(rest);
	const resolved: string[] = [];
	for (const part of rest.split(SEPARATOR)) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
			else if (!rooted) resolved.push('..');
			continue;
		}
		resolved.push(part);
	}
	return `${drive}${rooted ? sep : ''}${resolved.join(sep)}`;
}

/** Join a relative reference onto a base folder and collapse dot segments. */
function joinResolved(base: string, relative: string): string {
	if (!base) return resolveDotSegments(relative);
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return resolveDotSegments(`${base}${sep}${relative}`);
}

/** Whether a source needs no file lookup at all. */
function isSelfContained(src: string): boolean {
	return /^(?:data:|https?:\/\/)/i.test(src);
}

/** Whether a relative reference explicitly starts at the note's folder. */
function isExplicitlyNoteRelative(src: string): boolean {
	return /^\.\.?[/\\]/.test(src);
}

/**
 * Resolve a reference against the folder of the markdown file that holds it,
 * the standard markdown reading. Absolute paths, data URLs, and http(s) URLs
 * come back unchanged.
 */
export function resolveNoteRelativePath(src: string, markdownFilePath: string): string {
	if (isSelfContained(src) || isAbsolutePath(src)) return src;
	return joinResolved(markdownFilePath.slice(0, Math.max(lastSeparator(markdownFilePath), 0)), src);
}

/**
 * Every on-disk path an embed reference may point at, most likely first and
 * without duplicates. See the module comment for the conventions covered.
 * Expects a percent-DECODED `src`.
 */
export function resolveEmbedCandidates(src: string, context: EmbedResolutionContext): string[] {
	const { markdownFilePath, projectRoot, homeDir, indices } = context;
	let ref = src.trim();
	if (!ref) return [];
	if (isSelfContained(ref)) return [ref];
	if (/^file:\/\//i.test(ref)) ref = ref.slice('file://'.length);
	if (/^~[/\\]/.test(ref)) {
		if (!homeDir) return [];
		ref = joinResolved(homeDir, ref.slice(2));
	}
	if (isAbsolutePath(ref)) return [resolveDotSegments(ref)];

	const readings: string[] = [resolveNoteRelativePath(ref, markdownFilePath)];

	if (projectRoot && !isExplicitlyNoteRelative(ref)) {
		readings.push(joinResolved(projectRoot, ref));
	}

	if (projectRoot && indices) {
		const noteDir = markdownFilePath.slice(0, Math.max(lastSeparator(markdownFilePath), 0));
		const proximityBase = toRelativePath(noteDir.replace(/\\/g, '/'), projectRoot) ?? '';
		const treeRef = ref.replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '');
		const match = findClosestMatch(treeRef, indices, proximityBase);
		if (match) readings.push(joinResolved(projectRoot, match));
	}

	// A bare file name may sit in an attachment folder the file tree does not
	// list (a filtered, depth-limited, or not-yet-refreshed tree).
	if (!SEPARATOR.test(ref)) {
		const noteDir = markdownFilePath.slice(0, Math.max(lastSeparator(markdownFilePath), 0));
		for (const folder of ATTACHMENT_FOLDERS) {
			readings.push(joinResolved(noteDir, `${folder}/${ref}`));
			if (projectRoot) readings.push(joinResolved(projectRoot, `${folder}/${ref}`));
		}
	}

	const unique = [...new Set(readings)];
	if (!projectRoot || !indices) return unique;

	const inTree = (path: string) => {
		const relative = toRelativePath(path.replace(/\\/g, '/'), projectRoot.replace(/\\/g, '/'));
		return relative !== null && indices.allPaths.has(relative);
	};
	return [...unique.filter(inTree), ...unique.filter((path) => !inTree(path))];
}

/**
 * Probe candidates in order and return the first one `probe` accepts, with the
 * value it produced. `probe` returns `null` (or throws) for a miss. A throw on
 * one candidate does not stop the walk; the last error is rethrown only when
 * every candidate failed and at least one threw.
 */
export async function findFirstExistingPath<T>(
	candidates: string[],
	probe: (path: string) => Promise<T | null>
): Promise<{ path: string; value: T } | null> {
	let lastError: unknown;
	for (const path of candidates) {
		try {
			const value = await probe(path);
			if (value !== null && value !== undefined) return { path, value };
		} catch (err) {
			lastError = err;
		}
	}
	if (lastError !== undefined) throw lastError;
	return null;
}

/**
 * Obsidian sizes a markdown image through its alt text: `![caption|220](x.png)`
 * or `![caption|220x140](x.png)`. Splits the size off so the caption reads clean.
 */
export function parseEmbedAltSize(alt: string | undefined): {
	alt: string;
	width?: number;
	height?: number;
} {
	const match = alt?.match(/^(.*?)\s*\|\s*(\d+)(?:x(\d+))?\s*$/);
	if (!match) return { alt: alt ?? '' };
	return {
		alt: match[1],
		width: parseInt(match[2], 10),
		height: match[3] ? parseInt(match[3], 10) : undefined,
	};
}

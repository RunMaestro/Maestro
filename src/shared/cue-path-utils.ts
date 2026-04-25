/**
 * Path utilities for cross-directory Cue pipeline support.
 *
 * Enables pipelines to span agents in subdirectories of a common project root
 * by detecting ancestor/descendant relationships between project paths.
 *
 * Pure string-based implementation — intentionally does NOT import Node's
 * `path` module so this file can be called from both the Electron main
 * process and the renderer. (The renderer strips Node built-ins; importing
 * `path` there throws `path.resolve is not a function` when the pipeline
 * editor saves, which is exactly what this utility powers.)
 *
 * Inputs are expected to already be absolute, os-native paths sourced from
 * `session.projectRoot` — the main process resolves those via Node before
 * they reach here, so we only need collapse/trim + prefix comparison.
 */

// Paths are assumed to use ONE separator consistently within a single input
// (sourced from `session.projectRoot`, which the main process resolves to an
// os-native path before it reaches here). When detection sees both separators
// in the same string — a degenerate case we've seen when users hand-author
// test fixtures — we pick whichever appears first in the input so the rest of
// the pipeline at least operates on a coherent split.
function detectSeparator(p: string): '\\' | '/' {
	const firstFwd = p.indexOf('/');
	const firstBack = p.indexOf('\\');
	if (firstFwd !== -1 && firstBack !== -1) {
		return firstBack < firstFwd ? '\\' : '/';
	}
	// Windows drive letter (`C:\...`), UNC prefix (`\\server\share`), or any
	// backslash in the input → '\'.
	if (/^[a-zA-Z]:\\/.test(p) || p.startsWith('\\\\') || p.includes('\\')) return '\\';
	return '/';
}

function isWindowsRoot(p: string): boolean {
	// `C:\` or `C:` — treat as a root that must not lose its trailing sep.
	return /^[a-zA-Z]:\\?$/.test(p);
}

function isUncRoot(p: string): boolean {
	// `\\server\share` — the share component is mandatory and we must not
	// collapse the leading `\\` or strip the share as a trailing separator.
	return /^\\\\[^\\]+\\[^\\]+$/.test(p);
}

/**
 * Collapse consecutive separators and strip a single trailing separator (but
 * preserve roots like `/`, `C:\`, and UNC shares `\\server\share`). Does NOT
 * resolve `..`/`.` segments — inputs are pre-resolved absolute paths from the
 * Electron main process.
 */
function normalize(p: string, sep: '\\' | '/'): string {
	if (!p) return p;

	// UNC paths (`\\server\share\...`) MUST retain their leading double
	// backslash — collapsing it via the general `\\+` rule would truncate to
	// `\server\share\...` and break every downstream comparison. We carve off
	// the `\\` prefix, collapse the rest, then reattach.
	if (sep === '\\' && p.startsWith('\\\\')) {
		const rest = p.slice(2).replace(/\\+/g, '\\');
		let out = '\\\\' + rest;
		if (out.length > 2 && out.endsWith('\\') && !isUncRoot(out.slice(0, -1))) {
			out = out.slice(0, -1);
		}
		return out;
	}

	const collapseRe = sep === '\\' ? /\\+/g : /\/+/g;
	let out = p.replace(collapseRe, sep);
	if (out.length > 1 && out.endsWith(sep) && !isWindowsRoot(out) && !isUncRoot(out)) {
		out = out.slice(0, -1);
	}
	return out;
}

/**
 * Given an array of absolute paths, return their longest common directory
 * prefix. Returns `null` for empty input, or the single path for a
 * single-element array.
 *
 * Example: `['/a/b/c', '/a/b/d']` → `'/a/b'`
 */
export function computeCommonAncestorPath(paths: string[]): string | null {
	if (paths.length === 0) return null;

	const sep = detectSeparator(paths[0]);
	const normalized = paths.map((p) => normalize(p, sep));
	if (normalized.length === 1) return normalized[0];

	const segments = normalized.map((p) => p.split(sep));
	const minLength = Math.min(...segments.map((s) => s.length));

	let commonLength = 0;
	for (let i = 0; i < minLength; i++) {
		const segment = segments[0][i];
		if (segments.every((s) => s[i] === segment)) {
			commonLength = i + 1;
		} else {
			break;
		}
	}

	if (commonLength === 0) return sep;
	return segments[0].slice(0, commonLength).join(sep) || sep;
}

/**
 * Returns `true` if `child` is the same as or a subdirectory of `parent`.
 * Both must be absolute paths. Uses normalized comparison.
 */
export function isDescendantOrEqual(child: string, parent: string): boolean {
	const sep = detectSeparator(child || parent);
	const normalizedChild = normalize(child, sep);
	const normalizedParent = normalize(parent, sep);
	if (normalizedChild === normalizedParent) return true;
	return normalizedChild.startsWith(normalizedParent + sep);
}

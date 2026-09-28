/**
 * Shared glob pattern matching and .gitignore parsing utilities.
 * Used by both the renderer (file tree loading) and main process (directory stats).
 */

// Cache compiled regexes per pattern string. File-tree traversals call
// matchGlobPattern once per (file × pattern), so without this cache every
// refresh recompiles tens of thousands of identical regexes.
const globRegexCache = new Map<string, RegExp>();

function compileGlobRegex(pattern: string): RegExp {
	const cached = globRegexCache.get(pattern);
	if (cached) return cached;
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
		.replace(/\*/g, '.*') // * matches any chars
		.replace(/\?/g, '.'); // ? matches single char
	const regex = new RegExp(`^${regexStr}$`, 'i');
	globRegexCache.set(pattern, regex);
	return regex;
}

/**
 * Simple glob pattern matcher for ignore patterns.
 * Supports basic glob patterns: *, ?, and character classes.
 * @param pattern - The glob pattern to match against
 * @param name - The file/folder name to test
 * @returns true if the name matches the pattern
 */
export function matchGlobPattern(pattern: string, name: string): boolean {
	return compileGlobRegex(pattern).test(name);
}

/**
 * A pattern list split into the two things it actually contains: plain names
 * and real globs. See {@link shouldIgnore} for why the split exists.
 */
interface CompiledIgnoreSet {
	/** Lower-cased literal names (no `*` or `?`), matched by Set lookup. */
	literals: Set<string>;
	/** Compiled regexes for the patterns that genuinely need one. */
	globs: RegExp[];
}

// Keyed on the pattern ARRAY identity, not its contents: building a content key
// would cost more than the work it saves. Callers (the file-tree walk, the
// directory-size walk) hold one patterns array for the whole traversal, so the
// identity key hits on every entry after the first. WeakMap so a stale
// .gitignore's patterns are collected with the array that held them.
const compiledIgnoreSets = new WeakMap<string[], CompiledIgnoreSet>();

function compileIgnoreSet(patterns: string[]): CompiledIgnoreSet {
	const cached = compiledIgnoreSets.get(patterns);
	if (cached) return cached;

	const literals = new Set<string>();
	const globs: RegExp[] = [];
	for (const pattern of patterns) {
		if (pattern.includes('*') || pattern.includes('?')) {
			globs.push(compileGlobRegex(pattern));
		} else {
			// matchGlobPattern compiles with the `i` flag, so literals fold too.
			literals.add(pattern.toLowerCase());
		}
	}

	const compiled = { literals, globs };
	compiledIgnoreSets.set(patterns, compiled);
	return compiled;
}

/**
 * Check if a file/folder name should be ignored based on patterns.
 *
 * Hot path: this runs once per (entry x pattern) for every file-tree traversal
 * and every directory-size walk, so a repo with a 60-line .gitignore pays 60
 * regex tests per file with the naive implementation. Almost every gitignore
 * line is a plain name (`node_modules`, `dist`, `.venv`) that needs no regex at
 * all, so the pattern list is split once per array and literals are answered by
 * a single Set lookup. Matching is case-insensitive either way, unchanged.
 *
 * @param name - The file/folder name to check
 * @param patterns - Array of glob patterns to match against
 * @returns true if the name matches any ignore pattern
 */
export function shouldIgnore(name: string, patterns: string[]): boolean {
	const { literals, globs } = compileIgnoreSet(patterns);
	if (literals.size > 0 && literals.has(name.toLowerCase())) return true;
	for (const glob of globs) {
		if (glob.test(name)) return true;
	}
	return false;
}

/**
 * Parse raw .gitignore content into simplified name-based patterns.
 * Shared between local and remote gitignore handling.
 * Skips comments, empty lines, and negation patterns (!).
 * Strips leading `/` and trailing `/` since we match against names, not paths.
 */
export function parseGitignoreContent(content: string): string[] {
	const patterns: string[] = [];

	for (const line of content.split('\n')) {
		const trimmed = line.trim();

		// Skip empty lines, comments, and negation patterns
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
			continue;
		}

		// Remove leading slash (we match against names, not paths)
		let pattern = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;

		// Remove trailing slash (we match the folder name itself)
		if (pattern.endsWith('/')) {
			pattern = pattern.slice(0, -1);
		}

		if (pattern) {
			patterns.push(pattern);
		}
	}

	return patterns;
}

/** Default local ignore patterns (used when no user-configured patterns are provided) */
export const LOCAL_IGNORE_DEFAULTS = ['node_modules', '__pycache__'];

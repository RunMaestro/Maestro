/**
 * Shared glob pattern matching and .gitignore parsing utilities.
 * Used by both the renderer (file tree loading) and main process (directory stats).
 */

/**
 * Simple glob pattern matcher for ignore patterns.
 * Supports basic glob patterns: *, ?, and character classes.
 * @param pattern - The glob pattern to match against
 * @param name - The file/folder name to test
 * @returns true if the name matches the pattern
 */
export function matchGlobPattern(pattern: string, name: string): boolean {
	// Convert glob pattern to regex
	// Escape special regex chars except * and ?
	const regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
		.replace(/\*/g, '.*') // * matches any chars
		.replace(/\?/g, '.'); // ? matches single char

	// Make it case-insensitive and match full string
	const regex = new RegExp(`^${regexStr}$`, 'i');
	return regex.test(name);
}

/**
 * Check if a file/folder name should be ignored based on patterns.
 * @param name - The file/folder name to check
 * @param patterns - Array of glob patterns to match against
 * @returns true if the name matches any ignore pattern
 */
export function shouldIgnore(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchGlobPattern(pattern, name));
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

/**
 * Shared query-compilation helpers for the FilePreview search bar.
 *
 * The bar has three search kinds, toggled by the chip on the left of the input
 * (only shown for line-numbered code/text views):
 *   - 'text'  - literal substring match (the historical default; the query is
 *               escaped so regex metacharacters are matched verbatim).
 *   - 'regex' - the query is a JS regular expression source, used as-is.
 *   - 'line'  - the query is a 1-based line number; navigation jumps the
 *               viewport to that line instead of finding text matches.
 *
 * Centralizing here keeps every tier (Rich DOM walk, Fast text/code, Giant CM6,
 * edit-mode CM6) building the SAME regex from the SAME rules, so a pattern that
 * matches in one tier matches in all of them.
 */

export type SearchKind = 'text' | 'regex' | 'line';

/** The order the left-of-input chip cycles through on each click. */
export const SEARCH_KIND_CYCLE: readonly SearchKind[] = ['text', 'regex', 'line'];

/** Escape regex metacharacters so a literal query is matched verbatim. */
export function escapeRegExp(query: string): string {
	return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompileSearchRegexOptions {
	/** When true, treat `query` as a raw regex source instead of a literal. */
	regex?: boolean;
	/** Defaults to false (case-insensitive). */
	caseSensitive?: boolean;
}

export interface CompiledSearchRegex {
	/** Global RegExp ready for an exec loop, or null for an empty/invalid query. */
	regex: RegExp | null;
	/** Human-readable message when `regex` mode received an invalid pattern. */
	error: string | null;
}

/**
 * Build a global RegExp from a search query. Literal queries are escaped; regex
 * queries are compiled as-is and surface a friendly error on a bad pattern
 * (e.g. an unclosed group) so the caller can show it rather than throw.
 */
export function compileSearchRegex(
	query: string,
	options: CompileSearchRegexOptions = {}
): CompiledSearchRegex {
	if (!query) return { regex: null, error: null };
	const source = options.regex ? query : escapeRegExp(query);
	const flags = options.caseSensitive ? 'g' : 'gi';
	try {
		return { regex: new RegExp(source, flags), error: null };
	} catch (e) {
		return { regex: null, error: e instanceof Error ? e.message : 'Invalid regular expression' };
	}
}

/**
 * Parse a 'line' query into a 1-based line number, or null when it isn't a
 * positive integer (blank input, partial typing, decimals, negatives).
 */
export function parseLineQuery(query: string): number | null {
	const trimmed = query.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const line = Number(trimmed);
	return Number.isInteger(line) && line >= 1 ? line : null;
}

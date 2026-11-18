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

/** A match as a half-open `[from, to)` character range. */
export interface MatchRange {
	from: number;
	to: number;
}

/**
 * Every match of `pattern` (a ready-to-compile regex source, as the search
 * hook builds it) in `content`, case-insensitive like the rest of the bar.
 * Zero-length matches (`^`, `\b`) are kept but cannot stall the loop.
 */
export function findMatchRanges(content: string, pattern: string): MatchRange[] {
	return findMatches(content, pattern).map((m) => ({ from: m.index, to: m.index + m[0].length }));
}

function findMatches(content: string, pattern: string): RegExpExecArray[] {
	const regex = new RegExp(pattern, 'gi');
	const matches: RegExpExecArray[] = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		matches.push(match);
		if (match.index === regex.lastIndex) regex.lastIndex++;
	}
	return matches;
}

/**
 * Expand a regex replacement template for one match, with the same rules as
 * `String.prototype.replace`: `$1`..`$99`, `$<name>`, `$&` (the match),
 * `` $` `` / `$'` (the text before / after it), and `$$` for a literal `$`.
 * A `$` sequence that names no group stays literal, as it does natively.
 */
export function expandReplacement(template: string, match: RegExpExecArray): string {
	const input = match.input;
	const groupCount = match.length - 1;
	return template.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (token, kind, name, digits) => {
		if (kind === '$') return '$';
		if (kind === '&') return match[0];
		if (kind === '`') return input.slice(0, match.index);
		if (kind === "'") return input.slice(match.index + match[0].length);
		if (name !== undefined) {
			if (!match.groups) return token;
			return match.groups[name] ?? '';
		}
		// Two digits when that group exists, else one digit plus a literal.
		const two = Number(digits);
		if (digits.length === 2 && two >= 1 && two <= groupCount) return match[two] ?? '';
		const one = Number(digits[0]);
		if (one >= 1 && one <= groupCount) return (match[one] ?? '') + digits.slice(1);
		return token;
	});
}

export interface BuildReplacementsOptions {
	/** Regex mode expands `$1`-style references; text mode inserts verbatim. */
	regex: boolean;
	/** Replace only the match at this index (Replace). Omit for Replace All. */
	onlyIndex?: number;
}

/**
 * The edits that replace matches of `pattern` in `content`, as offsets into
 * `content` before any edit applies (the shape a single CodeMirror
 * transaction takes, so Replace All undoes in one step).
 */
export function buildReplacements(
	content: string,
	pattern: string,
	replacement: string,
	options: BuildReplacementsOptions
): { from: number; to: number; insert: string }[] {
	const matches = findMatches(content, pattern);
	const picked =
		options.onlyIndex === undefined
			? matches
			: matches[options.onlyIndex]
				? [matches[options.onlyIndex]]
				: [];
	return picked.map((m) => ({
		from: m.index,
		to: m.index + m[0].length,
		insert: options.regex ? expandReplacement(replacement, m) : replacement,
	}));
}

/**
 * `.env` text <-> the two env-var records, plus the one validator both editing
 * modes share.
 *
 * Every env-var editor has a Basic mode (a row per variable) and an Advanced
 * mode (one textarea of `KEY=value` lines). They edit the SAME records, so the
 * rules for what a line means live here rather than in either component:
 *
 *  - `KEY=value`, with an optional leading `export `. Only the first `=`
 *    splits, so `KEY=a=b` is the value `a=b`.
 *  - **Quotes are kept verbatim.** The row editor stores `"a b"` with its
 *    quotes, and its special-character rule passes a value BECAUSE it starts
 *    with one. Stripping them here would make the two modes disagree about the
 *    value of the same variable, and would fail that rule on the way back in.
 *  - `# KEY=value` is a PARKED variable (see `parkedRecords.ts`) when the
 *    caller can park. Any other comment, and every blank line, is ignored and
 *    is not stored anywhere: the records have nowhere to keep it.
 *  - A value cannot span lines. A quote left open that closes further down is
 *    reported once, against the line that opened it, and the lines it swallowed
 *    are skipped rather than each being misread as its own assignment (the
 *    `=` padding at the end of a PEM body would otherwise become a variable).
 *  - A line that fails is reported and left out. Every other line still lands,
 *    which is how the row editor already treats one invalid row.
 */

import { isAbsolutePath } from './formatters';
import { splitParkedEntries, type ParkableEntry } from './parkedRecords';

/** What a POSIX shell accepts as a variable name. */
export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variable names whose values MUST be absolute filesystem paths. A relative
 * value (e.g. `sm/Users/me/.claude-smash` - a real typo we shipped through)
 * gets `path.resolve()`'d against the main-process cwd at sample time, which
 * silently points the variable at a non-existent directory and produces
 * confusing dashboard tabs. Validating here rejects the bad value at write
 * time so the typo never lands on disk.
 */
const ABSOLUTE_PATH_KEYS: Record<string, true> = {
	CLAUDE_CONFIG_DIR: true,
	CODEX_HOME: true,
};

/** `null` when the name is usable, otherwise the reason it is not. */
export function validateEnvVarName(key: string): string | null {
	if (ENV_VAR_NAME_PATTERN.test(key)) return null;
	return `Invalid variable name: only letters, numbers, and underscores allowed and must not start with a number.`;
}

/** `null` when the value is acceptable for `key`, otherwise the reason it is not. */
export function validateEnvVarValue(key: string, value: string): string | null {
	// Check if value contains special characters that might need quoting
	if (value && /[&|;`$<>()]/.test(value) && !value.startsWith('"') && !value.startsWith("'")) {
		return `Invalid value: contains disallowed special characters; quote or escape them if you intend to include them.`;
	}
	// Variables that are consumed as filesystem paths must be absolute -
	// relative values get resolved against the main-process cwd at runtime
	// (often `/`) and silently point at a non-existent directory.
	if (ABSOLUTE_PATH_KEYS[key] && value && !isAbsolutePath(value)) {
		return `${key} must be an absolute path (starting with /).`;
	}
	return null;
}

/**
 * Validate one variable. A blank name is not an error: it is a row the user
 * has not named yet, and it is dropped rather than committed.
 */
export function validateEnvVarEntry(key: string, value: string): string | null {
	if (!key.trim()) return null;
	return validateEnvVarName(key) ?? validateEnvVarValue(key, value);
}

/** Something to tell the user about one line. `line` is 1-based. */
export interface DotEnvIssue {
	line: number;
	message: string;
}

export interface ParseDotEnvOptions {
	/**
	 * Read `# KEY=value` as a parked variable. Leave it off for an editor with
	 * nowhere to keep one, where every comment is just a comment.
	 */
	parked?: boolean;
	/**
	 * Extra rule for a value, beyond the syntax. Each editor passes whatever its
	 * row mode enforces, so a variable one mode accepts is never dropped by the
	 * other.
	 */
	validateValue?: (key: string, value: string) => string | null;
}

export interface ParsedDotEnv {
	/** Live variables. */
	vars: Record<string, string>;
	/** Parked variables. Always empty unless `parked` was set. */
	disabledVars: Record<string, string>;
	/** Lines that were NOT committed, and why. */
	errors: DotEnvIssue[];
	/** Lines that were committed but deserve a second look. */
	warnings: DotEnvIssue[];
}

const EXPORT_PREFIX = /^export\s+/;
const COMMENT_PREFIX = /^#+\s*/;

function splitAssignment(text: string): { key: string; value: string } | null {
	const body = text.replace(EXPORT_PREFIX, '');
	const eq = body.indexOf('=');
	if (eq === -1) return null;
	return { key: body.slice(0, eq).trim(), value: body.slice(eq + 1).trim() };
}

/**
 * Index of the first `quote` at or after `from` that actually closes a quoted
 * value, or -1. Inside double quotes a backslash escapes the next character,
 * so `\"` is part of the value; single quotes have no escape.
 */
function indexOfClosingQuote(text: string, quote: string, from: number): number {
	for (let index = from; index < text.length; index++) {
		if (quote === '"' && text[index] === '\\') {
			index++;
			continue;
		}
		if (text[index] === quote) return index;
	}
	return -1;
}

/**
 * Index of the first line at or after `from` that closes a quote opened on an
 * earlier line, or -1. A closing line is one whose ONLY unescaped `quote` is
 * its last character: the tail of a PEM block, a `}"`, a final base64 chunk.
 *
 * Two rules it is deliberately not:
 *  - "any line ending in the quote". `BAR="x"` ends in one, and treating it as
 *    the close of an earlier lone quote would skip every line in between.
 *  - "stop at the first line that looks like `KEY=value`". A short final line
 *    of a base64 body (`Kw=="`) reads as exactly that, and would be saved as a
 *    variable the user never wrote.
 */
function findClosingQuoteLine(lines: string[], from: number, quote: string): number {
	for (let index = from; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line.endsWith(quote) && indexOfClosingQuote(line, quote, 0) === line.length - 1) {
			return index;
		}
	}
	return -1;
}

export function parseDotEnv(text: string, options: ParseDotEnvOptions = {}): ParsedDotEnv {
	const lines = text.split(/\r\n|\r|\n/);
	const errors: DotEnvIssue[] = [];
	const warnings: DotEnvIssue[] = [];
	const entries: Array<ParkableEntry & { line: number }> = [];

	for (let index = 0; index < lines.length; index++) {
		const line = index + 1;
		let body = lines[index].trim();
		if (!body) continue;

		let enabled = true;
		if (body.startsWith('#')) {
			const commented = body.replace(COMMENT_PREFIX, '');
			const candidate = splitAssignment(commented);
			// Only a comment that IS an assignment is a parked variable. Prose,
			// and every comment in an editor that cannot park, is dropped.
			if (!options.parked || !candidate || !ENV_VAR_NAME_PATTERN.test(candidate.key)) continue;
			enabled = false;
			body = commented;
		}

		const assignment = splitAssignment(body);
		if (!assignment) {
			errors.push({ line, message: 'Expected KEY=value.' });
			continue;
		}
		const { key, value } = assignment;

		const quote = value[0];
		if ((quote === '"' || quote === "'") && indexOfClosingQuote(value, quote, 1) === -1) {
			const closingIndex = findClosingQuoteLine(lines, index + 1, quote);
			if (closingIndex !== -1) {
				errors.push({
					line,
					message: `Multiline values are not supported. The quote opened here closes on line ${closingIndex + 1}, so nothing through line ${closingIndex + 1} is saved.`,
				});
				index = closingIndex;
				continue;
			}
		}

		if (!key) {
			errors.push({ line, message: 'Missing variable name before "=".' });
			continue;
		}
		const error = validateEnvVarName(key) ?? options.validateValue?.(key, value) ?? null;
		if (error) {
			errors.push({ line, message: error });
			continue;
		}

		if (quote !== '"' && quote !== "'" && /\s#/.test(value)) {
			warnings.push({
				line,
				message: `Inline comments are not supported: everything after "=" is the value of ${key}.`,
			});
		}
		entries.push({ key, value, enabled, line });
	}

	const liveLines = new Map<string, number>();
	const parkedLines = new Map<string, number>();
	for (const entry of entries) {
		if (entry.enabled) liveLines.set(entry.key, entry.line);
	}
	const seenLive = new Map<string, number>();
	for (const entry of entries) {
		const liveLine = liveLines.get(entry.key);
		if (!entry.enabled && liveLine !== undefined) {
			// A key lives in exactly one record, and the live one wins it.
			warnings.push({
				line: entry.line,
				message: `${entry.key} is also set on line ${liveLine}, so this switched-off copy is ignored.`,
			});
			continue;
		}
		const seen = entry.enabled ? seenLive : parkedLines;
		const earlier = seen.get(entry.key);
		if (earlier !== undefined) {
			warnings.push({
				line: entry.line,
				message: `${entry.key} is already set on line ${earlier}. This line wins.`,
			});
		}
		seen.set(entry.key, entry.line);
	}
	warnings.sort((a, b) => a.line - b.line);

	const pair = splitParkedEntries(entries);
	return { vars: pair.active ?? {}, disabledVars: pair.parked ?? {}, errors, warnings };
}

/**
 * Render the two records as `.env` text: live variables first, then each
 * parked one as a commented assignment. Unnamed rows (a row the user added and
 * has not typed into yet) are skipped.
 */
export function serializeDotEnv(
	vars: Record<string, string>,
	disabledVars: Record<string, string> = {}
): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		if (key.trim()) lines.push(`${key}=${value}`);
	}
	for (const [key, value] of Object.entries(disabledVars)) {
		if (key.trim() && !(key in vars)) lines.push(`# ${key}=${value}`);
	}
	return lines.join('\n');
}

/**
 * Order-insensitive fingerprint of the two records, ignoring unnamed rows.
 * Two pairs with the same fingerprint hold the same variables, so an editor
 * can tell its own edit echoing back from a change made somewhere else.
 */
export function envVarRecordsFingerprint(
	vars: Record<string, string>,
	disabledVars: Record<string, string> = {}
): string {
	return serializeDotEnv(vars, disabledVars).split('\n').sort().join('\n');
}

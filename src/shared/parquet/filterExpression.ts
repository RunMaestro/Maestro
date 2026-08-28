/**
 * Parquet Filter Expression Language
 *
 * One text box, three levels of power, no mode switch:
 *
 *   smith                      any column contains "smith"
 *   status = active            typed comparison against a column
 *   price > 100 and qty <= 5   boolean composition
 *   ts >= now-7d               relative time literals
 *   region in (us, eu)         set membership
 *   name ~ /^acme/i            regex
 *   notes is null              null tests
 *
 * The mode-free design is deliberate. The JSONL viewer makes the user pick
 * between "text" and "jq" before typing, which means the first thing a user
 * types in a fresh box is usually evaluated by the wrong engine. Here a bare
 * word is a substring search across every column and anything containing an
 * operator is a predicate, so the box does the obvious thing at every level of
 * user sophistication.
 *
 * The parser produces an AST rather than a closure because the AST has two
 * consumers: {@link evaluateFilterNode} runs it per row, and
 * `compileFilterPushdown` (./pushdown.ts) translates the parts it safely can
 * into parquet-level row-group / bloom / page pruning. A closure could only do
 * the first, and the pruning is what makes filtering a multi-GB file instant.
 *
 * Null semantics follow SQL: a comparison against null is unknown, and an
 * unknown predicate excludes the row. Only `is null` matches a null.
 */

import type { ParquetColumnInfo, ParquetFilterProblem, ParquetValueKind } from './types';

// ─── AST ──────────────────────────────────────────────────────────────────────

/** Comparison operators that have a natural ordering or equality meaning. */
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** Operators that work on the string rendering of a value. */
export type MatchMode = 'contains' | 'startsWith' | 'endsWith' | 'regex';

/**
 * A literal after binding: the text the user typed plus the value coerced into
 * the column's comparison domain. Coercion happens once at bind time so the
 * per-row evaluator never re-parses a date or re-scans a number.
 */
export interface BoundLiteral {
	/** Exactly what the user typed, for error messages and round-tripping. */
	text: string;
	/** The coerced value, or `null` for an explicit `null` literal. */
	value: string | number | bigint | boolean | null;
	/** True when the literal came from an explicit `null` keyword. */
	isNull: boolean;
}

export type FilterNode =
	| { kind: 'and'; children: FilterNode[] }
	| { kind: 'or'; children: FilterNode[] }
	| { kind: 'not'; child: FilterNode }
	| { kind: 'compare'; column: string; op: ComparisonOp; literal: BoundLiteral }
	| { kind: 'in'; column: string; negated: boolean; literals: BoundLiteral[] }
	| { kind: 'between'; column: string; low: BoundLiteral; high: BoundLiteral }
	| { kind: 'null'; column: string; negated: boolean }
	| {
			kind: 'match';
			column: string;
			mode: MatchMode;
			negated: boolean;
			needle: string;
			regex?: RegExp;
	  }
	/** A bare word: substring match against every column's string rendering. */
	| { kind: 'anyColumn'; needle: string };

/** Result of turning filter text into something the engine can run. */
export interface BoundFilter {
	/** `null` when the expression was empty (i.e. match everything). */
	node: FilterNode | null;
	problem?: ParquetFilterProblem;
	/** Columns the residual evaluator must read. Empty means "no columns". */
	columns: string[];
	/** True when a bare term forces every column to be decoded. */
	scansAllColumns: boolean;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type TokenType = 'word' | 'string' | 'number' | 'regex' | 'op' | 'punct' | 'eof';

interface Token {
	type: TokenType;
	/** Normalized text: quotes stripped, operators canonicalized. */
	text: string;
	/** True when the text arrived inside quotes, so it can never be a keyword. */
	quoted: boolean;
	/** True when the token was a `[col]` / backtick-quoted identifier. */
	identifierQuoted: boolean;
	/** Regex flags, only for `regex` tokens. */
	flags?: string;
	start: number;
	end: number;
}

/** Characters that end a bare word. Everything else is fair game inside one. */
const DELIMITERS = new Set([
	' ',
	'\t',
	'\n',
	'\r',
	'(',
	')',
	',',
	'=',
	'!',
	'<',
	'>',
	'~',
	'^',
	'$',
	'&',
	'|',
]);

/** Two-character operators, checked before their single-character prefixes. */
const TWO_CHAR_OPS: Record<string, string> = {
	'>=': '>=',
	'<=': '<=',
	'!=': '!=',
	'<>': '!=',
	'==': '=',
	'!~': '!~',
	'^=': '^=',
	'$=': '$=',
	'&&': 'and',
	'||': 'or',
};

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

class FilterSyntaxError extends Error {
	constructor(
		message: string,
		readonly start: number,
		readonly end: number
	) {
		super(message);
		this.name = 'FilterSyntaxError';
	}
}

/**
 * Try to read a regex literal starting at `start`.
 *
 * Returns `null` when the token is not a complete `/body/flags` run ending at
 * a delimiter, which is the signal for the tokenizer to fall back to lexing a
 * bare word. An unterminated regex is reported as a syntax error rather than
 * silently becoming a word, because the user clearly meant one.
 */
function scanRegexLiteral(
	source: string,
	start: number
): { body: string; flags: string; end: number } | null {
	let i = start + 1;
	let body = '';
	let closed = false;
	while (i < source.length) {
		if (source[i] === '\\' && i + 1 < source.length) {
			body += source[i] + source[i + 1];
			i += 2;
			continue;
		}
		if (source[i] === '/') {
			i++;
			closed = true;
			break;
		}
		if (source[i] === ' ' || source[i] === '\t' || source[i] === '\n') break;
		body += source[i];
		i++;
	}
	// A slash-led token with no closing slash is a path, a URL, or a date -
	// anything but a regex - so it goes back to the tokenizer as a bare word.
	if (!closed) return null;
	let flags = '';
	while (i < source.length && /[gimsuy]/.test(source[i])) {
		flags += source[i];
		i++;
	}
	// Must land on a delimiter, or this was never a regex.
	if (i < source.length && !DELIMITERS.has(source[i])) return null;
	return { body, flags, end: i };
}

/**
 * Split filter text into tokens.
 *
 * Bare words swallow `/`, `-`, `.` and `:` so that paths, ISO dates, and
 * hostnames survive as single tokens. That is why a regex literal is only
 * recognized when `/` opens a token: `path/to/file` must not lex as the regex
 * `/to/` surrounded by words.
 */
export function tokenizeFilter(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < source.length) {
		const ch = source[i];

		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++;
			continue;
		}

		if (ch === '(' || ch === ')' || ch === ',') {
			tokens.push({
				type: 'punct',
				text: ch,
				quoted: false,
				identifierQuoted: false,
				start: i,
				end: i + 1,
			});
			i++;
			continue;
		}

		// Quoted string literal. Both quote styles accept backslash escapes and
		// the SQL-style doubled quote (`'it''s'`).
		if (ch === '"' || ch === "'") {
			const start = i;
			const quote = ch;
			i++;
			let value = '';
			let closed = false;
			while (i < source.length) {
				const c = source[i];
				if (c === '\\' && i + 1 < source.length) {
					value += source[i + 1];
					i += 2;
					continue;
				}
				if (c === quote) {
					if (source[i + 1] === quote) {
						value += quote;
						i += 2;
						continue;
					}
					i++;
					closed = true;
					break;
				}
				value += c;
				i++;
			}
			if (!closed) throw new FilterSyntaxError('Unterminated string', start, source.length);
			tokens.push({
				type: 'string',
				text: value,
				quoted: true,
				identifierQuoted: false,
				start,
				end: i,
			});
			continue;
		}

		// Quoted identifier, for column names containing spaces or operators.
		if (ch === '`' || ch === '[') {
			const start = i;
			const close = ch === '`' ? '`' : ']';
			i++;
			let value = '';
			let closed = false;
			while (i < source.length) {
				if (source[i] === close) {
					i++;
					closed = true;
					break;
				}
				value += source[i];
				i++;
			}
			if (!closed) throw new FilterSyntaxError('Unterminated column name', start, source.length);
			tokens.push({
				type: 'word',
				text: value,
				quoted: true,
				identifierQuoted: true,
				start,
				end: i,
			});
			continue;
		}

		// Regex literal. Two conditions, both needed: the `/` opens the token,
		// and the closing `/` (plus any flags) runs to a delimiter. Without the
		// second condition `path ^= /var/log` lexes as the regex `/var/`
		// followed by a stray `log`, which is the classic slash ambiguity and
		// the reason a path is far more likely than a regex in that position.
		// Backing off to a bare word costs nothing: a real regex is always
		// followed by whitespace, `)`, or the end of the expression.
		if (ch === '/') {
			const regex = scanRegexLiteral(source, i);
			if (regex) {
				tokens.push({
					type: 'regex',
					text: regex.body,
					quoted: true,
					identifierQuoted: false,
					flags: regex.flags,
					start: i,
					end: regex.end,
				});
				i = regex.end;
				continue;
			}
		}

		const two = source.slice(i, i + 2);
		if (TWO_CHAR_OPS[two]) {
			tokens.push({
				type: 'op',
				text: TWO_CHAR_OPS[two],
				quoted: false,
				identifierQuoted: false,
				start: i,
				end: i + 2,
			});
			i += 2;
			continue;
		}

		if (ch === '=' || ch === '>' || ch === '<' || ch === '~') {
			tokens.push({
				type: 'op',
				text: ch,
				quoted: false,
				identifierQuoted: false,
				start: i,
				end: i + 1,
			});
			i++;
			continue;
		}
		if (ch === '!') {
			tokens.push({
				type: 'op',
				text: 'not',
				quoted: false,
				identifierQuoted: false,
				start: i,
				end: i + 1,
			});
			i++;
			continue;
		}
		// A lone `^` or `$` is not a valid operator, but reporting it as one
		// produces a far better message than lexing it into the next word.
		if (ch === '^' || ch === '$' || ch === '&' || ch === '|') {
			throw new FilterSyntaxError(`Unexpected "${ch}"`, i, i + 1);
		}

		// Bare word: runs to the next delimiter.
		const start = i;
		while (i < source.length && !DELIMITERS.has(source[i])) i++;
		const text = source.slice(start, i);
		tokens.push({
			type: NUMERIC_RE.test(text) ? 'number' : 'word',
			text,
			quoted: false,
			identifierQuoted: false,
			start,
			end: i,
		});
	}

	tokens.push({
		type: 'eof',
		text: '',
		quoted: false,
		identifierQuoted: false,
		start: source.length,
		end: source.length,
	});
	return tokens;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * An unbound predicate. Parsing is separated from binding so the parser stays
 * ignorant of the schema: it produces column names and literal *text*, and
 * {@link bindFilterExpression} is the only place that knows what a column's
 * type is and how to coerce a literal into it.
 */
type RawNode =
	| { kind: 'and'; children: RawNode[] }
	| { kind: 'or'; children: RawNode[] }
	| { kind: 'not'; child: RawNode }
	| { kind: 'compare'; column: Token; op: ComparisonOp; value: Token }
	| { kind: 'in'; column: Token; negated: boolean; values: Token[] }
	| { kind: 'between'; column: Token; low: Token; high: Token }
	| { kind: 'null'; column: Token; negated: boolean }
	| { kind: 'match'; column: Token; mode: MatchMode; negated: boolean; value: Token }
	| { kind: 'anyColumn'; value: Token };

/** True when a token is the given keyword, ignoring case and skipping quotes. */
function isKeyword(token: Token, keyword: string): boolean {
	return !token.quoted && token.type === 'word' && token.text.toLowerCase() === keyword;
}

/** True when the token could start a value (as opposed to closing an expression). */
function startsValue(token: Token): boolean {
	return (
		token.type === 'word' ||
		token.type === 'string' ||
		token.type === 'number' ||
		token.type === 'regex'
	);
}

class Parser {
	private pos = 0;

	constructor(private readonly tokens: Token[]) {}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
	}

	private next(): Token {
		return this.tokens[Math.min(this.pos++, this.tokens.length - 1)];
	}

	parse(): RawNode | null {
		if (this.peek().type === 'eof') return null;
		const node = this.parseOr();
		const trailing = this.peek();
		if (trailing.type !== 'eof') {
			throw new FilterSyntaxError(
				`Unexpected "${trailing.text || ')'}"`,
				trailing.start,
				trailing.end
			);
		}
		return node;
	}

	private parseOr(): RawNode {
		const children = [this.parseAnd()];
		while (
			isKeyword(this.peek(), 'or') ||
			(this.peek().type === 'op' && this.peek().text === 'or')
		) {
			this.next();
			children.push(this.parseAnd());
		}
		return children.length === 1 ? children[0] : { kind: 'or', children };
	}

	private parseAnd(): RawNode {
		const children = [this.parseNot()];
		for (;;) {
			const token = this.peek();
			if (isKeyword(token, 'and') || (token.type === 'op' && token.text === 'and')) {
				this.next();
				children.push(this.parseNot());
				continue;
			}
			// Juxtaposition is an implicit AND, which is what makes `status=ok
			// smith` read like a search box rather than a syntax error.
			if (startsValue(token) || (token.type === 'punct' && token.text === '(')) {
				if (isKeyword(token, 'or')) break;
				children.push(this.parseNot());
				continue;
			}
			break;
		}
		return children.length === 1 ? children[0] : { kind: 'and', children };
	}

	private parseNot(): RawNode {
		const token = this.peek();
		if (isKeyword(token, 'not') || (token.type === 'op' && token.text === 'not')) {
			this.next();
			return { kind: 'not', child: this.parseNot() };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): RawNode {
		const token = this.peek();

		if (token.type === 'punct' && token.text === '(') {
			this.next();
			const inner = this.parseOr();
			const close = this.next();
			if (!(close.type === 'punct' && close.text === ')')) {
				throw new FilterSyntaxError('Expected ")"', close.start, close.end);
			}
			return inner;
		}

		if (!startsValue(token)) {
			throw new FilterSyntaxError(
				token.type === 'eof' ? 'Unexpected end of filter' : `Unexpected "${token.text}"`,
				token.start,
				token.end
			);
		}

		const first = this.next();
		const operator = this.peek();

		// `column is [not] null`
		if (isKeyword(operator, 'is')) {
			this.next();
			let negated = false;
			if (
				isKeyword(this.peek(), 'not') ||
				(this.peek().type === 'op' && this.peek().text === 'not')
			) {
				this.next();
				negated = true;
			}
			const nullToken = this.next();
			if (!isKeyword(nullToken, 'null')) {
				throw new FilterSyntaxError('Expected "null" after "is"', nullToken.start, nullToken.end);
			}
			return { kind: 'null', column: first, negated };
		}

		// `column [not] in (a, b, c)`
		const notIn =
			(isKeyword(operator, 'not') || (operator.type === 'op' && operator.text === 'not')) &&
			isKeyword(this.peek(1), 'in');
		if (isKeyword(operator, 'in') || notIn) {
			if (notIn) this.next();
			this.next();
			const open = this.next();
			if (!(open.type === 'punct' && open.text === '(')) {
				throw new FilterSyntaxError('Expected "(" after "in"', open.start, open.end);
			}
			const values: Token[] = [];
			for (;;) {
				const value = this.next();
				if (!startsValue(value)) {
					throw new FilterSyntaxError('Expected a value inside "in (...)"', value.start, value.end);
				}
				values.push(value);
				const separator = this.next();
				if (separator.type === 'punct' && separator.text === ')') break;
				if (!(separator.type === 'punct' && separator.text === ',')) {
					throw new FilterSyntaxError('Expected "," or ")"', separator.start, separator.end);
				}
			}
			return { kind: 'in', column: first, negated: notIn, values };
		}

		// `column between low and high`
		if (isKeyword(operator, 'between')) {
			this.next();
			const low = this.next();
			if (!startsValue(low))
				throw new FilterSyntaxError('Expected a value after "between"', low.start, low.end);
			const and = this.next();
			if (!isKeyword(and, 'and'))
				throw new FilterSyntaxError('Expected "and" in "between"', and.start, and.end);
			const high = this.next();
			if (!startsValue(high))
				throw new FilterSyntaxError('Expected a value after "and"', high.start, high.end);
			return { kind: 'between', column: first, low, high };
		}

		if (operator.type === 'op') {
			const value = this.peek(1);
			if (!startsValue(value)) {
				throw new FilterSyntaxError(
					`Expected a value after "${operator.text}"`,
					value.start,
					value.end
				);
			}
			this.next();
			this.next();
			switch (operator.text) {
				case '=':
					return value.type === 'regex'
						? { kind: 'match', column: first, mode: 'regex', negated: false, value }
						: { kind: 'compare', column: first, op: 'eq', value };
				case '!=':
					return value.type === 'regex'
						? { kind: 'match', column: first, mode: 'regex', negated: true, value }
						: { kind: 'compare', column: first, op: 'ne', value };
				case '>':
					return { kind: 'compare', column: first, op: 'gt', value };
				case '>=':
					return { kind: 'compare', column: first, op: 'gte', value };
				case '<':
					return { kind: 'compare', column: first, op: 'lt', value };
				case '<=':
					return { kind: 'compare', column: first, op: 'lte', value };
				case '~':
					return {
						kind: 'match',
						column: first,
						mode: value.type === 'regex' ? 'regex' : 'contains',
						negated: false,
						value,
					};
				case '!~':
					return {
						kind: 'match',
						column: first,
						mode: value.type === 'regex' ? 'regex' : 'contains',
						negated: true,
						value,
					};
				case '^=':
					return { kind: 'match', column: first, mode: 'startsWith', negated: false, value };
				case '$=':
					return { kind: 'match', column: first, mode: 'endsWith', negated: false, value };
				default:
					throw new FilterSyntaxError(
						`Unsupported operator "${operator.text}"`,
						operator.start,
						operator.end
					);
			}
		}

		// No operator followed it, so this is a bare search term.
		if (isKeyword(first, 'null') || isKeyword(first, 'true') || isKeyword(first, 'false')) {
			throw new FilterSyntaxError(
				`"${first.text}" needs a column to compare against`,
				first.start,
				first.end
			);
		}
		return { kind: 'anyColumn', value: first };
	}
}

// ─── Binding ──────────────────────────────────────────────────────────────────

/** Units accepted by relative time literals (`now-7d`). */
const RELATIVE_UNITS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/**
 * Resolve a relative time literal against a reference instant.
 *
 * `now`, `now-15m`, `now+1h`, `today` (local midnight). Returns `undefined`
 * when the text is not a relative literal, so absolute parsing can take over.
 */
export function parseRelativeTime(text: string, now: number): number | undefined {
	const lower = text.trim().toLowerCase();
	if (lower === 'now') return now;
	if (lower === 'today') {
		const date = new Date(now);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	}
	const match = /^now\s*([+-])\s*(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(lower);
	if (!match) return undefined;
	const delta = Number(match[2]) * RELATIVE_UNITS[match[3]];
	return match[1] === '-' ? now - delta : now + delta;
}

/**
 * Turn literal text into a value comparable against the column's decoded rows.
 *
 * Timestamps land on epoch milliseconds because that is what the evaluator
 * reduces a decoded `Date` to; integers stay `bigint` past 2^53 so an INT64 id
 * column can still be matched exactly.
 */
function coerceLiteral(token: Token, kind: ParquetValueKind, now: number): BoundLiteral {
	const text = token.text;
	if (isKeyword(token, 'null')) {
		return { text, value: null, isNull: true };
	}

	switch (kind) {
		case 'boolean': {
			const lower = text.toLowerCase();
			if (lower === 'true' || lower === '1' || lower === 'yes')
				return { text, value: true, isNull: false };
			if (lower === 'false' || lower === '0' || lower === 'no')
				return { text, value: false, isNull: false };
			throw new FilterSyntaxError(`"${text}" is not true or false`, token.start, token.end);
		}
		case 'integer': {
			if (!/^[+-]?\d+$/.test(text)) {
				const asFloat = Number(text);
				if (!Number.isFinite(asFloat))
					throw new FilterSyntaxError(`"${text}" is not a number`, token.start, token.end);
				return { text, value: asFloat, isNull: false };
			}
			const asBig = BigInt(text);
			// Stay in `number` while it is exact: mixed bigint/number relational
			// comparisons are legal in JS, but keeping small ids as numbers means
			// the common case never allocates a BigInt per comparison.
			const asNumber = Number(asBig);
			return { text, value: Number.isSafeInteger(asNumber) ? asNumber : asBig, isNull: false };
		}
		case 'float':
		case 'decimal': {
			const value = Number(text);
			if (!Number.isFinite(value))
				throw new FilterSyntaxError(`"${text}" is not a number`, token.start, token.end);
			return { text, value, isNull: false };
		}
		case 'timestamp':
		case 'date':
		case 'time': {
			const relative = parseRelativeTime(text, now);
			if (relative !== undefined) return { text, value: relative, isNull: false };
			if (/^\d+$/.test(text)) return { text, value: Number(text), isNull: false };
			// `2024-01-15 10:30` is far more natural to type than the `T` form,
			// so accept it by normalizing to what Date.parse understands.
			const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(text) ? text.replace(' ', 'T') : text);
			if (Number.isNaN(parsed)) {
				throw new FilterSyntaxError(`"${text}" is not a date or time`, token.start, token.end);
			}
			return { text, value: parsed, isNull: false };
		}
		default:
			return { text, value: text, isNull: false };
	}
}

/** Levenshtein distance, capped for the short strings column names always are. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let previous = Array.from({ length: cols }, (_, i) => i);
	for (let i = 1; i < rows; i++) {
		const current = [i];
		for (let j = 1; j < cols; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
		}
		previous = current;
	}
	return previous[cols - 1];
}

/** Closest column name to a typo, or `undefined` when nothing is close enough. */
export function suggestColumn(name: string, columns: string[]): string | undefined {
	const lower = name.toLowerCase();
	let best: string | undefined;
	let bestScore = Infinity;
	for (const column of columns) {
		const candidate = column.toLowerCase();
		// A prefix or substring hit beats raw edit distance: a user typing
		// `cust` for `customer_id` is not making a spelling mistake.
		const score =
			candidate.startsWith(lower) || candidate.includes(lower) ? 0 : editDistance(lower, candidate);
		if (score < bestScore) {
			bestScore = score;
			best = column;
		}
	}
	const threshold = Math.max(2, Math.floor(name.length / 3));
	return bestScore <= threshold ? best : undefined;
}

/**
 * Parse and type-check filter text against a schema.
 *
 * Never throws: a malformed expression comes back as `{ node: null, problem }`
 * so the filter bar can underline the offending span while the grid keeps
 * showing the last good result.
 */
export function bindFilterExpression(
	source: string,
	columns: ParquetColumnInfo[],
	now: number = Date.now()
): BoundFilter {
	const trimmed = source.trim();
	if (!trimmed) return { node: null, columns: [], scansAllColumns: false };

	const byLowerName = new Map<string, ParquetColumnInfo>();
	for (const column of columns) byLowerName.set(column.name.toLowerCase(), column);
	const names = columns.map((column) => column.name);

	const used = new Set<string>();
	let scansAllColumns = false;

	const resolveColumn = (token: Token): ParquetColumnInfo => {
		const exact = columns.find((column) => column.name === token.text);
		const column = exact ?? byLowerName.get(token.text.toLowerCase());
		if (!column) {
			const suggestion = suggestColumn(token.text, names);
			const error = new FilterSyntaxError(
				suggestion
					? `No column "${token.text}". Did you mean "${suggestion}"?`
					: `No column "${token.text}"`,
				token.start,
				token.end
			);
			(error as FilterSyntaxError & { suggestion?: string }).suggestion = suggestion;
			throw error;
		}
		used.add(column.name);
		return column;
	};

	const buildRegex = (token: Token, mode: MatchMode): RegExp | undefined => {
		if (mode !== 'regex') return undefined;
		try {
			// Case-insensitive by default so `~ /acme/` behaves like the plain
			// `~ acme` next to it; an explicit flag list wins.
			return new RegExp(token.text, token.flags || 'i');
		} catch (error) {
			throw new FilterSyntaxError(
				`Invalid regex: ${(error as Error).message}`,
				token.start,
				token.end
			);
		}
	};

	const bind = (node: RawNode): FilterNode => {
		switch (node.kind) {
			case 'and':
			case 'or':
				return { kind: node.kind, children: node.children.map(bind) } as FilterNode;
			case 'not':
				return { kind: 'not', child: bind(node.child) };
			case 'anyColumn':
				scansAllColumns = true;
				return { kind: 'anyColumn', needle: node.value.text.toLowerCase() };
			case 'null': {
				const column = resolveColumn(node.column);
				return { kind: 'null', column: column.name, negated: node.negated };
			}
			case 'match': {
				const column = resolveColumn(node.column);
				return {
					kind: 'match',
					column: column.name,
					mode: node.mode,
					negated: node.negated,
					needle: node.mode === 'regex' ? node.value.text : node.value.text.toLowerCase(),
					regex: buildRegex(node.value, node.mode),
				};
			}
			case 'compare': {
				const column = resolveColumn(node.column);
				return {
					kind: 'compare',
					column: column.name,
					op: node.op,
					literal: coerceLiteral(node.value, column.kind, now),
				};
			}
			case 'in': {
				const column = resolveColumn(node.column);
				return {
					kind: 'in',
					column: column.name,
					negated: node.negated,
					literals: node.values.map((value) => coerceLiteral(value, column.kind, now)),
				};
			}
			case 'between': {
				const column = resolveColumn(node.column);
				return {
					kind: 'between',
					column: column.name,
					low: coerceLiteral(node.low, column.kind, now),
					high: coerceLiteral(node.high, column.kind, now),
				};
			}
		}
	};

	try {
		const raw = new Parser(tokenizeFilter(source)).parse();
		if (!raw) return { node: null, columns: [], scansAllColumns: false };
		const node = bind(raw);
		return {
			node,
			columns: scansAllColumns ? names : [...used],
			scansAllColumns,
		};
	} catch (error) {
		if (error instanceof FilterSyntaxError) {
			const problem: ParquetFilterProblem = {
				message: error.message,
				start: error.start,
				end: Math.max(error.end, error.start + 1),
			};
			const suggestion = (error as FilterSyntaxError & { suggestion?: string }).suggestion;
			if (suggestion) problem.suggestion = suggestion;
			return { node: null, problem, columns: [], scansAllColumns: false };
		}
		throw error;
	}
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Reduce a decoded parquet value to something the comparison operators
 * understand. `Date` becomes epoch milliseconds to match how timestamp
 * literals bind, and nested values become their JSON text so a bare search
 * term can still find something inside a struct.
 */
export function toComparable(value: unknown): string | number | bigint | boolean | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'object') {
		if (ArrayBuffer.isView(value)) return bytesToText(value as ArrayBufferView);
		try {
			return JSON.stringify(value, jsonBigIntReplacer);
		} catch {
			return String(value);
		}
	}
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	return String(value);
}

/** `JSON.stringify` throws on bigint, which INT64 columns produce constantly. */
function jsonBigIntReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}

/** Render raw bytes as lowercase hex, which is how the grid shows them too. */
function bytesToText(view: ArrayBufferView): string {
	const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** String rendering used by `~`, `^=`, `$=`, regex, and bare terms. */
export function toSearchText(value: unknown): string {
	const comparable = toComparable(value);
	return comparable === null ? '' : String(comparable);
}

/**
 * Equality across the mixed value domain parquet produces.
 *
 * `10n === 10` is false in JS but `10n == 10` is true, and an INT64 column
 * compared against a small literal hits exactly that case, so equality is
 * spelled out rather than delegated to `===`.
 */
function valuesEqual(
	a: string | number | bigint | boolean | null,
	b: string | number | bigint | boolean | null
): boolean {
	if (a === null || b === null) return a === b;
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
		if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
		// Loose equality on purpose: `10n === 10` is false, and an INT64 column
		// compared against a small literal is exactly that comparison.
		return a == b;
	}
	if (typeof a === 'string' && typeof b === 'string') return a === b;
	if (typeof a === 'string' || typeof b === 'string') {
		// A string column matched against an unquoted literal is the common
		// case, and it is already string/string. Anything else here is a mixed
		// comparison the user asked for, so compare textually.
		return String(a) === String(b);
	}
	return a === b;
}

/** Signed ordering, or `undefined` when the two values are not ordered. */
function compareValues(
	a: string | number | bigint | boolean | null,
	b: string | number | bigint | boolean | null
): number | undefined {
	if (a === null || b === null) return undefined;
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === 'string' || typeof b === 'string') {
		const left = String(a);
		const right = String(b);
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof a === 'boolean' || typeof b === 'boolean') {
		const left = Number(a);
		const right = Number(b);
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof a === 'number' && Number.isNaN(a)) return undefined;
	if (typeof b === 'number' && Number.isNaN(b)) return undefined;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads one column's value for the row being evaluated. */
export type FilterRowAccessor = (column: string) => unknown;

/**
 * Run a bound predicate against a single row.
 *
 * `allColumns` is only consulted for bare search terms; passing it lazily
 * keeps the common typed-predicate path from touching columns it does not
 * need.
 */
export function evaluateFilterNode(
	node: FilterNode,
	getValue: FilterRowAccessor,
	allColumns: string[] = []
): boolean {
	switch (node.kind) {
		case 'and':
			return node.children.every((child) => evaluateFilterNode(child, getValue, allColumns));
		case 'or':
			return node.children.some((child) => evaluateFilterNode(child, getValue, allColumns));
		case 'not':
			return !evaluateFilterNode(node.child, getValue, allColumns);
		case 'null': {
			const isNull = toComparable(getValue(node.column)) === null;
			return node.negated ? !isNull : isNull;
		}
		case 'compare': {
			const value = toComparable(getValue(node.column));
			if (node.literal.isNull) {
				// `col = null` is a friendlier spelling of `col is null` than
				// SQL's unknown-forever semantics, and nobody ever means the
				// latter in a filter box.
				const isNull = value === null;
				return node.op === 'eq' ? isNull : node.op === 'ne' ? !isNull : false;
			}
			if (value === null) return false;
			if (node.op === 'eq') return valuesEqual(value, node.literal.value);
			if (node.op === 'ne') return !valuesEqual(value, node.literal.value);
			const order = compareValues(value, node.literal.value);
			if (order === undefined) return false;
			switch (node.op) {
				case 'gt':
					return order > 0;
				case 'gte':
					return order >= 0;
				case 'lt':
					return order < 0;
				case 'lte':
					return order <= 0;
			}
			return false;
		}
		case 'in': {
			const value = toComparable(getValue(node.column));
			const hit = node.literals.some((literal) =>
				literal.isNull ? value === null : value !== null && valuesEqual(value, literal.value)
			);
			return node.negated ? !hit : hit;
		}
		case 'between': {
			const value = toComparable(getValue(node.column));
			if (value === null) return false;
			const low = compareValues(value, node.low.value);
			const high = compareValues(value, node.high.value);
			return low !== undefined && high !== undefined && low >= 0 && high <= 0;
		}
		case 'match': {
			const raw = getValue(node.column);
			if (toComparable(raw) === null) return false;
			const text = toSearchText(raw);
			let hit: boolean;
			if (node.mode === 'regex') {
				hit = node.regex ? node.regex.test(text) : false;
			} else {
				const lower = text.toLowerCase();
				hit =
					node.mode === 'contains'
						? lower.includes(node.needle)
						: node.mode === 'startsWith'
							? lower.startsWith(node.needle)
							: lower.endsWith(node.needle);
			}
			return node.negated ? !hit : hit;
		}
		case 'anyColumn': {
			for (const column of allColumns) {
				if (toSearchText(getValue(column)).toLowerCase().includes(node.needle)) return true;
			}
			return false;
		}
	}
}

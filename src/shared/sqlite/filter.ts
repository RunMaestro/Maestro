/**
 * SQLite Table Filter
 *
 * The table view's filter box speaks the same language as the Parquet
 * viewer's (`src/shared/parquet/filterExpression.ts`): a bare word searches
 * every column, `status = active and price > 100` is a typed predicate. The
 * parser and binder are shared; this module is the SQLite back end, which
 * turns the bound AST into a `WHERE` clause SQLite runs over the whole table.
 *
 * Two rules, without exception:
 *
 *   - **Every value is a bound parameter.** Nothing the user types is spliced
 *     into SQL text. The only names in the text are column names the binder
 *     resolved against the statement's own columns, and they go through
 *     `quoteSqliteIdentifier()`. `LIKE` needles have their wildcards escaped,
 *     so `50%` finds the text `50%`.
 *   - **Comparison is SQLite's.** Every column binds as `string`, so the
 *     binder coerces nothing, and a literal travels as text. SQLite then
 *     applies the column's affinity to it (https://www.sqlite.org/datatype3.html#type_conversions_prior_to_comparison):
 *     `price > 100` compares numbers on an INTEGER / REAL / NUMERIC column,
 *     and `created_at >= 2024-01-01` compares text on a DATETIME column that
 *     holds ISO strings. A column with no affinity (no declared type, a view
 *     expression) converts nothing, so a numeric literal is bound as a number
 *     there. `true` / `false` mean 1 / 0 on any non-TEXT column.
 *
 * Null semantics match the Parquet evaluator exactly. A predicate over a NULL
 * is false, never "unknown", so `not (qty > 5)` keeps the rows where `qty` is
 * NULL, as it does in the Parquet viewer. SQL's three-valued logic only
 * differs from that under a `NOT`, so only leaves under a `NOT` are wrapped in
 * `ifnull(..., 0)`; everywhere else NULL and false exclude a row alike, and
 * the plain comparison keeps SQLite free to use an index.
 *
 * Text matching (`~`, `^=`, `$=`, bare words) is `LIKE`, which SQLite folds
 * case for ASCII only. A BLOB matches on its hex for an explicit column
 * (`hash ~ ff00`), the way the Parquet viewer matches binary; a bare word
 * skips BLOBs, where a hex digit run would match noise. Regexes run through
 * one app-registered function, {@link SQLITE_REGEXP_FUNCTION}.
 */

import {
	bindFilterExpression,
	type BoundFilter,
	type BoundLiteral,
	type FilterNode,
	type MatchMode,
} from '../parquet/filterExpression';
import type { ParquetFilterProblem } from '../parquet/types';
import { quoteSqliteIdentifier } from './sql';
import type { SqliteAffinity } from './types';

/** A value better-sqlite3 can bind. */
export type SqliteBindValue = string | number | bigint | null;

/** What the filter needs to know about one result column. */
export interface SqliteFilterColumn {
	name: string;
	affinity: SqliteAffinity;
}

/** A compiled filter: `WHERE` clause text (without the keyword) and its bindings in order. */
export interface CompiledSqliteFilter {
	where: string;
	params: SqliteBindValue[];
}

/** The result of turning filter text into SQL: a clause, nothing (empty text), or a problem. */
export interface SqliteFilterBuild {
	/** Null when the text is empty (match every row) or does not bind. */
	compiled: CompiledSqliteFilter | null;
	/** Set when the text does not parse or names a column the object lacks. */
	problem?: ParquetFilterProblem;
}

/**
 * Name of the regex function the viewer's connection registers
 * (`sqliteRegexpTest()`). SQLite has no built-in `REGEXP`; a private name
 * keeps a database's own `regexp()` expectations out of it.
 */
export const SQLITE_REGEXP_FUNCTION = 'maestro_regexp';

const INTEGER_TEXT_RE = /^[+-]?\d+$/;
const NUMBER_TEXT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `true` / `false` (any case) as SQLite's 1 / 0, or undefined for anything else. */
function booleanAsInteger(text: string): number | undefined {
	const lower = text.toLowerCase();
	if (lower === 'true') return 1;
	if (lower === 'false') return 0;
	return undefined;
}

/**
 * The parameter one literal binds as, for a column of this affinity. See the
 * module comment: text for SQLite to convert, except where the column has no
 * affinity to convert with.
 */
export function sqliteFilterParam(
	literal: BoundLiteral,
	affinity: SqliteAffinity
): SqliteBindValue {
	if (literal.isNull) return null;
	const text = literal.text;
	if (affinity === 'TEXT') return text;
	const asBoolean = booleanAsInteger(text);
	if (asBoolean !== undefined) return asBoolean;
	if (affinity !== 'BLOB') return text;
	if (INTEGER_TEXT_RE.test(text)) {
		const exact = BigInt(text);
		const narrow = Number(exact);
		return Number.isSafeInteger(narrow) ? narrow : exact;
	}
	if (NUMBER_TEXT_RE.test(text)) return Number(text);
	return text;
}

/** Escape `LIKE`'s wildcards (and the escape character itself) in a needle. */
export function escapeSqliteLikePattern(needle: string): string {
	return needle.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The text a column's value is matched as: hex for a BLOB, its text otherwise. */
function searchText(column: string): string {
	return `CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) ELSE CAST(${column} AS TEXT) END`;
}

const LIKE_ESCAPE = "ESCAPE '\\'";

function likePattern(mode: Exclude<MatchMode, 'regex'>, needle: string): string {
	const escaped = escapeSqliteLikePattern(needle);
	if (mode === 'startsWith') return `${escaped}%`;
	if (mode === 'endsWith') return `%${escaped}`;
	return `%${escaped}%`;
}

/** Regex flags a stateless test can honour: `g` and `y` make `test()` stateful. */
function statelessFlags(flags: string): string {
	return flags.replace(/[gy]/g, '');
}

const COMPARISON_SQL = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/**
 * Compile a bound filter AST into a `WHERE` clause over the given columns.
 * Throws when the AST names a column not in `columns`, which only happens
 * when it was bound against a different column list (a caller bug).
 */
export function compileSqliteFilter(
	node: FilterNode,
	columns: readonly SqliteFilterColumn[]
): CompiledSqliteFilter {
	const affinityOf = new Map(columns.map((column) => [column.name, column.affinity]));
	const params: SqliteBindValue[] = [];

	const column = (name: string): { sql: string; affinity: SqliteAffinity } => {
		const affinity = affinityOf.get(name);
		if (!affinity) throw new Error(`The filter names a column this object lacks: ${name}`);
		return { sql: quoteSqliteIdentifier(name), affinity };
	};
	const bind = (value: SqliteBindValue): string => {
		params.push(value);
		return '?';
	};

	/** One leaf: TRUE, FALSE, or NULL, where NULL means the Parquet evaluator's false. */
	const leaf = (node: Exclude<FilterNode, { kind: 'and' | 'or' | 'not' }>): string => {
		switch (node.kind) {
			case 'null': {
				const { sql } = column(node.column);
				return `${sql} IS ${node.negated ? 'NOT ' : ''}NULL`;
			}
			case 'compare': {
				const { sql, affinity } = column(node.column);
				if (node.literal.isNull) {
					// `col = null` is the friendly spelling of `col is null`, as in
					// the Parquet evaluator; an ordering against null matches nothing.
					if (node.op === 'eq') return `${sql} IS NULL`;
					if (node.op === 'ne') return `${sql} IS NOT NULL`;
					return '0';
				}
				return `${sql} ${COMPARISON_SQL[node.op]} ${bind(sqliteFilterParam(node.literal, affinity))}`;
			}
			case 'in': {
				// Reached only un-negated: `compile()` turns `not in` into `not (in)`.
				const { sql, affinity } = column(node.column);
				const values = node.literals.filter((literal) => !literal.isNull);
				const terms: string[] = [];
				if (values.length > 0) {
					const list = values.map((literal) => bind(sqliteFilterParam(literal, affinity)));
					terms.push(`${sql} IN (${list.join(', ')})`);
				}
				if (values.length < node.literals.length) terms.push(`${sql} IS NULL`);
				return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
			}
			case 'between': {
				const { sql, affinity } = column(node.column);
				const low = bind(sqliteFilterParam(node.low, affinity));
				const high = bind(sqliteFilterParam(node.high, affinity));
				return `${sql} BETWEEN ${low} AND ${high}`;
			}
			case 'match': {
				const text = searchText(column(node.column).sql);
				let test: string;
				if (node.mode === 'regex') {
					const pattern = node.regex?.source ?? node.needle;
					const flags = statelessFlags(node.regex?.flags ?? 'i');
					test = `${SQLITE_REGEXP_FUNCTION}(${text}, ${bind(pattern)}, ${bind(flags)})`;
				} else {
					test = `${text} LIKE ${bind(likePattern(node.mode, node.needle))} ${LIKE_ESCAPE}`;
				}
				// A NULL value stays NULL through NOT, so `!~` skips it, as in Parquet.
				return node.negated ? `NOT (${test})` : test;
			}
			case 'anyColumn': {
				const pattern = likePattern('contains', node.needle);
				const terms = columns.map((entry) => {
					const sql = quoteSqliteIdentifier(entry.name);
					return `(typeof(${sql}) != 'blob' AND ${sql} LIKE ${bind(pattern)} ${LIKE_ESCAPE})`;
				});
				if (terms.length === 0) return '0';
				return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
			}
		}
	};

	const compile = (node: FilterNode, underNot: boolean): string => {
		switch (node.kind) {
			case 'and':
			case 'or': {
				const joiner = node.kind === 'and' ? ' AND ' : ' OR ';
				return `(${node.children.map((child) => compile(child, underNot)).join(joiner)})`;
			}
			case 'not':
				return `NOT (${compile(node.child, true)})`;
			case 'in':
				if (node.negated) {
					return compile({ kind: 'not', child: { ...node, negated: false } }, underNot);
				}
				break;
		}
		const sql = leaf(node as Exclude<FilterNode, { kind: 'and' | 'or' | 'not' }>);
		return underNot ? `ifnull(${sql}, 0)` : sql;
	};

	return { where: compile(node, false), params };
}

/**
 * Parse filter text and bind it against a table's or view's columns. Every
 * column binds as `string`: SQLite, not the binder, decides how a literal
 * compares (see the module comment). Never throws on bad text.
 */
export function bindSqliteFilter(
	source: string,
	columns: readonly SqliteFilterColumn[]
): BoundFilter {
	return bindFilterExpression(
		source,
		columns.map((column) => ({ name: column.name, kind: 'string' as const }))
	);
}

/** Filter text to a `WHERE` clause in one step: bind, then compile. */
export function buildSqliteFilter(
	source: string,
	columns: readonly SqliteFilterColumn[]
): SqliteFilterBuild {
	const bound = bindSqliteFilter(source, columns);
	if (bound.problem) return { compiled: null, problem: bound.problem };
	if (!bound.node) return { compiled: null };
	return { compiled: compileSqliteFilter(bound.node, columns) };
}

/** Compiled regexes by `flags/pattern`, so a scan compiles each one once. */
const regexCache = new Map<string, RegExp>();
const REGEX_CACHE_LIMIT = 32;

/**
 * The body of {@link SQLITE_REGEXP_FUNCTION}: 1 when `text` matches, 0 when it
 * does not, NULL when `text` is NULL (so a regex over NULL is neither a match
 * nor a non-match, like every other predicate here). An invalid pattern
 * throws, which SQLite reports as the statement's error; the binder has
 * already refused one, so only a hand-written call can reach that.
 */
export function sqliteRegexpTest(text: unknown, pattern: unknown, flags: unknown): number | null {
	if (text === null || text === undefined) return null;
	const source = String(pattern);
	const safeFlags = statelessFlags(String(flags ?? ''));
	const key = `${safeFlags}/${source}`;
	let regex = regexCache.get(key);
	if (!regex) {
		regex = new RegExp(source, safeFlags);
		if (regexCache.size >= REGEX_CACHE_LIMIT) {
			const oldest = regexCache.keys().next().value;
			if (oldest !== undefined) regexCache.delete(oldest);
		}
		regexCache.set(key, regex);
	}
	return regex.test(String(text)) ? 1 : 0;
}

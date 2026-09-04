/**
 * Filter Pushdown Compiler
 *
 * Translates the part of a bound filter expression that parquet itself can
 * enforce into hyparquet's `pruningFilter`, which eliminates whole row groups
 * (and, with page indexes, whole pages) using footer statistics and bloom
 * filters before a single data page is decompressed. On a multi-GB file this
 * is the difference between a filter that answers instantly and one that reads
 * the whole file.
 *
 * Two invariants govern everything here, and both exist because breaking them
 * silently *loses rows* rather than producing a visible error.
 *
 * **1. The compiled filter must never be more selective than the predicate it
 * came from.** Anything not expressible is dropped, and the residual evaluator
 * (`evaluateFilterNode`) still runs on every surviving row, so a dropped
 * conjunct costs speed and never correctness. Concretely: a child may be
 * dropped from an AND, but if any child of an OR fails to compile the whole OR
 * must be dropped, since narrowing one branch of a union discards rows the
 * other branch would have matched.
 *
 * **2. Literals must be compiled into the domain the statistics are recorded
 * in, which is the CONVERTED domain, not the physical one.** This is the
 * counter-intuitive half. Parquet stores a MICROS timestamp on disk as
 * `1704067200000000`, and it is tempting to reason that a bound compared
 * against footer statistics must therefore be in microseconds. It must not:
 * hyparquet runs every statistics bound through `convertMetadata` while
 * parsing the footer, so by the time a bound reaches the pruning check a
 * timestamp is a `Date`, a DATE is a `Date`, a DECIMAL is already scaled, and
 * a BYTE_ARRAY is a UTF-8 string. Compiling to microseconds prunes every row
 * group in the file - the bound is a thousand times larger than any statistic
 * it is compared against, so every group "provably" cannot match. That is
 * precisely the failure this comment exists to prevent, because it presents as
 * a filter that quietly returns nothing.
 *
 * The happy consequence is that statistics and decoded row values live in the
 * *same* domain, so a literal bound once by `bindFilterExpression` is directly
 * usable both here and in the residual evaluator, with no second conversion.
 */

import type { BoundLiteral, FilterNode } from './filterExpression';
import type { ParquetColumnInfo } from './types';

/**
 * Subset of hyparquet's `ParquetQueryFilter` that this compiler emits.
 * Declared locally so the shared layer carries no dependency on the reader,
 * which only the main process loads.
 */
export type PushdownOperator = {
	$eq?: unknown;
	$ne?: unknown;
	$gt?: unknown;
	$gte?: unknown;
	$lt?: unknown;
	$lte?: unknown;
	$in?: unknown[];
	$nin?: unknown[];
};

export type PushdownFilter =
	| { [column: string]: PushdownOperator }
	| { $and: PushdownFilter[] }
	| { $or: PushdownFilter[] };

export interface PushdownResult {
	filter?: PushdownFilter;
	/**
	 * True when every part of the predicate compiled, so the residual pass is
	 * a formality. Surfaced in the UI as "fully pushed down".
	 */
	complete: boolean;
}

/**
 * Whether a column's statistics can be compared against a bound literal.
 *
 * The gate is on the *physical* type even though the comparison happens in the
 * converted domain, because the physical type is what decides whether
 * hyparquet produced a comparable statistic at all. Two cases are deliberately
 * out:
 *
 *  - **Nested columns** (LIST / MAP / STRUCT). Their leaf statistics describe
 *    elements, not rows, so a bound on them means nothing about which rows
 *    match.
 *  - **INT96.** A deprecated 12-byte timestamp whose statistics are not
 *    reliably converted, and which no current writer emits.
 *
 * Raw byte columns are permitted and simply never prune: hyparquet declines to
 * order a `Uint8Array` statistic against a string literal, which costs a
 * pruning opportunity and cannot cost a row.
 */
function isComparableColumn(column: ParquetColumnInfo): boolean {
	if (column.nested) return false;
	if (column.physicalType === 'INT96') return false;
	switch (column.kind) {
		case 'string':
		case 'integer':
		case 'float':
		case 'decimal':
		case 'boolean':
		case 'timestamp':
		case 'date':
			return true;
		// TIME columns are rare enough that their conversion path is not worth
		// the risk of getting wrong, and `binary` / `json` have no ordering a
		// filter literal could be compared against.
		default:
			return false;
	}
}

/**
 * Whether a literal can stand as a statistics bound for this column.
 *
 * Null tests are excluded across the board: hyparquet already refuses to prune
 * a row group whose null count permits a match, so pushing them buys nothing
 * and only widens the surface where a domain mismatch could hide.
 */
function isPushableLiteral(literal: BoundLiteral): boolean {
	return !literal.isNull;
}

/** Compile one comparison, or `undefined` when the column or literal resists. */
function compileComparison(
	column: ParquetColumnInfo,
	op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte',
	literal: BoundLiteral
): PushdownOperator | undefined {
	if (!isComparableColumn(column) || !isPushableLiteral(literal)) return undefined;
	const value = literal.value;
	switch (op) {
		case 'eq':
			return { $eq: value };
		case 'ne':
			return { $ne: value };
		case 'gt':
			return { $gt: value };
		case 'gte':
			return { $gte: value };
		case 'lt':
			return { $lt: value };
		case 'lte':
			return { $lte: value };
	}
}

/**
 * Compile a bound filter into a conservative parquet pruning filter.
 *
 * @param node Bound predicate, or `null` for "match everything".
 * @param columns Schema columns, used to resolve each reference's type.
 */
export function compileFilterPushdown(
	node: FilterNode | null,
	columns: ParquetColumnInfo[]
): PushdownResult {
	if (!node) return { complete: true };
	const byName = new Map(columns.map((column) => [column.name, column]));
	let complete = true;

	const compile = (current: FilterNode): PushdownFilter | undefined => {
		switch (current.kind) {
			case 'and': {
				const compiled = current.children
					.map(compile)
					.filter((child): child is PushdownFilter => !!child);
				if (compiled.length === 0) return undefined;
				return compiled.length === 1 ? compiled[0] : { $and: compiled };
			}
			case 'or': {
				const compiled: PushdownFilter[] = [];
				for (const child of current.children) {
					const result = compile(child);
					// One un-compilable branch poisons the whole union: keeping
					// the others would narrow the result to their rows alone.
					if (!result) return undefined;
					compiled.push(result);
				}
				return compiled.length === 1 ? compiled[0] : { $or: compiled };
			}
			case 'not':
				// Negation inverts which row groups are interesting, and
				// hyparquet declines to prune `$nor` anyway.
				complete = false;
				return undefined;
			case 'compare': {
				const column = byName.get(current.column);
				const operator = column && compileComparison(column, current.op, current.literal);
				if (!operator) {
					complete = false;
					return undefined;
				}
				return { [current.column]: operator };
			}
			case 'in': {
				const column = byName.get(current.column);
				if (!column || !isComparableColumn(column) || !current.literals.every(isPushableLiteral)) {
					complete = false;
					return undefined;
				}
				const values = current.literals.map((literal) => literal.value);
				return { [current.column]: current.negated ? { $nin: values } : { $in: values } };
			}
			case 'between': {
				const column = byName.get(current.column);
				const low = column && compileComparison(column, 'gte', current.low);
				const high = column && compileComparison(column, 'lte', current.high);
				if (!low || !high) {
					complete = false;
					return undefined;
				}
				return { [current.column]: { ...low, ...high } };
			}
			case 'null':
			case 'match':
			case 'anyColumn':
				// Null tests, substring/regex matching, and bare search terms
				// have no statistics-level equivalent.
				complete = false;
				return undefined;
		}
	};

	const filter = compile(node);
	if (!filter) complete = false;
	return { filter, complete };
}

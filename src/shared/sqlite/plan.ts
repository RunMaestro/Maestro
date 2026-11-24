/**
 * Query plans: the rows `EXPLAIN QUERY PLAN` returns, as the tree they
 * describe.
 *
 * SQLite answers `EXPLAIN QUERY PLAN <statement>` with one row per step:
 * `id`, `parent` (the id of the step it belongs to, 0 at the top),
 * `notused`, and `detail` (`SCAN users`, `SEARCH orders USING INDEX ...`).
 * Read flat, a plan with a subquery or a CTE is hard to follow, so this
 * rebuilds the tree and draws it the way the `sqlite3` shell does:
 *
 * ```
 * QUERY PLAN
 * |--SCAN u
 * `--SEARCH t USING INTEGER PRIMARY KEY (rowid=?)
 * ```
 *
 * Shared by Query mode's plan view and `maestro-cli sqlite query --plan`, so
 * both draw the same tree and name the same steps.
 */

import type { SqliteCellValue } from './types';

/**
 * What a step costs, read from its detail:
 *
 * - `scan`: reads every row of a table, or every entry of an index
 *   (`SCAN t`, `SCAN t USING COVERING INDEX i`). The step to look at first
 *   when a query is slow.
 * - `search`: reaches rows through an index or the rowid (`SEARCH t USING ...`).
 * - `sort`: builds a temporary b-tree to sort, group, or deduplicate
 *   (`USE TEMP B-TREE FOR ORDER BY`), often avoidable with an index.
 * - `other`: structure (a subquery, a CTE, a compound SELECT) or a scan of
 *   one constant row.
 */
export type SqliteQueryPlanStepKind = 'scan' | 'search' | 'sort' | 'other';

/** One step of a plan, in the order the tree is drawn. */
export interface SqliteQueryPlanStep {
	/** SQLite's id for the step. */
	id: number;
	/** The id of the step this one belongs to; 0 at the top. */
	parent: number;
	/** SQLite's description of the step, verbatim. */
	detail: string;
	kind: SqliteQueryPlanStepKind;
	/** Levels below the top, from 0. */
	depth: number;
	/** The tree guide drawn before `detail`: `|--`, `` `-- ``, `|  |--`, ... */
	prefix: string;
}

/** One sentence per kind, for a legend or a tooltip. */
export const SQLITE_QUERY_PLAN_KIND_HINTS: Readonly<Record<SqliteQueryPlanStepKind, string>> = {
	scan: 'SCAN reads every row of the table (or every entry of the index). On a big table, this is the step to look at first.',
	search: 'SEARCH reaches rows through an index or the rowid, without reading the rest.',
	sort: 'USE TEMP B-TREE sorts, groups, or deduplicates in a temporary structure. An index on those columns can often remove it.',
	other: 'Structure of the statement: a subquery, a CTE, a compound SELECT, or a constant row.',
};

/** The kind of a step, from its detail text. */
export function sqliteQueryPlanStepKind(detail: string): SqliteQueryPlanStepKind {
	if (/^SCAN CONSTANT ROW\b/.test(detail)) return 'other';
	if (/^SCAN\b/.test(detail)) return 'scan';
	if (/^SEARCH\b/.test(detail)) return 'search';
	if (/^USE TEMP B-TREE\b/.test(detail)) return 'sort';
	return 'other';
}

function cellNumber(cell: SqliteCellValue | undefined): number {
	if (typeof cell === 'number') return cell;
	if (cell && typeof cell === 'object' && cell.kind === 'integer') return Number(cell.text);
	return Number.NaN;
}

function cellText(cell: SqliteCellValue | undefined): string {
	if (typeof cell === 'string') return cell;
	if (cell && typeof cell === 'object' && cell.kind === 'text') return cell.head;
	return typeof cell === 'number' ? String(cell) : '';
}

/**
 * The steps of a plan, depth first in SQLite's row order, each with the tree
 * guide to draw before it. `rows` are the cells of an `EXPLAIN QUERY PLAN`
 * result (`id`, `parent`, `notused`, `detail`). A step whose parent is not in
 * the plan is drawn at the top rather than dropped, and a step is drawn once
 * even if the ids loop.
 */
export function sqliteQueryPlanSteps(
	rows: ReadonlyArray<ReadonlyArray<SqliteCellValue>>
): SqliteQueryPlanStep[] {
	const nodes = rows.map((row, position) => {
		const id = cellNumber(row[0]);
		return {
			// A step with no usable id still gets a distinct one, below SQLite's.
			id: Number.isFinite(id) ? id : -(position + 1),
			parent: cellNumber(row[1]),
			detail: cellText(row[3]),
		};
	});
	const ids = new Set(nodes.map((node) => node.id));
	const children = new Map<number, typeof nodes>();
	const roots: typeof nodes = [];
	for (const node of nodes) {
		if (node.parent === node.id || !ids.has(node.parent)) {
			roots.push(node);
			continue;
		}
		const list = children.get(node.parent) ?? [];
		list.push(node);
		children.set(node.parent, list);
	}

	const steps: SqliteQueryPlanStep[] = [];
	const drawn = new Set<(typeof nodes)[number]>();
	const walk = (level: typeof nodes, depth: number, guide: string) => {
		level.forEach((node, index) => {
			if (drawn.has(node)) return;
			drawn.add(node);
			const last = index === level.length - 1;
			steps.push({
				id: node.id,
				parent: Number.isFinite(node.parent) ? node.parent : 0,
				detail: node.detail,
				kind: sqliteQueryPlanStepKind(node.detail),
				depth,
				prefix: `${guide}${last ? '`--' : '|--'}`,
			});
			walk(children.get(node.id) ?? [], depth + 1, `${guide}${last ? '   ' : '|  '}`);
		});
	};
	walk(roots, 0, '');
	// Anything a loop cut off from the top is still shown.
	walk(
		nodes.filter((node) => !drawn.has(node)),
		0,
		''
	);
	return steps;
}

/**
 * A plan as the `sqlite3` shell prints it: a `QUERY PLAN` heading, then one
 * line per step under its tree guide. A plan with no steps (a PRAGMA)
 * says so.
 */
export function formatSqliteQueryPlan(steps: readonly SqliteQueryPlanStep[]): string {
	if (steps.length === 0) return 'QUERY PLAN\n`--(SQLite reports no steps for this statement)';
	return ['QUERY PLAN', ...steps.map((step) => `${step.prefix}${step.detail}`)].join('\n');
}

import { describe, expect, it } from 'vitest';

import {
	SQLITE_QUERY_PLAN_KIND_HINTS,
	formatSqliteQueryPlan,
	sqliteQueryPlanStepKind,
	sqliteQueryPlanSteps,
} from '../../../shared/sqlite/plan';
import type { SqliteCellValue } from '../../../shared/sqlite/types';

/** Rows as `EXPLAIN QUERY PLAN` returns them: id, parent, notused, detail. */
function plan(...steps: Array<[number, number, string]>): SqliteCellValue[][] {
	return steps.map(([id, parent, detail]) => [id, parent, 0, detail]);
}

describe('sqliteQueryPlanStepKind', () => {
	it('names full scans, index searches, and temporary sorts', () => {
		expect(sqliteQueryPlanStepKind('SCAN users')).toBe('scan');
		expect(sqliteQueryPlanStepKind('SCAN t USING COVERING INDEX tb')).toBe('scan');
		expect(sqliteQueryPlanStepKind('SEARCH t USING INDEX tb (b=?)')).toBe('search');
		expect(sqliteQueryPlanStepKind('USE TEMP B-TREE FOR ORDER BY')).toBe('sort');
		expect(sqliteQueryPlanStepKind('USE TEMP B-TREE FOR DISTINCT')).toBe('sort');
	});

	it('treats a constant row and structure as neither', () => {
		expect(sqliteQueryPlanStepKind('SCAN CONSTANT ROW')).toBe('other');
		expect(sqliteQueryPlanStepKind('CO-ROUTINE r')).toBe('other');
		expect(sqliteQueryPlanStepKind('LIST SUBQUERY 1')).toBe('other');
		expect(sqliteQueryPlanStepKind('SCANNER')).toBe('other');
	});

	it('has a hint for every kind', () => {
		for (const kind of ['scan', 'search', 'sort', 'other'] as const) {
			expect(SQLITE_QUERY_PLAN_KIND_HINTS[kind].length).toBeGreaterThan(0);
		}
	});
});

describe('sqliteQueryPlanSteps', () => {
	it('draws a flat plan with the last step closed off', () => {
		const steps = sqliteQueryPlanSteps(
			plan(
				[4, 0, 'SCAN u'],
				[6, 0, 'SEARCH t USING INTEGER PRIMARY KEY (rowid=?)'],
				[18, 0, 'USE TEMP B-TREE FOR ORDER BY']
			)
		);
		expect(steps.map((step) => [step.prefix, step.kind, step.depth])).toEqual([
			['|--', 'scan', 0],
			['|--', 'search', 0],
			['`--', 'sort', 0],
		]);
	});

	it('nests steps under their parent, the way the sqlite3 shell draws them', () => {
		// A recursive CTE, verbatim from SQLite 3.4x.
		const steps = sqliteQueryPlanSteps(
			plan(
				[2, 0, 'CO-ROUTINE r'],
				[5, 2, 'SETUP'],
				[6, 5, 'SCAN CONSTANT ROW'],
				[17, 2, 'RECURSIVE STEP'],
				[18, 17, 'SCAN r'],
				[27, 0, 'SCAN r']
			)
		);
		expect(formatSqliteQueryPlan(steps)).toBe(
			[
				'QUERY PLAN',
				'|--CO-ROUTINE r',
				'|  |--SETUP',
				'|  |  `--SCAN CONSTANT ROW',
				'|  `--RECURSIVE STEP',
				'|     `--SCAN r',
				'`--SCAN r',
			].join('\n')
		);
		expect(steps.map((step) => step.depth)).toEqual([0, 1, 2, 1, 2, 0]);
		expect(steps[3]).toMatchObject({ id: 17, parent: 2, detail: 'RECURSIVE STEP' });
	});

	it('keeps children in row order even when a later parent comes first', () => {
		const steps = sqliteQueryPlanSteps(plan([1, 0, 'A'], [3, 0, 'B'], [4, 3, 'B1'], [2, 1, 'A1']));
		expect(steps.map((step) => step.detail)).toEqual(['A', 'A1', 'B', 'B1']);
	});

	it('draws a step whose parent is missing at the top, and survives an id loop', () => {
		const orphan = sqliteQueryPlanSteps(plan([1, 0, 'A'], [2, 99, 'lost']));
		expect(orphan.map((step) => [step.detail, step.depth])).toEqual([
			['A', 0],
			['lost', 0],
		]);

		const loop = sqliteQueryPlanSteps(plan([1, 2, 'x'], [2, 1, 'y']));
		expect(loop.map((step) => step.detail).sort()).toEqual(['x', 'y']);
	});

	it('reads big integers and cut text cells', () => {
		const steps = sqliteQueryPlanSteps([
			[{ kind: 'integer', text: '7' }, 0, 0, { kind: 'text', head: 'SCAN big', length: 9000 }],
		]);
		expect(steps[0]).toMatchObject({ id: 7, detail: 'SCAN big', kind: 'scan' });
	});

	it('returns no steps for a statement with no plan', () => {
		expect(sqliteQueryPlanSteps([])).toEqual([]);
		expect(formatSqliteQueryPlan([])).toMatch(/^QUERY PLAN\n`--\(SQLite reports no steps/);
	});
});

/**
 * Tests for the Cue filter matching engine.
 *
 * Tests cover:
 * - Exact string matching
 * - Negation (!value)
 * - Numeric comparisons (>, <, >=, <=)
 * - Glob pattern matching (*)
 * - Boolean matching
 * - Numeric equality
 * - Dot-notation nested key access
 * - AND logic (all conditions must pass)
 * - Missing payload fields
 * - describeFilter human-readable output
 */

import { describe, it, expect } from 'vitest';
import { matchesFilter, describeFilter } from '../../../main/cue/cue-filter';

describe('cue-filter', () => {
	describe('matchesFilter', () => {
		describe('exact string matching', () => {
			it('matches exact string values', () => {
				expect(matchesFilter({ extension: '.ts' }, { extension: '.ts' })).toBe(true);
			});

			it('rejects non-matching string values', () => {
				expect(matchesFilter({ extension: '.js' }, { extension: '.ts' })).toBe(false);
			});

			it('coerces payload value to string for comparison', () => {
				expect(matchesFilter({ count: 42 }, { count: '42' })).toBe(true);
			});
		});

		describe('negation (!value)', () => {
			it('matches when value does not equal', () => {
				expect(matchesFilter({ status: 'active' }, { status: '!archived' })).toBe(true);
			});

			it('rejects when value equals the negated term', () => {
				expect(matchesFilter({ status: 'archived' }, { status: '!archived' })).toBe(false);
			});
		});

		describe('numeric comparisons', () => {
			it('matches greater than', () => {
				expect(matchesFilter({ size: 1500 }, { size: '>1000' })).toBe(true);
			});

			it('rejects not greater than', () => {
				expect(matchesFilter({ size: 500 }, { size: '>1000' })).toBe(false);
			});

			it('rejects equal for greater than', () => {
				expect(matchesFilter({ size: 1000 }, { size: '>1000' })).toBe(false);
			});

			it('matches less than', () => {
				expect(matchesFilter({ priority: 3 }, { priority: '<5' })).toBe(true);
			});

			it('rejects not less than', () => {
				expect(matchesFilter({ priority: 7 }, { priority: '<5' })).toBe(false);
			});

			it('matches greater than or equal', () => {
				expect(matchesFilter({ score: 100 }, { score: '>=100' })).toBe(true);
				expect(matchesFilter({ score: 101 }, { score: '>=100' })).toBe(true);
			});

			it('rejects less than for >=', () => {
				expect(matchesFilter({ score: 99 }, { score: '>=100' })).toBe(false);
			});

			it('matches less than or equal', () => {
				expect(matchesFilter({ count: 10 }, { count: '<=10' })).toBe(true);
				expect(matchesFilter({ count: 9 }, { count: '<=10' })).toBe(true);
			});

			it('rejects greater than for <=', () => {
				expect(matchesFilter({ count: 11 }, { count: '<=10' })).toBe(false);
			});

			it('handles string payload values with numeric comparison', () => {
				expect(matchesFilter({ size: '1500' }, { size: '>1000' })).toBe(true);
			});
		});

		describe('glob pattern matching', () => {
			it('matches simple glob patterns', () => {
				expect(matchesFilter({ path: 'file.ts' }, { path: '*.ts' })).toBe(true);
			});

			it('rejects non-matching glob patterns', () => {
				expect(matchesFilter({ path: 'file.js' }, { path: '*.ts' })).toBe(false);
			});

			it('matches complex glob patterns', () => {
				expect(matchesFilter({ path: 'src/components/Button.tsx' }, { path: 'src/**/*.tsx' })).toBe(
					true
				);
			});

			it('rejects non-matching complex patterns', () => {
				expect(matchesFilter({ path: 'test/Button.tsx' }, { path: 'src/**/*.tsx' })).toBe(false);
			});
		});

		describe('boolean matching', () => {
			it('matches true boolean', () => {
				expect(matchesFilter({ active: true }, { active: true })).toBe(true);
			});

			it('rejects false when expecting true', () => {
				expect(matchesFilter({ active: false }, { active: true })).toBe(false);
			});

			it('matches false boolean', () => {
				expect(matchesFilter({ active: false }, { active: false })).toBe(true);
			});

			it('rejects true when expecting false', () => {
				expect(matchesFilter({ active: true }, { active: false })).toBe(false);
			});
		});

		describe('numeric equality', () => {
			it('matches exact numeric values', () => {
				expect(matchesFilter({ exitCode: 0 }, { exitCode: 0 })).toBe(true);
			});

			it('rejects non-matching numeric values', () => {
				expect(matchesFilter({ exitCode: 1 }, { exitCode: 0 })).toBe(false);
			});
		});

		describe('dot-notation nested access', () => {
			it('resolves nested payload fields', () => {
				const payload = { source: { status: 'completed' } };
				expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(true);
			});

			it('returns false for missing nested path', () => {
				const payload = { source: {} };
				expect(matchesFilter(payload, { 'source.status': 'completed' })).toBe(false);
			});

			it('handles deeply nested access', () => {
				const payload = { a: { b: { c: 'deep' } } };
				expect(matchesFilter(payload, { 'a.b.c': 'deep' })).toBe(true);
			});
		});

		describe('AND logic', () => {
			it('requires all conditions to pass', () => {
				const payload = { extension: '.ts', changeType: 'change', path: 'src/index.ts' };
				const filter = { extension: '.ts', changeType: 'change' };
				expect(matchesFilter(payload, filter)).toBe(true);
			});

			it('fails if any condition does not pass', () => {
				const payload = { extension: '.js', changeType: 'change' };
				const filter = { extension: '.ts', changeType: 'change' };
				expect(matchesFilter(payload, filter)).toBe(false);
			});
		});

		describe('missing payload fields', () => {
			it('fails when payload field is undefined', () => {
				expect(matchesFilter({}, { extension: '.ts' })).toBe(false);
			});

			it('fails when nested payload field is undefined', () => {
				expect(matchesFilter({ source: {} }, { 'source.missing': 'value' })).toBe(false);
			});
		});

		describe('empty filter', () => {
			it('matches everything when filter is empty', () => {
				expect(matchesFilter({ any: 'value' }, {})).toBe(true);
			});
		});
	});

	describe('describeFilter', () => {
		it('describes exact string match', () => {
			expect(describeFilter({ extension: '.ts' })).toBe('extension == ".ts"');
		});

		it('describes negation', () => {
			expect(describeFilter({ status: '!archived' })).toBe('status != archived');
		});

		it('describes greater than', () => {
			expect(describeFilter({ size: '>1000' })).toBe('size > 1000');
		});

		it('describes less than', () => {
			expect(describeFilter({ priority: '<5' })).toBe('priority < 5');
		});

		it('describes greater than or equal', () => {
			expect(describeFilter({ score: '>=100' })).toBe('score >= 100');
		});

		it('describes less than or equal', () => {
			expect(describeFilter({ count: '<=10' })).toBe('count <= 10');
		});

		it('describes glob pattern', () => {
			expect(describeFilter({ path: '*.ts' })).toBe('path matches *.ts');
		});

		it('describes boolean', () => {
			expect(describeFilter({ active: true })).toBe('active is true');
		});

		it('describes numeric equality', () => {
			expect(describeFilter({ exitCode: 0 })).toBe('exitCode == 0');
		});

		it('joins multiple conditions with AND', () => {
			const result = describeFilter({ extension: '.ts', status: '!archived' });
			expect(result).toBe('extension == ".ts" AND status != archived');
		});
	});
});

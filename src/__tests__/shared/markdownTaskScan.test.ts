/**
 * Tests for the part of shared/markdownTaskScan that model routing reads: the
 * text of the tasks an Auto Run dispatch will work.
 */

import { describe, it, expect } from 'vitest';

import { autoRunRoutingPrompt, nextUncheckedTaskTexts } from '../../shared/markdownTaskScan';

const DOCUMENT = [
	'# Phase 2',
	'',
	'<!-- MAESTRO:MODEL tier="low" -->',
	'',
	'- [x] Survey the call sites',
	'  - twelve of them',
	'- [ ] Rename `formatDate` to `formatDay` <!-- MAESTRO:MODEL effort="low" -->',
	'  - update the three callers',
	'  - keep the old name as an alias',
	'',
	'  > Note from the survey: one caller is in a test helper.',
	'- [ ] Design the migration',
	'',
	'## Later',
	'',
	'Some prose that belongs to no task.',
	'',
	'* [ ] Ship it',
].join('\n');

describe('nextUncheckedTaskTexts', () => {
	it('reads the next unchecked task with the lines under it, and no checkbox', () => {
		expect(nextUncheckedTaskTexts(DOCUMENT)).toEqual([
			[
				'Rename `formatDate` to `formatDay`',
				'  - update the three callers',
				'  - keep the old name as an alias',
				'',
				'  > Note from the survey: one caller is in a test helper.',
			].join('\n'),
		]);
	});

	it('steps over checked tasks and what is written under them', () => {
		expect(nextUncheckedTaskTexts(DOCUMENT)[0]).not.toContain('twelve of them');
		expect(nextUncheckedTaskTexts(DOCUMENT)[0]).not.toContain('Survey');
	});

	it('drops HTML comments, so a marker is never part of what a task says', () => {
		expect(nextUncheckedTaskTexts(DOCUMENT, 3).join('\n')).not.toContain('MAESTRO');
	});

	it('stops a task at the next task and at a heading', () => {
		expect(nextUncheckedTaskTexts(DOCUMENT, 3)).toEqual([
			expect.stringContaining('Rename'),
			'Design the migration',
			'Ship it',
		]);
	});

	it('returns as many tasks as were asked for, in order', () => {
		expect(nextUncheckedTaskTexts(DOCUMENT, 2)).toHaveLength(2);
		expect(nextUncheckedTaskTexts(DOCUMENT, 99)).toHaveLength(3);
	});

	it('ignores a task written inside a code fence', () => {
		const fenced = ['```markdown', '- [ ] an example', '```', '- [ ] the real one'].join('\n');
		expect(nextUncheckedTaskTexts(fenced)).toEqual(['the real one']);
	});

	it('finds nothing in a document with no unchecked task', () => {
		expect(nextUncheckedTaskTexts('- [x] done\n\nprose')).toEqual([]);
		expect(nextUncheckedTaskTexts('')).toEqual([]);
	});
});

describe('autoRunRoutingPrompt', () => {
	it('is the one next task in task mode', () => {
		expect(autoRunRoutingPrompt(DOCUMENT, 1)).toBe(nextUncheckedTaskTexts(DOCUMENT)[0]);
	});

	it('is the tasks of the segment in document mode, a blank line apart', () => {
		expect(autoRunRoutingPrompt(DOCUMENT, 2).endsWith('\n\nDesign the migration')).toBe(true);
	});

	it('is every task left when no count is given', () => {
		expect(autoRunRoutingPrompt(DOCUMENT).endsWith('\n\nShip it')).toBe(true);
	});

	it('is empty for a document with nothing left to do', () => {
		expect(autoRunRoutingPrompt('- [x] done')).toBe('');
	});
});

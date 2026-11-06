/**
 * @file goalPlan.test.ts
 * @description Tests for the Goal-Driven Auto Run Plan Doc module
 * (src/shared/goalDriven/goalPlan.ts): parse, canonical render, round trip,
 * preservation of human text, the fresh-run doc, the agent's plan marker, and
 * the three-way Plan merge.
 */

import { describe, it, expect } from 'vitest';
import {
	createGoalPlanDoc,
	mergeGoalPlan,
	parseGoalPlanDoc,
	parsePlanMarker,
	planProgress,
	renderGoalPlanDoc,
} from '../../../shared/goalDriven/goalPlan';
import type {
	GoalPlanDoc,
	GoalPlanItem,
	GoalPlanMergeResult,
} from '../../../shared/goalDriven/types';

const CANONICAL = [
	'---',
	'goal-run: run-123',
	'status: running',
	'iteration: 4',
	'max-iterations: 20',
	'progress: 45',
	'updated: 2026-10-16T21:14:00-05:00',
	'---',
	'',
	'## Goal',
	'Migrate auth to the new data layer.',
	'',
	'## Exit Criteria',
	'All auth tests green.',
	'',
	'## Plan',
	'- [x] Map the current auth flow <!-- id:a1 by:agent it:1 -->',
	'- [ ] Migrate the data layer <!-- id:a2 by:agent it:2 -->',
	'  - [ ] Write the migration test first <!-- id:a3 by:agent it:3 -->',
	'- [ ] Do not touch the billing module <!-- id:h1 by:human -->',
	'',
	'## Conductor Notes',
	'Prefer small commits.',
	'',
	'## Iteration Log',
	'- it:1 12% map done, data layer next',
	'- it:2 30% schema migrated, tests red',
	'',
].join('\n');

describe('parseGoalPlanDoc', () => {
	it('reads front matter, sections, items and the log', () => {
		const doc = parseGoalPlanDoc(CANONICAL);
		expect(doc.frontMatter).toEqual({
			goalRun: 'run-123',
			status: 'running',
			iteration: 4,
			maxIterations: 20,
			progress: 45,
			updated: '2026-10-16T21:14:00-05:00',
		});
		expect(doc.goal).toBe('Migrate auth to the new data layer.');
		expect(doc.exitCriteria).toBe('All auth tests green.');
		expect(doc.conductorNotes).toBe('Prefer small commits.');
		expect(doc.iterationLog).toEqual([
			'it:1 12% map done, data layer next',
			'it:2 30% schema migrated, tests red',
		]);
		expect(doc.items).toEqual([
			{
				id: 'a1',
				text: 'Map the current auth flow',
				checked: true,
				depth: 0,
				author: 'agent',
				iteration: 1,
			},
			{
				id: 'a2',
				text: 'Migrate the data layer',
				checked: false,
				depth: 0,
				author: 'agent',
				iteration: 2,
			},
			{
				id: 'a3',
				text: 'Write the migration test first',
				checked: false,
				depth: 1,
				author: 'agent',
				iteration: 3,
			},
			{
				id: 'h1',
				text: 'Do not touch the billing module',
				checked: false,
				depth: 0,
				author: 'human',
				iteration: null,
			},
		]);
	});

	it('gives a Plan line with no id the next free h<n> and by:human', () => {
		const text = CANONICAL.replace(
			'## Conductor Notes',
			'- [ ] Typed in the editor\n- [x] Another one\n\n## Conductor Notes'
		).replace('<!-- id:h1 by:human -->', '<!-- id:h4 by:human -->');
		const doc = parseGoalPlanDoc(text);
		const human = doc.items.filter((item) => item.author === 'human');
		expect(human.map((item) => [item.id, item.text, item.checked, item.iteration])).toEqual([
			['h4', 'Do not touch the billing module', false, null],
			['h5', 'Typed in the editor', false, null],
			['h6', 'Another one', true, null],
		]);
	});

	it('reassigns a copy-pasted duplicate id to a new human item', () => {
		const text = CANONICAL.replace(
			'## Conductor Notes',
			'- [ ] Migrate the data layer again <!-- id:a2 by:agent it:2 -->\n\n## Conductor Notes'
		);
		const ids = parseGoalPlanDoc(text).items.map((item) => `${item.id}:${item.author}`);
		expect(ids).toEqual(['a1:agent', 'a2:agent', 'a3:agent', 'h1:human', 'h2:human']);
	});

	it('treats an empty checkbox with no id as text, not an item', () => {
		const text = CANONICAL.replace('## Conductor Notes', '- [ ]\n\n## Conductor Notes');
		const doc = parseGoalPlanDoc(text);
		expect(doc.items).toHaveLength(4);
		expect(doc.preserved.planText).toEqual([{ afterId: 'h1', text: '- [ ]' }]);
	});

	it('ignores checkbox and heading lines inside fenced code', () => {
		const text = CANONICAL.replace(
			'Prefer small commits.',
			'Prefer small commits.\n```\n## Plan\n```'
		).replace('## Conductor Notes', '```md\n- [ ] example only\n```\n\n## Conductor Notes');
		const doc = parseGoalPlanDoc(text);
		expect(doc.items).toHaveLength(4);
		expect(doc.conductorNotes).toBe('Prefer small commits.\n```\n## Plan\n```');
		expect(doc.preserved.planText).toEqual([
			{ afterId: 'h1', text: '```md\n- [ ] example only\n```' },
		]);
	});

	it('falls back to defaults for missing front matter and sections', () => {
		const doc = parseGoalPlanDoc('## Plan\n- [ ] only step\n');
		expect(doc.frontMatter).toEqual({
			goalRun: '',
			status: 'running',
			iteration: 0,
			maxIterations: null,
			progress: 0,
			updated: '',
		});
		expect(doc.goal).toBe('');
		expect(doc.items).toEqual([
			{ id: 'h1', text: 'only step', checked: false, depth: 0, author: 'human', iteration: null },
		]);
	});

	it('reads a human max-iterations edit and treats a non-number as no cap', () => {
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: 30   # bumped'))
				.frontMatter.maxIterations
		).toBe(30);
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: none')).frontMatter
				.maxIterations
		).toBeNull();
		expect(
			parseGoalPlanDoc(CANONICAL.replace('max-iterations: 20', 'max-iterations: null')).frontMatter
				.maxIterations
		).toBeNull();
	});
});

describe('renderGoalPlanDoc', () => {
	it('round-trips a canonical document byte for byte', () => {
		expect(renderGoalPlanDoc(parseGoalPlanDoc(CANONICAL))).toBe(CANONICAL);
	});

	it('round-trips a canonical document with unknown sections and free text', () => {
		const text = [
			'---',
			'goal-run: run-9',
			'status: paused',
			'iteration: 0',
			'max-iterations: null',
			'progress: 0',
			'updated: 2026-10-16T00:00:00.000Z',
			'tags: [goal]',
			'---',
			'',
			'# My goal run',
			'',
			'## Links',
			'- https://example.com',
			'',
			'## Goal',
			'Line one.',
			'',
			'### Detail',
			'Line two.',
			'',
			'## Exit Criteria',
			'',
			'## Plan',
			'Intro paragraph before any item.',
			'- [ ] First <!-- id:h1 by:human -->',
			'',
			'A note between items.',
			'',
			'- [x] Second <!-- id:a1 by:agent it:1 -->',
			'',
			'## Scratch',
			'free text',
			'',
			'## Conductor Notes',
			'',
			'## Iteration Log',
			'',
		].join('\n');
		const doc = parseGoalPlanDoc(text);
		expect(doc.preserved.frontMatterLines).toEqual(['tags: [goal]']);
		expect(doc.preserved.preamble).toBe('# My goal run');
		expect(doc.preserved.sections).toEqual([
			{ heading: '## Links', body: '- https://example.com', after: null },
			{ heading: '## Scratch', body: 'free text', after: 'plan' },
		]);
		expect(doc.goal).toBe('Line one.\n\n### Detail\nLine two.');
		expect(renderGoalPlanDoc(doc)).toBe(text);
	});

	it('normalizes non-canonical input without losing content', () => {
		const messy = CANONICAL.replace(/\n/g, '\r\n')
			.replace('- [x] Map', '* [X] Map')
			.replace('## Goal\r\n', '## Goal\r\n\r\n\r\n');
		const rendered = renderGoalPlanDoc(parseGoalPlanDoc(messy));
		expect(rendered).toBe(CANONICAL);
	});

	it('keeps free text anchored to an item that is gone', () => {
		const doc = parseGoalPlanDoc(
			CANONICAL.replace('## Conductor Notes', 'after billing\n\n## Conductor Notes')
		);
		doc.items = doc.items.filter((item) => item.id !== 'h1');
		expect(renderGoalPlanDoc(doc)).toContain(
			'  - [ ] Write the migration test first <!-- id:a3 by:agent it:3 -->\nafter billing\n\n## Conductor Notes'
		);
	});

	it('writes a human item typed without an id back with its new id', () => {
		const text = CANONICAL.replace('## Conductor Notes', '- [ ] New step\n\n## Conductor Notes');
		expect(renderGoalPlanDoc(parseGoalPlanDoc(text))).toContain(
			'- [ ] New step <!-- id:h2 by:human -->'
		);
	});
});

describe('createGoalPlanDoc', () => {
	it('builds a fresh run doc from the config', () => {
		const doc = createGoalPlanDoc(
			{ goal: '  Ship it\n## Sub\nmore  ', exitCriteria: 'Tests pass', maxIterations: 12 },
			'run-1',
			new Date('2026-10-16T12:00:00.000Z')
		);
		expect(doc.frontMatter).toEqual({
			goalRun: 'run-1',
			status: 'running',
			iteration: 0,
			maxIterations: 12,
			progress: 0,
			updated: '2026-10-16T12:00:00.000Z',
		});
		expect(doc.goal).toBe('Ship it\n### Sub\nmore');
		expect(doc.items).toEqual([]);
		const rendered = renderGoalPlanDoc(doc);
		expect(renderGoalPlanDoc(parseGoalPlanDoc(rendered))).toBe(rendered);
		expect(parseGoalPlanDoc(rendered).goal).toBe('Ship it\n### Sub\nmore');
	});
});

describe('planProgress', () => {
	it('counts checked items over all items at every depth', () => {
		const doc = parseGoalPlanDoc(
			[
				'## Plan',
				'',
				'- [x] Top done <!-- id:a1 by:agent it:1 -->',
				'  - [ ] Child open <!-- id:a2 by:agent it:1 -->',
				'    - [x] Grandchild done <!-- id:a3 by:agent it:2 -->',
				'- [ ] Human step',
				'',
			].join('\n')
		);
		expect(planProgress(doc)).toEqual({ checked: 2, total: 4 });
	});

	it('reports zero of zero for an empty plan', () => {
		const doc = createGoalPlanDoc(
			{ goal: 'Ship it', exitCriteria: 'Tests pass', maxIterations: null },
			'run-1',
			new Date('2026-10-16T12:00:00.000Z')
		);
		expect(planProgress(doc)).toEqual({ checked: 0, total: 0 });
	});
});

describe('parsePlanMarker', () => {
	const block = (...lines: string[]) =>
		['<!-- maestro:plan -->', ...lines, '<!-- /maestro:plan -->'].join('\n');

	it('returns null when there is no closed plan block', () => {
		expect(parsePlanMarker('Did work.\n<!-- maestro:progress 40 -->')).toBeNull();
		expect(parsePlanMarker('<!-- maestro:plan -->\n- [ ] never closed')).toBeNull();
	});

	it('returns null when nothing in the block parses as an item', () => {
		expect(parsePlanMarker(block('No list here, just prose.', '- [ ] <!-- id:new -->'))).toBeNull();
	});

	it('keeps explicit ids and gives new or id-less items fresh agent ids', () => {
		const items = parsePlanMarker(
			block(
				'- [x] Map the flow <!-- id:a1 by:agent it:1 -->',
				'- [ ] Keep billing out <!-- id:h1 -->',
				'- [ ] Write the test <!-- id:new -->',
				'- [ ] Run the suite'
			)
		);
		expect(items).toEqual([
			{ id: 'a1', text: 'Map the flow', checked: true, depth: 0, author: 'agent', iteration: 1 },
			{
				id: 'h1',
				text: 'Keep billing out',
				checked: false,
				depth: 0,
				author: 'human',
				iteration: null,
			},
			{
				id: 'a2',
				text: 'Write the test',
				checked: false,
				depth: 0,
				author: 'agent',
				iteration: null,
			},
			{
				id: 'a3',
				text: 'Run the suite',
				checked: false,
				depth: 0,
				author: 'agent',
				iteration: null,
			},
		]);
	});

	it('takes the last block when the agent wrote several', () => {
		const text = [
			block('- [ ] Old draft'),
			'Revised:',
			block('- [x] Final step <!-- id:a4 -->'),
		].join('\n');
		expect(parsePlanMarker(text)).toEqual([
			{ id: 'a4', text: 'Final step', checked: true, depth: 0, author: 'agent', iteration: null },
		]);
	});

	it('never hands out a reserved id', () => {
		const items = parsePlanMarker(block('- [ ] New step <!-- id:new -->'), ['a1', 'a7', 'h3']);
		expect(items?.[0].id).toBe('a8');
	});

	it('gives a repeated id to its first holder and a fresh id to the copy', () => {
		const items = parsePlanMarker(block('- [ ] One <!-- id:a1 -->', '- [ ] Copy <!-- id:a1 -->'));
		expect(items?.map((item) => [item.id, item.author])).toEqual([
			['a1', 'agent'],
			['a2', 'agent'],
		]);
	});

	it('measures depth from the shallowest item and ignores prose in the block', () => {
		const items = parsePlanMarker(
			block(
				'   Here is the plan:',
				'   - [ ] Parent <!-- id:a1 -->',
				'     - [ ] Child <!-- id:a2 -->',
				'       - [x] Grandchild <!-- id:new -->'
			)
		);
		expect(items?.map((item) => [item.id, item.depth])).toEqual([
			['a1', 0],
			['a2', 1],
			['a3', 2],
		]);
	});
});

describe('mergeGoalPlan', () => {
	const item = (id: string, text: string, extra: Partial<GoalPlanItem> = {}): GoalPlanItem => ({
		id,
		text,
		checked: false,
		depth: 0,
		author: id.startsWith('h') ? 'human' : 'agent',
		iteration: null,
		...extra,
	});

	// base: a1 (done), a2, a3 (child of a2), h1
	const base = parseGoalPlanDoc(CANONICAL);
	const withItems = (items: GoalPlanItem[]): GoalPlanDoc => ({ ...base, items });
	const ids = (result: GoalPlanMergeResult) => result.doc.items.map((entry) => entry.id);
	const byId = (result: GoalPlanMergeResult, id: string) =>
		result.doc.items.find((entry) => entry.id === id);

	it('leaves the Plan as on disk and warns when the agent proposed nothing', () => {
		const ours = withItems([...base.items, item('h2', 'Typed during the run')]);
		const result = mergeGoalPlan(base, ours, null);
		expect(result.doc.items).toEqual(ours.items);
		expect(result.conflicts).toEqual([]);
		expect(result.warnings).toHaveLength(1);
	});

	it('lets the agent add, check and reword its own items', () => {
		const theirs = [
			base.items[0],
			{ ...base.items[1], checked: true, text: 'Migrate the data layer (done)' },
			base.items[2],
			item('a4', 'Wire the new client'),
			base.items[3],
		];
		const result = mergeGoalPlan(base, base, theirs, { iteration: 5 });
		expect(ids(result)).toEqual(['a1', 'a2', 'a3', 'a4', 'h1']);
		expect(byId(result, 'a2')).toMatchObject({
			checked: true,
			text: 'Migrate the data layer (done)',
			iteration: 2,
		});
		expect(byId(result, 'a4')).toMatchObject({ author: 'agent', iteration: 5 });
		expect(result.conflicts).toEqual([]);
	});

	it('lets the agent uncheck and re-nest its own items', () => {
		const theirs = [
			{ ...base.items[0], checked: false },
			base.items[1],
			{ ...base.items[2], depth: 0 },
			base.items[3],
		];
		const result = mergeGoalPlan(base, base, theirs);
		expect(byId(result, 'a1')?.checked).toBe(false);
		expect(byId(result, 'a3')?.depth).toBe(0);
		expect(result.conflicts).toEqual([]);
	});

	it('treats an agent line with empty text as keeping the text', () => {
		const theirs = [{ ...base.items[0], text: '', checked: false }, ...base.items.slice(1)];
		const result = mergeGoalPlan(base, base, theirs);
		expect(byId(result, 'a1')).toMatchObject({ text: 'Map the current auth flow', checked: false });
	});

	it('refuses an agent rewording of a human item but lets it check one', () => {
		const theirs = [
			...base.items.slice(0, 3),
			{ ...base.items[3], text: 'Touch billing if needed', checked: true },
		];
		const result = mergeGoalPlan(base, base, theirs);
		expect(byId(result, 'h1')).toMatchObject({
			text: 'Do not touch the billing module',
			checked: true,
			author: 'human',
		});
		expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['h1']);
	});

	it('refuses an agent deletion of a human item and keeps it in place', () => {
		const doc = withItems([base.items[0], base.items[3], base.items[1], base.items[2]]);
		const result = mergeGoalPlan(doc, doc, [base.items[0], base.items[1], base.items[2]]);
		expect(ids(result)).toEqual(['a1', 'h1', 'a2', 'a3']);
		expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['h1']);
	});

	it('lets the agent delete its own item the human did not touch', () => {
		const result = mergeGoalPlan(base, base, [base.items[0], base.items[1], base.items[3]]);
		expect(ids(result)).toEqual(['a1', 'a2', 'h1']);
		expect(result.conflicts).toEqual([]);
	});

	it('keeps an agent item the agent deleted when the human edited it', () => {
		const ours = withItems([
			base.items[0],
			base.items[1],
			{ ...base.items[2], text: 'Write the migration test first, with fixtures' },
			base.items[3],
		]);
		const result = mergeGoalPlan(base, ours, [base.items[0], base.items[1], base.items[3]]);
		expect(ids(result)).toEqual(['a1', 'a2', 'a3', 'h1']);
		expect(byId(result, 'a3')?.text).toBe('Write the migration test first, with fixtures');
		expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['a3']);
	});

	it('keeps an item the human deleted deleted, even if the agent kept or edited it', () => {
		const ours = withItems([base.items[0], base.items[1], base.items[3]]);
		const kept = mergeGoalPlan(base, ours, base.items);
		expect(ids(kept)).toEqual(['a1', 'a2', 'h1']);
		expect(kept.conflicts).toEqual([]);

		const edited = mergeGoalPlan(base, ours, [
			base.items[0],
			base.items[1],
			{ ...base.items[2], checked: true },
			base.items[3],
		]);
		expect(ids(edited)).toEqual(['a1', 'a2', 'h1']);
		expect(edited.conflicts.map((conflict) => conflict.id)).toEqual(['a3']);
	});

	it('gives the human the field both sides changed', () => {
		const ours = withItems([
			base.items[0],
			{ ...base.items[1], text: 'Migrate the data layer to Postgres' },
			base.items[2],
			base.items[3],
		]);
		const theirs = [
			{ ...base.items[0], checked: false },
			{ ...base.items[1], text: 'Migrate the data layer to SQLite' },
			base.items[2],
			base.items[3],
		];
		const result = mergeGoalPlan(base, ours, theirs);
		expect(byId(result, 'a2')?.text).toBe('Migrate the data layer to Postgres');
		expect(byId(result, 'a1')?.checked).toBe(false);
		expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['a2']);
	});

	it('follows the agent order when the human did not reorder', () => {
		const ours = withItems([
			...base.items.slice(0, 2),
			item('h2', 'Human step'),
			...base.items.slice(2),
		]);
		const theirs = [base.items[3], base.items[1], base.items[2], base.items[0]];
		const result = mergeGoalPlan(base, ours, theirs);
		expect(ids(result)).toEqual(['h1', 'a2', 'h2', 'a3', 'a1']);
	});

	it('follows the human order when the human reordered', () => {
		const ours = withItems([base.items[3], base.items[0], base.items[1], base.items[2]]);
		const theirs = [
			base.items[1],
			base.items[0],
			item('a4', 'New step'),
			base.items[2],
			base.items[3],
		];
		const result = mergeGoalPlan(base, ours, theirs);
		expect(ids(result)).toEqual(['h1', 'a1', 'a4', 'a2', 'a3']);
	});

	it('keeps a human edit and an agent edit to different items', () => {
		const ours = withItems([
			base.items[0],
			base.items[1],
			base.items[2],
			{ ...base.items[3], text: 'Do not touch billing or invoices' },
		]);
		const theirs = [
			base.items[0],
			base.items[1],
			{ ...base.items[2], checked: true },
			base.items[3],
		];
		const result = mergeGoalPlan(base, ours, theirs);
		expect(byId(result, 'h1')?.text).toBe('Do not touch billing or invoices');
		expect(byId(result, 'a3')?.checked).toBe(true);
		expect(result.conflicts).toEqual([]);
	});

	it('takes authorship from the doc and renames an added human-looking id', () => {
		const theirs = [
			{ ...base.items[0], author: 'human' as const },
			...base.items.slice(1),
			item('h9', 'Agent posing as human'),
		];
		const result = mergeGoalPlan(base, base, theirs);
		expect(byId(result, 'a1')?.author).toBe('agent');
		expect(byId(result, 'h9')).toBeUndefined();
		expect(result.doc.items[4]).toMatchObject({ id: 'a4', author: 'agent' });
		expect(result.warnings).toHaveLength(1);
	});

	it('warns on a repeated id and keeps the first', () => {
		const theirs = [...base.items, { ...base.items[0], checked: false }];
		const result = mergeGoalPlan(base, base, theirs);
		expect(byId(result, 'a1')?.checked).toBe(true);
		expect(result.warnings).toHaveLength(1);
	});

	it('takes every section other than the Plan from the on-disk copy', () => {
		const ours: GoalPlanDoc = {
			...base,
			goal: 'A new goal',
			conductorNotes: 'Be careful.',
			frontMatter: { ...base.frontMatter, maxIterations: 30 },
		};
		const result = mergeGoalPlan(base, ours, base.items);
		expect(result.doc).toEqual(ours);
	});
});

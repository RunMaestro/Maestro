/**
 * Model hints are resolved against the NEXT unfinished task, so the cases that
 * matter are about position: which marker wins, what a checked task does to a
 * marker above it, and whether a marker in a code fence counts.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { noteEffortRejection, resetEffortRejections } from '../../shared/effortRejection';
import {
	findActiveModelHint,
	findAllModelHints,
	countTasksUnderActiveHint,
	describeSegmentLimit,
} from '../../shared/autorunModelHints';
import { resolveTurnSettings } from '../../shared/autorunTurnSettings';

describe('findActiveModelHint', () => {
	it('returns null when the document sets no hint', () => {
		expect(findActiveModelHint('- [ ] do the thing')).toBeNull();
	});

	it('applies the marker above the next unfinished task', () => {
		const doc = `<!-- MAESTRO:MODEL tier="high" effort="high" -->\n\n- [ ] plan the migration`;
		expect(findActiveModelHint(doc)).toMatchObject({ tier: 'high', effort: 'high' });
	});

	it('takes the LAST marker above the task, because a hint is a setting', () => {
		// Unlike a HITL gate (where the earliest unacknowledged one wins because it
		// is a thing to stop at), the most recent assignment wins.
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'<!-- MAESTRO:MODEL tier="high" -->',
			'- [ ] task',
		].join('\n');
		expect(findActiveModelHint(doc)?.tier).toBe('high');
	});

	it('steps over checked tasks so a half-done section keeps its setting', () => {
		// The completed half of a phase must not drop the model the rest of it
		// still needs - this is what makes one marker per section work.
		const doc = [
			'## Design',
			'<!-- MAESTRO:MODEL tier="high" -->',
			'- [x] sketch the approach',
			'- [ ] write the plan',
		].join('\n');
		expect(findActiveModelHint(doc)?.tier).toBe('high');
	});

	it('switches settings at a later section boundary', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="high" -->',
			'- [x] design done',
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] mechanical rename',
		].join('\n');
		expect(findActiveModelHint(doc)?.tier).toBe('low');
	});

	it('ignores markers inside fenced code so a playbook can document the syntax', () => {
		const doc = [
			'Explaining the feature:',
			'```markdown',
			'<!-- MAESTRO:MODEL tier="high" -->',
			'```',
			'- [ ] task',
		].join('\n');
		expect(findActiveModelHint(doc)).toBeNull();
	});

	it('reports no hint when every task is done', () => {
		// A trailing marker governs nothing - there is no task left for it to apply
		// to, so it must not be reported as active.
		const doc = ['- [x] done', '<!-- MAESTRO:MODEL tier="high" -->'].join('\n');
		expect(findActiveModelHint(doc)).toBeNull();
	});

	it('treats each axis independently', () => {
		const doc = `<!-- MAESTRO:MODEL effort="low" -->\n- [ ] task`;
		const hint = findActiveModelHint(doc);
		expect(hint?.effort).toBe('low');
		expect(hint?.tier).toBeUndefined();
	});

	it('keeps "default" as an explicit directive rather than collapsing it', () => {
		// It must survive parsing so a task-scoped `default` can override a
		// document-scoped level. Resolution treats it as "use the agent's value".
		const doc = `<!-- MAESTRO:MODEL tier="default" effort="default" -->\n- [ ] task`;
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBe('default');
		expect(hint?.effort).toBe('default');
		expect(hint?.invalid).toBeUndefined();
	});

	it('records a misspelled value instead of silently ignoring it', () => {
		// A typo that resolved to "no hint" would run the task on the wrong model
		// with no signal, which is the exact failure this feature exists to avoid.
		const doc = `<!-- MAESTRO:MODEL tier="hgih" -->\n- [ ] task`;
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBeUndefined();
		expect(hint?.invalid).toEqual([{ attribute: 'tier', value: 'hgih' }]);
	});
});

describe('hint scopes', () => {
	it('carries a document-scoped marker to every task below it', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" effort="low" -->',
			'- [x] first',
			'- [ ] second',
			'- [ ] third',
		].join('\n');
		expect(findActiveModelHint(doc)).toMatchObject({ tier: 'low', effort: 'low' });
	});

	it('applies an inline marker to that task only', () => {
		const doc = ['- [ ] design the migration <!-- MAESTRO:MODEL tier="high" -->'].join('\n');
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBe('high');
		expect(hint?.scopes?.tier).toBe('task');
	});

	it('reverts to the document scope once the inline task is checked off', () => {
		// The whole point of task scope: the NEXT task must not inherit it.
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" effort="low" -->',
			'- [x] design the migration <!-- MAESTRO:MODEL tier="high" effort="high" -->',
			'- [ ] apply the renames',
		].join('\n');
		expect(findActiveModelHint(doc)).toMatchObject({ tier: 'low', effort: 'low' });
	});

	it('reverts to no hint at all when there was no document scope', () => {
		const doc = [
			'- [x] design the migration <!-- MAESTRO:MODEL tier="high" -->',
			'- [ ] apply the renames',
		].join('\n');
		expect(findActiveModelHint(doc)).toBeNull();
	});

	it('layers the two per axis rather than wholesale', () => {
		// A task raising only the tier must keep the document's effort - otherwise
		// tier="high" would silently LOWER the effort inside a high-effort section.
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" effort="high" -->',
			'- [ ] design <!-- MAESTRO:MODEL tier="high" -->',
		].join('\n');
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBe('high');
		expect(hint?.effort).toBe('high');
		expect(hint?.scopes).toEqual({ tier: 'task', effort: 'document' });
	});

	it('lets one task opt out of a document-wide hint with "default"', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="high" effort="high" -->',
			'- [ ] trivial rename <!-- MAESTRO:MODEL tier="default" effort="default" -->',
		].join('\n');
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBe('default');
		expect(hint?.effort).toBe('default');
	});

	it('does not let an inline marker on a checked task become a section marker', () => {
		const doc = ['- [x] design <!-- MAESTRO:MODEL tier="high" -->', '- [ ] a', '- [ ] b'].join(
			'\n'
		);
		expect(findActiveModelHint(doc)).toBeNull();
	});

	it('ignores an inline marker inside fenced code', () => {
		// The fence promise has to hold for BOTH forms, or a playbook that
		// documents the inline syntax silently changes its own model.
		const doc = [
			'```markdown',
			'- [ ] example <!-- MAESTRO:MODEL tier="high" -->',
			'```',
			'- [ ] the real task',
		].join('\n');
		expect(findActiveModelHint(doc)).toBeNull();
	});

	it('keeps a typo on either scope reportable after they merge', () => {
		// Merging must not swallow the document's invalid value in favor of the
		// task's, or a misspelled marker warns only until someone adds an inline
		// one below it.
		const doc = [
			'<!-- MAESTRO:MODEL tier="hgih" -->',
			'- [ ] design <!-- MAESTRO:MODEL effort="hihg" -->',
		].join('\n');
		expect(findActiveModelHint(doc)?.invalid).toEqual([
			{ attribute: 'tier', value: 'hgih' },
			{ attribute: 'effort', value: 'hihg' },
		]);
	});
});

describe('reason attribute', () => {
	it('parses the justification alongside the levels', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="high" effort="high" reason="Lock ordering across three services. A wrong ordering corrupts data." -->',
			'- [ ] Design',
		].join('\n');
		expect(findActiveModelHint(doc)).toMatchObject({
			tier: 'high',
			effort: 'high',
			reason: 'Lock ordering across three services. A wrong ordering corrupts data.',
		});
	});

	it('never lets a reason change what the task runs on', () => {
		// The whole safety argument for the attribute: it is documentation, so it
		// must not reach model resolution even when it is the only thing present.
		const withReason = findActiveModelHint(
			'<!-- MAESTRO:MODEL tier="low" reason="Mechanical work." -->\n- [ ] x'
		);
		const without = findActiveModelHint('<!-- MAESTRO:MODEL tier="low" -->\n- [ ] x');
		expect(resolveTurnSettings('claude-code', withReason)).toEqual(
			resolveTurnSettings('claude-code', without)
		);
	});

	it('does not split a document-mode segment on differing reasons', () => {
		// Segmenting compares resolved model/effort. If prose reached that
		// comparison, editing a comment would cost an extra dispatch.
		const doc = [
			'- [ ] a <!-- MAESTRO:MODEL tier="low" reason="Because of one thing." -->',
			'- [ ] b <!-- MAESTRO:MODEL tier="low" reason="Because of something else." -->',
		].join('\n');
		expect(countTasksUnderActiveHint(doc, 'claude-code')).toEqual({ count: 2, total: 2 });
	});

	it('keeps the levels when an inner double quote truncates the reason', () => {
		// Degrading to a short sentence is fine; degrading to the wrong model is
		// not. tier and effort are matched independently of the prose.
		const hint = findActiveModelHint(
			'<!-- MAESTRO:MODEL tier="high" effort="high" reason="Uses the "fast" path." -->\n- [ ] x'
		);
		expect(hint).toMatchObject({ tier: 'high', effort: 'high', reason: 'Uses the' });
	});

	it('collapses newlines so a wrapped marker reads as one sentence', () => {
		const hint = findActiveModelHint(
			'<!-- MAESTRO:MODEL tier="low" reason="First line.   Second line." -->\n- [ ] x'
		);
		expect(hint?.reason).toBe('First line. Second line.');
	});

	it('truncates a reason too long to peek at', () => {
		const hint = findActiveModelHint(
			`<!-- MAESTRO:MODEL tier="low" reason="${'x'.repeat(600)}" -->\n- [ ] x`
		);
		expect(hint?.reason).toHaveLength(400);
		expect(hint?.reason?.endsWith('…')).toBe(true);
	});

	it('omits the field entirely when the attribute is absent or empty', () => {
		expect(
			findActiveModelHint('<!-- MAESTRO:MODEL tier="low" -->\n- [ ] x')?.reason
		).toBeUndefined();
		expect(
			findActiveModelHint('<!-- MAESTRO:MODEL tier="low" reason="  " -->\n- [ ] x')?.reason
		).toBeUndefined();
	});

	it('lets the narrower scope explain itself when the two merge', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" reason="Mostly mechanical phase." -->',
			'- [ ] Design <!-- MAESTRO:MODEL tier="high" reason="This one needs judgment." -->',
		].join('\n');
		expect(findActiveModelHint(doc)).toMatchObject({
			tier: 'high',
			reason: 'This one needs judgment.',
		});
	});

	it('inherits the document reason when the task marker gives none', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" reason="Mostly mechanical phase." -->',
			'- [ ] Design <!-- MAESTRO:MODEL effort="high" -->',
		].join('\n');
		expect(findActiveModelHint(doc)?.reason).toBe('Mostly mechanical phase.');
	});
});

describe('findAllModelHints', () => {
	it('collects every marker for authoring-time validation', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] a',
			'<!-- MAESTRO:MODEL tier="bogus" -->',
			'- [ ] b',
		].join('\n');
		const all = findAllModelHints(doc);
		expect(all).toHaveLength(2);
		expect(all[1].invalid).toEqual([{ attribute: 'tier', value: 'bogus' }]);
	});

	it('tags each marker with the scope it would apply at', () => {
		// Authoring-time validation reports where a hint reaches, so a marker the
		// author meant as document-wide but wrote onto a task line has to be
		// distinguishable from one that really is standalone.
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] a <!-- MAESTRO:MODEL tier="high" -->',
			'- [x] b <!-- MAESTRO:MODEL effort="high" -->',
		].join('\n');
		expect(findAllModelHints(doc).map((hint) => hint.scopes)).toEqual([
			{ tier: 'document' },
			{ tier: 'task' },
			{ effort: 'task' },
		]);
	});
});

describe('resolveTurnSettings', () => {
	it('leaves the agent config alone when there is no hint', () => {
		const resolved = resolveTurnSettings('claude-code', null, 'sonnet', 'medium');
		expect(resolved).toMatchObject({ model: 'sonnet', effort: 'medium' });
		expect(resolved.notes).toEqual([]);
		expect(resolved.warnings).toEqual([]);
	});

	it('overrides the agent config when the provider can honor the hint', () => {
		const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
		const resolved = resolveTurnSettings('claude-code', hint, 'sonnet', 'medium');
		expect(resolved.model).toBe('opus');
		expect(resolved.effort).toBe('max');
		expect(resolved.warnings).toEqual([]);
	});

	it('falls back to the agent config AND warns when the provider cannot honor it', () => {
		// Running the task anyway is right, since the work still needs doing.
		// Doing it silently is how someone concludes the feature is broken.
		const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
		const resolved = resolveTurnSettings('opencode', hint, 'ollama/qwen3:8b', undefined);
		expect(resolved.model).toBe('ollama/qwen3:8b');
		expect(resolved.effort).toBeUndefined();
		expect(resolved.warnings).toHaveLength(2);
		expect(resolved.warnings.join(' ')).toContain('opencode');
	});

	it('honors the axis it can and warns about the one it cannot', () => {
		// Codex has an effort ladder but no tier map, so a marker setting both
		// must not be all-or-nothing.
		const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
		const resolved = resolveTurnSettings('codex', hint, 'gpt-5.3-codex', undefined);
		expect(resolved.effort).toBe('xhigh');
		expect(resolved.model).toBe('gpt-5.3-codex');
		expect(resolved.warnings).toHaveLength(1);
	});

	describe('after the provider refused the value a level maps to', () => {
		afterEach(() => {
			resetEffortRejections();
		});

		it('inherits the agent effort and says the provider refused it', () => {
			// Not "no level is mapped": the document is fine, the provider's
			// catalogue moved, and the author should be told which it was.
			noteEffortRejection('codex', {
				value: 'xhigh',
				model: 'gpt-6-luna',
				supported: ['low', 'medium', 'high'],
			});
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="high" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('codex', hint, 'gpt-6-luna', 'medium');

			expect(resolved.effort).toBe('medium');
			expect(resolved.notes).toEqual([]);
			expect(resolved.warnings).toEqual([
				'codex rejected effort "xhigh" for gpt-6-luna. It accepts low, medium, high. effort="high" was ignored; using the agent\'s configured effort.',
			]);
		});

		it('leaves a level that maps to a different value untouched', () => {
			noteEffortRejection('codex', { value: 'xhigh', supported: [] });
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="low" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('codex', hint, undefined, 'medium');

			expect(resolved.effort).toBe('low');
			expect(resolved.warnings).toEqual([]);
		});
	});

	it('resolves an explicit "default" back to the agent\'s own values', () => {
		const hint = findActiveModelHint(
			[
				'<!-- MAESTRO:MODEL tier="high" effort="high" -->',
				'- [ ] trivial <!-- MAESTRO:MODEL tier="default" effort="default" -->',
			].join('\n')
		);
		const resolved = resolveTurnSettings('claude-code', hint, 'sonnet', 'medium');
		expect(resolved.model).toBe('sonnet');
		expect(resolved.effort).toBe('medium');
		expect(resolved.warnings).toEqual([]);
	});

	it('reports which scope supplied each axis', () => {
		const hint = findActiveModelHint(
			[
				'<!-- MAESTRO:MODEL effort="high" -->',
				'- [ ] design <!-- MAESTRO:MODEL tier="high" -->',
			].join('\n')
		);
		const resolved = resolveTurnSettings('claude-code', hint, undefined, undefined);
		expect(resolved.notes.join(' ')).toContain('(task)');
		expect(resolved.notes.join(' ')).toContain('(document)');
	});

	it('surfaces a misspelled value as a warning', () => {
		const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="hihg" -->\n- [ ] x`);
		const resolved = resolveTurnSettings('claude-code', hint, undefined, undefined);
		expect(resolved.warnings.join(' ')).toContain('hihg');
		expect(resolved.effort).toBeUndefined();
	});
});

describe('countTasksUnderActiveHint', () => {
	// The regression that would hurt: every playbook written before model hints
	// existed has no markers, so this path decides whether the whole existing
	// corpus keeps behaving as it always has.
	it('reports the whole document when nothing changes settings', () => {
		const content = ['- [ ] one', '- [ ] two', '- [ ] three'].join('\n');
		expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
			count: 3,
			total: 3,
		});
	});

	it('stops at the task that asks for a different tier', () => {
		const content = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] one',
			'- [ ] two',
			'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
			'- [ ] four',
		].join('\n');
		expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
			count: 2,
			total: 4,
		});
	});

	it('stops when a standalone marker changes the settings partway down', () => {
		const content = [
			'- [ ] one',
			'<!-- MAESTRO:MODEL tier="high" -->',
			'- [ ] two',
			'- [ ] three',
		].join('\n');
		expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
			count: 1,
			total: 3,
		});
	});

	// The whole reason this compares resolved settings instead of tier words:
	// codex has no tier table, so both tiers fall back to the agent's own model.
	// Splitting here would end one dispatch and start another at exactly the
	// same configuration.
	it('does not split on tier words that resolve to identical settings', () => {
		const content = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] one',
			'- [ ] two <!-- MAESTRO:MODEL tier="high" -->',
		].join('\n');
		expect(countTasksUnderActiveHint(content, 'codex', 'gpt-5', 'medium')).toEqual({
			count: 2,
			total: 2,
		});
	});

	it('treats tier="default" as the agent baseline rather than a change', () => {
		const content = ['- [ ] one', '- [ ] two <!-- MAESTRO:MODEL tier="default" -->'].join('\n');
		expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
			count: 2,
			total: 2,
		});
	});

	it('ignores checked tasks and counts only what remains', () => {
		const content = ['- [x] done', '- [ ] one', '- [ ] two'].join('\n');
		expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
			count: 2,
			total: 2,
		});
	});

	it('reports nothing for a document with no unchecked tasks', () => {
		expect(countTasksUnderActiveHint('- [x] done', 'claude-code')).toEqual({ count: 0, total: 0 });
	});
});

describe('describeSegmentLimit', () => {
	it('returns nothing when the whole remainder shares one setting', () => {
		expect(describeSegmentLimit({ count: 3, total: 3 })).toBe('');
		expect(describeSegmentLimit(undefined)).toBe('');
	});

	it('names the boundary when the settings change partway down', () => {
		const text = describeSegmentLimit({ count: 2, total: 5 });
		expect(text).toContain('ONLY the next 2 unchecked tasks');
		expect(text).toContain('separate pass');
	});

	it('says "task" rather than "tasks" for a single one', () => {
		expect(describeSegmentLimit({ count: 1, total: 4 })).toContain('next 1 unchecked task,');
	});
});

/**
 * The contract the two pieces make together: a document that changes settings
 * partway down must produce MORE THAN ONE dispatch, each at its own resolved
 * model, rather than one dispatch that silently runs every task at whatever the
 * first task asked for. The engines recompute both of these per dispatch from
 * the document as it stands, so replaying them over the checked-off document is
 * the same walk the runner does.
 */
describe('document-mode dispatch boundary', () => {
	const dispatch = (content: string) => {
		const settings = resolveTurnSettings(
			'claude-code',
			findActiveModelHint(content),
			'sonnet',
			'medium'
		);
		const segment = countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium');
		return { model: settings.model, effort: settings.effort, segment };
	};

	it('splits a mixed-tier document into two dispatches at different models', () => {
		const first = dispatch(
			[
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] one',
				'- [ ] two',
				'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
			].join('\n')
		);
		expect(first.segment).toEqual({ count: 2, total: 3 });

		// The runner checks off what it completed and comes back around.
		const second = dispatch(
			[
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [x] one',
				'- [x] two',
				'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
			].join('\n')
		);
		expect(second.segment).toEqual({ count: 1, total: 1 });

		// Two dispatches, and they are genuinely at different models - not two
		// passes over the same configuration.
		expect(first.model).toBeTruthy();
		expect(second.model).toBeTruthy();
		expect(second.model).not.toBe(first.model);
	});

	it('leaves an unmarked document as a single whole-document dispatch', () => {
		const only = dispatch(['- [ ] one', '- [ ] two', '- [ ] three'].join('\n'));
		expect(only.segment).toEqual({ count: 3, total: 3 });
		expect(describeSegmentLimit(only.segment)).toBe('');
		expect(only.model).toBe('sonnet');
		expect(only.effort).toBe('medium');
	});
});

describe('Grok hints with selected-model effort evidence', () => {
	afterEach(() => resetEffortRejections());

	it.each([
		{ name: 'ordered', menu: ['minimal', 'medium', 'max'] },
		{ name: 'reordered', menu: ['max', 'minimal', 'medium'] },
		{ name: 'extended', menu: ['ultra', 'none', 'max', 'high', 'medium', 'low', 'minimal'] },
	])('replays the same dispatch boundaries with a $name menu', ({ menu }) => {
		let doc = [
			'<!-- MAESTRO:MODEL effort="low" -->',
			'- [ ] scan',
			'- [ ] catalogue',
			'- [ ] design <!-- MAESTRO:MODEL effort="high" -->',
			'- [ ] implement <!-- MAESTRO:MODEL effort="medium" -->',
			'- [ ] tidy',
		].join('\n');
		expect(findAllModelHints(doc)).toMatchObject([
			{ effort: 'low', scopes: { effort: 'document' } },
			{ effort: 'high', scopes: { effort: 'task' } },
			{ effort: 'medium', scopes: { effort: 'task' } },
		]);
		for (const step of [
			{ effort: 'minimal', scope: 'document', count: 2, total: 5 },
			{ effort: 'max', scope: 'task', count: 1, total: 3 },
			{ effort: 'medium', scope: 'task', count: 1, total: 2 },
			{ effort: 'minimal', scope: 'document', count: 1, total: 1 },
		]) {
			const resolved = resolveTurnSettings(
				'grok',
				findActiveModelHint(doc),
				'chosen-model',
				'high',
				menu
			);
			expect(resolved).toMatchObject({ model: 'chosen-model', effort: step.effort, warnings: [] });
			expect(resolved.notes).toHaveLength(1);
			expect(resolved.notes[0]).toContain(`(${step.scope}) -> ${step.effort}`);
			expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'high', menu)).toEqual({
				count: step.count,
				total: step.total,
			});
			// Advance exactly the completed segment, just as the existing replay test does.
			for (let completed = 0; completed < step.count; completed++) {
				doc = doc.replace('- [ ]', '- [x]');
			}
		}
		expect(findActiveModelHint(doc)).toBeNull();
		expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'high', menu)).toEqual({
			count: 0,
			total: 0,
		});
	});

	it.each([
		{ name: 'absent', menu: undefined, warning: 'No advertised effort menu is available' },
		{ name: 'empty', menu: [], warning: 'does not include the rung' },
		{ name: 'legacy', menu: ['low', 'high', 'xhigh'], warning: 'does not include the rung' },
		{
			name: 'selector IDs',
			menu: ['menu-minimal', 'menu-medium', 'menu-max'],
			warning: 'does not include the rung',
		},
		{
			name: 'uppercase aliases',
			menu: ['MINIMAL', 'MEDIUM', 'MAX'],
			warning: 'does not include the rung',
		},
		{ name: 'noncandidate values', menu: ['none', 'ultra'], warning: 'does not include the rung' },
	])('inherits configured settings and explains an $name menu', ({ menu, warning }) => {
		const doc = [
			'- [ ] scan <!-- MAESTRO:MODEL effort="low" -->',
			'- [ ] implement <!-- MAESTRO:MODEL effort="medium" -->',
			'- [ ] design <!-- MAESTRO:MODEL effort="high" -->',
		].join('\n');
		for (const hint of findAllModelHints(doc)) {
			const resolved = resolveTurnSettings('grok', hint, 'chosen-model', 'xhigh', menu);
			expect(resolved).toMatchObject({ model: 'chosen-model', effort: 'xhigh', notes: [] });
			expect(resolved.warnings).toHaveLength(1);
			expect(resolved.warnings[0]).toContain(warning);
			expect(resolved.warnings[0]).toContain(`effort="${hint.effort}"`);
			expect(resolved.warnings[0]).toContain("using the agent's configured effort");
		}
		expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'xhigh', menu)).toEqual({
			count: 3,
			total: 3,
		});
	});

	it.each([
		{ level: 'low', menu: ['low', 'medium', 'max'] },
		{ level: 'medium', menu: ['minimal', 'low', 'high', 'max'] },
		{ level: 'high', menu: ['minimal', 'medium', 'high', 'xhigh', 'ultra'] },
	])('never substitutes an adjacent advertised rung for $level', ({ level, menu }) => {
		const doc = [`- [ ] hinted <!-- MAESTRO:MODEL effort="${level}" -->`, '- [ ] baseline'].join(
			'\n'
		);
		const resolved = resolveTurnSettings(
			'grok',
			findActiveModelHint(doc),
			'chosen-model',
			'high',
			menu
		);
		expect(resolved).toMatchObject({ model: 'chosen-model', effort: 'high', notes: [] });
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.warnings[0]).toContain('does not include the rung');
		expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'high', menu)).toEqual({
			count: 2,
			total: 2,
		});
	});

	it.each(['low', 'medium', 'high'])(
		'warns for unsupported Grok tier %s without splitting identical settings',
		(tier) => {
			const doc = [
				`- [ ] hinted <!-- MAESTRO:MODEL tier="${tier}" effort="medium" -->`,
				'- [ ] baseline',
			].join('\n');
			const resolved = resolveTurnSettings(
				'grok',
				findActiveModelHint(doc),
				'chosen-model',
				'medium',
				['medium']
			);
			expect(resolved).toMatchObject({
				model: 'chosen-model',
				effort: 'medium',
				notes: ['effort="medium" (task) -> medium'],
			});
			expect(resolved.warnings).toHaveLength(1);
			expect(resolved.warnings[0]).toContain(
				`grok has no model tier mapping, so tier="${tier}" was ignored`
			);
			expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'medium', ['medium'])).toEqual({
				count: 2,
				total: 2,
			});
		}
	);

	it.each([
		{
			marker: 'tier="default"',
			scopes: { tier: 'task', effort: 'document' },
			effort: 'max',
			notes: ['effort="high" (document) -> max'],
			warnings: 0,
			count: 2,
		},
		{
			marker: 'effort="default"',
			scopes: { tier: 'document', effort: 'task' },
			effort: 'xhigh',
			notes: [],
			warnings: 1,
			count: 1,
		},
		{
			marker: 'tier="default" effort="default"',
			scopes: { tier: 'task', effort: 'task' },
			effort: 'xhigh',
			notes: [],
			warnings: 0,
			count: 1,
		},
		{
			marker: 'effort="low"',
			scopes: { tier: 'document', effort: 'task' },
			effort: 'minimal',
			notes: ['effort="low" (task) -> minimal'],
			warnings: 1,
			count: 1,
		},
	])('layers $marker per axis and restores the document after completion', (entry) => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="high" effort="high" -->',
			`- [ ] special <!-- MAESTRO:MODEL ${entry.marker} -->`,
			'- [ ] ordinary',
		].join('\n');
		const menu = ['minimal', 'medium', 'max'];
		const hint = findActiveModelHint(doc);
		expect(hint?.scopes).toEqual(entry.scopes);
		const resolved = resolveTurnSettings('grok', hint, 'chosen-model', 'xhigh', menu);
		expect(resolved).toMatchObject({
			model: 'chosen-model',
			effort: entry.effort,
			notes: entry.notes,
		});
		expect(resolved.warnings).toHaveLength(entry.warnings);
		expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', 'xhigh', menu)).toEqual({
			count: entry.count,
			total: 2,
		});
		const remaining = doc.replace('- [ ]', '- [x]');
		expect(findActiveModelHint(remaining)?.scopes).toEqual({
			tier: 'document',
			effort: 'document',
		});
		expect(
			resolveTurnSettings('grok', findActiveModelHint(remaining), 'chosen-model', 'xhigh', menu)
		).toMatchObject({
			model: 'chosen-model',
			effort: 'max',
			notes: ['effort="high" (document) -> max'],
		});
	});

	it.each([
		'- [ ] no hint',
		'<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] opt out <!-- MAESTRO:MODEL tier="default" effort="default" -->',
	])('preserves configured or unset values without menu warnings for %s', (doc) => {
		for (const current of [
			{ model: 'chosen-model', effort: 'MAX' },
			{ model: undefined, effort: undefined },
		]) {
			expect(
				resolveTurnSettings('grok', findActiveModelHint(doc), current.model, current.effort)
			).toEqual({ ...current, notes: [], warnings: [] });
		}
	});

	it.each([
		{ name: 'missing', menu: undefined },
		{ name: 'empty', menu: [] },
		{ name: 'advertised again', menu: ['minimal', 'medium', 'max'] },
	])('keeps a remembered refusal authoritative when the menu is $name', ({ menu }) => {
		noteEffortRejection('grok', {
			value: 'MAX',
			model: 'other-model',
			supported: ['medium', 'menu-fast'],
		});
		const doc = ['- [ ] hinted <!-- MAESTRO:MODEL effort="high" -->', '- [ ] baseline'].join('\n');
		// Refusal memory is provider-wide. Inheritance never rewrites an explicit choice.
		for (const effort of ['xhigh', 'MAX']) {
			const resolved = resolveTurnSettings(
				'grok',
				findActiveModelHint(doc),
				'chosen-model',
				effort,
				menu
			);
			expect(resolved).toMatchObject({ model: 'chosen-model', effort, notes: [] });
			expect(resolved.warnings).toHaveLength(1);
			expect(resolved.warnings[0]).toContain('grok rejected effort "MAX" for other-model');
			expect(resolved.warnings[0]).not.toContain('advertised effort menu');
			expect(countTasksUnderActiveHint(doc, 'grok', 'chosen-model', effort, menu)).toEqual({
				count: 2,
				total: 2,
			});
		}
	});

	it.each([
		{ provider: 'claude-code' as const, model: 'opus', effort: 'max', count: 1 },
		{ provider: 'codex' as const, model: 'chosen-model', effort: 'xhigh', count: 1 },
		{ provider: 'opencode' as const, model: 'chosen-model', effort: 'high', count: 2 },
	])(
		'leaves $provider dispatch and inspection unchanged when supplied a Grok menu',
		({ provider, model, effort, count }) => {
			const doc = [
				'- [ ] hinted <!-- MAESTRO:MODEL tier="high" effort="high" -->',
				'- [ ] baseline',
			].join('\n');
			const hint = findActiveModelHint(doc);
			const baseline = resolveTurnSettings(provider, hint, 'chosen-model', 'high');
			expect(baseline).toMatchObject({ model, effort });
			for (const menu of [[], ['minimal', 'medium', 'max']]) {
				expect(resolveTurnSettings(provider, hint, 'chosen-model', 'high', menu)).toEqual(baseline);
				expect(countTasksUnderActiveHint(doc, provider, 'chosen-model', 'high', menu)).toEqual({
					count,
					total: 2,
				});
			}
		}
	);
});

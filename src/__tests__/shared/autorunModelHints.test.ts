/**
 * Model hints are resolved against the NEXT unfinished task, so the cases that
 * matter are about position: which marker wins, what a checked task does to a
 * marker above it, and whether a marker in a code fence counts.
 */

import { describe, it, expect } from 'vitest';
import { findActiveModelHint, findAllModelHints } from '../../shared/autorunModelHints';
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

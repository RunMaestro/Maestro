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

	it('treats "default" as inherit rather than as a level', () => {
		const doc = `<!-- MAESTRO:MODEL tier="default" effort="default" -->\n- [ ] task`;
		const hint = findActiveModelHint(doc);
		expect(hint?.tier).toBeUndefined();
		expect(hint?.effort).toBeUndefined();
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

	it('surfaces a misspelled value as a warning', () => {
		const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="hihg" -->\n- [ ] x`);
		const resolved = resolveTurnSettings('claude-code', hint, undefined, undefined);
		expect(resolved.warnings.join(' ')).toContain('hihg');
		expect(resolved.effort).toBeUndefined();
	});
});

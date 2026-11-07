/**
 * Tests for the agent side of shared/modelTiers: each tier of one agent as a
 * launch would resolve it, the check every writer of an agent's tiers shares,
 * and the `<tier>=<target>` spelling `update-agent --tier` takes.
 */

import { describe, it, expect } from 'vitest';

import {
	agentTierRows,
	harnessTierRows,
	parseTierAssignment,
	parseTierTargetsEdit,
	tierRowRecord,
	type TierTarget,
} from '../../shared/modelTiers';

const OLLAMA = { id: 'ep-ollama', name: 'Ollama' };
const LOCAL: TierTarget = { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' };
const OPUS: TierTarget = { type: 'provider-model', model: 'opus' };

describe('agentTierRows', () => {
	it('names the layer each tier came from: agent, harness default, built-in', () => {
		const rows = agentTierRows(
			{ toolType: 'claude-code', tierTargets: { low: LOCAL } },
			{ 'claude-code': { low: OPUS, medium: OPUS } }
		);

		expect(rows.map((row) => [row.tier, row.source])).toEqual([
			['low', 'agent'],
			['medium', 'harness-default'],
			['high', 'built-in'],
		]);
		expect(rows[0].target).toEqual(LOCAL);
		expect(rows[1].target).toEqual(OPUS);
		expect(rows[2].target).toEqual({ type: 'provider-model', model: 'opus' });
		expect(rows[2].builtIn).toBe('opus');
	});

	it("blames the agent's own layer for a target a launch would refuse", () => {
		const rows = agentTierRows({ toolType: 'factory-droid', tierTargets: { high: LOCAL } });

		expect(rows[2]).toMatchObject({ tier: 'high', target: null, source: 'agent' });
		expect(rows[2].problem).toMatch(/This agent's "high" tier target/);
		expect(rows[2].note).toBeUndefined();
	});

	it('blames the harness default when that is the layer that cannot be used', () => {
		const rows = agentTierRows({ toolType: 'factory-droid' }, { 'factory-droid': { low: LOCAL } });

		expect(rows[0]).toMatchObject({ target: null, source: 'harness-default' });
		expect(rows[0].problem).toMatch(/harness default/);
	});

	it('says why a tier does not apply, without calling it broken', () => {
		// Only the built-in table maps the tier, and the agent runs on a source.
		const onSource = agentTierRows({ toolType: 'claude-code', runOn: LOCAL });
		expect(onSource[0]).toMatchObject({ target: null, source: null });
		expect(onSource[0].note).toMatch(/runs on a Local Models source/);
		expect(onSource[0].problem).toBeUndefined();

		// No layer maps the tier at all.
		const unmapped = agentTierRows({ toolType: 'opencode' });
		expect(unmapped[0]).toMatchObject({ target: null, source: null, builtIn: null });
		expect(unmapped[0].note).toMatch(/no model tier mapping/);
	});

	it('is what the harness table reads, minus the agent layer', () => {
		const defaults = { 'claude-code': { low: LOCAL } };
		expect(harnessTierRows('claude-code', defaults)).toEqual(
			agentTierRows({ toolType: 'claude-code' }, defaults)
		);
	});
});

describe('tierRowRecord', () => {
	it('spells and names the target, so a read can be written back', () => {
		const [low, , high] = agentTierRows({ toolType: 'claude-code', tierTargets: { low: LOCAL } });

		expect(tierRowRecord(low, [OLLAMA])).toEqual({
			tier: 'low',
			target: LOCAL,
			spec: 'ep-ollama:qwen3:latest',
			label: 'qwen3:latest on Ollama',
			source: 'agent',
			builtIn: 'haiku',
		});
		expect(tierRowRecord(high)).toMatchObject({ spec: 'provider:opus', label: 'opus' });
	});

	it('carries the refusal and the note', () => {
		const [low] = agentTierRows({ toolType: 'claude-code', runOn: LOCAL });
		const record = tierRowRecord(low);

		expect(record).toMatchObject({ target: null, spec: null, label: null, source: null });
		expect(record.note).toMatch(/Local Models source/);
		expect('problem' in record).toBe(false);
	});
});

describe('parseTierTargetsEdit', () => {
	it('reads a whole record and stores each target in its one form', () => {
		const edit = parseTierTargetsEdit('claude-code', {
			low: { ...LOCAL, stray: true },
			high: { type: 'provider' },
		});

		expect(edit).toEqual({
			ok: true,
			tierTargets: { low: LOCAL, high: { type: 'provider-model' } },
		});
	});

	it('stores the absence of the field when no tier is set', () => {
		expect(parseTierTargetsEdit('claude-code', {})).toEqual({ ok: true, tierTargets: undefined });
		expect(parseTierTargetsEdit('claude-code', null)).toEqual({ ok: true, tierTargets: undefined });
		expect(parseTierTargetsEdit('claude-code', undefined)).toEqual({
			ok: true,
			tierTargets: undefined,
		});
	});

	it('merges a patch onto the base: a named tier is replaced, a null tier cleared', () => {
		const edit = parseTierTargetsEdit(
			'claude-code',
			{ low: null, high: OPUS },
			{ base: { low: LOCAL, medium: OPUS } }
		);

		expect(edit).toEqual({ ok: true, tierTargets: { medium: OPUS, high: OPUS } });
	});

	it('clears every tier for null, whatever the base holds', () => {
		expect(parseTierTargetsEdit('claude-code', null, { base: { low: LOCAL } })).toEqual({
			ok: true,
			tierTargets: undefined,
		});
	});

	it('answers undefined when a patch clears the last tier', () => {
		expect(parseTierTargetsEdit('claude-code', { low: null }, { base: { low: LOCAL } })).toEqual({
			ok: true,
			tierTargets: undefined,
		});
	});

	it('refuses a source on a harness with no Run on recipe, naming the tier', () => {
		const edit = parseTierTargetsEdit('factory-droid', { medium: LOCAL });

		expect(edit.ok).toBe(false);
		if (!edit.ok) expect(edit.error).toMatch(/^medium: /);
	});

	it('refuses a source id that names nothing when the saved sources are passed', () => {
		const typed = { low: { type: 'source', endpointId: 'ep-gone', model: 'm' } };

		expect(parseTierTargetsEdit('claude-code', typed).ok).toBe(true);
		const edit = parseTierTargetsEdit('claude-code', typed, { endpoints: [OLLAMA] });
		expect(edit.ok).toBe(false);
		if (!edit.ok) expect(edit.error).toMatch(/^low: No source has the id "ep-gone"/);
	});

	it('reports the first refused tier in tier order, not key order', () => {
		const edit = parseTierTargetsEdit('claude-code', { high: 'nope', low: 'nope' });

		expect(edit.ok).toBe(false);
		if (!edit.ok) expect(edit.error).toMatch(/^low: /);
	});

	it('refuses a key that is not a tier, and a value that is not a record', () => {
		const unknown = parseTierTargetsEdit('claude-code', { turbo: OPUS });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error).toMatch(/"turbo" is not a tier/);

		expect(parseTierTargetsEdit('claude-code', 'low=opus').ok).toBe(false);
		expect(parseTierTargetsEdit('claude-code', [OPUS]).ok).toBe(false);
	});

	it('keeps a base tier the patch does not name as it is stored', () => {
		// A stored target a launch refuses must not vanish because another tier
		// was edited: dropping it would send that tier to the next layer.
		const broken = { type: 'source' } as unknown as TierTarget;
		const edit = parseTierTargetsEdit('claude-code', { high: OPUS }, { base: { low: broken } });

		expect(edit).toEqual({ ok: true, tierTargets: { low: broken, high: OPUS } });
	});
});

describe('parseTierAssignment', () => {
	it.each([
		['low=ep-ollama:qwen3:latest', 'low', LOCAL],
		['high=provider:opus', 'high', OPUS],
		['medium=provider', 'medium', { type: 'provider-model' }],
		['LOW = default', 'low', undefined],
	])('reads %j', (entry, tier, target) => {
		expect(parseTierAssignment(entry)).toEqual({ ok: true, tier, target });
	});

	it('splits at the first "=", so a model name may hold one', () => {
		expect(parseTierAssignment('low=provider:a=b')).toEqual({
			ok: true,
			tier: 'low',
			target: { type: 'provider-model', model: 'a=b' },
		});
	});

	it.each(['low', '=opus', 'turbo=provider:opus', ''])('refuses %j by its form', (entry) => {
		const result = parseTierAssignment(entry);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/<low\|medium\|high>=<target>/);
	});

	it('names the tier when the target is not one', () => {
		const result = parseTierAssignment('low=opus');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/^low: A tier target is/);
	});
});

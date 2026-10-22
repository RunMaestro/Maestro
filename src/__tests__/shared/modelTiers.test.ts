/**
 * The tier/effort vocabulary is a contract between Auto Run documents and every
 * provider. A playbook written against `tier="high"` must keep meaning the same
 * thing, so these tests pin the mapping rather than merely exercising it.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { noteEffortRejection, resetEffortRejections } from '../../shared/effortRejection';
import {
	TIER_LEVELS,
	asTierLevel,
	cheapResumeTurnSettings,
	cheapTurnSettings,
	isLadderEffortValue,
	rejectedEffortForLevel,
	resolveEffortLevel,
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
} from '../../shared/modelTiers';

describe('tier vocabulary', () => {
	it('is exactly low, medium, high', () => {
		expect(TIER_LEVELS).toEqual(['low', 'medium', 'high']);
	});

	it('narrows only real levels', () => {
		expect(asTierLevel('high')).toBe('high');
		expect(asTierLevel('max')).toBeUndefined();
		expect(asTierLevel('')).toBeUndefined();
		expect(asTierLevel(undefined)).toBeUndefined();
		expect(asTierLevel(2)).toBeUndefined();
	});
});

describe('effort ladders', () => {
	it('maps Maestro levels to ladder POSITIONS, not to same-named strings', () => {
		// Claude's ladder is low, medium, high, xhigh, max. "high" means the
		// ceiling of that ladder, so it resolves to `max`, and "medium" means the
		// middle rung, which is Claude's `high`. Identity mapping here would mean
		// a document asking for the most effort silently got the middle.
		expect(resolveEffortLevel('claude-code', 'low')).toBe('low');
		expect(resolveEffortLevel('claude-code', 'medium')).toBe('high');
		expect(resolveEffortLevel('claude-code', 'high')).toBe('max');
	});

	it("uses codex's real floor, which is low: no current model accepts minimal", () => {
		// `minimal` used to sit below `low`. Every model in Codex's catalogue
		// now rejects it with a 400 ("'minimal' is not supported with the
		// 'gpt-6-astra' model"), which killed every cheap turn with no output.
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
		expect(resolveEffortLevel('codex', 'medium')).toBe('medium');
		expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
	});

	it('is the identity only where the provider ladder is exactly three rungs', () => {
		expect(resolveEffortLevel('factory-droid', 'low')).toBe('low');
		expect(resolveEffortLevel('factory-droid', 'medium')).toBe('medium');
		expect(resolveEffortLevel('factory-droid', 'high')).toBe('high');
	});

	it('reports no effort for a provider that has no effort knob', () => {
		// OpenCode exposes no effort/reasoning option at all, so an effort hint has
		// nothing to write. Undefined (inherit + warn), never a guessed value.
		expect(resolveEffortLevel('opencode', 'high')).toBeUndefined();
		expect(supportsEffortSelection('opencode')).toBe(false);
		expect(supportsEffortSelection('claude-code')).toBe(true);
	});
});

describe('model tiers', () => {
	it('uses Claude permanent aliases so a playbook does not rot', () => {
		expect(resolveTierModel('claude-code', 'low')).toBe('haiku');
		expect(resolveTierModel('claude-code', 'medium')).toBe('sonnet');
		expect(resolveTierModel('claude-code', 'high')).toBe('opus');
	});

	it('leaves discovery-driven providers unmapped rather than guessing', () => {
		// Codex/Copilot IDs churn per release and OpenCode runs whatever the user
		// configured. A shipped guess would rot into naming a model they cannot
		// run, so these resolve to the agent default and the caller warns.
		expect(resolveTierModel('codex', 'high')).toBeUndefined();
		expect(resolveTierModel('copilot-cli', 'high')).toBeUndefined();
		expect(resolveTierModel('opencode', 'high')).toBeUndefined();
		expect(supportsTierSelection('opencode')).toBe(false);
		expect(supportsTierSelection('claude-code')).toBe(true);
	});
});

describe('cheap synopsis turn', () => {
	it('pins to the bottom of both ladders', () => {
		expect(cheapTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
		expect(cheapTurnSettings('codex')).toEqual({ model: undefined, effort: 'low' });
	});

	it('yields all-undefined for a provider with neither axis mapped', () => {
		// Callers fall back to the agent's own config, so a synopsis still runs.
		expect(cheapTurnSettings('opencode')).toEqual({ model: undefined, effort: undefined });
	});
});

describe('cheap synopsis turn resumed on its session', () => {
	it('drops to the bottom of both ladders when the window does not shrink', () => {
		expect(cheapResumeTurnSettings('claude-code', { model: 'opus', effort: 'max' })).toEqual({
			model: 'haiku',
			effort: 'low',
		});
	});

	it('keeps the session model when the cheap one has a smaller context window', () => {
		// Resuming replays the transcript: what fit a 1M window cannot fit 200k.
		// Effort still drops, since that costs nothing to read.
		expect(cheapResumeTurnSettings('claude-code', { model: 'opus[1m]', effort: 'max' })).toEqual({
			model: 'opus[1m]',
			effort: 'low',
		});
	});

	it('inherits the session values on a provider with no cheap tier', () => {
		expect(cheapResumeTurnSettings('codex', { model: 'gpt-5-codex', effort: 'high' })).toEqual({
			model: 'gpt-5-codex',
			effort: 'low',
		});
		expect(cheapResumeTurnSettings('opencode', { model: 'm', effort: 'e' })).toEqual({
			model: 'm',
			effort: 'e',
		});
	});

	it('works with nothing configured on the session', () => {
		expect(cheapResumeTurnSettings('claude-code')).toEqual({ model: 'haiku', effort: 'low' });
		expect(cheapResumeTurnSettings('opencode')).toEqual({ model: undefined, effort: undefined });
	});
});

describe('a ladder value the provider has refused', () => {
	// The ladders are a snapshot of each provider's catalogue. Codex retired
	// `minimal` and answered it with a 400, which killed every cheap turn with
	// no output. A refusal noted in this process takes the value out of
	// circulation instead of letting the next turn fail the same way.
	const refusal = { value: 'low', model: 'gpt-6-astra', supported: ['medium', 'high'] };

	afterEach(() => {
		resetEffortRejections();
	});

	it('resolves to undefined, meaning inherit the agent own effort', () => {
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
		noteEffortRejection('codex', refusal);
		expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
		expect(cheapTurnSettings('codex')).toEqual({ model: undefined, effort: undefined });
	});

	it('leaves the other levels and the other providers alone', () => {
		noteEffortRejection('codex', refusal);
		expect(resolveEffortLevel('codex', 'medium')).toBe('medium');
		expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
		// Claude maps `low` to the same string, but it is Codex that said no.
		expect(resolveEffortLevel('claude-code', 'low')).toBe('low');
	});

	it('takes out every level that maps to the refused value', () => {
		// Claude's `medium` is `high`; a refusal of `high` must not leave it live.
		noteEffortRejection('claude-code', { value: 'high', supported: [] });
		expect(resolveEffortLevel('claude-code', 'medium')).toBeUndefined();
		expect(resolveEffortLevel('claude-code', 'high')).toBe('max');
	});

	it('still reports the provider as having an effort setting', () => {
		noteEffortRejection('codex', refusal);
		expect(supportsEffortSelection('codex')).toBe(true);
	});

	it('hands the refusal to callers that explain an unmapped level', () => {
		expect(rejectedEffortForLevel('codex', 'low')).toBeUndefined();
		noteEffortRejection('codex', refusal);
		expect(rejectedEffortForLevel('codex', 'low')).toEqual(refusal);
		expect(rejectedEffortForLevel('codex', 'medium')).toBeUndefined();
		expect(rejectedEffortForLevel('opencode', 'low')).toBeUndefined();
	});

	it('ignores a refusal of a value no ladder hands out', () => {
		// `ultra` is something a user picked on a tab, not a ladder rung.
		noteEffortRejection('codex', { value: 'ultra', supported: [] });
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
		expect(resolveEffortLevel('codex', 'high')).toBe('xhigh');
	});
});

describe('isLadderEffortValue', () => {
	it('is true only for a value a ladder hands out for that provider', () => {
		expect(isLadderEffortValue('codex', 'low')).toBe(true);
		expect(isLadderEffortValue('codex', 'xhigh')).toBe(true);
		// Offered in the Codex dropdown, never chosen by Maestro.
		expect(isLadderEffortValue('codex', 'ultra')).toBe(false);
		expect(isLadderEffortValue('codex', 'minimal')).toBe(false);
		expect(isLadderEffortValue('claude-code', 'max')).toBe(true);
	});

	it('is false for a provider with no ladder, or one it has never heard of', () => {
		expect(isLadderEffortValue('opencode', 'low')).toBe(false);
		expect(isLadderEffortValue('not-a-provider', 'low')).toBe(false);
	});
});

/**
 * Tests for agentVisibility - the one rule for whether a stored agent is live
 * or dormant (a Pianola whose Encore flag is off).
 */

import { describe, it, expect } from 'vitest';
import { filterLiveAgents, isAgentDormant, isPianolaEnabled } from '../../shared/agentVisibility';

describe('isPianolaEnabled', () => {
	it('reads the flag through the shipped defaults (off)', () => {
		expect(isPianolaEnabled(undefined)).toBe(false);
		expect(isPianolaEnabled({})).toBe(false);
		expect(isPianolaEnabled({ pianola: 'yes' })).toBe(false);
		expect(isPianolaEnabled({ pianola: true })).toBe(true);
	});
});

describe('isAgentDormant', () => {
	it('is never true for an ordinary agent', () => {
		expect(isAgentDormant({ id: 'a' }, { pianola: false })).toBe(false);
		expect(isAgentDormant(null, undefined)).toBe(false);
		expect(isAgentDormant(undefined, undefined)).toBe(false);
	});

	it('is true for the Pianola agent while its flag is off', () => {
		expect(isAgentDormant({ isPianola: true }, { pianola: false })).toBe(true);
		expect(isAgentDormant({ isPianola: true }, undefined)).toBe(true);
	});

	it('is false for the Pianola agent once its flag is on', () => {
		expect(isAgentDormant({ isPianola: true }, { pianola: true })).toBe(false);
	});
});

describe('filterLiveAgents', () => {
	const alpha = { id: 'a' };
	const pianola = { id: 'p', isPianola: true };

	it('drops the dormant Pianola agent', () => {
		expect(filterLiveAgents([alpha, pianola], { pianola: false })).toEqual([alpha]);
	});

	it('returns the same array identity when nothing is dormant', () => {
		const withPianola = [alpha, pianola];
		expect(filterLiveAgents(withPianola, { pianola: true })).toBe(withPianola);
		const ordinary = [alpha];
		expect(filterLiveAgents(ordinary, { pianola: false })).toBe(ordinary);
	});

	it('tolerates damaged entries a sessions file can hold', () => {
		const damaged = [null, alpha, pianola, 42] as unknown[];
		expect(filterLiveAgents(damaged, undefined)).toEqual([null, alpha, 42]);
	});
});

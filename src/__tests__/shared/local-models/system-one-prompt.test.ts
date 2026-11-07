/**
 * @file system-one-prompt.test.ts
 * @description What an agent's system prompt says about System One: the one
 * rule for whether the section is there, and the words its variables render.
 */

import { describe, expect, it } from 'vitest';
import {
	EMPTY_SYSTEM_ONE_PROMPT_VARIABLES,
	SYSTEM_ONE_CALIBRATED_NOTE,
	SYSTEM_ONE_FREE_ENGINE_NOTE,
	SYSTEM_ONE_UNCALIBRATED_NOTE,
	isSystemOneAdvertised,
	systemOnePromptVariables,
} from '../../../shared/local-models/system-one-prompt';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../../helpers/systemOneAccess';

const budget = (spent: number, daily = 1) => ({
	dayStartedAt: 0,
	dailyBudgetUsd: daily,
	spentTodayUsd: spent,
	remainingTodayUsd: Math.max(0, daily - spent),
});

describe('isSystemOneAdvertised', () => {
	it('is true for a local agent whose request would be answered', () => {
		expect(isSystemOneAdvertised(systemOneAccess(), { isSsh: false })).toBe(true);
	});

	it('is false behind every switch that refuses the agent', () => {
		for (const gate of SYSTEM_ONE_GATES) {
			expect(isSystemOneAdvertised(refusedSystemOneAccess(gate), { isSsh: false }), gate).toBe(
				false
			);
		}
	});

	it('is false for an SSH remote agent, whatever the access says', () => {
		expect(isSystemOneAdvertised(systemOneAccess(), { isSsh: true })).toBe(false);
	});

	it('reads no answer as not allowed', () => {
		expect(isSystemOneAdvertised(undefined, { isSsh: false })).toBe(false);
		expect(isSystemOneAdvertised(null, { isSsh: false })).toBe(false);
	});

	it('does not trust an answer that says allowed with no engine', () => {
		const access = systemOneAccess({ engine: 'off', engineLabel: 'Off', calibrated: null });
		expect(isSystemOneAdvertised(access, { isSsh: false })).toBe(false);
	});

	it('needs allowed to be exactly true', () => {
		const access = { ...systemOneAccess(), allowed: 'yes' } as never;
		expect(isSystemOneAdvertised(access, { isSsh: false })).toBe(false);
	});
});

describe('systemOnePromptVariables', () => {
	it('names the engine and says a calibrated engine is calibrated', () => {
		const vars = systemOnePromptVariables(systemOneAccess());
		expect(vars.engine).toBe('Jev (TypeSafe cloud)');
		expect(vars.calibrated).toBe(SYSTEM_ONE_CALIBRATED_NOTE);
		expect(vars.calibrated).toMatch(/^calibrated/);
	});

	it('never lets a local judge read as calibrated', () => {
		const vars = systemOnePromptVariables(
			systemOneAccess({
				engine: 'local-judge',
				engineLabel: 'Local judge (qwen), not calibrated',
				calibrated: false,
			})
		);
		expect(vars.engine).toContain('not calibrated');
		expect(vars.calibrated).toBe(SYSTEM_ONE_UNCALIBRATED_NOTE);
		expect(vars.calibrated).toMatch(/^NOT calibrated/);
		expect(vars.calibrated).toMatch(/never gate a destructive action/);
	});

	it('says the daily budget and a band, never an exact remainder', () => {
		const full = systemOnePromptVariables(systemOneAccess({ budget: budget(0) })).budget;
		expect(full).toBe('$1.00 a day across all agents; more than half is left today');

		// Two spends inside one band render the same text, so the system prompt
		// (and the provider's cache of it) does not change after every request.
		const a = systemOnePromptVariables(systemOneAccess({ budget: budget(0.01) })).budget;
		const b = systemOnePromptVariables(systemOneAccess({ budget: budget(0.37) })).budget;
		expect(a).toBe(full);
		expect(b).toBe(full);
	});

	it('moves through three bands as the budget is spent', () => {
		const band = (spent: number) =>
			systemOnePromptVariables(systemOneAccess({ budget: budget(spent) })).budget;
		expect(band(0.5)).toContain('less than half is left');
		expect(band(0.89)).toContain('less than half is left');
		expect(band(0.9)).toContain('less than a tenth is left');
		expect(band(0.999)).toContain('less than a tenth is left');
	});

	it("names an agent's own cap, and takes the band of the tighter budget", () => {
		const vars = systemOnePromptVariables(
			systemOneAccess({
				budget: {
					...budget(0.1),
					agent: {
						agentId: 'a1',
						budgetUsd: 0.25,
						spentTodayUsd: 0.24,
						remainingTodayUsd: 0.01,
					},
				},
			})
		);
		expect(vars.budget).toBe(
			'$1.00 a day across all agents, $0.25 a day for this agent; less than a tenth is left today'
		);
	});

	it('leaves an agent with no cap of its own out of the sentence', () => {
		const vars = systemOnePromptVariables(
			systemOneAccess({
				budget: {
					...budget(0),
					agent: { agentId: 'a1', budgetUsd: null, spentTodayUsd: 0, remainingTodayUsd: null },
				},
			})
		);
		expect(vars.budget).toBe('$1.00 a day across all agents; more than half is left today');
	});

	it('says an engine with no price costs nothing, in place of a dollar budget', () => {
		for (const engine of ['openjev', 'local-judge'] as const) {
			const vars = systemOnePromptVariables(
				systemOneAccess({ engine, calibrated: engine === 'openjev' })
			);
			expect(vars.budget, engine).toBe(SYSTEM_ONE_FREE_ENGINE_NOTE);
		}
	});

	it('renders nothing while System One is off or there is no answer', () => {
		expect(systemOnePromptVariables(undefined)).toBe(EMPTY_SYSTEM_ONE_PROMPT_VARIABLES);
		expect(systemOnePromptVariables(null)).toBe(EMPTY_SYSTEM_ONE_PROMPT_VARIABLES);
		expect(systemOnePromptVariables(refusedSystemOneAccess('engine-off'))).toEqual({
			engine: '',
			calibrated: '',
			budget: '',
		});
	});
});

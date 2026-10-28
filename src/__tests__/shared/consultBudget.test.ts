/**
 * Consultation budget - the setting's contract (key, default, range).
 *
 * Three processes read the stored value (the renderer, main, and the CLI), and
 * the CLI can write any JSON under the key, so the normalizer is the only thing
 * standing between a hand-written value and the enforcement code.
 */

import { describe, it, expect } from 'vitest';

import {
	CONSULT_BUDGET_EXHAUSTED_CODE,
	CONSULT_BUDGET_UNAVAILABLE_CODE,
	CONSULT_CHAIN_ENV_VAR,
	CONSULT_DEPTH_ENV_VAR,
	DEFAULT_MAX_CONSULTATIONS_PER_TURN,
	MAX_CONSULTATIONS_PER_TURN_CEILING,
	MAX_CONSULTATIONS_PER_TURN_SETTING,
	buildConsultChainEnv,
	childConsultChain,
	describeConsultBudgetRefusal,
	isConsultChainId,
	normalizeMaxConsultationsPerTurn,
	parseConsultChain,
	remainingConsultBudget,
	readConsultChainEnv,
	withoutConsultChainEnv,
} from '../../shared/consultBudget';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

describe('consultBudget', () => {
	it('defaults to 25', () => {
		expect(DEFAULT_MAX_CONSULTATIONS_PER_TURN).toBe(25);
	});

	it('names a key the settings registry knows, with the same default', () => {
		const meta = SETTINGS_METADATA[MAX_CONSULTATIONS_PER_TURN_SETTING];
		expect(meta).toBeDefined();
		expect(meta.type).toBe('number');
		expect(meta.default).toBe(DEFAULT_MAX_CONSULTATIONS_PER_TURN);
		expect(meta.description).toContain(`0-${MAX_CONSULTATIONS_PER_TURN_CEILING}`);
	});

	describe('normalizeMaxConsultationsPerTurn', () => {
		it('keeps 0, which turns peer consults off rather than meaning unset', () => {
			expect(normalizeMaxConsultationsPerTurn(0)).toBe(0);
		});

		it('keeps a whole number in range', () => {
			expect(normalizeMaxConsultationsPerTurn(1)).toBe(1);
			expect(normalizeMaxConsultationsPerTurn(25)).toBe(25);
			expect(normalizeMaxConsultationsPerTurn(MAX_CONSULTATIONS_PER_TURN_CEILING)).toBe(
				MAX_CONSULTATIONS_PER_TURN_CEILING
			);
		});

		it('rounds a fraction down, so a budget is never more than was typed', () => {
			expect(normalizeMaxConsultationsPerTurn(3.9)).toBe(3);
			expect(normalizeMaxConsultationsPerTurn(0.5)).toBe(0);
		});

		it('clamps below 0 and above the ceiling', () => {
			expect(normalizeMaxConsultationsPerTurn(-1)).toBe(0);
			expect(normalizeMaxConsultationsPerTurn(MAX_CONSULTATIONS_PER_TURN_CEILING + 1)).toBe(
				MAX_CONSULTATIONS_PER_TURN_CEILING
			);
		});

		it.each([undefined, null, '25', '', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY])(
			'reads %j as the default',
			(raw) => {
				expect(normalizeMaxConsultationsPerTurn(raw)).toBe(DEFAULT_MAX_CONSULTATIONS_PER_TURN);
			}
		);
	});

	describe('isConsultChainId', () => {
		it('accepts a UUID and other plain ids', () => {
			expect(isConsultChainId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
			expect(isConsultChainId('chain_1')).toBe(true);
			expect(isConsultChainId('a')).toBe(true);
			expect(isConsultChainId('a'.repeat(64))).toBe(true);
		});

		it.each([
			'',
			' ',
			'a b',
			'-leading-dash',
			'__proto__',
			'../escape',
			'a/b',
			'a.b',
			'a'.repeat(65),
			undefined,
			null,
			42,
			{},
		])('refuses %j', (value) => {
			expect(isConsultChainId(value)).toBe(false);
		});
	});

	describe('the chain in the environment', () => {
		it('round-trips the chain id and depth', () => {
			const env = buildConsultChainEnv({ chainId: 'chain-1', depth: 2 });
			expect(env).toEqual({ [CONSULT_CHAIN_ENV_VAR]: 'chain-1', [CONSULT_DEPTH_ENV_VAR]: '2' });
			expect(readConsultChainEnv(env)).toEqual({ chainId: 'chain-1', depth: 2 });
		});

		it('uses the variable names the CLI and the docs name', () => {
			expect(CONSULT_CHAIN_ENV_VAR).toBe('MAESTRO_CONSULT_CHAIN');
			expect(CONSULT_DEPTH_ENV_VAR).toBe('MAESTRO_CONSULT_DEPTH');
		});

		it('reads no chain from an environment that has none, or a blank one', () => {
			expect(readConsultChainEnv({})).toBeUndefined();
			expect(readConsultChainEnv({ [CONSULT_CHAIN_ENV_VAR]: '  ' })).toBeUndefined();
			expect(readConsultChainEnv({ [CONSULT_DEPTH_ENV_VAR]: '3' })).toBeUndefined();
		});

		it('reads no chain from an id the counter would refuse', () => {
			expect(
				readConsultChainEnv({ [CONSULT_CHAIN_ENV_VAR]: '../escape', [CONSULT_DEPTH_ENV_VAR]: '1' })
			).toBeUndefined();
		});

		it.each([undefined, '', 'deep', '-1', '1.5', '1e2', ' '])(
			'keeps the chain and reads depth %j as 0, so a damaged depth never resets the budget',
			(depth) => {
				expect(
					readConsultChainEnv({
						[CONSULT_CHAIN_ENV_VAR]: 'chain-1',
						[CONSULT_DEPTH_ENV_VAR]: depth,
					})
				).toEqual({ chainId: 'chain-1', depth: 0 });
			}
		);
	});

	describe('parseConsultChain', () => {
		it('narrows a chain that arrived as data', () => {
			expect(parseConsultChain({ chainId: 'chain-1', depth: 3, extra: true })).toEqual({
				chainId: 'chain-1',
				depth: 3,
			});
			expect(parseConsultChain({ chainId: 'chain-1', depth: '4' })).toEqual({
				chainId: 'chain-1',
				depth: 4,
			});
		});

		it.each([undefined, null, 'chain-1', 7, [], {}, { depth: 1 }, { chainId: 'a b', depth: 1 }])(
			'reads %j as no chain',
			(value) => {
				expect(parseConsultChain(value)).toBeUndefined();
			}
		);

		it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}])(
			'reads depth %j as 0',
			(depth) => {
				expect(parseConsultChain({ chainId: 'chain-1', depth })).toEqual({
					chainId: 'chain-1',
					depth: 0,
				});
			}
		);
	});

	describe('childConsultChain', () => {
		it('keeps the chain and goes one hop deeper', () => {
			const root = { chainId: 'chain-1', depth: 0 };
			expect(childConsultChain(root)).toEqual({ chainId: 'chain-1', depth: 1 });
			expect(childConsultChain(childConsultChain(root))).toEqual({ chainId: 'chain-1', depth: 2 });
			expect(root).toEqual({ chainId: 'chain-1', depth: 0 });
		});
	});

	describe('withoutConsultChainEnv', () => {
		it('collapses a chain-only record to undefined, like an agent with no overrides', () => {
			expect(
				withoutConsultChainEnv(buildConsultChainEnv({ chainId: 'chain-1', depth: 0 }))
			).toBeUndefined();
			expect(withoutConsultChainEnv(undefined)).toBeUndefined();
		});

		it('keeps real configuration and leaves the input untouched', () => {
			const env = {
				...buildConsultChainEnv({ chainId: 'chain-1', depth: 0 }),
				CLAUDE_CONFIG_DIR: '/cfg',
			};
			expect(withoutConsultChainEnv(env)).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
			expect(env).toHaveProperty(CONSULT_CHAIN_ENV_VAR);
		});
	});

	describe('remainingConsultBudget', () => {
		it('is the budget less what the chain has spent', () => {
			expect(remainingConsultBudget({ limit: 25, spent: 0 })).toBe(25);
			expect(remainingConsultBudget({ limit: 25, spent: 3 })).toBe(22);
			expect(remainingConsultBudget({ limit: 25, spent: 25 })).toBe(0);
		});

		it('never goes below zero when the setting was lowered under a running chain', () => {
			expect(remainingConsultBudget({ limit: 4, spent: 9 })).toBe(0);
			expect(remainingConsultBudget({ limit: 0, spent: 0 })).toBe(0);
		});

		it('is undefined, not NaN, when either figure is not a count', () => {
			expect(remainingConsultBudget({ limit: Number.NaN, spent: 0 })).toBeUndefined();
			expect(remainingConsultBudget({ limit: 25, spent: Number.NaN })).toBeUndefined();
			expect(remainingConsultBudget({ limit: -1, spent: 0 })).toBeUndefined();
			expect(remainingConsultBudget({ limit: 25, spent: -1 })).toBeUndefined();
			expect(remainingConsultBudget({ limit: 25, spent: 1.5 })).toBeUndefined();
			expect(remainingConsultBudget({ limit: Infinity, spent: 0 })).toBeUndefined();
		});
	});

	// One wording for every verb. The reader is an agent, and what it must learn
	// is that the peer was never reached.
	describe('describeConsultBudgetRefusal', () => {
		it('names the budget, what the chain has spent, and the setting', () => {
			const refusal = describeConsultBudgetRefusal({ spent: 25, limit: 25 });

			expect(refusal.code).toBe(CONSULT_BUDGET_EXHAUSTED_CODE);
			expect(refusal.message).toContain('Consultation budget exhausted');
			expect(refusal.message).toContain('25 of 25');
			expect(refusal.message).toContain(MAX_CONSULTATIONS_PER_TURN_SETTING);
			expect(refusal.message).toContain('nothing was sent');
		});

		it('reports the true total when the setting was lowered under a running chain', () => {
			expect(describeConsultBudgetRefusal({ spent: 9, limit: 4 }).message).toContain('9 of 4');
		});

		it('says peer dispatch is off at a budget of 0, rather than "0 of 0"', () => {
			const refusal = describeConsultBudgetRefusal({ spent: 0, limit: 0 });

			expect(refusal.code).toBe(CONSULT_BUDGET_EXHAUSTED_CODE);
			expect(refusal.message).toContain('switched off');
			expect(refusal.message).toContain(MAX_CONSULTATIONS_PER_TURN_SETTING);
			expect(refusal.message).not.toContain('0 of 0');
		});

		it('shows a broken counter as it reported itself, and prints no count', () => {
			const problem = 'The consult budget counter at /data/consult-budget.json could not be used.';
			const refusal = describeConsultBudgetRefusal({ spent: 0, limit: 25, problem });

			expect(refusal.code).toBe(CONSULT_BUDGET_UNAVAILABLE_CODE);
			expect(refusal.message).toContain(problem);
			expect(refusal.message).toContain('nothing was sent');
			expect(refusal.message).not.toContain('0 of 25');
		});

		it('never uses a dash that reads as machine-written', () => {
			for (const spend of [
				{ spent: 25, limit: 25 },
				{ spent: 0, limit: 0 },
				{ spent: 0, limit: 25, problem: 'broken' },
			]) {
				expect(describeConsultBudgetRefusal(spend).message).not.toMatch(/[\u2013\u2014]/);
			}
		});
	});
});

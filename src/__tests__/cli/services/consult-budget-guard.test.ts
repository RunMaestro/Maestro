/**
 * @file consult-budget-guard.test.ts
 * @description What a `maestro-cli` verb supplies to the consult budget: the
 * chain its shell inherited, whether an agent's shell ran it, and the setting.
 * The rule itself is covered in `main/peer-consults/consult-budget.test.ts`.
 *
 * Runs against a real temp directory. Every call passes `dataDir`:
 * `MAESTRO_USER_DATA` is set in an agent's shell, so the default directory is
 * the LIVE one. The environment is passed in too, never read from this process,
 * which is itself an agent's shell with a chain of its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
}));

import { admitCliConsult } from '../../../cli/services/consult-budget-guard';
import { readSettingValue } from '../../../cli/services/storage';
import {
	CONSULT_BUDGET_FILE,
	readConsultBudgetSpent,
} from '../../../main/peer-consults/consult-budget';
import { buildCallerIdentityEnv } from '../../../shared/agentDelegation';
import {
	CONSULT_BUDGET_EXHAUSTED_CODE,
	CONSULT_BUDGET_UNAVAILABLE_CODE,
	DEFAULT_MAX_CONSULTATIONS_PER_TURN,
	MAX_CONSULTATIONS_PER_TURN_SETTING,
	buildConsultChainEnv,
} from '../../../shared/consultBudget';

let dataDir: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-budget-guard-'));
	vi.mocked(readSettingValue).mockReset();
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

/** An agent's shell: its identity, and its place in a chain when it has one. */
function agentShell(chain?: { chainId: string; depth: number }): Record<string, string> {
	return {
		...buildCallerIdentityEnv('agent-a', 'tab-1'),
		...(chain ? buildConsultChainEnv(chain) : {}),
	};
}

describe('admitCliConsult', () => {
	it('spends from the chain in the environment and hands the target the next hop', () => {
		vi.mocked(readSettingValue).mockReturnValue(5);

		const admission = admitCliConsult(agentShell({ chainId: 'chain-a', depth: 1 }), { dataDir });

		expect(admission).toEqual({ allowed: true, chain: { chainId: 'chain-a', depth: 2 } });
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
	});

	it('reads the budget from the setting, by its key', () => {
		vi.mocked(readSettingValue).mockReturnValue(1);
		const env = agentShell({ chainId: 'chain-a', depth: 0 });

		expect(admitCliConsult(env, { dataDir }).allowed).toBe(true);
		const refused = admitCliConsult(env, { dataDir });

		expect(readSettingValue).toHaveBeenCalledWith(MAX_CONSULTATIONS_PER_TURN_SETTING);
		expect(refused).toMatchObject({ allowed: false, code: CONSULT_BUDGET_EXHAUSTED_CODE });
		if (refused.allowed) throw new Error('expected a refusal');
		expect(refused.message).toContain('1 of 1');
	});

	it('uses the default budget when the setting was never written', () => {
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		const env = agentShell({ chainId: 'chain-a', depth: 0 });

		for (let spent = 0; spent < DEFAULT_MAX_CONSULTATIONS_PER_TURN; spent += 1) {
			expect(admitCliConsult(env, { dataDir }).allowed).toBe(true);
		}
		expect(admitCliConsult(env, { dataDir }).allowed).toBe(false);
	});

	// `maestro-cli settings set` stores any JSON, so a string must not read as 0
	// (everything refused) or as unlimited.
	it('uses the default budget when the stored value is not a number', () => {
		vi.mocked(readSettingValue).mockReturnValue('lots');

		expect(admitCliConsult(agentShell({ chainId: 'chain-a', depth: 0 }), { dataDir }).allowed).toBe(
			true
		);
	});

	it('refuses an agent at a stored budget of 0, which is off, not unset', () => {
		vi.mocked(readSettingValue).mockReturnValue(0);

		const admission = admitCliConsult(agentShell({ chainId: 'chain-a', depth: 0 }), { dataDir });

		expect(admission).toMatchObject({ allowed: false, code: CONSULT_BUDGET_EXHAUSTED_CODE });
		if (admission.allowed) throw new Error('expected a refusal');
		expect(admission.message).toContain('switched off');
	});

	it('roots a new chain for an agent whose shell carries none, and spends the first of it', () => {
		vi.mocked(readSettingValue).mockReturnValue(5);

		const admission = admitCliConsult(agentShell(), { dataDir });

		if (!admission.allowed) throw new Error('expected the consult to be admitted');
		expect(admission.chain.depth).toBe(1);
		expect(readConsultBudgetSpent(admission.chain.chainId, { dataDir })).toBe(1);
	});

	it("lets the user's own shell through without spending, even at a budget of 0", () => {
		vi.mocked(readSettingValue).mockReturnValue(0);

		const admission = admitCliConsult({}, { dataDir });

		if (!admission.allowed) throw new Error('expected the send to be admitted');
		expect(admission.chain.depth).toBe(0);
		expect(fs.existsSync(path.join(dataDir, CONSULT_BUDGET_FILE))).toBe(false);
	});

	it('treats a chain id the counter would refuse as no chain at all', () => {
		vi.mocked(readSettingValue).mockReturnValue(5);

		const admission = admitCliConsult({ MAESTRO_CONSULT_CHAIN: '../escape' }, { dataDir });

		if (!admission.allowed) throw new Error('expected the send to be admitted');
		expect(admission.chain.chainId).not.toBe('../escape');
		expect(admission.chain.depth).toBe(0);
	});

	it("refuses with the counter's own report when the counter is damaged", () => {
		vi.mocked(readSettingValue).mockReturnValue(5);
		const filePath = path.join(dataDir, CONSULT_BUDGET_FILE);
		fs.writeFileSync(filePath, 'not json', 'utf-8');

		const admission = admitCliConsult(agentShell({ chainId: 'chain-a', depth: 0 }), { dataDir });

		expect(admission).toMatchObject({ allowed: false, code: CONSULT_BUDGET_UNAVAILABLE_CODE });
		if (admission.allowed) throw new Error('expected a refusal');
		expect(admission.message).toContain(filePath);
	});
});

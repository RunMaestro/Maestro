/**
 * @file consult-budget.test.ts
 * @description The consult budget counter against a real temp directory and
 * real fs: the count is the whole point, and so is what happens to it when the
 * file under it is missing, expired, locked or damaged.
 *
 * Every call passes `dataDir`. `MAESTRO_USER_DATA` is set in an agent's shell,
 * so the default directory is the LIVE one even though nothing here is Electron.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	CONSULT_BUDGET_EXHAUSTED_CODE,
	CONSULT_BUDGET_UNAVAILABLE_CODE,
	isConsultChainId,
} from '../../../shared/consultBudget';
import {
	CONSULT_BUDGET_FILE,
	CONSULT_CHAIN_TTL_MS,
	admitConsult,
	newConsultChainId,
	readConsultBudgetSpent,
	readConsultBudgetStatus,
	spendConsultBudget,
	sweepExpiredChains,
} from '../../../main/peer-consults/consult-budget';

let dataDir: string;
let filePath: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-budget-'));
	filePath = path.join(dataDir, CONSULT_BUDGET_FILE);
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

function readFile(): Record<string, { count: number; updatedAt: number }> {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
		string,
		{ count: number; updatedAt: number }
	>;
}

describe('newConsultChainId', () => {
	it('mints a distinct, valid chain id each time', () => {
		const a = newConsultChainId();
		const b = newConsultChainId();

		expect(isConsultChainId(a)).toBe(true);
		expect(isConsultChainId(b)).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe('spendConsultBudget', () => {
	it('counts each spend and persists the count', () => {
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 1 });
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 2 });
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 3 });

		expect(readFile()['chain-a'].count).toBe(3);
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(3);
	});

	it('refuses the spend past the limit without counting it', () => {
		spendConsultBudget('chain-a', 2, { dataDir });
		spendConsultBudget('chain-a', 2, { dataDir });

		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: false, spent: 2 });
		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: false, spent: 2 });
		expect(readFile()['chain-a'].count).toBe(2);
	});

	it('lets a raised limit take effect on the next spend', () => {
		spendConsultBudget('chain-a', 1, { dataDir });
		expect(spendConsultBudget('chain-a', 1, { dataDir }).allowed).toBe(false);

		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: true, spent: 2 });
	});

	it('refuses everything at a limit of 0 and records no chain', () => {
		expect(spendConsultBudget('chain-a', 0, { dataDir })).toEqual({ allowed: false, spent: 0 });

		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('refuses when the limit is not a number', () => {
		expect(spendConsultBudget('chain-a', Number.NaN, { dataDir }).allowed).toBe(false);
	});

	it('keeps a separate budget for each chain', () => {
		spendConsultBudget('chain-a', 1, { dataDir });

		expect(spendConsultBudget('chain-a', 1, { dataDir }).allowed).toBe(false);
		expect(spendConsultBudget('chain-b', 1, { dataDir })).toEqual({ allowed: true, spent: 1 });
		expect(readFile()).toMatchObject({ 'chain-a': { count: 1 }, 'chain-b': { count: 1 } });
	});

	it('creates the data directory when it does not exist yet', () => {
		const fresh = path.join(dataDir, 'not', 'yet');

		expect(spendConsultBudget('chain-a', 1, { dataDir: fresh })).toEqual({
			allowed: true,
			spent: 1,
		});
	});

	it('releases its lock and leaves no temp file behind', () => {
		spendConsultBudget('chain-a', 1, { dataDir });

		expect(fs.readdirSync(dataDir)).toEqual([CONSULT_BUDGET_FILE]);
	});

	it('refuses an id that is not a chain id, and says so', () => {
		const result = spendConsultBudget('../escape', 5, { dataDir });

		expect(result.allowed).toBe(false);
		expect(result.problem).toContain('chain id');
		expect(fs.existsSync(filePath)).toBe(false);
	});

	describe('expiry', () => {
		const start = 1_000_000;

		it('sweeps a chain idle past the TTL when another chain spends', () => {
			spendConsultBudget('old-chain', 5, { dataDir, now: start });

			spendConsultBudget('new-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 });

			expect(Object.keys(readFile())).toEqual(['new-chain']);
		});

		it('keeps a chain that is exactly at the TTL', () => {
			spendConsultBudget('old-chain', 5, { dataDir, now: start });

			spendConsultBudget('new-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS });

			expect(Object.keys(readFile()).sort()).toEqual(['new-chain', 'old-chain']);
		});

		it('starts an expired chain over', () => {
			spendConsultBudget('chain-a', 1, { dataDir, now: start });
			const later = start + CONSULT_CHAIN_TTL_MS + 1;

			expect(readConsultBudgetSpent('chain-a', { dataDir, now: later })).toBe(0);
			expect(spendConsultBudget('chain-a', 1, { dataDir, now: later })).toEqual({
				allowed: true,
				spent: 1,
			});
		});

		it('counts a refused spend as activity, so a runaway cannot wait out the TTL', () => {
			spendConsultBudget('chain-a', 1, { dataDir, now: start });
			const almost = start + CONSULT_CHAIN_TTL_MS - 1;
			expect(spendConsultBudget('chain-a', 1, { dataDir, now: almost }).allowed).toBe(false);

			// Past the TTL measured from the first spend, but not from the refusal.
			expect(
				spendConsultBudget('chain-a', 1, { dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 })
			).toEqual({ allowed: false, spent: 1 });
		});
	});

	describe('a counter that cannot be used fails closed', () => {
		it.each([
			['truncated JSON', '{"chain-a": {"count": 1, "upd'],
			['an empty file', ''],
			['a JSON array', '[]'],
			['a JSON null', 'null'],
			['an entry with no count', '{"chain-a": {"updatedAt": 1}}'],
			['a negative count', '{"chain-a": {"count": -1, "updatedAt": 1}}'],
			['a fractional count', '{"chain-a": {"count": 1.5, "updatedAt": 1}}'],
			['a count that is a string', '{"chain-a": {"count": "1", "updatedAt": 1}}'],
			['an entry that is null', '{"chain-a": null}'],
			['a key that is not a chain id', '{"not a chain": {"count": 1, "updatedAt": 1}}'],
		])('refuses on %s and leaves the file as it was', (_name, content) => {
			fs.writeFileSync(filePath, content, 'utf-8');

			const result = spendConsultBudget('chain-b', 25, { dataDir });

			expect(result.allowed).toBe(false);
			expect(result.problem).toContain(filePath);
			// Never rewritten as an empty counter: that would be a free budget.
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
			expect(fs.readdirSync(dataDir)).toEqual([CONSULT_BUDGET_FILE]);
		});

		it('keeps refusing until the file is repaired, then counts again', () => {
			fs.writeFileSync(filePath, 'not json', 'utf-8');
			expect(spendConsultBudget('chain-a', 25, { dataDir }).allowed).toBe(false);
			expect(spendConsultBudget('chain-a', 25, { dataDir }).allowed).toBe(false);

			fs.rmSync(filePath);

			expect(spendConsultBudget('chain-a', 25, { dataDir })).toEqual({ allowed: true, spent: 1 });
		});

		it('refuses when the counter is a directory, not a file', () => {
			fs.mkdirSync(filePath);

			const result = spendConsultBudget('chain-a', 25, { dataDir });

			expect(result.allowed).toBe(false);
			expect(result.problem).toContain(filePath);
		});
	});
});

// The one admission rule every verb shares. Three callers, and the difference
// between them is the point of each case.
describe('admitConsult', () => {
	describe('a caller in a chain', () => {
		const mine = { chainId: 'chain-a', depth: 2 };

		it('spends one from its chain and puts the target one hop further down', () => {
			const admission = admitConsult({ chain: mine, fromAgent: true, limit: 5 }, { dataDir });

			expect(admission).toEqual({ allowed: true, chain: { chainId: 'chain-a', depth: 3 } });
			expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
		});

		it('spends whoever it is: a chain makes the caller a descendant', () => {
			admitConsult({ chain: mine, fromAgent: false, limit: 5 }, { dataDir });

			expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
		});

		it('is refused once the chain is out, with the count and the setting', () => {
			admitConsult({ chain: mine, fromAgent: true, limit: 2 }, { dataDir });
			admitConsult({ chain: mine, fromAgent: true, limit: 2 }, { dataDir });

			const admission = admitConsult({ chain: mine, fromAgent: true, limit: 2 }, { dataDir });

			expect(admission).toMatchObject({ allowed: false, code: CONSULT_BUDGET_EXHAUSTED_CODE });
			if (admission.allowed) throw new Error('expected a refusal');
			expect(admission.message).toContain('2 of 2');
			expect(admission.message).toContain('maxConsultationsPerTurn');
			expect(admission).not.toHaveProperty('chain');
			expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(2);
		});

		it('shares one budget with every other member of the chain', () => {
			admitConsult(
				{ chain: { chainId: 'chain-a', depth: 0 }, fromAgent: true, limit: 2 },
				{ dataDir }
			);
			admitConsult(
				{ chain: { chainId: 'chain-a', depth: 1 }, fromAgent: true, limit: 2 },
				{ dataDir }
			);

			expect(
				admitConsult(
					{ chain: { chainId: 'chain-a', depth: 4 }, fromAgent: true, limit: 2 },
					{ dataDir }
				).allowed
			).toBe(false);
		});

		it('is refused, not waved through, when the counter cannot be used', () => {
			fs.writeFileSync(filePath, 'not json', 'utf-8');

			const admission = admitConsult({ chain: mine, fromAgent: true, limit: 5 }, { dataDir });

			expect(admission).toMatchObject({ allowed: false, code: CONSULT_BUDGET_UNAVAILABLE_CODE });
			if (admission.allowed) throw new Error('expected a refusal');
			expect(admission.message).toContain(filePath);
			expect(fs.readFileSync(filePath, 'utf-8')).toBe('not json');
		});
	});

	describe('an agent in no chain', () => {
		it('becomes the root of a new chain and spends the first of it', () => {
			const admission = admitConsult({ fromAgent: true, limit: 5 }, { dataDir });

			if (!admission.allowed) throw new Error('expected the consult to be admitted');
			expect(isConsultChainId(admission.chain.chainId)).toBe(true);
			expect(admission.chain.depth).toBe(1);
			expect(readConsultBudgetSpent(admission.chain.chainId, { dataDir })).toBe(1);
		});

		it('is refused at a budget of 0, and leaves no chain behind', () => {
			const admission = admitConsult({ fromAgent: true, limit: 0 }, { dataDir });

			expect(admission).toMatchObject({ allowed: false, code: CONSULT_BUDGET_EXHAUSTED_CODE });
			if (admission.allowed) throw new Error('expected a refusal');
			expect(admission.message).toContain('switched off');
			expect(fs.existsSync(filePath)).toBe(false);
		});
	});

	// Looks like a hole in the budget and is not one: this call IS the user's
	// message, not a consult made while working on one.
	describe('the user, in no chain', () => {
		it('is let through without spending, and roots a chain for the target', () => {
			const admission = admitConsult({ fromAgent: false, limit: 5 }, { dataDir });

			if (!admission.allowed) throw new Error('expected the send to be admitted');
			expect(isConsultChainId(admission.chain.chainId)).toBe(true);
			expect(admission.chain.depth).toBe(0);
			expect(readConsultBudgetSpent(admission.chain.chainId, { dataDir })).toBe(0);
			expect(fs.existsSync(filePath)).toBe(false);
		});

		it('is let through even at a budget of 0', () => {
			expect(admitConsult({ fromAgent: false, limit: 0 }, { dataDir }).allowed).toBe(true);
		});

		it('is let through even when the counter is damaged, which it never reads', () => {
			fs.writeFileSync(filePath, 'not json', 'utf-8');

			expect(admitConsult({ fromAgent: false, limit: 5 }, { dataDir }).allowed).toBe(true);
		});

		it("mints a chain per call, so two of the user's messages never share a budget", () => {
			const first = admitConsult({ fromAgent: false, limit: 5 }, { dataDir });
			const second = admitConsult({ fromAgent: false, limit: 5 }, { dataDir });

			if (!first.allowed || !second.allowed) throw new Error('expected both to be admitted');
			expect(first.chain.chainId).not.toBe(second.chain.chainId);
		});

		it('bounds what the target then starts: its consults spend the minted chain', () => {
			const root = admitConsult({ fromAgent: false, limit: 1 }, { dataDir });
			if (!root.allowed) throw new Error('expected the send to be admitted');

			expect(
				admitConsult({ chain: root.chain, fromAgent: false, limit: 1 }, { dataDir }).allowed
			).toBe(true);
			expect(
				admitConsult({ chain: root.chain, fromAgent: false, limit: 1 }, { dataDir }).allowed
			).toBe(false);
		});
	});
});

describe('readConsultBudgetSpent', () => {
	it('reads 0 for a chain that has not spent, and when no file exists', () => {
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(0);

		spendConsultBudget('chain-b', 5, { dataDir });
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(0);
	});

	it('does not spend', () => {
		spendConsultBudget('chain-a', 5, { dataDir });

		readConsultBudgetSpent('chain-a', { dataDir });
		readConsultBudgetSpent('chain-a', { dataDir });

		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
	});

	it('reads null when the amount is not known', () => {
		expect(readConsultBudgetSpent('../escape', { dataDir })).toBeNull();

		fs.writeFileSync(filePath, 'not json', 'utf-8');
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBeNull();
	});
});

// What a turn about to be spawned is told about its budget.
describe('readConsultBudgetStatus', () => {
	it('reads a root turn (no chain yet) as nothing spent, without touching the counter', () => {
		expect(readConsultBudgetStatus({ limit: 25 }, { dataDir })).toEqual({ limit: 25, spent: 0 });
		expect(fs.existsSync(filePath)).toBe(false);

		// Not even a damaged counter changes it: the root's chain is not in the file.
		fs.writeFileSync(filePath, 'not json', 'utf-8');
		expect(readConsultBudgetStatus({ limit: 25 }, { dataDir })).toEqual({ limit: 25, spent: 0 });
	});

	it('reads what the chain the turn was placed in has already spent', () => {
		const first = admitConsult({ fromAgent: true, limit: 25 }, { dataDir });
		if (!first.allowed) throw new Error('expected the first consult to be admitted');
		spendConsultBudget(first.chain.chainId, 25, { dataDir });

		expect(readConsultBudgetStatus({ chain: first.chain, limit: 25 }, { dataDir })).toEqual({
			limit: 25,
			spent: 2,
		});
		// Another chain's spending is not this turn's.
		expect(
			readConsultBudgetStatus({ chain: { chainId: 'chain-b', depth: 1 }, limit: 25 }, { dataDir })
		).toEqual({ limit: 25, spent: 0 });
	});

	it('does not spend', () => {
		spendConsultBudget('chain-a', 5, { dataDir });
		const chain = { chainId: 'chain-a', depth: 1 };

		readConsultBudgetStatus({ chain, limit: 5 }, { dataDir });
		readConsultBudgetStatus({ chain, limit: 5 }, { dataDir });

		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
	});

	it('passes a budget of 0 through as it is, so the prompt can say consults are off', () => {
		expect(readConsultBudgetStatus({ limit: 0 }, { dataDir })).toEqual({ limit: 0, spent: 0 });
	});

	it('is undefined when the count is not known, so no figure is printed', () => {
		fs.writeFileSync(filePath, 'not json', 'utf-8');
		expect(
			readConsultBudgetStatus({ chain: { chainId: 'chain-a', depth: 1 }, limit: 25 }, { dataDir })
		).toBeUndefined();
	});
});

describe('sweepExpiredChains', () => {
	const start = 1_000_000;

	it('removes only the chains idle past the TTL', () => {
		spendConsultBudget('old-chain', 5, { dataDir, now: start });
		spendConsultBudget('live-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS });

		expect(sweepExpiredChains({ dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 })).toEqual({
			swept: 1,
		});
		expect(Object.keys(readFile())).toEqual(['live-chain']);
	});

	it('sweeps nothing and writes nothing when no chain has expired', () => {
		spendConsultBudget('chain-a', 5, { dataDir, now: start });
		const before = fs.statSync(filePath).mtimeMs;

		expect(sweepExpiredChains({ dataDir, now: start + 1 })).toEqual({ swept: 0 });
		expect(fs.statSync(filePath).mtimeMs).toBe(before);
	});

	it('is a no-op when there is no counter file', () => {
		expect(sweepExpiredChains({ dataDir })).toEqual({ swept: 0 });
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('reports a corrupt counter and leaves it as it was', () => {
		fs.writeFileSync(filePath, 'not json', 'utf-8');

		const result = sweepExpiredChains({ dataDir });

		expect(result.swept).toBe(0);
		expect(result.problem).toContain(filePath);
		expect(fs.readFileSync(filePath, 'utf-8')).toBe('not json');
	});
});

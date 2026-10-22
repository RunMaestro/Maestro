/**
 * @file system-one-spend.test.ts
 * @description `maestro-cli s1 usage|cost`, through the real option parser with
 * the bridge to the desktop mocked.
 *
 * Properties worth protecting:
 *
 *   - **`usage` is the desktop's report**, asked for with the query both
 *     surfaces send, and with the caller beside it so an agent sees its own
 *     count.
 *   - **`cost` sends nothing to an engine**: it asks the desktop only which
 *     engine is in force, and prices the caller's own text.
 *   - **With no engine chosen the price is the hosted Jev's, and says so.**
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

const storage = vi.hoisted(() => ({ resolveAgentId: vi.fn((id: string) => `${id}-full-id`) }));
vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	...storage,
}));

const stdin = vi.hoisted(() => ({
	readStdinIfReady: vi.fn<() => Promise<string | null>>(),
	readStdinText: vi.fn<() => string>(),
	isStdinTerminal: vi.fn(() => false),
}));
vi.mock('../../../cli/services/stdin', () => stdin);

import { registerSystemOneAgentCommands } from '../../../cli/commands/system-one-ask';
import { ExitCode } from '../../../cli/exit-codes';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../../shared/agentDelegation';
import {
	JEV_PRICE_PER_MTOK_INPUT_USD,
	estimateSystemOneTokens,
} from '../../../shared/local-models/system-one';
import {
	JEV_REQUEST_OVERHEAD_TOKENS,
	estimateSystemOneJob,
	type SystemOneUsageReport,
} from '../../../shared/local-models/system-one-spend';

interface Sent {
	payload: Record<string, unknown>;
	responseType: string;
}

function mockBridge(reply: (payload: Record<string, unknown>) => unknown): Sent[] {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation(async (payload: Record<string, unknown>, responseType: string) => {
					sent.push({ payload, responseType });
					return reply(payload);
				}),
		} as never)
	);
	return sent;
}

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

function usageReport(overrides: Partial<SystemOneUsageReport> = {}): SystemOneUsageReport {
	return {
		since: NOW - 30 * 86_400_000,
		retentionDays: 30,
		rows: [
			{
				agentId: 'agent-1-full-id',
				agentName: 'acappella',
				requests: 1200,
				cachedRequests: 300,
				tokensIn: 345_000,
				tokensOut: 900,
				costUsd: 0.01449,
				averageLatencyMs: 142,
			},
			{
				agentId: null,
				agentName: null,
				requests: 3,
				cachedRequests: 0,
				tokensIn: 1125,
				tokensOut: 3,
				costUsd: 0.000047,
				averageLatencyMs: 137,
			},
		],
		totals: {
			requests: 1203,
			cachedRequests: 300,
			tokensIn: 346_125,
			tokensOut: 903,
			costUsd: 0.014537,
		},
		budget: {
			dayStartedAt: NOW - 18 * 3_600_000,
			dailyBudgetUsd: 1,
			spentTodayUsd: 0.004,
			remainingTodayUsd: 0.996,
			agent: {
				agentId: 'agent-1',
				budgetUsd: 0.25,
				spentTodayUsd: 0.003,
				remainingTodayUsd: 0.247,
			},
		},
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		notice: null,
		...overrides,
	};
}

/** The status report, as far as `cost` reads it. */
function status(engine: string, engineLabel: string) {
	return { success: true, report: { settings: { engine }, engineLabel, problem: null } };
}

const JEV = status('jev-cloud', 'Jev (TypeSafe cloud)');

let dir: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;
let savedEnv: Record<string, string | undefined>;

const out = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const err = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
const jsonOut = () => JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

async function s1(...words: string[]): Promise<void> {
	const program = new Command();
	program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
	registerSystemOneAgentCommands(program.command('s1'));
	await program.parseAsync(['node', 'maestro-cli', 's1', ...words]);
}

async function exitCode(...words: string[]): Promise<number> {
	await expect(s1(...words)).rejects.toThrow(/^exit:/);
	return Number(exitSpy.mock.calls.at(-1)?.[0]);
}

function file(name: string, text: string): string {
	const target = path.join(dir, name);
	fs.writeFileSync(target, text, 'utf-8');
	return target;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(withMaestroClient).mockReset();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-one-spend-'));
	stdin.readStdinIfReady.mockResolvedValue(null);
	stdin.readStdinText.mockReturnValue('');
	storage.resolveAgentId.mockImplementation((id: string) => `${id}-full-id`);
	savedEnv = {
		[CALLER_AGENT_ID_ENV_VAR]: process.env[CALLER_AGENT_ID_ENV_VAR],
		[CALLER_TAB_ID_ENV_VAR]: process.env[CALLER_TAB_ID_ENV_VAR],
	};
	process.env[CALLER_AGENT_ID_ENV_VAR] = 'agent-1';
	delete process.env[CALLER_TAB_ID_ENV_VAR];
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as never);
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(dir, { recursive: true, force: true });
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe('s1 usage', () => {
	it('asks the desktop for every agent, with the caller beside the query', async () => {
		const sent = mockBridge(() => ({ success: true, report: usageReport() }));
		await s1('usage');

		expect(sent).toEqual([
			{
				payload: { type: 'system_one_usage', query: {}, fromSessionId: 'agent-1' },
				responseType: 'system_one_usage_result',
			},
		]);
	});

	it('prints today against the budget, then one row per agent and the total', async () => {
		mockBridge(() => ({ success: true, report: usageReport() }));
		await s1('usage');

		const text = out();
		expect(text).toContain('SYSTEM ONE USAGE  Jev (TypeSafe cloud)');
		expect(text).toContain('kept 30 days');
		expect(text).toMatch(/Today\s+\$0\.004000 of \$1\.00 today across all agents, \$1\.00 left/);
		expect(text).toMatch(/This agent\s+\$0\.003000 today of \$0\.25/);
		expect(text).toMatch(/agent\s+requests\s+cached\s+in tokens\s+out\s+cost\s+avg ms/);
		expect(text).toMatch(/acappella\s+1,200\s+300\s+345,000\s+900\s+\$0\.01\s+142/);
		expect(text).toMatch(/\(no agent\)\s+3\s+0\s+1,125\s+3\s+\$0\.000047\s+137/);
		expect(text).toMatch(/total\s+1,203\s+300\s+346,125\s+903\s+\$0\.01/);
	});

	it('names an agent that no longer exists by its id, and says when it has no cap', async () => {
		const report = usageReport();
		report.rows = [{ ...report.rows[0], agentName: null }];
		report.budget.agent = {
			agentId: 'agent-1',
			budgetUsd: null,
			spentTodayUsd: 0,
			remainingTodayUsd: null,
		};
		mockBridge(() => ({ success: true, report }));
		await s1('usage');

		expect(out()).toContain('agent-1-full-id');
		expect(out()).toContain('no cap of its own');
		expect(out()).not.toMatch(/^\s*total/m);
	});

	it('resolves --agent to a whole id, and reads --since as a time', async () => {
		const sent = mockBridge(() => ({ success: true, report: usageReport() }));
		await s1('usage', '--agent', 'agent-9', '--since', '2h');

		expect(storage.resolveAgentId).toHaveBeenCalledWith('agent-9');
		expect(sent[0].payload.query).toEqual({
			agentId: 'agent-9-full-id',
			since: NOW - 2 * 3_600_000,
		});
	});

	it('says why the rows may be short, and when there are none', async () => {
		mockBridge(() => ({
			success: true,
			report: usageReport({
				rows: [],
				notice: 'Usage statistics are switched off, so new decisions are not kept.',
			}),
		}));
		await s1('usage');

		expect(out()).toContain('Usage statistics are switched off');
		expect(out()).toContain('No agent requests in this window.');
	});

	it('prints the whole report as JSON', async () => {
		mockBridge(() => ({ success: true, report: usageReport() }));
		await s1('usage', '--json');
		expect(jsonOut()).toEqual({ success: true, ...usageReport() });
	});

	it('refuses a time it cannot read before anything is sent', async () => {
		const sent = mockBridge(() => ({ success: true, report: usageReport() }));
		expect(await exitCode('usage', '--since', 'a while ago')).toBe(ExitCode.InvalidUsage);
		expect(sent).toHaveLength(0);
	});

	it('exits non-zero when the agent is not known, or the desktop refuses', async () => {
		storage.resolveAgentId.mockImplementation(() => {
			throw new Error('Agent not found: nope');
		});
		const sent = mockBridge(() => ({ success: true, report: usageReport() }));
		expect(await exitCode('usage', '--agent', 'nope')).toBe(ExitCode.GeneralError);
		expect(sent).toHaveLength(0);

		storage.resolveAgentId.mockImplementation((id: string) => id);
		mockBridge(() => ({ success: false, error: 'Name the agent by its id.' }));
		expect(await exitCode('usage')).toBe(ExitCode.GeneralError);
		expect(err()).toContain('Name the agent by its id.');
	});
});

describe('s1 cost', () => {
	const TICKET = 'The export button crashes the settings page in Safari but works in Chrome.';

	it('asks the desktop only which engine is in force, and sends no text', async () => {
		const sent = mockBridge(() => JEV);
		await s1('cost', TICKET);

		expect(sent).toEqual([
			{ payload: { type: 'system_one_status' }, responseType: 'system_one_status_result' },
		]);
	});

	it('prices one request: the state, a question, and what the engine adds', async () => {
		mockBridge(() => JEV);
		await s1('cost', TICKET);

		const expected = estimateSystemOneJob({ engine: 'jev-cloud', state: TICKET });
		const lines = out().split('\n');
		expect(lines[0]).toBe(
			`state        ${estimateSystemOneTokens(TICKET)} tokens (estimated at 3.32 characters a token)`
		);
		expect(lines[1]).toContain(
			`per request  ${expected.tokensPerRequest} tokens = state + 1 question(s)`
		);
		expect(lines[1]).toContain(`+ ${JEV_REQUEST_OVERHEAD_TOKENS} the engine adds`);
		expect(lines[1]).toContain(
			'fits the request limit (32,388 for the state and its longest question'
		);
		expect(lines[2]).toMatch(
			/^cost {9}\$0\.0000\d\d on Jev \(TypeSafe cloud\) at \$0\.042 per million input tokens$/
		);
		expect(lines).toHaveLength(3);
	});

	it('reads a file named as the argument, @path, and the state flags', async () => {
		const notes = file('notes.md', 'word '.repeat(2_000));
		const tokens = estimateSystemOneTokens('word '.repeat(2_000));

		mockBridge(() => JEV);
		await s1('cost', notes, '--json');
		expect(jsonOut().stateTokens).toBe(tokens);

		await s1('cost', `@${notes}`, '--json');
		expect(jsonOut().stateTokens).toBe(tokens);

		await s1('cost', '--state-file', notes, '--json');
		expect(jsonOut().stateTokens).toBe(tokens);

		await s1('cost', '--field', `body=@${notes}`, '--field', 'author=Ana', '--json');
		expect(jsonOut().stateTokens).toBe(
			estimateSystemOneTokens({ body: 'word '.repeat(2_000), author: 'Ana' })
		);
	});

	it('reads standard input when nothing names the state', async () => {
		stdin.readStdinIfReady.mockResolvedValue(TICKET);
		mockBridge(() => JEV);
		await s1('cost', '--json');
		expect(jsonOut().stateTokens).toBe(estimateSystemOneTokens(TICKET));
	});

	it('sizes a rank: the candidates packed into requests', async () => {
		mockBridge(() => JEV);
		await s1('cost', 'a security fix', '--items', '600', '--question-chars', '90');

		const expected = estimateSystemOneJob({
			engine: 'jev-cloud',
			state: 'a security fix',
			questionChars: 90,
			items: 600,
		});
		expect(expected.requests).toBe(3);
		expect(out()).toContain(
			`job          600 candidates in 3 request(s), ${expected.inputTokens.toLocaleString('en-US')} input tokens`
		);
		expect(out()).toMatch(/an item\)$/m);
	});

	it('sizes a batch: one request per row', async () => {
		mockBridge(() => JEV);
		await s1('cost', TICKET, '--items', '1000', '--per-item', '--questions', '2', '--json');

		expect(jsonOut()).toEqual({
			success: true,
			...estimateSystemOneJob({
				engine: 'jev-cloud',
				state: TICKET,
				questions: 2,
				items: 1000,
				perItem: true,
			}),
			engineLabel: 'Jev (TypeSafe cloud)',
			engineChosen: 'jev-cloud',
		});
		expect(jsonOut()).toMatchObject({ shape: 'batch', requests: 1000 });
	});

	it('says a state past the limit EXCEEDS it', async () => {
		mockBridge(() => JEV);
		await s1('cost', '--state-file', file('big.txt', 'word '.repeat(30_000)));
		expect(out()).toContain('EXCEEDS the request limit');
	});

	it('prices an engine on the user`s own hardware at nothing', async () => {
		mockBridge(() => status('openjev', 'OpenJev at jev.internal:8080'));
		await s1('cost', TICKET);
		expect(out()).toContain(
			'cost         $0: OpenJev at jev.internal:8080 runs on your own hardware'
		);
	});

	it('does not hold the local judge to a Jev limit', async () => {
		mockBridge(() => status('local-judge', 'Local judge (Qwen3 1.7B), not calibrated'));
		await s1('cost', TICKET, '--items', '40');

		expect(out()).toContain("the local judge's limit is its model's context");
		expect(out()).toContain('40 candidates in 40 request(s)');
		expect(out()).not.toContain('the engine adds');
	});

	it('prices as the hosted Jev when no engine is chosen, and says so', async () => {
		mockBridge(() => status('off', 'Off'));
		await s1('cost', TICKET);
		expect(out()).toContain(
			`No engine is chosen, so this is priced as Jev (TypeSafe cloud) at its list price of $${JEV_PRICE_PER_MTOK_INPUT_USD} per million input tokens.`
		);

		await s1('cost', TICKET, '--json');
		expect(jsonOut()).toMatchObject({ engine: 'jev-cloud', engineChosen: 'off' });
		expect(jsonOut().note).toContain('No engine is chosen');
	});

	describe('a wrong command line is exit 2, and the desktop is not asked', () => {
		it.each([
			['no state', ['cost']],
			['a state named two ways', ['cost', 'some text', '-s', 'other text']],
			['a count that is not a number', ['cost', 'text', '--items', 'many']],
			['no questions', ['cost', 'text', '--questions', '0']],
			['one request per item with no items', ['cost', 'text', '--per-item']],
			['a state that is not text or JSON', ['cost', '--state-json', '7']],
		])('%s', async (_name, words) => {
			const sent = mockBridge(() => JEV);
			expect(await exitCode(...words)).toBe(ExitCode.InvalidUsage);
			expect(sent).toHaveLength(0);
		});
	});
});

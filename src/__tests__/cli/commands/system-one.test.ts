/**
 * @file system-one.test.ts
 * @description Tests for `maestro-cli s1 status|set|key|test|ledger`: each request
 * crosses the WS bridge in the shape the desktop handler expects, a bad value
 * is refused before anything is sent, the key is read from standard input and
 * is never printed, and the exit code tells a script whether the engine can
 * answer. `set agents` and `set budget` are what agents may ask and spend:
 * every write is read back by `status`.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

const storage = vi.hoisted(() => ({
	readLocalModelAssignments: vi.fn(() => ({})),
	writeLocalModelAssignments: vi.fn(),
	readLocalModelEndpoints: vi.fn(() => []),
}));
vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	...storage,
}));

const stdin = vi.hoisted(() => ({ text: '', readFileSync: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const readFileSync = ((file: unknown, ...rest: unknown[]) =>
		file === 0
			? stdin.readFileSync()
			: (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest)) as never;
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import {
	systemOneKeyClear,
	systemOneKeySet,
	systemOneLedger,
	systemOneSetAgents,
	systemOneSetBudget,
	systemOneSetEngine,
	systemOneSetFailPolicy,
	systemOneSetKeepInputs,
	systemOneSetTimeout,
	systemOneStatus,
	systemOneTest,
} from '../../../cli/commands/system-one';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import type { SystemOneLedgerPage } from '../../../shared/local-models/system-one-ledger';
import type {
	SystemOneReport,
	SystemOneTestResult,
} from '../../../shared/local-models/system-one-settings';
import { LOCAL_JUDGE_TASK_ID } from '../../../shared/local-models/tasks';

const KEY = 'sk-cli-test-0123456789abcdef';

/** When the engine in the fixture report passed its Test. */
const TESTED_AT = Date.now() - 60_000;

interface Sent {
	payload: Record<string, unknown>;
	responseType: string;
}

/** Answer every bridge call with `reply(payload)`, recording what was sent. */
function mockBridge(reply: (payload: Record<string, unknown>) => Record<string, unknown>): Sent[] {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				sent.push({ payload, responseType: rt });
				return Promise.resolve(reply(payload));
			}),
		} as never)
	);
	return sent;
}

function report(overrides: Partial<SystemOneReport> = {}): SystemOneReport {
	return {
		settings: {
			engine: 'jev-cloud',
			openJevUrl: null,
			timeoutMs: 1500,
			models: {},
			failPolicies: {},
			keepInputs: false,
			agents: { enabled: true, dailyBudgetUsd: 1, perAgentBudgetUsd: null },
		},
		engineLabel: 'Jev (TypeSafe cloud)',
		disclosure:
			'Choosing Jev sends the text of every System One request to TypeSafe (api.typesafe.ai), after secrets are redacted.',
		baseUrl: 'https://api.typesafe.ai',
		model: null,
		modelLabel: null,
		timeoutMs: 1500,
		calibrated: true,
		keys: { 'jev-cloud': { source: 'stored', storage: 'os' }, openjev: { source: 'none' } },
		problem: null,
		testPassedAt: TESTED_AT,
		failPolicies: [
			{ taskId: 'cue-gate', label: 'Cue gate', policy: 'open', defaultPolicy: 'open' },
			{
				taskId: 'injection-screen',
				label: 'Prompt-injection screen',
				policy: 'closed',
				defaultPolicy: 'closed',
			},
		],
		...overrides,
	};
}

const OFF = report({
	settings: {
		engine: 'off',
		openJevUrl: null,
		timeoutMs: 1500,
		models: {},
		failPolicies: {},
		keepInputs: false,
		agents: { enabled: true, dailyBudgetUsd: 1, perAgentBudgetUsd: null },
	},
	engineLabel: 'Off',
	disclosure: 'System One is off. No task text is sent to an engine.',
	baseUrl: null,
	timeoutMs: null,
	calibrated: null,
	keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
	testPassedAt: null,
});

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
const jsonOut = () => JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

/** Run a command that is expected to exit, and answer with the code it exited with. */
async function exitCode(run: () => Promise<void>): Promise<number> {
	await expect(run()).rejects.toThrow(/^exit:/);
	return Number(exitSpy.mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	storage.readLocalModelAssignments.mockReturnValue({});
	storage.readLocalModelEndpoints.mockReturnValue([]);
	stdin.readFileSync.mockImplementation(() => `${KEY}\n`);
	Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as never);
});

describe('s1 status', () => {
	it('prints the engine, the address, the budget, the key sources and the fail policies', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneStatus({});

		expect(sent).toEqual([
			{ payload: { type: 'system_one_status' }, responseType: 'system_one_status_result' },
		]);
		const out = printed();
		expect(out).toContain('Jev (TypeSafe cloud)');
		expect(out).toContain('https://api.typesafe.ai');
		expect(out).toContain('1500 ms');
		expect(out).toContain('jev-latest');
		expect(out).toContain('Stored sealed by the system key store.');
		expect(out).toContain('TypeSafe (api.typesafe.ai)');
		expect(out).toMatch(/cue-gate\s+open/);
		expect(out).toMatch(/injection-screen\s+closed/);
		expect(out).toContain('keeps question ids and answers, not inputs');
	});

	it('says when the ledger keeps inputs', async () => {
		mockBridge(() => ({
			success: true,
			report: report({ settings: { ...report().settings, keepInputs: true } }),
		}));
		await systemOneStatus({});

		expect(printed()).toContain('keeps inputs, redacted');
	});

	it('says what agents may ask and spend, and that the engine passed its Test', async () => {
		mockBridge(() => ({ success: true, report: report() }));
		await systemOneStatus({});

		const out = printed();
		expect(out).toMatch(/Agents\s+may ask/);
		expect(out).toContain('budget $1.00 a day across all agents, no cap per agent');
		expect(out).toContain('maestro-cli s1 usage');
		expect(out).toContain('The engine passed its Test');
	});

	it('says when agents are switched off, and names a cap per agent', async () => {
		mockBridge(() => ({
			success: true,
			report: report({
				settings: {
					...report().settings,
					agents: { enabled: false, dailyBudgetUsd: 2.5, perAgentBudgetUsd: 0.25 },
				},
			}),
		}));
		await systemOneStatus({});

		const out = printed();
		expect(out).toMatch(/Agents\s+may not ask/);
		expect(out).toContain('budget $2.50 a day across all agents, $0.25 a day per agent');
		// Off is the whole answer: nothing about the Test is said under it.
		expect(out).not.toContain('passes its Test');
		expect(out).not.toContain('The engine passed its Test');
	});

	it('says what still stops agents while the switch is on', async () => {
		mockBridge(() => ({ success: true, report: report({ testPassedAt: null }) }));
		await systemOneStatus({});
		expect(printed()).toContain('Agents can ask once the engine passes its Test');

		logSpy.mockClear();
		mockBridge(() => ({ success: true, report: OFF }));
		await systemOneStatus({});
		expect(printed()).toContain('No engine is chosen, so no agent can ask.');
	});

	it('prints the whole report as JSON, which carries no key', async () => {
		mockBridge(() => ({ success: true, report: report() }));
		await systemOneStatus({ json: true });
		expect(jsonOut()).toMatchObject({ success: true, engineLabel: 'Jev (TypeSafe cloud)' });
	});

	it('is not a failure when System One is off, and says how to choose an engine', async () => {
		mockBridge(() => ({ success: true, report: OFF }));
		await systemOneStatus({});
		expect(exitSpy).not.toHaveBeenCalled();
		expect(printed()).toContain('maestro-cli s1 set engine');
	});

	it('exits non-zero when the engine in force cannot answer as it is set up', async () => {
		const problem =
			'Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One.';
		mockBridge(() => ({ success: true, report: report({ problem }) }));
		expect(await exitCode(() => systemOneStatus({}))).toBe(ExitCode.GeneralError);
		expect(printed()).toContain(problem);
	});

	it('reports a bridge failure', async () => {
		mockBridge(() => ({ success: false, error: 'state file unreadable' }));
		expect(await exitCode(() => systemOneStatus({}))).toBe(ExitCode.GeneralError);
		expect(errors()).toContain('state file unreadable');
	});
});

describe('s1 set engine', () => {
	it('sends the engine, and prints where the text goes', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneSetEngine('jev-cloud', {});
		expect(sent).toEqual([
			{
				payload: { type: 'system_one_set', patch: { engine: 'jev-cloud' } },
				responseType: 'system_one_set_result',
			},
		]);
		expect(printed()).toContain('TypeSafe');
		expect(printed()).toContain('maestro-cli s1 test');
	});

	it('sends the OpenJev URL and a pinned model with the engine', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneSetEngine('openjev', { url: 'https://gpu.lan:8000', model: 'openjev-1' });
		expect(sent).toHaveLength(1);
		expect(sent[0].payload.patch).toEqual({
			engine: 'openjev',
			openJevUrl: 'https://gpu.lan:8000',
			model: 'openjev-1',
		});
	});

	it('removes a pin with --model default', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneSetEngine('jev-cloud', { model: 'default' });
		expect(sent[0].payload.patch).toEqual({ engine: 'jev-cloud', model: null });
	});

	it('refuses OpenJev with no URL given and none stored, and changes nothing', async () => {
		const sent = mockBridge(() => ({ success: true, report: OFF }));
		expect(await exitCode(() => systemOneSetEngine('openjev', {}))).toBe(ExitCode.InvalidUsage);
		expect(sent.map((call) => call.payload.type)).toEqual(['system_one_status']);
		expect(errors()).toContain('--url');
	});

	it('keeps a stored OpenJev URL when none is given', async () => {
		const stored = report({
			settings: { ...report().settings, engine: 'off', openJevUrl: 'https://gpu.lan:8000' },
		});
		const sent = mockBridge(() => ({ success: true, report: stored }));
		await systemOneSetEngine('openjev', {});
		expect(sent.map((call) => call.payload.type)).toEqual(['system_one_status', 'system_one_set']);
		expect(sent[1].payload.patch).toEqual({ engine: 'openjev' });
	});

	it("stores the local judge's model as the Local judge task's assignment", async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneSetEngine('local-judge', { model: `local:${QWEN3_1_7B_ID}` });

		// The app is asked first, so nothing is stored when it is not running.
		expect(sent.map((call) => call.payload.type)).toEqual(['system_one_status', 'system_one_set']);
		expect(sent[1].payload.patch).toEqual({ engine: 'local-judge' });
		expect(storage.writeLocalModelAssignments).toHaveBeenCalledWith({
			[LOCAL_JUDGE_TASK_ID]: { type: 'local', modelId: QWEN3_1_7B_ID },
		});
	});

	it('stores no assignment when the app cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));
		await exitCode(() => systemOneSetEngine('local-judge', { model: `local:${QWEN3_1_7B_ID}` }));
		expect(storage.writeLocalModelAssignments).not.toHaveBeenCalled();
	});

	it('refuses a bad value before anything is sent', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		const cases: Array<[string, { url?: string; model?: string }, string]> = [
			['gpt', {}, 'is not an engine'],
			['jev-cloud', { url: 'https://gpu.lan' }, 'OpenJev server'],
			['openjev', { url: 'ftp://gpu.lan' }, 'http and https'],
			['off', { model: 'jev-1.13.0' }, 'needs an engine'],
			['jev-cloud', { model: 'two words' }, 'no spaces'],
			['local-judge', { model: 'qwen' }, 'Assignment must be'],
			['local-judge', { model: 'off' }, 'needs a model'],
			['local-judge', { model: 'local:not-a-model' }, 'not a known local model'],
		];
		for (const [engine, options, message] of cases) {
			errorSpy.mockClear();
			expect(await exitCode(() => systemOneSetEngine(engine, options))).toBe(ExitCode.InvalidUsage);
			expect(errors()).toContain(message);
		}
		expect(sent).toHaveLength(0);
		expect(storage.writeLocalModelAssignments).not.toHaveBeenCalled();
	});

	it('warns when the engine was set and cannot answer yet', async () => {
		const problem =
			'Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One.';
		mockBridge(() => ({ success: true, report: report({ problem }) }));
		await systemOneSetEngine('jev-cloud', {});
		expect(printed()).toContain(problem);
		expect(printed()).not.toContain('maestro-cli s1 test');
	});
});

describe('s1 set timeout and fail-policy', () => {
	it('sends the timeout as a number', async () => {
		const sent = mockBridge(() => ({
			success: true,
			report: report({ settings: { ...report().settings, timeoutMs: 800 } }),
		}));
		await systemOneSetTimeout('800', {});
		expect(sent[0].payload).toEqual({ type: 'system_one_set', patch: { timeoutMs: 800 } });
		expect(printed()).toContain('800 ms');
	});

	it('refuses a timeout that is not a whole number in range', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		for (const value of ['fast', '50', '1500.5', '999999']) {
			expect(await exitCode(() => systemOneSetTimeout(value, {}))).toBe(ExitCode.InvalidUsage);
		}
		expect(sent).toHaveLength(0);
	});

	it('sends one task and its policy, and says what the task now does', async () => {
		const changed = report({
			failPolicies: [
				{ taskId: 'cue-gate', label: 'Cue gate', policy: 'closed', defaultPolicy: 'open' },
			],
		});
		const sent = mockBridge(() => ({ success: true, report: changed }));
		await systemOneSetFailPolicy('cue-gate', 'closed', {});
		expect(sent[0].payload).toEqual({
			type: 'system_one_set',
			patch: { failPolicy: { taskId: 'cue-gate', policy: 'closed' } },
		});
		expect(printed()).toContain('Cue gate fails closed');
	});

	it('refuses a task with no fail policy, or a policy that is not one', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		expect(await exitCode(() => systemOneSetFailPolicy('dictation', 'open', {}))).toBe(
			ExitCode.InvalidUsage
		);
		expect(errors()).toContain('cue-gate, injection-screen');
		expect(await exitCode(() => systemOneSetFailPolicy('cue-gate', 'maybe', {}))).toBe(
			ExitCode.InvalidUsage
		);
		expect(sent).toHaveLength(0);
	});
});

describe('s1 set keep-inputs', () => {
	it('sends on and off as a boolean, and says what the ledger now keeps', async () => {
		const sent = mockBridge((payload) => ({
			success: true,
			report: report({
				settings: {
					...report().settings,
					keepInputs: (payload.patch as { keepInputs: boolean }).keepInputs,
				},
			}),
		}));

		await systemOneSetKeepInputs('on', {});
		expect(sent[0]).toEqual({
			payload: { type: 'system_one_set', patch: { keepInputs: true } },
			responseType: 'system_one_set_result',
		});
		expect(printed()).toContain('Keep inputs in the ledger: on');
		expect(printed()).toContain('with secrets redacted');

		await systemOneSetKeepInputs('off', {});
		expect(sent[1].payload).toEqual({ type: 'system_one_set', patch: { keepInputs: false } });
		expect(printed()).toContain('Keep inputs in the ledger: off');
		expect(printed()).toContain('stay until their records are 30 days old');
	});

	it('refuses anything but on or off before anything is sent', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		for (const value of ['yes', 'true', '']) {
			expect(await exitCode(() => systemOneSetKeepInputs(value, {}))).toBe(ExitCode.InvalidUsage);
		}
		expect(sent).toHaveLength(0);
	});
});

describe('s1 set agents', () => {
	/** A desktop that stores what it is sent and answers with the report. */
	const storing = (base: SystemOneReport = report()) =>
		mockBridge((payload) => ({
			success: true,
			report: {
				...base,
				settings: {
					...base.settings,
					agents: {
						...base.settings.agents,
						...(payload.patch as { agents: Record<string, unknown> }).agents,
					},
				},
			},
		}));

	it('sends on and off as a boolean, and says what agents may now do', async () => {
		const sent = storing();

		await systemOneSetAgents('off', {});
		expect(sent[0]).toEqual({
			payload: { type: 'system_one_set', patch: { agents: { enabled: false } } },
			responseType: 'system_one_set_result',
		});
		expect(printed()).toContain('Let agents use System One: off');
		expect(printed()).toContain('No agent may ask System One');

		logSpy.mockClear();
		await systemOneSetAgents('on', {});
		expect(sent[1].payload).toEqual({
			type: 'system_one_set',
			patch: { agents: { enabled: true } },
		});
		expect(printed()).toContain('Let agents use System One: on');
		expect(printed()).toContain('update-agent <agent-id> --system-one off');
		// The engine in the report is tested: nothing stands in the way.
		expect(printed()).not.toContain('passes its Test');
	});

	it('says what still stops agents when it is switched on over an untested engine', async () => {
		storing(report({ testPassedAt: null }));
		await systemOneSetAgents('on', {});
		expect(printed()).toContain('Agents can ask once the engine passes its Test');

		logSpy.mockClear();
		storing(OFF);
		await systemOneSetAgents('on', {});
		expect(printed()).toContain('No engine is chosen, so no agent can ask.');

		// Off needs no such line: nothing can ask either way.
		logSpy.mockClear();
		storing(OFF);
		await systemOneSetAgents('off', {});
		expect(printed()).not.toContain('No engine is chosen');
	});

	it('prints the report as JSON', async () => {
		storing();
		await systemOneSetAgents('off', { json: true });
		expect(jsonOut()).toMatchObject({
			success: true,
			settings: { agents: { enabled: false, dailyBudgetUsd: 1 } },
		});
	});

	it('refuses anything but on or off before anything is sent', async () => {
		const sent = storing();
		for (const value of ['yes', 'true', '']) {
			expect(await exitCode(() => systemOneSetAgents(value, {}))).toBe(ExitCode.InvalidUsage);
		}
		expect(sent).toHaveLength(0);
	});

	describe('s1 set budget', () => {
		it('sends the daily budget in dollars, and says what agents may spend', async () => {
			const sent = storing();
			await systemOneSetBudget('2.50', {});

			expect(sent).toEqual([
				{
					payload: { type: 'system_one_set', patch: { agents: { dailyBudgetUsd: 2.5 } } },
					responseType: 'system_one_set_result',
				},
			]);
			const out = printed();
			expect(out).toContain('Agents may spend $2.50 a day on System One, across all of them');
			expect(out).toContain('No agent has a cap of its own.');
			expect(out).toContain('maestro-cli s1 usage');
		});

		it('reads a dollar sign, and sets the cap per agent with or without the daily budget', async () => {
			const sent = storing();
			await systemOneSetBudget('$3', { perAgent: '0.25' });
			expect(sent[0].payload).toEqual({
				type: 'system_one_set',
				patch: { agents: { dailyBudgetUsd: 3, perAgentBudgetUsd: 0.25 } },
			});
			expect(printed()).toContain('One agent may spend $0.25 a day.');

			await systemOneSetBudget(undefined, { perAgent: '0.5' });
			expect(sent[1].payload).toEqual({
				type: 'system_one_set',
				patch: { agents: { perAgentBudgetUsd: 0.5 } },
			});
		});

		it('removes the cap per agent with none, sent as null', async () => {
			const sent = storing(
				report({
					settings: {
						...report().settings,
						agents: { enabled: true, dailyBudgetUsd: 1, perAgentBudgetUsd: 0.25 },
					},
				})
			);
			await systemOneSetBudget(undefined, { perAgent: 'None' });
			expect(sent[0].payload).toEqual({
				type: 'system_one_set',
				patch: { agents: { perAgentBudgetUsd: null } },
			});
			expect(printed()).toContain('No agent has a cap of its own.');
		});

		it('warns that a budget of zero refuses every agent request', async () => {
			storing();
			await systemOneSetBudget('0', {});
			expect(printed()).toContain('A budget of 0 refuses every agent request.');
		});

		it('says a budget never binds on an engine with no price', async () => {
			storing(report({ settings: { ...report().settings, engine: 'local-judge' } }));
			await systemOneSetBudget('5', {});
			expect(printed()).toContain('has no price, so a budget above 0 never binds');
		});

		it('refuses a value that is not a budget, and a call that names none, before anything is sent', async () => {
			const sent = storing();
			for (const value of ['', 'lots', '-1', '1001', '1e2']) {
				expect(await exitCode(() => systemOneSetBudget(value, {})), value).toBe(
					ExitCode.InvalidUsage
				);
			}
			expect(await exitCode(() => systemOneSetBudget('1', { perAgent: 'lots' }))).toBe(
				ExitCode.InvalidUsage
			);
			expect(errors()).toContain('--per-agent');
			expect(errors()).toContain('"none"');
			expect(await exitCode(() => systemOneSetBudget(undefined, {}))).toBe(ExitCode.InvalidUsage);
			expect(errors()).toContain('--per-agent <usd|none>');
			expect(sent).toHaveLength(0);
		});

		it('prints the report as JSON', async () => {
			storing();
			await systemOneSetBudget('4', { json: true });
			expect(jsonOut()).toMatchObject({
				success: true,
				settings: { agents: { enabled: true, dailyBudgetUsd: 4, perAgentBudgetUsd: null } },
			});
		});
	});
});

describe('s1 key', () => {
	it('reads the key from standard input, sends it, and never prints it', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneKeySet({});
		expect(sent).toEqual([
			{
				payload: { type: 'system_one_key_set', key: KEY },
				responseType: 'system_one_key_set_result',
			},
		]);
		expect(printed()).toContain('Stored the key');
		expect(printed()).not.toContain(KEY);
		expect(errors()).not.toContain(KEY);
	});

	it('names the engine when one is given, and prints no key as JSON either', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		await systemOneKeySet({ engine: 'openjev', json: true });
		expect(sent[0].payload).toEqual({ type: 'system_one_key_set', key: KEY, engine: 'openjev' });
		expect(printed()).not.toContain(KEY);
	});

	it('refuses a terminal: a key is piped, never typed or passed as an argument', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
		expect(await exitCode(() => systemOneKeySet({}))).toBe(ExitCode.InvalidUsage);
		expect(errors()).toContain('standard input');
		expect(stdin.readFileSync).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it('refuses an empty or multi-line input without echoing it', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		stdin.readFileSync.mockImplementation(() => '\n');
		expect(await exitCode(() => systemOneKeySet({}))).toBe(ExitCode.InvalidUsage);
		expect(errors()).toContain('The key is empty.');

		errorSpy.mockClear();
		stdin.readFileSync.mockImplementation(() => 'sk-first-line\nsk-second-line\n');
		expect(await exitCode(() => systemOneKeySet({}))).toBe(ExitCode.InvalidUsage);
		expect(errors()).not.toContain('sk-first-line');
		expect(sent).toHaveLength(0);
	});

	it('refuses an engine that has no key', async () => {
		const sent = mockBridge(() => ({ success: true, report: report() }));
		expect(await exitCode(() => systemOneKeySet({ engine: 'local-judge' }))).toBe(
			ExitCode.InvalidUsage
		);
		expect(await exitCode(() => systemOneKeyClear({ engine: 'off' }))).toBe(ExitCode.InvalidUsage);
		expect(sent).toHaveLength(0);
	});

	it('warns when the key could only be stored obscured', async () => {
		mockBridge(() => ({
			success: true,
			report: report({
				keys: {
					'jev-cloud': { source: 'stored', storage: 'obscured' },
					openjev: { source: 'none' },
				},
			}),
		}));
		await systemOneKeySet({});
		expect(printed()).toContain('obscured, not encrypted');
	});

	it('clears the stored key, and says when another source still supplies one', async () => {
		const sent = mockBridge(() => ({
			success: true,
			report: report({
				keys: {
					'jev-cloud': { source: 'env', envVar: 'TYPESAFE_API_KEY', from: 'settings' },
					openjev: { source: 'none' },
				},
			}),
		}));
		await systemOneKeyClear({});
		expect(sent[0].payload).toEqual({ type: 'system_one_key_clear' });
		expect(printed()).toContain('Cleared the stored key');
		expect(printed()).toContain('still has a key from another source');
	});
});

describe('s1 test', () => {
	const OK: SystemOneTestResult = {
		ok: true,
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		model: 'jev-1.13.0',
		probability: 0.97,
		latencyMs: 212,
		calibrated: true,
		usage: { inputTokens: 41, outputTokens: 1 },
		costUsd: 0.0000017,
	};

	it('prints the answer, the latency and the engine that gave it', async () => {
		const sent = mockBridge(() => ({ success: true, result: OK }));
		await systemOneTest({});
		expect(sent[0]).toEqual({
			payload: { type: 'system_one_test' },
			responseType: 'system_one_test_result',
		});
		const out = printed();
		expect(out).toContain('Jev (TypeSafe cloud) answered in 212 ms');
		expect(out).toContain('P(yes) 0.97');
		expect(out).toContain('jev-1.13.0');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says so when a local judge answered, since its number is not calibrated', async () => {
		mockBridge(() => ({
			success: true,
			result: {
				...OK,
				engine: 'local-judge',
				engineLabel: 'Local judge (Qwen3 1.7B), not calibrated',
				calibrated: false,
			},
		}));
		await systemOneTest({});
		expect(printed()).toContain('not calibrated');
	});

	it('exits non-zero with no answer, naming the engine that was asked and why', async () => {
		mockBridge(() => ({
			success: true,
			result: {
				ok: false,
				engine: 'jev-cloud',
				engineLabel: 'Jev (TypeSafe cloud)',
				code: 'timeout',
				error: 'Jev (TypeSafe cloud) did not answer within 1500 ms.',
			},
		}));
		expect(await exitCode(() => systemOneTest({}))).toBe(ExitCode.GeneralError);
		expect(printed()).toContain('did not answer within 1500 ms');
		expect(printed()).toContain('timeout');
	});

	it('answers as JSON with success set from the result', async () => {
		mockBridge(() => ({ success: true, result: OK }));
		await systemOneTest({ json: true });
		expect(jsonOut()).toMatchObject({ success: true, ok: true, probability: 0.97 });
	});
});

describe('s1 ledger', () => {
	const NOW = 1_800_000_000_000;
	const page = (overrides: Partial<SystemOneLedgerPage> = {}): SystemOneLedgerPage => ({
		entries: [
			{
				id: 'decision-2',
				taskId: 'cue-gate',
				engine: 'jev-cloud',
				model: 'jev-1.13.0',
				questionIds: ['proceed'],
				answers: { proceed: { type: 'noul', probability: 0.93 } },
				outcome: 'ok',
				startedAt: NOW,
				latencyMs: 241,
				usage: { inputTokens: 412, outputTokens: 3 },
				costUsd: 0.0000173,
			},
			{
				id: 'decision-1',
				taskId: 'injection-screen',
				engine: 'jev-cloud',
				questionIds: ['injected'],
				outcome: 'failed-closed',
				code: 'timeout',
				startedAt: NOW - 60_000,
				latencyMs: 1500,
			},
		],
		total: 2,
		retentionDays: 30,
		notice: null,
		...overrides,
	});

	it('asks for every decision with no flag, and prints one line each', async () => {
		const sent = mockBridge(() => ({ success: true, page: page() }));
		await systemOneLedger({});

		expect(sent).toEqual([
			{
				payload: { type: 'system_one_ledger', query: {} },
				responseType: 'system_one_ledger_result',
			},
		]);
		const out = printed();
		expect(out).toContain('2 of 2, kept 30 days');
		expect(out).toMatch(/cue-gate\s+jev-cloud\s+Answered\s+yes \(0\.93\)\s+241 ms/);
		expect(out).toMatch(/injection-screen\s+jev-cloud\s+Failed closed\s+timeout\s+1500 ms/);
	});

	it('sends the task, the outcome, the limit and --since as a time', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			const sent = mockBridge(() => ({ success: true, page: page() }));
			await systemOneLedger({ task: 'cue-gate', outcome: 'timeout', since: '2h', limit: '5' });

			expect(sent[0].payload).toEqual({
				type: 'system_one_ledger',
				query: { taskId: 'cue-gate', outcome: 'timeout', since: NOW - 2 * 3_600_000, limit: 5 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses a bad flag before anything is sent', async () => {
		const sent = mockBridge(() => ({ success: true, page: page() }));
		for (const options of [
			{ task: 'no-such-task' },
			{ outcome: 'sideways' },
			{ since: 'yesterday-ish' },
			{ limit: '0' },
			{ limit: 'many' },
			{ limit: '5000' },
		]) {
			expect(await exitCode(() => systemOneLedger(options))).toBe(ExitCode.InvalidUsage);
		}
		expect(sent).toHaveLength(0);
		expect(errors()).toContain('ok, failed-open, failed-closed, unavailable, cancelled, timeout');
	});

	it('prints a kept input under its row, and the notice when decisions are not kept', async () => {
		const kept = page();
		kept.entries[0].input = '{"state":"A comment.","questions":{}}';
		mockBridge(() => ({
			success: true,
			page: {
				...kept,
				notice: 'Usage statistics are switched off, so new decisions are not kept.',
			},
		}));
		await systemOneLedger({});

		expect(printed()).toContain('{"state":"A comment.","questions":{}}');
		expect(printed()).toContain('Usage statistics are switched off');
	});

	it('says so when nothing matches', async () => {
		mockBridge(() => ({ success: true, page: page({ entries: [], total: 0 }) }));
		await systemOneLedger({ outcome: 'cancelled' });

		expect(printed()).toContain('No decisions match.');
	});

	it('prints the page as JSON', async () => {
		mockBridge(() => ({ success: true, page: page() }));
		await systemOneLedger({ json: true });

		expect(jsonOut()).toMatchObject({
			success: true,
			total: 2,
			retentionDays: 30,
			entries: [{ id: 'decision-2' }, { id: 'decision-1', code: 'timeout' }],
		});
	});

	it('reports a refusal from the app', async () => {
		mockBridge(() => ({ success: false, error: 'The statistics database is not open.' }));

		expect(await exitCode(() => systemOneLedger({}))).toBe(ExitCode.GeneralError);
		expect(errors()).toContain('The statistics database is not open.');
	});
});

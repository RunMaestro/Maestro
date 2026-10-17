/**
 * @file agent-test-run-on.test.ts
 * @description Tests for `maestro-cli agent test-run-on`: it resolves the
 * agent, sends only its id across the WS bridge, and reports the app's verdict
 * with an exit status a script can branch on.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((ref: string) => `${ref}-full-id`),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { agentTestRunOn } from '../../../cli/commands/agent-test-run-on';
import { ExitCode } from '../../../cli/exit-codes';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { RUN_ON_TEST_PROMPT } from '../../../shared/local-models/run-on';
import { formatError } from '../../../cli/output/formatter';

const PASSED = {
	ok: true,
	model: 'qwen3:latest',
	label: 'qwen3:latest on Ollama',
	reply: 'ready',
	durationMs: 4200,
	contextTokens: 65_536,
};

function mockSend(result: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(result);
				}),
		} as never)
	);
	return captured;
}

function lastJson(spy: MockInstance): Record<string, unknown> {
	const calls = spy.mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

describe('agent test-run-on command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends only the resolved agent id and waits long enough for a cold model', async () => {
		const cap = mockSend({ success: true, result: PASSED });

		await agentTestRunOn('scout', { json: true });

		expect(resolveAgentId).toHaveBeenCalledWith('scout');
		expect(cap.payload).toEqual({ type: 'local_models_run_on_test', agentId: 'scout-full-id' });
		expect(cap.responseType).toBe('local_models_run_on_test_result');
		// The app starts the model server, loads the model and runs a cold turn.
		expect(cap.timeout).toBeGreaterThanOrEqual(10 * 60 * 1000);
		expect(lastJson(logSpy)).toEqual({ success: true, ...PASSED });
	});

	it('prints the reply, the model and what was asked for a person', async () => {
		mockSend({ success: true, result: PASSED });

		await agentTestRunOn('scout', {});

		const printed = logSpy.mock.calls.map((call) => call[0] as string).join('\n');
		expect(printed).toContain('qwen3:latest on Ollama answered in 4200 ms');
		expect(printed).toContain('65536 tokens');
		expect(printed).toContain(RUN_ON_TEST_PROMPT);
		expect(printed).toContain('ready');
	});

	it('passes a refusal code through and exits non-zero', async () => {
		mockSend({
			success: true,
			result: {
				ok: false,
				code: 'run-on-source-disabled',
				message: 'The source "Ollama" is disabled.',
			},
		});

		await expect(agentTestRunOn('scout', { json: true })).rejects.toThrow('__exit__');

		expect(lastJson(logSpy)).toEqual({
			success: false,
			code: 'run-on-source-disabled',
			error: 'The source "Ollama" is disabled.',
		});
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('reports how long a failed turn ran, and names the code for a person', async () => {
		const failed = {
			ok: false,
			code: 'run-on-test-timeout',
			message: 'Claude Code did not finish a turn.',
			durationMs: 300_000,
		};
		mockSend({ success: true, result: failed });
		await expect(agentTestRunOn('scout', { json: true })).rejects.toThrow('__exit__');
		expect(lastJson(logSpy)).toMatchObject({ code: 'run-on-test-timeout', durationMs: 300_000 });

		mockSend({ success: true, result: failed });
		await expect(agentTestRunOn('scout', {})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenLastCalledWith(
			formatError('Claude Code did not finish a turn. [run-on-test-timeout]')
		);
	});

	it('fails when the app answers with an error', async () => {
		mockSend({ success: false, error: 'Name the agent to test.' });

		await expect(agentTestRunOn('scout', { json: true })).rejects.toThrow('__exit__');

		expect(lastJson(logSpy)).toEqual({ success: false, error: 'Name the agent to test.' });
	});

	it('fails before the bridge when no agent matches', async () => {
		vi.mocked(resolveAgentId).mockImplementationOnce(() => {
			throw new Error('Agent not found: nope');
		});

		await expect(agentTestRunOn('nope', { json: true })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(lastJson(logSpy)).toEqual({ success: false, error: 'Agent not found: nope' });
	});

	it('fails with the reason when the app cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValueOnce(new Error('Maestro is not running'));

		await expect(agentTestRunOn('scout', { json: true })).rejects.toThrow('__exit__');

		expect(lastJson(logSpy)).toEqual({ success: false, error: 'Maestro is not running' });
	});
});

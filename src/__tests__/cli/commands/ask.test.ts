/**
 * @file ask.test.ts
 * @description Tests for the `maestro-cli ask` command.
 *
 * `ask` is the agent-to-agent QUESTION verb. It must never reach the dispatch
 * path: a dispatch lands in the target's active tab, which interrupts whatever
 * conversation the human has open there and sends the answer to the screen
 * instead of back to the agent that asked.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type * as MaestroClientModule from '../../../cli/services/maestro-client';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => {
	const actual = await importOriginal<typeof MaestroClientModule>();
	return {
		...actual,
		withMaestroClient: vi.fn(),
	};
});

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));

import { ask } from '../../../cli/commands/ask';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../../shared/agentDelegation';

/** Wire `withMaestroClient` to a stub client and hand back its sendCommand spy. */
function mockClient(response: Record<string, unknown>) {
	const sendCommand = vi.fn().mockResolvedValue(response);
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

describe('ask command', () => {
	// `--from` defaults to the caller identity in the environment, and the suite
	// runs in whatever shell launched it - inside a Maestro agent that is a real id.
	isolateAgentEnv([CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR]);

	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(resolveAgentId).mockImplementation((id: string) => `resolved-${id}`);
	});

	it('sends cross_agent_ask - never send_command - and prints the answer', async () => {
		const sendCommand = mockClient({
			type: 'cross_agent_ask_result',
			success: true,
			answer: 'HMAC-signed cookie, no session table.',
			targetAgentName: 'PedTome',
		});

		await ask('pedtome', 'How does the gate work?', { from: 'kensho' });

		const [message] = sendCommand.mock.calls[0];
		expect(message.type).toBe('cross_agent_ask');
		expect(message).toMatchObject({
			sessionId: 'resolved-pedtome',
			question: 'How does the gate work?',
			fromSessionId: 'resolved-kensho',
			withContext: false,
		});
		expect(logSpy).toHaveBeenCalledWith('HMAC-signed cookie, no session table.');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('sends a fresh context by default and forwards the transcript only with --with-context', async () => {
		const sendCommand = mockClient({ success: true, answer: 'ok' });
		await ask('pedtome', 'q', { withContext: true });
		expect(sendCommand.mock.calls[0][0].withContext).toBe(true);
	});

	it('refuses a self-consult before touching the desktop', async () => {
		const sendCommand = mockClient({ success: true, answer: 'ok' });
		await ask('kensho', 'q', { from: 'kensho' });
		expect(sendCommand).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot consult itself'));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects an empty question', async () => {
		const sendCommand = mockClient({ success: true });
		await ask('pedtome', '   ', {});
		expect(sendCommand).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('waits longer than the desktop does so the desktop timeout is the one reported', async () => {
		// A client-side timeout can only say "the app did not answer", which sends
		// the caller debugging Maestro instead of the consult that went quiet.
		const sendCommand = mockClient({ success: true, answer: 'ok' });
		await ask('pedtome', 'q', { timeout: '60' });
		const [, responseType, clientTimeout] = sendCommand.mock.calls[0];
		expect(responseType).toBe('cross_agent_ask_result');
		expect(sendCommand.mock.calls[0][0].timeoutMs).toBe(60_000);
		expect(clientTimeout).toBeGreaterThan(60_000);
	});

	it('rejects a timeout outside the supported range', async () => {
		const sendCommand = mockClient({ success: true });
		await ask('pedtome', 'q', { timeout: '99999' });
		expect(sendCommand).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('keeps a partial answer on stdout while reporting the failure on stderr', async () => {
		mockClient({
			success: false,
			answer: 'Half an answer',
			error: 'the agent timed out',
			targetAgentName: 'PedTome',
		});

		await ask('pedtome', 'q', {});

		expect(logSpy).toHaveBeenCalledWith('Half an answer');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('the agent timed out'));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('names a stopped consult as stopped, not as a failure of the target', async () => {
		mockClient({ success: false, canceled: true, targetAgentName: 'PedTome' });
		await ask('pedtome', 'q', {});
		expect(errorSpy).toHaveBeenCalledWith('Consult with PedTome was stopped');
	});

	it('emits a single JSON object with --json', async () => {
		mockClient({
			success: true,
			answer: 'Signed cookie.',
			targetAgentName: 'PedTome',
			targetTabId: 'consult-1',
		});

		await ask('pedtome', 'q', { json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			answer: 'Signed cookie.',
			error: undefined,
			canceled: undefined,
			agentId: 'resolved-pedtome',
			agentName: 'PedTome',
			tabId: 'consult-1',
		});
	});

	describe('caller attribution', () => {
		it('defaults --from to the agent this shell runs under and forwards its tab', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'caller-agent';
			process.env[CALLER_TAB_ID_ENV_VAR] = 'caller-tab';
			const sendCommand = mockClient({ success: true, answer: 'yes' });

			await ask('pedtome', 'q', {});

			expect(sendCommand.mock.calls[0][0]).toMatchObject({
				fromSessionId: 'caller-agent',
				fromTabId: 'caller-tab',
			});
		});

		it("does not lend this shell's tab to an explicit --from naming another agent", async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'caller-agent';
			process.env[CALLER_TAB_ID_ENV_VAR] = 'caller-tab';
			const sendCommand = mockClient({ success: true, answer: 'yes' });

			await ask('pedtome', 'q', { from: 'kensho' });

			expect(sendCommand.mock.calls[0][0]).toMatchObject({ fromSessionId: 'resolved-kensho' });
			expect(sendCommand.mock.calls[0][0]).not.toHaveProperty('fromTabId');
		});

		it('refuses an agent consulting itself through the default', async () => {
			process.env[CALLER_AGENT_ID_ENV_VAR] = 'resolved-pedtome';
			const sendCommand = mockClient({ success: true });

			await ask('pedtome', 'q', {});

			expect(sendCommand).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith('Error: an agent cannot consult itself');
		});
	});
});

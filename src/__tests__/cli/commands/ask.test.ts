/**
 * @file ask.test.ts
 * @description Tests for the `maestro-cli ask` command.
 *
 * `ask` is the agent-to-agent QUESTION verb. It must never reach the dispatch
 * path: a dispatch lands in the target's active tab, which interrupts whatever
 * conversation the human has open there and sends the answer to the screen
 * instead of back to the agent that asked.
 */

import * as os from 'os';
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { buildRemoteAskerKey, CROSS_AGENT_ASK_TAB_ID } from '../../../shared/crossAgentTypes';
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
	getSessionById: vi.fn(() => undefined),
	readSettings: vi.fn(() => ({})),
}));

// Routes one test's target to a peer without dialing anything; null leaves routing alone.
const peerRoute = vi.hoisted(() => ({ value: null as { peer: string; agent: string } | null }));
// The peer host's bridge for one test: `withPeerAgent` hands its body this `sendCommand`.
const peerBridge = vi.hoisted(() => ({
	sendCommand: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock('../../../cli/services/peer-resolver', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../cli/services/peer-resolver')>();
	return {
		...actual,
		routeAgentTarget: (...args: Parameters<typeof actual.routeAgentTarget>) =>
			peerRoute.value
				? { kind: 'peer' as const, target: peerRoute.value }
				: actual.routeAgentTarget(...args),
		withPeerAgent: (...args: Parameters<typeof actual.withPeerAgent>) => {
			const sendCommand = peerBridge.sendCommand;
			if (!sendCommand) return actual.withPeerAgent(...args);
			const [target, body] = args;
			return body({
				agent: { id: 'host-agent-1' },
				peer: target.peer,
				withBridge: (action: (client: unknown) => Promise<unknown>) => action({ sendCommand }),
			} as never);
		},
	};
});

import { ask } from '../../../cli/commands/ask';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { getSessionById, readSettings, resolveAgentId } from '../../../cli/services/storage';
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

	// Addressed by its local id, a hosted agent answers where it runs: the question goes to its
	// host over the `peer:agent` route, never refused and never asked of the local copy.
	it('asks a hosted agent on its host by the local id', async () => {
		vi.mocked(readSettings).mockReturnValueOnce({ federationHostedAgents: true });
		const localSend = mockClient({ type: 'cross_agent_ask_result', success: true });
		const peerSend = vi.fn().mockResolvedValue({
			type: 'cross_agent_ask_result',
			success: true,
			answer: 'in main',
		});
		vi.mocked(getSessionById).mockReturnValueOnce({
			id: 'resolved-builder',
			name: 'Builder',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
		});
		peerBridge.sendCommand = peerSend;
		try {
			await ask('builder', 'Where is the gate?', { json: true });
		} finally {
			peerBridge.sendCommand = null;
		}

		expect(localSend).not.toHaveBeenCalled();
		expect(peerSend.mock.calls[0][0]).toMatchObject({
			type: 'cross_agent_ask',
			sessionId: 'host-agent-1',
			question: 'Where is the gate?',
		});
		expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
			success: true,
			answer: 'in main',
			peer: 'build-box',
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	// G2: from an agent's own shell, a hosted ask names its asker as a local ask does, so the host
	// keeps one consult tab per asking (machine, agent), named after it.
	it('names the calling agent to the host of a hosted agent, for its own consult tab', async () => {
		process.env[CALLER_AGENT_ID_ENV_VAR] = 'caller-agent';
		vi.mocked(readSettings).mockReturnValueOnce({ federationHostedAgents: true });
		const peerSend = vi.fn().mockResolvedValue({ type: 'cross_agent_ask_result', success: true });
		vi.mocked(getSessionById).mockImplementation(((id: string) =>
			id === 'caller-agent'
				? { id, name: 'Kensho', toolType: 'claude-code', cwd: '/k', projectRoot: '/k' }
				: {
						id: 'resolved-builder',
						name: 'Builder',
						toolType: 'claude-code',
						cwd: '/p',
						projectRoot: '/p',
						liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
					}) as never);
		peerBridge.sendCommand = peerSend;
		try {
			await ask('builder', 'Where is the gate?', {});
		} finally {
			peerBridge.sendCommand = null;
			vi.mocked(getSessionById).mockImplementation(() => undefined);
		}
		expect(peerSend.mock.calls[0][0]).toMatchObject({
			type: 'cross_agent_ask',
			askerKey: buildRemoteAskerKey({
				machine: os.hostname(),
				agentId: 'caller-agent',
				tabId: CROSS_AGENT_ASK_TAB_ID,
			}),
			fromAgentName: 'Kensho',
		});
		expect(peerSend.mock.calls[0][0]).not.toHaveProperty('fromSessionId');
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

	describe('--btw side questions', () => {
		it('asks a side question of the named tab instead of consulting', async () => {
			const sendCommand = mockClient({
				type: 'cross_agent_ask_result',
				success: true,
				answer: 'teal',
			});

			await ask('pedtome', 'favourite colour?', { btw: true, tab: 'tab-7' });

			const [message] = sendCommand.mock.calls[0];
			expect(message).toMatchObject({
				type: 'cross_agent_ask',
				sessionId: 'resolved-pedtome',
				sideQuestion: true,
				targetTabId: 'tab-7',
			});
			expect(logSpy).toHaveBeenCalledWith('teal');
		});

		it('lets an agent ask a side question about its own conversation', async () => {
			const sendCommand = mockClient({
				type: 'cross_agent_ask_result',
				success: true,
				answer: 'x',
			});

			await ask('kensho', 'what did I just do?', { btw: true, from: 'kensho' });

			expect(sendCommand).toHaveBeenCalledTimes(1);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('refuses --tab without --btw and --with-context with it', async () => {
			const sendCommand = mockClient({});

			await ask('pedtome', 'q', { tab: 'tab-7' });
			await ask('pedtome', 'q', { btw: true, withContext: true });

			expect(sendCommand).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledTimes(2);
		});

		it('asks a peer agent the same side question, which its host forks its own tab for', async () => {
			const localSend = mockClient({});
			const peerSend = vi.fn().mockResolvedValue({
				type: 'cross_agent_ask_result',
				success: true,
				answer: 'teal',
			});
			peerRoute.value = { peer: 'build-box', agent: 'pedtome' };
			peerBridge.sendCommand = peerSend;
			try {
				await ask('build-box:pedtome', 'favourite colour?', { btw: true, tab: 'tab-7' });
			} finally {
				peerRoute.value = null;
				peerBridge.sendCommand = null;
			}

			expect(localSend).not.toHaveBeenCalled();
			expect(peerSend.mock.calls[0][0]).toMatchObject({
				type: 'cross_agent_ask',
				sessionId: 'host-agent-1',
				question: 'favourite colour?',
				sideQuestion: true,
				targetTabId: 'tab-7',
			});
			expect(logSpy).toHaveBeenCalledWith('teal');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('refuses --tab without --btw for a peer agent too', async () => {
			const peerSend = vi.fn();
			peerRoute.value = { peer: 'build-box', agent: 'pedtome' };
			peerBridge.sendCommand = peerSend;
			try {
				await ask('build-box:pedtome', 'q', { tab: 'tab-7' });
			} finally {
				peerRoute.value = null;
				peerBridge.sendCommand = null;
			}

			expect(peerSend).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith('Error: --tab only applies to --btw');
			expect(exitSpy).toHaveBeenCalledTimes(1);
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

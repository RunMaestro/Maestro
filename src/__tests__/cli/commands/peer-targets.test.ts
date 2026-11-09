/**
 * @file peer-targets.test.ts
 * @description The `peer:agent` path of `show agent`, `send`, `ask`, `dispatch`, `interrupt`, and
 * `tab new|rename|star|unstar --agent peer:agent` (Federation over SSH).
 *
 * The resolver is stood in for at its seams (`routeAgentTarget`, `withPeerAgent`,
 * `resolvePeerAgent`), so no SSH is dialed; the rest of it (error codes, `hostCallError`,
 * `watchPeerConnection`) is the real module. Each verb must send the host the bridge message it
 * sends locally, report in the local shape plus `peer`, refuse the flags that name local state,
 * and exit non-zero on a dead forward without retrying.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type * as PeerResolverModule from '../../../cli/services/peer-resolver';

vi.mock('../../../cli/services/peer-resolver', async (importOriginal) => {
	const actual = await importOriginal<typeof PeerResolverModule>();
	return {
		...actual,
		routeAgentTarget: vi.fn(),
		withPeerAgent: vi.fn(),
		resolvePeerAgent: vi.fn(),
	};
});

import {
	PeerResolveError,
	resolvePeerAgent,
	routeAgentTarget,
	withPeerAgent,
	type ResolvedPeerAgent,
} from '../../../cli/services/peer-resolver';
import { showAgent } from '../../../cli/commands/show-agent';
import { interrupt } from '../../../cli/commands/interrupt';
import { ask } from '../../../cli/commands/ask';
import { dispatch, runDispatch } from '../../../cli/commands/dispatch';
import { send } from '../../../cli/commands/send';
import { tabNew, tabRename, tabStar } from '../../../cli/commands/tab';
import { ExitCode } from '../../../cli/exit-codes';
import type {
	ClientResult,
	MaestroEvent,
	TurnEvent,
} from '../../../shared/maestro-lib/client/types';
import type { SshForwardState } from '../../../shared/maestro-lib/client/ssh-forward';
import type { AgentRecord, AITabRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const PEER = 'buildbox';
const AGENT_ID = 'a1111111-0000-4000-8000-000000000001';

const remote: SshRemoteConfig = {
	id: 'r1-abcdef',
	name: PEER,
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
};

function agentWith(tabs: AITabRecord[], extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: AGENT_ID,
		name: 'docs',
		toolType: 'claude-code',
		cwd: '/srv/docs',
		aiTabs: tabs,
		activeTabId: tabs[0]?.id,
		...extra,
	};
}

/** A host connection whose client, lease and bridge are all fakes the test drives. */
function fakePeer(agent: AgentRecord, bridgeReply: Record<string, unknown> = {}) {
	const turnListeners: Array<(event: TurnEvent) => void> = [];
	const hostListeners: Array<(event: MaestroEvent) => void> = [];
	const leaseListeners: Array<(state: SshForwardState) => void> = [];
	const sendCommand = vi.fn(async () => bridgeReply);
	const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
	const client = {
		groups: { list: vi.fn(async () => ok([{ id: 'g1', name: 'Docs group' }])) },
		agents: { get: vi.fn(async () => ok(agent)) },
		tabs: {
			create: vi.fn(async () => ok({ tabId: 'tab-new' })),
			rename: vi.fn(async () => ok(undefined)),
			star: vi.fn(async () => ok(undefined)),
		},
		turns: {
			send: vi.fn(async () => ok({ status: 'started' as const })),
			interrupt: vi.fn(async () => ok({ stopped: true })),
			subscribe: vi.fn((_agentId: string, _tabId: string, listener: (e: TurnEvent) => void) => {
				turnListeners.push(listener);
				return () => undefined;
			}),
		},
		events: {
			subscribe: vi.fn((listener: (e: MaestroEvent) => void) => {
				hostListeners.push(listener);
				return () => undefined;
			}),
		},
	};
	const lease = {
		remoteId: remote.id,
		state: () => ({ status: 'starting' }) as SshForwardState,
		ready: vi.fn(),
		onChange: vi.fn((listener: (state: SshForwardState) => void) => {
			leaseListeners.push(listener);
			return () => undefined;
		}),
		restart: vi.fn(),
		release: vi.fn(async () => undefined),
	};
	const release = vi.fn(async () => undefined);
	const resolved = {
		peer: PEER,
		remote,
		agent,
		client,
		lease,
		withBridge: vi.fn(async (action: (bridge: unknown) => Promise<unknown>) =>
			action({ sendCommand })
		),
		release,
	} as unknown as ResolvedPeerAgent;

	vi.mocked(routeAgentTarget).mockReturnValue({
		kind: 'peer',
		target: { peer: PEER, agent: 'docs' },
	});
	vi.mocked(withPeerAgent).mockImplementation(async (_target, action) => {
		try {
			return await action(resolved);
		} finally {
			await resolved.release();
		}
	});
	vi.mocked(resolvePeerAgent).mockResolvedValue(resolved);

	return {
		resolved,
		client,
		sendCommand,
		release,
		emitTurn: (event: TurnEvent) => turnListeners.forEach((listener) => listener(event)),
		dropLease: () =>
			leaseListeners.forEach((listener) =>
				listener({ status: 'down', error: new Error('ssh exited'), attempt: 1, retryInMs: 500 })
			),
		loseHost: () =>
			hostListeners.forEach((listener) => listener({ type: 'host.lost', reason: 'socket closed' })),
	};
}

/** A resolver failure for a peer whose host is not running. */
function hostDown(): PeerResolveError {
	return new PeerResolveError(
		'host-down',
		`No Maestro host is running on peer "${PEER}". Start it with: maestro-cli remote-host start ${PEER}`,
		ExitCode.NotRunning,
		PEER
	);
}

/** Every JSON object the command printed on stdout. */
function printedJson(spy: MockInstance): Array<Record<string, unknown>> {
	return spy.mock.calls
		.map((call) => {
			try {
				return JSON.parse(String(call[0])) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((value): value is Record<string, unknown> => value !== null);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('peer:agent targets', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	describe('show agent', () => {
		it('prints the host record in the local shape, with the peer, its tabs and no stats', async () => {
			const { release } = fakePeer(
				agentWith(
					[{ id: 'tab-1', name: 'Main', state: 'busy', agentSessionId: 'sess-1' }, { id: 'tab-2' }],
					{ groupId: 'g1', customModel: 'opus' }
				)
			);

			await showAgent(`${PEER}:docs`, { json: true });

			const [output] = printedJson(logSpy);
			expect(output).toMatchObject({
				id: AGENT_ID,
				name: 'docs',
				toolType: 'claude-code',
				cwd: '/srv/docs',
				groupName: 'Docs group',
				customModel: 'opus',
				peer: PEER,
				activeTabId: 'tab-1',
				stats: null,
				recentHistory: [],
				tabs: [
					{ id: 'tab-1', name: 'Main', state: 'busy', agentSessionId: 'sess-1' },
					{ id: 'tab-2', name: null, state: 'idle', agentSessionId: null },
				],
			});
			expect(release).toHaveBeenCalledTimes(1);
		});

		it('renders the human view without the local usage stats', async () => {
			fakePeer(agentWith([{ id: 'tab-1', state: 'idle' }]));

			await showAgent(`${PEER}:docs`, {});

			const text = String(logSpy.mock.calls[0][0]);
			expect(text).toContain(PEER);
			expect(text).toContain('tab-1');
			expect(text).toContain(`Kept on peer ${PEER}`);
		});

		it('reports a stopped host with its PEER_ code and exit 3', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});
			vi.mocked(withPeerAgent).mockRejectedValue(hostDown());

			await expect(showAgent(`${PEER}:docs`, { json: true })).rejects.toThrow('process.exit(3)');

			const payload = JSON.parse(String(errorSpy.mock.calls[0][0]));
			expect(payload).toMatchObject({ code: 'PEER_HOST_DOWN', peer: PEER });
			expect(payload.error).toContain(`maestro-cli remote-host start ${PEER}`);
		});
	});

	describe('interrupt', () => {
		it('stops every busy host tab, reads the agent back, and reports in the local shape', async () => {
			const { client } = fakePeer(
				agentWith([
					{ id: 'tab-1', state: 'busy' },
					{ id: 'tab-2', state: 'idle' },
					{ id: 'tab-3', state: 'busy' },
				])
			);
			client.agents.get.mockResolvedValue({
				ok: true,
				value: agentWith([{ id: 'tab-1', state: 'idle' }, { id: 'tab-3' }]),
			});

			await interrupt(`${PEER}:docs`, { json: true });

			expect(client.turns.interrupt.mock.calls).toEqual([
				[AGENT_ID, 'tab-1'],
				[AGENT_ID, 'tab-3'],
			]);
			expect(printedJson(logSpy)[0]).toEqual({
				success: true,
				agentId: AGENT_ID,
				tabId: null,
				wasBusy: true,
				interrupted: true,
				stoppedTabIds: ['tab-1', 'tab-3'],
				exited: true,
				peer: PEER,
			});
		});

		it('stops the one tab --tab names by prefix, and says how to check a slow exit', async () => {
			const { client } = fakePeer(agentWith([{ id: 'tab-1abc', state: 'busy' }, { id: 'tab-2' }]));

			await interrupt(`${PEER}:docs`, { tab: 'tab-1' });

			expect(client.turns.interrupt).toHaveBeenCalledWith(AGENT_ID, 'tab-1abc');
			const lines = logSpy.mock.calls.map((call) => String(call[0]));
			expect(lines.some((line) => line.includes(`on tab tab-1abc on peer ${PEER}`))).toBe(true);
			expect(lines).toContain(
				`The process is still exiting; check with: maestro-cli show agent ${PEER}:${AGENT_ID}`
			);
		});

		it('is a no-op success when nothing runs on the host', async () => {
			const { client } = fakePeer(agentWith([{ id: 'tab-1', state: 'idle' }]));

			await interrupt(`${PEER}:docs`, { json: true });

			expect(client.turns.interrupt).not.toHaveBeenCalled();
			expect(printedJson(logSpy)[0]).toMatchObject({ success: true, wasBusy: false, peer: PEER });
		});

		it('exits 3 with PEER_CONNECTION_LOST when the host drops during the stop', async () => {
			const { client } = fakePeer(agentWith([{ id: 'tab-1', state: 'busy' }]));
			client.turns.interrupt.mockResolvedValue({
				ok: false,
				error: { code: 'host-lost', message: 'The connection dropped.', method: 'turns.interrupt' },
			} as never);

			await expect(interrupt(`${PEER}:docs`, { json: true })).rejects.toThrow('process.exit(3)');
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: false,
				code: 'PEER_CONNECTION_LOST',
				peer: PEER,
			});
		});
	});

	describe('ask', () => {
		beforeEach(() => {
			// `ask` reports and returns after `process.exit`, like its own suite expects.
			exitSpy.mockImplementation(() => undefined as never);
		});

		it('sends the local cross_agent_ask over the peer bridge, with no local caller fields', async () => {
			const { sendCommand, release } = fakePeer(agentWith([]), {
				type: 'cross_agent_ask_result',
				success: true,
				answer: 'main',
				targetAgentName: 'docs',
			});

			await ask(`${PEER}:docs`, 'Which branch?', { json: true, timeout: '30' });

			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'cross_agent_ask',
					sessionId: AGENT_ID,
					question: 'Which branch?',
					withContext: false,
					timeoutMs: 30_000,
				},
				'cross_agent_ask_result',
				45_000
			);
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: true,
				answer: 'main',
				agentId: AGENT_ID,
				agentName: 'docs',
				peer: PEER,
			});
			expect(exitSpy).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
		});

		it('refuses --from and --with-context before dialing the peer', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});

			await ask(`${PEER}:docs`, 'q', { json: true, from: 'me' });
			await ask(`${PEER}:docs`, 'q', { json: true, withContext: true });

			expect(withPeerAgent).not.toHaveBeenCalled();
			expect(exitSpy.mock.calls).toEqual([[ExitCode.InvalidUsage], [ExitCode.InvalidUsage]]);
			expect(String(printedJson(logSpy)[0].error)).toContain('--from');
			expect(String(printedJson(logSpy)[1].error)).toContain('--with-context');
		});

		it('reports a resolver failure with its code and exit code', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});
			vi.mocked(withPeerAgent).mockRejectedValue(hostDown());

			await ask(`${PEER}:docs`, 'q', { json: true });

			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'PEER_HOST_DOWN', peer: PEER });
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.NotRunning);
		});
	});

	describe('dispatch', () => {
		it('sends send_command over the peer bridge without local caller or callback fields', async () => {
			const { sendCommand, release } = fakePeer(agentWith([]), {
				type: 'command_result',
				success: true,
				tabId: 'tab-1',
			});

			const result = await runDispatch(`${PEER}:docs`, 'Run the checklist', {});

			expect(sendCommand).toHaveBeenCalledTimes(1);
			const [message, replyType] = sendCommand.mock.calls[0] as unknown as [
				Record<string, unknown>,
				string,
			];
			expect(replyType).toBe('command_result');
			expect(message).toMatchObject({
				type: 'send_command',
				sessionId: AGENT_ID,
				command: 'Run the checklist',
				inputMode: 'ai',
			});
			expect(message).not.toHaveProperty('notifyOnComplete');
			expect(message).not.toHaveProperty('fromSessionId');
			expect(result).toMatchObject({
				success: true,
				agentId: AGENT_ID,
				tabId: 'tab-1',
				peer: PEER,
			});
			expect(release).toHaveBeenCalledTimes(1);
		});

		it('uses new_ai_tab_with_prompt for --new-tab and enqueue_command for --queue', async () => {
			const { sendCommand } = fakePeer(agentWith([]), { success: true, tabId: 'tab-9' });

			await runDispatch(`${PEER}:docs`, 'one', { newTab: true });
			await runDispatch(`${PEER}:docs`, 'two', { queue: true });

			const types = sendCommand.mock.calls.map(
				(call) => (call as unknown as [{ type: string }])[0].type
			);
			expect(types).toEqual(['new_ai_tab_with_prompt', 'enqueue_command']);
		});

		it('refuses --notify-on-complete and --routing before dialing the peer', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});

			const callback = await runDispatch(`${PEER}:docs`, 'x', {
				newTab: true,
				notifyOnComplete: 'me',
			});
			const routing = await runDispatch(`${PEER}:docs`, 'x @other', { routing: 'parallel' });

			expect(callback).toMatchObject({ success: false, code: 'INVALID_OPTIONS', peer: PEER });
			expect(routing).toMatchObject({ success: false, code: 'INVALID_OPTIONS', peer: PEER });
			expect(resolvePeerAgent).not.toHaveBeenCalled();
		});

		it('reports a lost acknowledgement as DISPATCH_UNKNOWN, never a resend', async () => {
			const { sendCommand } = fakePeer(agentWith([]));
			sendCommand.mockRejectedValue(new Error('socket closed'));

			const result = await runDispatch(`${PEER}:docs`, 'x', { dispatchId: undefined });

			expect(result).toMatchObject({ success: false, code: 'DISPATCH_UNKNOWN', peer: PEER });
			expect(sendCommand).toHaveBeenCalledTimes(1);
		});

		it('exits 3 with PEER_HOST_DOWN when the host is stopped', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});
			vi.mocked(resolvePeerAgent).mockRejectedValue(hostDown());

			await expect(dispatch(`${PEER}:docs`, 'x', {})).rejects.toThrow('process.exit(3)');

			const payload = printedJson(logSpy)[0];
			expect(payload).toMatchObject({ success: false, code: 'PEER_HOST_DOWN', peer: PEER });
			expect(payload).not.toHaveProperty('exitCode');
		});
	});

	describe('tab verbs with --agent peer:agent', () => {
		const tabs: AITabRecord[] = [
			{ id: 'tab-aaaa1111', state: 'idle' },
			{ id: 'tab-bbbb2222', state: 'idle' },
		];

		it('tab new opens a host tab through the shared action and reports it with the peer', async () => {
			const peer = fakePeer(agentWith(tabs));
			await tabNew({ agent: `${PEER}:docs`, json: true });
			expect(peer.client.tabs.create).toHaveBeenCalledWith(AGENT_ID);
			expect(printedJson(logSpy)[0]).toEqual({
				success: true,
				agentId: AGENT_ID,
				tabId: 'tab-new',
				peer: PEER,
			});
			expect(peer.release).toHaveBeenCalledTimes(1);
		});

		it('tab new refuses --prompt for a peer before dialing it', async () => {
			const peer = fakePeer(agentWith(tabs));
			await expect(tabNew({ agent: `${PEER}:docs`, prompt: 'hi', json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: false,
				error: expect.stringContaining('maestro-cli dispatch'),
			});
			expect(withPeerAgent).not.toHaveBeenCalled();
			expect(peer.client.tabs.create).not.toHaveBeenCalled();
		});

		it('tab rename resolves the tab on the host by prefix and renames it there', async () => {
			const peer = fakePeer(agentWith(tabs));
			await tabRename('tab-bbbb', '  Plan  ', { agent: `${PEER}:docs`, json: true });
			expect(peer.client.tabs.rename).toHaveBeenCalledWith(AGENT_ID, 'tab-bbbb2222', 'Plan');
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: true,
				tabId: 'tab-bbbb2222',
				peer: PEER,
			});
		});

		it('tab star and unstar take "active" as the host agent active tab', async () => {
			const peer = fakePeer(agentWith(tabs));
			await tabStar('active', true, { agent: `${PEER}:docs`, json: true });
			expect(peer.client.tabs.star).toHaveBeenCalledWith(AGENT_ID, 'tab-aaaa1111', true);
			await tabStar('tab-bbbb', false, { agent: `${PEER}:docs`, json: true });
			expect(peer.client.tabs.star).toHaveBeenLastCalledWith(AGENT_ID, 'tab-bbbb2222', false);
		});

		it('names the peer agent when the tab is not on the host, and sends nothing', async () => {
			const peer = fakePeer(agentWith(tabs));
			await expect(tabStar('nope', true, { agent: `${PEER}:docs`, json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(peer.client.tabs.star).not.toHaveBeenCalled();
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: false,
				code: 'PEER_HOST_FAILED',
				peer: PEER,
				error: expect.stringContaining(`${PEER}:${AGENT_ID}`),
			});
		});

		it('reports a dropped connection with its code, exit 3, and no retry', async () => {
			const peer = fakePeer(agentWith(tabs));
			peer.client.tabs.rename.mockResolvedValueOnce({
				ok: false,
				error: { code: 'host-lost', message: 'dropped', method: 'tabs.rename' },
			} as never);
			await expect(
				tabRename('tab-aaaa', 'x', { agent: `${PEER}:docs`, json: true })
			).rejects.toThrow('process.exit(3)');
			expect(peer.client.tabs.rename).toHaveBeenCalledTimes(1);
			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'PEER_CONNECTION_LOST', peer: PEER });
		});
	});

	describe('send', () => {
		it('runs the turn in a new host tab, waits for its outcome, and reports the local shape', async () => {
			const peer = fakePeer(agentWith([]));
			peer.client.turns.send.mockImplementation(async () => {
				queueMicrotask(() => {
					peer.emitTurn({ kind: 'session', at: 1, providerSessionId: 'sess-9' });
					peer.emitTurn({ kind: 'text', at: 2, text: 'All ' });
					peer.emitTurn({ kind: 'text', at: 3, text: 'green.' });
					peer.emitTurn({
						kind: 'usage',
						at: 4,
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							totalCostUsd: 0.01,
							contextWindow: 200000,
						},
					});
					peer.emitTurn({ kind: 'outcome', at: 5, outcome: 'completed', exitCode: 0 });
				});
				return { ok: true, value: { status: 'started' as const } };
			});

			await send(`${PEER}:docs`, 'Status?', {});

			expect(peer.client.tabs.create).toHaveBeenCalledWith(AGENT_ID);
			expect(peer.client.turns.send).toHaveBeenCalledWith(AGENT_ID, 'tab-new', { text: 'Status?' });
			expect(printedJson(logSpy)[0]).toMatchObject({
				agentId: AGENT_ID,
				agentName: 'docs',
				sessionId: 'sess-9',
				response: 'All green.',
				success: true,
				outcome: 'completed',
				usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 },
				peer: PEER,
				tabId: 'tab-new',
			});
			expect(exitSpy).not.toHaveBeenCalled();
			expect(peer.release).toHaveBeenCalledTimes(1);
		});

		it('reports a forward dropped mid-turn as still running on the host, exit 3', async () => {
			const peer = fakePeer(agentWith([]));

			const sending = send(`${PEER}:docs`, 'Long job', {});
			await flush();
			peer.dropLease();

			await expect(sending).rejects.toThrow('process.exit(3)');
			const payload = printedJson(logSpy)[0];
			expect(payload).toMatchObject({
				success: false,
				code: 'PEER_CONNECTION_LOST',
				peer: PEER,
				tabId: 'tab-new',
			});
			expect(String(payload.error)).toContain('still running');
			expect(String(payload.error)).toContain(`maestro-cli show agent ${PEER}:${AGENT_ID}`);
			expect(peer.client.turns.send).toHaveBeenCalledTimes(1);
		});

		it('treats the client losing the host the same way', async () => {
			const peer = fakePeer(agentWith([]));

			const sending = send(`${PEER}:docs`, 'Long job', {});
			await flush();
			peer.loseHost();

			await expect(sending).rejects.toThrow('process.exit(3)');
			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'PEER_CONNECTION_LOST' });
		});

		it('resumes --session in the idle host tab that holds it, and refuses a busy one', async () => {
			const idle = fakePeer(agentWith([{ id: 'tab-s', agentSessionId: 'sess-1', state: 'idle' }]));
			idle.client.turns.send.mockImplementation(async () => {
				queueMicrotask(() =>
					idle.emitTurn({ kind: 'outcome', at: 1, outcome: 'completed', exitCode: 0 })
				);
				return { ok: true, value: { status: 'started' as const } };
			});
			await send(`${PEER}:docs`, 'again', { session: 'sess-1' });
			expect(idle.client.tabs.create).not.toHaveBeenCalled();
			expect(idle.client.turns.send).toHaveBeenCalledWith(AGENT_ID, 'tab-s', { text: 'again' });

			logSpy.mockClear();
			const busy = fakePeer(agentWith([{ id: 'tab-s', agentSessionId: 'sess-1', state: 'busy' }]));
			await expect(send(`${PEER}:docs`, 'again', { session: 'sess-1' })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'TAB_BUSY', tabId: 'tab-s' });
			expect(busy.client.turns.send).not.toHaveBeenCalled();
		});

		it('exits 1 when the host turn crashes', async () => {
			const peer = fakePeer(agentWith([]));
			peer.client.turns.send.mockImplementation(async () => {
				queueMicrotask(() =>
					peer.emitTurn({ kind: 'outcome', at: 1, outcome: 'crashed', exitCode: 1 })
				);
				return { ok: true, value: { status: 'started' as const } };
			});

			await expect(send(`${PEER}:docs`, 'x', {})).rejects.toThrow('process.exit(1)');
			expect(printedJson(logSpy)[0]).toMatchObject({
				success: false,
				outcome: 'crashed',
				peer: PEER,
			});
		});

		it('refuses the flags that change the local run, before dialing the peer', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});

			await expect(send(`${PEER}:docs`, 'x', { readOnly: true })).rejects.toThrow(
				'process.exit(2)'
			);

			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'PEER_UNSUPPORTED_OPTION' });
			expect(String(printedJson(logSpy)[0].error)).toContain('--read-only');
			expect(withPeerAgent).not.toHaveBeenCalled();
		});

		it('reports a stopped host with PEER_HOST_DOWN and exit 3', async () => {
			vi.mocked(routeAgentTarget).mockReturnValue({
				kind: 'peer',
				target: { peer: PEER, agent: 'docs' },
			});
			vi.mocked(withPeerAgent).mockRejectedValue(hostDown());

			await expect(send(`${PEER}:docs`, 'x', {})).rejects.toThrow('process.exit(3)');
			expect(printedJson(logSpy)[0]).toMatchObject({ code: 'PEER_HOST_DOWN', peer: PEER });
		});
	});

	describe('resolver failures on every verb', () => {
		const verbs: Array<{ verb: string; run: () => unknown }> = [
			{ verb: 'show agent', run: () => showAgent(`${PEER}:docs`, { json: true }) },
			{ verb: 'interrupt', run: () => interrupt(`${PEER}:docs`, { json: true }) },
			{ verb: 'ask', run: () => ask(`${PEER}:docs`, 'q', { json: true }) },
			{ verb: 'dispatch', run: () => dispatch(`${PEER}:docs`, 'x', {}) },
			{ verb: 'send', run: () => send(`${PEER}:docs`, 'x', {}) },
		];
		const failures = [
			{
				error: () =>
					new PeerResolveError(
						'unknown-peer',
						`SSH remote not found: ${PEER}`,
						ExitCode.InvalidUsage,
						PEER
					),
				code: 'PEER_UNKNOWN_PEER',
				exitCode: ExitCode.InvalidUsage,
				says: `SSH remote not found: ${PEER}`,
			},
			{
				error: () =>
					new PeerResolveError(
						'federation-off',
						`SSH remote "${PEER}" is not opted in to Federation, so Maestro does not dial it. ` +
							`Turn it on with: maestro-cli update-ssh-remote ${remote.id} --federation on`,
						ExitCode.GeneralError,
						PEER
					),
				code: 'PEER_FEDERATION_OFF',
				exitCode: ExitCode.GeneralError,
				says: '--federation on',
			},
			{
				error: () =>
					new PeerResolveError(
						'agent-not-found',
						`Agent not found: docs (on peer "${PEER}"). ` +
							`List its agents with: maestro-cli list agents --peer ${PEER}`,
						ExitCode.GeneralError,
						PEER
					),
				code: 'PEER_AGENT_NOT_FOUND',
				exitCode: ExitCode.GeneralError,
				says: `maestro-cli list agents --peer ${PEER}`,
			},
		];
		const cases = verbs.flatMap((v) => failures.map((f) => ({ ...v, ...f })));

		it.each(cases)(
			'$verb reports $code with exit $exitCode and the fix',
			async ({ run, error, code, exitCode, says }) => {
				vi.mocked(routeAgentTarget).mockReturnValue({
					kind: 'peer',
					target: { peer: PEER, agent: 'docs' },
				});
				vi.mocked(withPeerAgent).mockRejectedValue(error());
				vi.mocked(resolvePeerAgent).mockRejectedValue(error());

				await Promise.resolve()
					.then(run)
					.catch((thrown: unknown) => {
						// The process.exit stand-in throws; anything else is a real failure.
						if (!String(thrown).includes('process.exit(')) throw thrown;
					});

				expect(exitSpy).toHaveBeenCalledWith(exitCode);
				const payloads = [...printedJson(logSpy), ...printedJson(errorSpy)];
				const payload = payloads.find((p) => p.code === code);
				expect(payload).toMatchObject({ code, peer: PEER });
				expect(String(payload?.error)).toContain(says);
			}
		);
	});
});

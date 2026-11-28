/**
 * The desktop's Move to Host (FED-SSH-06): `liftAgentFromDesktop()` runs the shared lift over the
 * mirror's held client and answers instead of throwing; the pointer goes to the window through
 * `remote:updateSessionConfig`; the deps read main's stores and live processes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestFromRenderer = vi.fn();
vi.mock('../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: (...args: unknown[]) => requestFromRenderer(...args),
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => Boolean(win),
}));
const isAgentBusy = vi.fn((..._args: unknown[]) => false);
vi.mock('../../../main/utils/agent-busy', () => ({
	isAgentBusy: (...args: unknown[]) => isAgentBusy(...args),
}));
// The SSH forward and the WebSocket client behind `connectHostForReturn()`: each lease is one
// `ssh` of ours, live from `acquire()` until its `release()`.
const liveLeases = new Set<object>();
const forwardAcquire = vi.fn((_remote: unknown) => {
	const lease = {
		ready: vi.fn().mockResolvedValue({ port: 4100 }),
		onChange: vi.fn(() => () => {}),
		release: vi.fn(async () => {
			liveLeases.delete(lease);
		}),
	};
	liveLeases.add(lease);
	return lease;
});
vi.mock('../../../shared/maestro-lib/client/ssh-forward', () => ({
	getSshForwardManager: () => ({ acquire: (remote: unknown) => forwardAcquire(remote) }),
}));
const wsConnect = vi.fn();
const wsClose = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../shared/maestro-lib/client/ws-client', () => ({
	createWsMaestroClient: () => ({ connection: { connect: wsConnect, close: wsClose } }),
}));

import {
	LIFT_POINTER_TIMEOUT_MS,
	buildDesktopLiftDeps,
	connectHostForReturn,
	holdHostConnections,
	liftAgentFromDesktop,
	returnAgentFromDesktop,
	setLiftPointerInWindow,
	type DesktopLiftDeps,
} from '../../../main/federation/lift';
import type { PeerMirrorService } from '../../../main/federation/peer-mirror-service';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const NOW = 1_700_000_000_000;

const remote = {
	id: 'remote-1',
	name: 'build-box',
	enabled: true,
	federation: true,
} as SshRemoteConfig;

function sshAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'agent-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/Users/me/placeholder',
		state: 'idle',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1', workingDirOverride: '/home/me' },
		aiTabs: [{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', logs: [] }],
		executionQueue: [{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'next' }],
		...overrides,
	};
}

function fakeService(connected = true) {
	const importAgent = vi
		.fn()
		.mockResolvedValue({ ok: true, value: { agentId: 'host-1', queued: 1 } });
	const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
	const hostClient = vi.fn((remoteId: string) => {
		if (!connected) throw new Error(`Not connected to peer "build-box" (lost). Nothing moved.`);
		expect(remoteId).toBe('remote-1');
		return { peer: 'build-box', client: { agents: { import: importAgent, remove } } };
	});
	return {
		service: { hostClient } as unknown as PeerMirrorService,
		hostClient,
		importAgent,
		remove,
	};
}

function depsWith(overrides: Partial<DesktopLiftDeps> = {}, svc = fakeService()) {
	const deps: DesktopLiftDeps = {
		readAgents: () => [sshAgent()],
		readRemotes: () => [remote],
		readAgentConfigs: () => ({}),
		isAgentRunning: () => false,
		service: () => svc.service,
		setPointer: vi.fn().mockResolvedValue(undefined),
		restore: vi.fn().mockResolvedValue(undefined),
		now: () => NOW,
		...overrides,
	};
	return { deps, ...svc };
}

beforeEach(() => {
	requestFromRenderer.mockReset();
	isAgentBusy.mockReset();
	isAgentBusy.mockReturnValue(false);
});

describe('liftAgentFromDesktop', () => {
	it('refuses while the peer mirror is not running yet', async () => {
		const { deps } = depsWith({ service: () => null });
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: false, code: 'FEDERATION_NOT_RUNNING' });
	});

	it('answers the dry-run plan as maestro-cli lift --dry-run prints it, and moves nothing', async () => {
		const { deps, importAgent } = depsWith();
		const answer = await liftAgentFromDesktop('agent-1', { dryRun: true }, deps);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.result.dryRun).toBe(true);
		expect(answer.planText).toMatch(/^Would lift "Docs" \(claude-code\) onto peer "build-box"/);
		expect(importAgent).not.toHaveBeenCalled();
		expect(deps.setPointer).not.toHaveBeenCalled();
	});

	it('imports over the borrowed client and sets the pointer through the window', async () => {
		const { deps, importAgent, hostClient } = depsWith();
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(hostClient).toHaveBeenCalledWith('remote-1');
		expect(importAgent).toHaveBeenCalledTimes(1);
		expect(deps.setPointer).toHaveBeenCalledWith(
			'agent-1',
			{ peer: 'build-box', agentId: 'host-1', at: NOW },
			['q1']
		);
		expect(answer).toMatchObject({ ok: true, result: { target: 'build-box:host-1' } });
		if (answer.ok) expect(answer.planText).toMatch(/^Lifting "Docs"/);
	});

	it('refuses a peer the mirror is not connected to, without dialing', async () => {
		const { deps } = depsWith({}, fakeService(false));
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: false, code: 'PEER_NOT_CONNECTED' });
		expect(answer.ok ? '' : answer.error).toContain('Nothing moved');
	});

	it('refuses an agent with a running turn', async () => {
		const { deps, hostClient } = depsWith({ isAgentRunning: () => true });
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: false, code: 'LIFT_BUSY' });
		expect(hostClient).not.toHaveBeenCalled();
	});

	it('refuses an agent that is not an SSH agent', async () => {
		const { deps } = depsWith({
			readAgents: () => [sshAgent({ sessionSshRemoteConfig: undefined })],
		});
		expect(await liftAgentFromDesktop('agent-1', {}, deps)).toMatchObject({
			ok: false,
			code: 'LIFT_NOT_SSH',
		});
	});

	it("rolls the host's copy back when the window refuses the pointer", async () => {
		const { deps, remove } = depsWith({
			setPointer: vi.fn().mockRejectedValue(new Error('Agent was already lifted')),
		});
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: false, code: 'LIFT_POINTER_FAILED' });
		expect(remove).toHaveBeenCalledWith('host-1');
	});

	it('sends secret env vars only with withEnv, reading the provider config', async () => {
		const { deps, importAgent } = depsWith({
			readAgentConfigs: () => ({ 'claude-code': { customEnvVars: { ANTHROPIC_API_KEY: 'sk' } } }),
		});
		await liftAgentFromDesktop('agent-1', {}, deps);
		expect(importAgent.mock.calls[0][0].agent.env ?? {}).not.toHaveProperty('ANTHROPIC_API_KEY');
		importAgent.mockClear();
		await liftAgentFromDesktop('agent-1', { withEnv: true }, deps);
		expect(importAgent.mock.calls[0][0].agent.env).toHaveProperty('ANTHROPIC_API_KEY', 'sk');
	});
});

describe('returnAgentFromDesktop', () => {
	const hosted = () =>
		sshAgent({ liftedTo: { peer: 'build-box', agentId: 'host-1', at: NOW } } as never);

	function hostClient() {
		return {
			agents: {
				get: vi.fn().mockResolvedValue({
					ok: true,
					value: { id: 'host-1', activeTabId: 'tab-1', aiTabs: [{ id: 'tab-1', state: 'idle' }] },
				}),
				remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
			},
			tabs: {
				list: vi.fn().mockResolvedValue({ ok: true, value: [{ id: 'tab-1', name: 'Main' }] }),
				transcript: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			},
			turns: { queue: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }) } },
		};
	}

	it('with no mirror running, opens one connection of its own and releases it', async () => {
		const client = hostClient();
		const release = vi.fn().mockResolvedValue(undefined);
		const connectHost = vi.fn().mockResolvedValue({ peer: 'build-box', client, release });
		const restore = vi.fn().mockResolvedValue(undefined);
		const { deps } = depsWith({
			readAgents: () => [hosted()],
			service: () => null,
			connectHost,
			restore,
		});
		const answer = await returnAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: true, result: { hostCopyRemoved: true, tabs: 1 } });
		expect(connectHost).toHaveBeenCalledTimes(1);
		expect(connectHost).toHaveBeenCalledWith('remote-1', 'build-box');
		expect(restore).toHaveBeenCalledWith(
			'agent-1',
			expect.objectContaining({ activeTabId: 'tab-1' })
		);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it('releases its own connection when the host refuses mid-return', async () => {
		const client = hostClient();
		client.tabs.list.mockResolvedValue({ ok: false, error: { code: 'timeout', message: 'gone' } });
		const release = vi.fn().mockResolvedValue(undefined);
		const restore = vi.fn();
		const { deps } = depsWith({
			readAgents: () => [hosted()],
			service: () => null,
			connectHost: vi.fn().mockResolvedValue({ peer: 'build-box', client, release }),
			restore,
		});
		const answer = await returnAgentFromDesktop('agent-1', {}, deps);
		expect(answer.ok).toBe(false);
		expect(restore).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it('answers PEER_NOT_CONNECTED when its own connection cannot be opened', async () => {
		const { deps } = depsWith({
			readAgents: () => [hosted()],
			service: () => null,
			connectHost: vi.fn().mockRejectedValue(new Error('host-down')),
			restore: vi.fn(),
		});
		expect(await returnAgentFromDesktop('agent-1', {}, deps)).toMatchObject({
			ok: false,
			code: 'PEER_NOT_CONNECTED',
		});
	});

	it('refuses with no mirror and no way to connect', async () => {
		const { deps } = depsWith({
			readAgents: () => [hosted()],
			service: () => null,
			restore: vi.fn(),
		});
		expect(await returnAgentFromDesktop('agent-1', {}, deps)).toMatchObject({
			ok: false,
			code: 'FEDERATION_NOT_RUNNING',
		});
	});

	it('runs one return of an agent at a time: a second one waits, then finds it home', async () => {
		const client = hostClient();
		let agent = hosted();
		let opened!: () => void;
		const gate = new Promise<void>((resolve) => (opened = resolve));
		const release = vi.fn().mockResolvedValue(undefined);
		const connectHost = vi.fn(async () => {
			await gate;
			return { peer: 'build-box', client, release };
		});
		const { deps } = depsWith({
			readAgents: () => [agent],
			service: () => null,
			connectHost,
			restore: vi.fn(async () => {
				agent = { ...agent, liftedTo: undefined } as typeof agent;
			}),
		});
		// The come-home job and Move Back from Host, on the same agent at once.
		const first = returnAgentFromDesktop('agent-1', {}, deps);
		const second = returnAgentFromDesktop('agent-1', {}, deps);
		await Promise.resolve();
		opened();
		expect(await first).toMatchObject({ ok: true });
		expect(await second).toMatchObject({ ok: false, code: 'RETURN_NOT_HOSTED' });
		expect(connectHost).toHaveBeenCalledTimes(1);
		expect(client.turns.queue.list).toHaveBeenCalledTimes(2);
	});

	it('borrows the running mirror and never opens a connection of its own', async () => {
		const client = hostClient();
		const connectHost = vi.fn();
		const service = { hostClient: vi.fn(() => ({ peer: 'build-box', client })) };
		const { deps } = depsWith({
			readAgents: () => [hosted()],
			service: () => service as unknown as PeerMirrorService,
			connectHost,
			restore: vi.fn().mockResolvedValue(undefined),
		});
		expect((await returnAgentFromDesktop('agent-1', {}, deps)).ok).toBe(true);
		expect(service.hostClient).toHaveBeenCalledWith('remote-1');
		expect(connectHost).not.toHaveBeenCalled();
	});
});

describe('connectHostForReturn', () => {
	beforeEach(() => {
		liveLeases.clear();
		forwardAcquire.mockClear();
		wsClose.mockClear();
		wsConnect.mockReset();
	});

	it('holds one forward while connected, and no ssh of its own is left after release()', async () => {
		wsConnect.mockResolvedValue({ ok: true, value: undefined });
		const connection = await connectHostForReturn([remote], 'remote-1', 'build-box');
		expect(forwardAcquire).toHaveBeenCalledTimes(1);
		expect(liveLeases.size).toBe(1);
		await connection.release();
		await connection.release();
		expect(wsClose).toHaveBeenCalledTimes(1);
		expect(liveLeases.size).toBe(0);
	});

	it('leaves no forward running when the host does not attach', async () => {
		wsConnect.mockResolvedValue({ ok: false, error: { code: 'timeout', message: 'no answer' } });
		await expect(connectHostForReturn([remote], 'remote-1', 'build-box')).rejects.toThrow();
		expect(forwardAcquire).toHaveBeenCalledTimes(1);
		expect(liveLeases.size).toBe(0);
	});

	it('opens nothing for a remote this machine does not know', async () => {
		await expect(connectHostForReturn([remote], 'gone', 'build-box')).rejects.toThrow(
			/not configured/
		);
		expect(forwardAcquire).not.toHaveBeenCalled();
	});
});

describe('holdHostConnections (R5: one held connection while the job polls)', () => {
	beforeEach(() => {
		liveLeases.clear();
		forwardAcquire.mockClear();
		wsClose.mockClear();
		wsConnect.mockReset();
	});

	const held = () =>
		holdHostConnections((remoteId, peer) => connectHostForReturn([remote], remoteId, peer));

	it('every return on a remote reuses one forward; release(remoteId) leaves no ssh running', async () => {
		wsConnect.mockResolvedValue({ ok: true, value: undefined });
		const connections = held();
		for (let check = 0; check < 4; check++) {
			const connection = await connections.connectHost('remote-1', 'build-box');
			// A return's own release does not end the held connection.
			await connection.release();
		}
		expect(forwardAcquire).toHaveBeenCalledTimes(1);
		expect(liveLeases.size).toBe(1);
		await connections.release('remote-1');
		await connections.release('remote-1');
		expect(wsClose).toHaveBeenCalledTimes(1);
		expect(liveLeases.size).toBe(0);
		// The next return dials again.
		await connections.connectHost('remote-1', 'build-box');
		expect(forwardAcquire).toHaveBeenCalledTimes(2);
		await connections.release('remote-1');
		expect(liveLeases.size).toBe(0);
	});

	it('a connection that never opened is not kept: the next return dials again', async () => {
		wsConnect
			.mockResolvedValueOnce({ ok: false, error: { code: 'timeout', message: 'no answer' } })
			.mockResolvedValue({ ok: true, value: undefined });
		const connections = held();
		await expect(connections.connectHost('remote-1', 'build-box')).rejects.toThrow();
		await connections.connectHost('remote-1', 'build-box');
		expect(forwardAcquire).toHaveBeenCalledTimes(2);
		await connections.release('remote-1');
		expect(liveLeases.size).toBe(0);
	});
});

describe('setLiftPointerInWindow', () => {
	const win = { webContents: {} } as never;
	const pointer = { peer: 'build-box', agentId: 'host-1', at: NOW };

	it('asks the window over remote:updateSessionConfig with the pointer and moved items', async () => {
		requestFromRenderer.mockResolvedValue({ success: true });
		await setLiftPointerInWindow(win, 'agent-1', pointer, ['q1']);
		expect(requestFromRenderer).toHaveBeenCalledWith(
			win,
			'remote:updateSessionConfig',
			expect.objectContaining({
				args: ['agent-1', { liftedTo: pointer, liftedQueueItemIds: ['q1'] }],
				timeoutMs: LIFT_POINTER_TIMEOUT_MS,
			})
		);
	});

	it('throws the refusal, and a missing window', async () => {
		requestFromRenderer.mockResolvedValue({ success: false, error: 'Agent was already lifted' });
		await expect(setLiftPointerInWindow(win, 'agent-1', pointer, [])).rejects.toThrow(
			'Agent was already lifted'
		);
		await expect(setLiftPointerInWindow(null, 'agent-1', pointer, [])).rejects.toThrow(
			'not available'
		);
	});

	it('reads a malformed reply as a refusal', async () => {
		requestFromRenderer.mockImplementation(
			async (_w, _c, options: { parse: (raw: unknown) => unknown }) => options.parse(undefined)
		);
		await expect(setLiftPointerInWindow(win, 'agent-1', pointer, [])).rejects.toThrow(
			'The window sent no answer'
		);
	});
});

describe('buildDesktopLiftDeps', () => {
	it("reads main's stores, tolerating malformed values, and asks the live processes", () => {
		const processManager = { get: vi.fn() };
		const deps = buildDesktopLiftDeps({
			readSessions: () => [sshAgent()],
			readSshRemotes: () => 'not an array',
			readAgentConfigs: () => ['bad'],
			getMainWindow: () => null,
			getProcessManager: () => processManager,
			service: () => null,
		});
		expect(deps.readAgents().map((a) => a.id)).toEqual(['agent-1']);
		expect(deps.readRemotes()).toEqual([]);
		expect(deps.readAgentConfigs()).toEqual({});
		isAgentBusy.mockReturnValue(true);
		expect(deps.isAgentRunning(sshAgent())).toBe(true);
		expect(isAgentBusy).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'agent-1' }),
			processManager
		);
	});
});

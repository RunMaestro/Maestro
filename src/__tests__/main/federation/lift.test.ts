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

import {
	LIFT_POINTER_TIMEOUT_MS,
	buildDesktopLiftDeps,
	liftAgentFromDesktop,
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
	it('refuses while the Federation Encore Feature is off', async () => {
		const { deps } = depsWith({ service: () => null });
		const answer = await liftAgentFromDesktop('agent-1', {}, deps);
		expect(answer).toMatchObject({ ok: false, code: 'PEER_ENCORE_OFF' });
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

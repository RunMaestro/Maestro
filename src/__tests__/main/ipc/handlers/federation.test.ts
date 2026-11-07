/**
 * Tests for the Federation peer mirror IPC (`federation:*`): what each channel answers while the
 * Federation Encore Feature is off (no service), and the pass-throughs and argument checks while
 * it is on, including `federation:act`, the input path to a mirrored agent, and `federation:lift`,
 * Move to Host (FED-SSH-06).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
const requestFromRenderer = vi.fn();
vi.mock('../../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: (...args: unknown[]) => requestFromRenderer(...args),
}));
vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => Boolean(win),
}));
vi.mock('../../../../main/utils/agent-busy', () => ({
	isAgentBusy: () => false,
}));

import { registerFederationHandlers } from '../../../../main/ipc/handlers/federation';
import { setPeerMirrorServiceForTests, type PeerMirrorService } from '../../../../main/federation';
import { encoreDisabledMessage } from '../../../../shared/encoreFeatureDefaults';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';

const liftableAgent: AgentRecord = {
	id: 'agent-1',
	name: 'Docs',
	toolType: 'claude-code',
	cwd: '/home/me',
	state: 'idle',
	sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
	aiTabs: [{ id: 'tab-1', name: 'Main', agentSessionId: 'sess-1', logs: [] }],
};
const mainWindow = { webContents: {} };

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`No handler for ${channel}`);
	return handler({}, ...args);
};

function fakeService() {
	const importAgent = vi.fn(async () => ({ ok: true, value: { agentId: 'host-1', queued: 0 } }));
	return {
		peers: vi.fn(() => [{ peerId: 'a', connection: 'connected', agentCount: 2 }]),
		snapshot: vi.fn(() => ({ peers: [{ peerId: 'a' }] })),
		transcript: vi.fn(async () => [{ id: 'e1' }]),
		reconnect: vi.fn(async (peerId: string) => ({ ok: true, peer: { peerId } })),
		act: vi.fn(async () => ({ ok: true, result: { kind: 'new-tab', tabId: 't9' } })),
		importAgent,
		hostClient: vi.fn(() => ({
			peer: 'build-box',
			client: { agents: { import: importAgent, remove: vi.fn() } },
		})),
	};
}

describe('federation IPC handlers', () => {
	beforeEach(() => {
		handlers.clear();
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				handlers.set(channel, handler);
			}
		);
		setPeerMirrorServiceForTests(null);
		requestFromRenderer.mockReset();
		registerFederationHandlers({
			readSessions: () => [liftableAgent],
			readSshRemotes: () => [
				{ id: 'remote-1', name: 'build-box', enabled: true, federation: true },
			],
			readAgentConfigs: () => ({}),
			getMainWindow: () => mainWindow as never,
			getProcessManager: () => null,
		});
	});

	it('registers the seven federation channels', () => {
		expect([...handlers.keys()].sort()).toEqual([
			'federation:act',
			'federation:lift',
			'federation:peers',
			'federation:reconnect',
			'federation:snapshot',
			'federation:status',
			'federation:transcript',
		]);
	});

	describe('while the Federation Encore Feature is off', () => {
		it('answers disabled and empty, and refuses the calls that need a peer', async () => {
			const off = encoreDisabledMessage('federation');
			expect(await call('federation:status')).toEqual({ enabled: false });
			expect(await call('federation:peers')).toEqual([]);
			expect(await call('federation:snapshot')).toEqual({ peers: [] });
			await expect(call('federation:transcript', 'a', 'x', 't1')).rejects.toThrow(off);
			expect(await call('federation:reconnect', 'a')).toEqual({ ok: false, error: off });
			expect(await call('federation:act', 'a', 'x', { kind: 'new-tab' })).toEqual({
				ok: false,
				error: off,
			});
			expect(await call('federation:lift', 'agent-1', { dryRun: true })).toEqual({
				ok: false,
				code: 'PEER_ENCORE_OFF',
				error: off,
			});
		});
	});

	describe('while it is on', () => {
		let service: ReturnType<typeof fakeService>;

		beforeEach(() => {
			service = fakeService();
			setPeerMirrorServiceForTests(service as unknown as PeerMirrorService);
		});

		it('passes the reads through to the one service', async () => {
			expect(await call('federation:status')).toEqual({ enabled: true });
			expect(await call('federation:peers')).toEqual(service.peers());
			expect(await call('federation:snapshot')).toEqual({ peers: [{ peerId: 'a' }] });
			expect(await call('federation:transcript', 'a', 'x', 't1', { tail: 50 })).toEqual([
				{ id: 'e1' },
			]);
			expect(service.transcript).toHaveBeenCalledWith('a', 'x', 't1', { tail: 50 });
			expect(await call('federation:transcript', 'a', 'x', 't1')).toHaveLength(1);
			expect(service.transcript).toHaveBeenLastCalledWith('a', 'x', 't1', {});
		});

		it('forwards a reconnect and answers with its result', async () => {
			expect(await call('federation:reconnect', 'a')).toEqual({ ok: true, peer: { peerId: 'a' } });
			expect(service.reconnect).toHaveBeenCalledWith('a');
		});

		it('forwards a parsed action and answers with its result', async () => {
			expect(await call('federation:act', 'a', 'x', { kind: 'new-tab' })).toEqual({
				ok: true,
				result: { kind: 'new-tab', tabId: 't9' },
			});
			expect(service.act).toHaveBeenCalledWith('a', 'x', { kind: 'new-tab' });
			await call('federation:act', 'a', 'x', {
				kind: 'rename-tab',
				tabId: 't1',
				name: '  Plan  ',
				extra: 'dropped',
			});
			expect(service.act).toHaveBeenLastCalledWith('a', 'x', {
				kind: 'rename-tab',
				tabId: 't1',
				name: 'Plan',
			});
		});

		it('refuses a bad action before the service is touched', async () => {
			await expect(call('federation:act', 'a', 'x', { kind: 'close-tab' })).rejects.toThrow(
				/Unknown action/
			);
			await expect(
				call('federation:act', 'a', 'x', { kind: 'send', tabId: 't1', text: ' ' })
			).rejects.toThrow(/nothing to send/);
			await expect(
				call('federation:act', 'a', 'x', { kind: 'star-tab', tabId: 't1' })
			).rejects.toThrow(/starred/);
			await expect(call('federation:act', '', 'x', { kind: 'new-tab' })).rejects.toThrow(/peer id/);
			expect(service.act).not.toHaveBeenCalled();
		});

		it('answers a Move to Host dry run with the plan, over the held client', async () => {
			const answer = (await call('federation:lift', 'agent-1', { dryRun: true })) as {
				ok: boolean;
				planText?: string;
			};
			expect(answer.ok).toBe(true);
			expect(answer.planText).toMatch(/^Would lift "Docs"/);
			expect(service.hostClient).toHaveBeenCalledWith('remote-1');
			expect(service.importAgent).not.toHaveBeenCalled();
			expect(requestFromRenderer).not.toHaveBeenCalled();
		});

		it('lifts, then asks the main window to set the pointer', async () => {
			requestFromRenderer.mockResolvedValue({ success: true });
			const answer = await call('federation:lift', 'agent-1', { withEnv: 'yes' });
			expect(answer).toMatchObject({ ok: true, result: { target: 'build-box:host-1' } });
			expect(service.importAgent).toHaveBeenCalledTimes(1);
			expect(requestFromRenderer).toHaveBeenCalledWith(
				mainWindow,
				'remote:updateSessionConfig',
				expect.objectContaining({
					args: [
						'agent-1',
						expect.objectContaining({ liftedTo: expect.objectContaining({ agentId: 'host-1' }) }),
					],
				})
			);
		});

		it('refuses a lift without an agent id', async () => {
			await expect(call('federation:lift', '')).rejects.toThrow(/agent id/);
		});

		it('refuses a missing id or a bad tail before the service is touched', async () => {
			await expect(call('federation:transcript', '', 'x', 't1')).rejects.toThrow(/peer id/);
			await expect(call('federation:transcript', 'a', 7, 't1')).rejects.toThrow(/agent id/);
			await expect(call('federation:transcript', 'a', 'x', undefined)).rejects.toThrow(/tab id/);
			await expect(call('federation:transcript', 'a', 'x', 't1', { tail: -1 })).rejects.toThrow(
				/whole number/
			);
			await expect(call('federation:transcript', 'a', 'x', 't1', { tail: 1.5 })).rejects.toThrow(
				/whole number/
			);
			await expect(call('federation:reconnect', '  ')).rejects.toThrow(/peer id/);
			expect(service.transcript).not.toHaveBeenCalled();
			expect(service.reconnect).not.toHaveBeenCalled();
		});
	});
});

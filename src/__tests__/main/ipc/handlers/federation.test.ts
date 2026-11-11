/**
 * Tests for the Federation peer mirror IPC (`federation:*`): what each channel answers while the
 * peer mirror is not running yet (no service), and the pass-throughs and argument checks while
 * it is on, including `federation:act`, the input path to a mirrored agent, and `federation:lift`,
 * Move to Host (FED-SSH-06).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	app: { getVersion: () => '1.0.0' },
}));
vi.mock('../../../../main/maestro-cli-manager', () => ({
	resolveBundledCliPathSync: () => null,
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
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../../../shared/federationCommands';
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

const HOUR = 3_600_000;
const NOW = Date.now();
/** A mirrored agent's History as the host sends it, newest first. */
const peerHistory = [
	{
		id: 'h1',
		type: 'USER',
		timestamp: NOW - 1 * HOUR,
		summary: 'a',
		projectPath: '/p',
		hostname: 'laptop',
	},
	{ id: 'h2', type: 'AUTO', timestamp: NOW - 2 * HOUR, summary: 'b', projectPath: '/p' },
	{
		id: 'h3',
		type: 'USER',
		timestamp: NOW - 30 * HOUR,
		summary: 'c',
		projectPath: '/p',
		hostname: 'box.host',
	},
];

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
		history: vi.fn(async () => peerHistory),
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
			readAutoMove: () => true,
		});
	});

	it('registers the thirteen federation channels', () => {
		expect([...handlers.keys()].sort()).toEqual([
			'federation:act',
			'federation:autoRun',
			'federation:autoStatus',
			'federation:historyGraph',
			'federation:historyOffset',
			'federation:historyPage',
			'federation:lift',
			'federation:peers',
			'federation:reconnect',
			'federation:setupHost',
			'federation:snapshot',
			'federation:status',
			'federation:transcript',
		]);
	});

	it('answers the automatic Federation snapshot, and runs a pass on request', async () => {
		const status = (await call('federation:autoStatus')) as {
			autoMove: boolean;
			remotes: unknown[];
		};
		expect(status).toMatchObject({ autoMove: true, running: false });
		const ran = (await call('federation:autoRun')) as { lastPassAt?: number };
		expect(typeof ran.lastPassAt).toBe('number');
	});

	describe('while the peer mirror is not running', () => {
		it('answers disabled and empty, and refuses the calls that need a peer', async () => {
			const off = FEDERATION_NOT_RUNNING_MESSAGE;
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
				code: 'FEDERATION_NOT_RUNNING',
				error: off,
			});
			expect(await call('federation:setupHost', 'remote-1', {})).toEqual({
				ok: false,
				code: 'FEDERATION_NOT_RUNNING',
				error: off,
			});
			await expect(call('federation:historyPage', 'a', 'x', {})).rejects.toThrow(off);
			await expect(call('federation:historyGraph', 'a', 'x', 24, null)).rejects.toThrow(off);
			await expect(call('federation:historyOffset', 'a', 'x', NOW, null)).rejects.toThrow(off);
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

		describe('history', () => {
			it('pages the service History newest first, after the lookback and the filters', async () => {
				const all = (await call('federation:historyPage', 'a', 'x')) as {
					entries: Array<{ id: string }>;
					total: number;
				};
				expect(service.history).toHaveBeenCalledWith('a', 'x');
				expect(all.entries.map((e) => e.id)).toEqual(['h1', 'h2', 'h3']);
				expect(all.total).toBe(3);

				const recent = (await call('federation:historyPage', 'a', 'x', {
					lookbackHours: 24,
					types: ['USER', 'NOT_A_TYPE'],
				})) as { entries: Array<{ id: string }> };
				expect(recent.entries.map((e) => e.id)).toEqual(['h1']);

				const local = (await call('federation:historyPage', 'a', 'x', {
					hostKey: '__local__',
				})) as { entries: Array<{ id: string }> };
				expect(local.entries.map((e) => e.id)).toEqual(['h2']);

				const page = (await call('federation:historyPage', 'a', 'x', {
					pagination: { offset: 1, limit: 1 },
				})) as { entries: Array<{ id: string }>; hasMore: boolean };
				expect(page.entries.map((e) => e.id)).toEqual(['h2']);
				expect(page.hasMore).toBe(true);
			});

			it('ignores a malformed query rather than refusing it', async () => {
				const loose = (await call('federation:historyPage', 'a', 'x', {
					lookbackHours: -5,
					types: 'USER',
					hostKey: '',
					pagination: { offset: -1, limit: 1.5 },
				})) as { entries: Array<{ id: string }> };
				expect(loose.entries.map((e) => e.id)).toEqual(['h1', 'h2', 'h3']);
				const none = (await call('federation:historyPage', 'a', 'x', 'garbage')) as {
					entries: unknown[];
				};
				expect(none.entries).toHaveLength(3);
			});

			it('graphs the History with the requested buckets and lookback', async () => {
				const graph = (await call('federation:historyGraph', 'a', 'x', 12, 24)) as {
					bucketCount: number;
					totalCount: number;
					userCount: number;
					autoCount: number;
					cueCount: number;
					cached: boolean;
					hostCounts: Record<string, number>;
				};
				expect(graph.bucketCount).toBe(12);
				expect(graph.totalCount).toBe(2);
				expect(graph).toMatchObject({ userCount: 1, autoCount: 1, cueCount: 0, cached: false });
				expect(graph.hostCounts).toEqual({ laptop: 1, __local__: 1 });
				const whole = (await call('federation:historyGraph', 'a', 'x', 'many', 'all')) as {
					bucketCount: number;
					totalCount: number;
				};
				expect(whole).toMatchObject({ bucketCount: 24, totalCount: 3 });
			});

			it('answers the offset a graph bar jumps to, on the list lookback and types', async () => {
				expect(await call('federation:historyOffset', 'a', 'x', NOW - 90 * 60_000, null)).toBe(1);
				expect(
					await call('federation:historyOffset', 'a', 'x', NOW - 90 * 60_000, null, ['USER'])
				).toBe(1);
				expect(await call('federation:historyOffset', 'a', 'x', NOW - 90 * 60_000, 24)).toBe(1);
				// Older than everything the lookback keeps: the last offset.
				expect(await call('federation:historyOffset', 'a', 'x', NOW - 40 * HOUR, 24)).toBe(1);
			});

			it('refuses a bad id or timestamp before the service is touched', async () => {
				await expect(call('federation:historyPage', '', 'x')).rejects.toThrow(/peer id/);
				await expect(call('federation:historyGraph', 'a', 7, 24, null)).rejects.toThrow(/agent id/);
				await expect(call('federation:historyOffset', 'a', 'x', 'now', null)).rejects.toThrow(
					/timestamp must be a number/
				);
				await expect(call('federation:historyOffset', 'a', 'x', Number.NaN, null)).rejects.toThrow(
					/timestamp must be a number/
				);
				expect(service.history).not.toHaveBeenCalled();
			});
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

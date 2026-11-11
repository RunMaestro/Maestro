/**
 * @file federation.test.ts
 * @description Tests for `maestro-cli federation peers|reconnect`, the CLI half of the desktop's
 * Federation peer mirror. Both send `federation_command` to the desktop and print its answer.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	FEDERATION_AUTO_RUN_TIMEOUT_MS,
	FEDERATION_HEADLESS_MESSAGE,
	FEDERATION_RECONNECT_TIMEOUT_MS,
	federationAuto,
	federationAutoRun,
	federationPeers,
	federationReconnect,
	formatFederationPeers,
} from '../../../cli/commands/federation';
import { UnsupportedCommandError, withMaestroClient } from '../../../cli/services/maestro-client';
import type { FederationCommandResult } from '../../../shared/federationCommands';
import type { MirrorPeerSummary } from '../../../shared/maestro-lib/client/peer-mirror';

const BUILDBOX: MirrorPeerSummary = {
	peerId: 'buildbox',
	remoteId: 'remote-1',
	name: 'buildbox',
	connection: 'connected',
	agentCount: 3,
};
const GPU: MirrorPeerSummary = {
	peerId: 'remote-2',
	remoteId: 'remote-2',
	name: 'gpu',
	connection: 'host-down',
	error: 'No host is running on gpu.\nStart it with: maestro-cli remote-host start gpu',
	agentCount: 1,
};

type Sent = { payload: Record<string, unknown>; responseType: string; timeoutMs?: number };

function mockDesktop(answer: FederationCommandResult | Error): Sent[] {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn(
				(payload: Record<string, unknown>, responseType: string, timeoutMs?: number) => {
					sent.push({ payload, responseType, ...(timeoutMs ? { timeoutMs } : {}) });
					return answer instanceof Error
						? Promise.reject(answer)
						: Promise.resolve({ type: 'federation_command_result', ...answer });
				}
			),
		} as never)
	);
	return sent;
}

describe('federation command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
	const printedErrors = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
	const lastJson = () => JSON.parse(String(logSpy.mock.calls.at(-1)![0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`__exit__${code}`);
		});
	});

	describe('federation peers', () => {
		it('sends a peers federation_command and prints each peer', async () => {
			const sent = mockDesktop({ success: true, peers: [BUILDBOX, GPU] });

			await federationPeers({});

			expect(sent).toEqual([
				{
					payload: { type: 'federation_command', action: 'peers' },
					responseType: 'federation_command_result',
				},
			]);
			expect(printed()).toContain('buildbox');
			expect(printed()).toContain('connected');
			expect(printed()).toContain('3 agents');
			expect(printed()).toContain('remote-2');
			expect(printed()).toContain('(gpu)');
			expect(printed()).toContain('1 agent');
			expect(printed()).toContain('  Start it with: maestro-cli remote-host start gpu');
		});

		it('prints the peers as JSON', async () => {
			mockDesktop({ success: true, peers: [BUILDBOX] });

			await federationPeers({ json: true });

			expect(lastJson()).toEqual({ success: true, peers: [BUILDBOX] });
		});

		it('says how to install a host when nothing is mirrored', async () => {
			mockDesktop({ success: true, peers: [] });

			await federationPeers({});

			expect(printed()).toContain('maestro-cli remote-host install <ssh-remote> --start');
		});

		it('exits 1 with the desktop refusal (Federation off)', async () => {
			mockDesktop({ success: false, error: 'Federation is turned off.' });

			await expect(federationPeers({})).rejects.toThrow('__exit__1');
			expect(printedErrors()).toContain('Federation is turned off.');
		});

		it('explains that a headless host mirrors no peers', async () => {
			mockDesktop(new UnsupportedCommandError('federation_command', 'headless'));

			await expect(federationPeers({ json: true })).rejects.toThrow('__exit__1');
			expect(lastJson()).toEqual({ success: false, error: FEDERATION_HEADLESS_MESSAGE });
		});
	});

	describe('federation reconnect', () => {
		it('sends the peer ref with the reconnect timeout and prints the peer', async () => {
			const sent = mockDesktop({ success: true, peer: BUILDBOX });

			await federationReconnect('BuildBox', {});

			expect(sent).toEqual([
				{
					payload: { type: 'federation_command', action: 'reconnect', peer: 'BuildBox' },
					responseType: 'federation_command_result',
					timeoutMs: FEDERATION_RECONNECT_TIMEOUT_MS,
				},
			]);
			expect(printed()).toContain('Reconnected buildbox');
			expect(printed()).toContain('3 agents');
		});

		it('prints the failed peer and exits 1', async () => {
			mockDesktop({ success: false, error: 'No host is running on gpu.', peer: GPU });

			await expect(federationReconnect('gpu', {})).rejects.toThrow('__exit__1');
			expect(printedErrors()).toContain('host-down');
			expect(printedErrors()).toContain('No host is running on gpu.');
		});

		it('prints the whole reply as JSON, and exits 1 on failure', async () => {
			mockDesktop({ success: true, peer: BUILDBOX });
			await federationReconnect('buildbox', { json: true });
			expect(lastJson()).toEqual({ success: true, peer: BUILDBOX });

			mockDesktop({ success: false, error: 'Not a mirrored peer: nope' });
			await expect(federationReconnect('nope', { json: true })).rejects.toThrow('__exit__1');
			expect(lastJson()).toEqual({ success: false, error: 'Not a mirrored peer: nope' });
		});
	});

	describe('formatFederationPeers', () => {
		it('adds the sync time when the peer has one', () => {
			expect(formatFederationPeers([{ ...BUILDBOX, lastSyncAt: Date.now() }])).toContain('synced');
			expect(formatFederationPeers([BUILDBOX])).not.toContain('synced');
		});
	});

	describe('federation auto', () => {
		const snapshot = {
			autoMove: true,
			running: false,
			lastPassAt: Date.now(),
			remotes: [
				{
					remoteId: 'r1',
					name: 'build-box',
					state: 'ready' as const,
					service: 'systemd user service: runs the host.',
					at: 1,
				},
			],
			agents: [
				{
					agentId: 'a1',
					agentName: 'Docs',
					remoteId: 'r1',
					state: 'blocked' as const,
					reason: 'Claude Code is not available.',
					fix: 'Install Claude Code.',
					at: 1,
				},
			],
		};

		it('prints each remote and agent with its fix, and exits 1 when something needs you', async () => {
			const sent = mockDesktop({ success: true, auto: snapshot });

			await federationAuto({});

			expect(sent[0].payload).toMatchObject({ type: 'federation_command', action: 'auto-status' });
			const text = printed();
			expect(text).toContain('build-box');
			expect(text).toContain('Service: systemd user service: runs the host.');
			expect(text).toContain('Docs');
			expect(text).toContain('To fix: Install Claude Code.');
			expect(process.exitCode).toBe(1);
			process.exitCode = undefined;
		});

		it('runs a pass with a long timeout and prints the JSON', async () => {
			const sent = mockDesktop({ success: true, auto: { ...snapshot, agents: [] } });

			await federationAutoRun({ json: true });

			expect(sent[0]).toMatchObject({
				payload: { action: 'auto-run' },
				timeoutMs: FEDERATION_AUTO_RUN_TIMEOUT_MS,
			});
			expect(lastJson()).toMatchObject({ autoMove: true, agents: [] });
			expect(process.exitCode).toBeUndefined();
		});
	});
});

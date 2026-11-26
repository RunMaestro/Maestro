/**
 * @file remove-agent.test.ts
 * @description Tests for the remove-agent CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

// The peer route: the real router, with the host connection stood in for.
vi.mock('../../../cli/services/peer-resolver', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/peer-resolver')>()),
	withPeerAgent: vi.fn(),
}));

import { removeAgent } from '../../../cli/commands/remove-agent';
import { withPeerAgent } from '../../../cli/services/peer-resolver';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('remove-agent command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should remove an agent successfully', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'delete_session_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await removeAgent('full-ses', {});

		expect(resolveAgentId).toHaveBeenCalledWith('full-ses');
		expect(formatSuccess).toHaveBeenCalledWith(
			'Removed agent full-session-id: its tabs, closed tabs and playbooks are gone and its processes stopped; its History, provider sessions and working directory are kept'
		);
	});

	it('should output JSON on success', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({ type: 'delete_session_result', success: true }),
			};
			return action(mockClient as never);
		});

		await removeAgent('agent-123', { json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.agentId).toBe('agent-123');
	});

	it('should error when agent ID not found', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: xyz');
		});

		await removeAgent('xyz', {});

		expect(formatError).toHaveBeenCalledWith('Agent not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle server failure', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'delete_session_result',
					success: false,
					error: 'Session in use',
				}),
			};
			return action(mockClient as never);
		});

		await removeAgent('agent-id', {});

		expect(formatError).toHaveBeenCalledWith('Session in use');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle connection error', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-id');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

		await removeAgent('agent-id', {});

		expect(formatError).toHaveBeenCalledWith('App not running');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	// T5: the copy a Move Back left on a host (a headless one too) is removed from this machine.
	describe('peer:agent', () => {
		it('removes the agent on the peer host, not on this machine', async () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found');
			});
			const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
			const get = vi.fn().mockResolvedValue({
				ok: true,
				value: { id: 'host-1', name: 'Docs', aiTabs: [{ id: 't1', state: 'idle' }] },
			});
			vi.mocked(withPeerAgent).mockImplementation(async (_target, action) =>
				action({
					agent: { id: 'host-1', name: 'Docs' },
					client: { agents: { get, remove } },
					peer: 'build-box',
				} as never)
			);

			await removeAgent('build-box:host-1', { json: true });

			expect(withPeerAgent).toHaveBeenCalledWith(
				{ peer: 'build-box', agent: 'host-1' },
				expect.any(Function)
			);
			expect(get).toHaveBeenCalledWith('host-1');
			expect(remove).toHaveBeenCalledWith('host-1');
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: true,
				agentId: 'host-1',
				peer: 'build-box',
				removed:
					'its 1 tab, closed tabs and playbooks are gone and its processes stopped; its History, provider sessions and working directory are kept',
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it("reports the host's refusal and exits non-zero", async () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found');
			});
			vi.mocked(withPeerAgent).mockImplementation(async (_target, action) =>
				action({
					agent: { id: 'host-1', name: 'Docs' },
					client: {
						agents: {
							get: async () => ({ ok: true, value: { id: 'host-1', name: 'Docs', aiTabs: [] } }),
							remove: async () => ({
								ok: false,
								error: { code: 'failed', message: 'disk full', method: 'agents.remove' },
							}),
						},
					},
					peer: 'build-box',
				} as never)
			);

			await removeAgent('build-box:host-1', { json: true });

			const out = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(out).toMatchObject({ success: false });
			expect(out.error).toContain('disk full');
			expect(processExitSpy).toHaveBeenCalled();
		});
	});

	// T8: a remove that would cut a running turn is refused unless --force, here and on a peer.
	describe('a running turn', () => {
		const busyAgent = {
			id: 'host-1',
			name: 'Docs',
			aiTabs: [
				{ id: 't1', name: 'Main', state: 'busy' },
				{ id: 't2', state: 'idle' },
			],
		};

		function peerWith(agent: Record<string, unknown>) {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error('Agent not found');
			});
			const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
			vi.mocked(withPeerAgent).mockImplementation(async (_target, action) =>
				action({
					agent: { id: 'host-1', name: 'Docs' },
					client: { agents: { get: async () => ({ ok: true, value: agent }), remove } },
					peer: 'build-box',
				} as never)
			);
			return remove;
		}

		function localWith(sessions: unknown[]) {
			vi.mocked(resolveAgentId).mockReturnValue('host-1');
			const sendCommand = vi.fn(async (message: { type: string }) =>
				message.type === 'get_sessions'
					? { type: 'sessions_list', sessions }
					: { type: 'delete_session_result', success: true }
			);
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({ sendCommand } as never)
			);
			return sendCommand;
		}

		it("refuses to remove a peer's agent that runs a turn, and removes nothing (T8)", async () => {
			const remove = peerWith(busyAgent);
			await removeAgent('build-box:host-1', { json: true });
			expect(remove).not.toHaveBeenCalled();
			const out = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(out.success).toBe(false);
			expect(out.error).toBe(
				'"Docs" on peer "build-box" is running a turn in tab "Main". Removing it stops the turn and loses its answer: wait for it to finish, or stop it, or pass --force to remove it anyway.'
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses an agent the host reads busy as a whole, as a desktop host reports it (T8)', async () => {
			const remove = peerWith({ id: 'host-1', name: 'Docs', state: 'busy', aiTabs: [] });
			await removeAgent('build-box:host-1', { json: true });
			expect(remove).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).error).toMatch(/is running a turn\./);
		});

		it('removes it anyway with --force (T8)', async () => {
			const remove = peerWith(busyAgent);
			await removeAgent('build-box:host-1', { json: true, force: true });
			expect(remove).toHaveBeenCalledWith('host-1');
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).success).toBe(true);
		});

		it('refuses a local agent that runs a turn the same way, and removes it with --force (T8)', async () => {
			const sendCommand = localWith([busyAgent]);
			await removeAgent('host-1', { json: true });
			expect(sendCommand.mock.calls.map(([m]) => m.type)).toEqual(['get_sessions']);
			expect(JSON.parse(consoleSpy.mock.calls[0][0]).error).toBe(
				'Agent host-1 is running a turn in tab "Main". Removing it stops the turn and loses its answer: wait for it to finish, or stop it, or pass --force to remove it anyway.'
			);

			consoleSpy.mockClear();
			const forced = localWith([busyAgent]);
			await removeAgent('host-1', { json: true, force: true });
			expect(forced.mock.calls.map(([m]) => m.type)).toEqual(['get_sessions', 'delete_session']);
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				removed: expect.stringContaining('its 2 tabs'),
			});
		});
	});
});

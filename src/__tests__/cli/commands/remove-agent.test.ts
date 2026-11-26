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
		expect(formatSuccess).toHaveBeenCalledWith('Removed agent full-session-id');
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
			vi.mocked(withPeerAgent).mockImplementation(async (_target, action) =>
				action({
					agent: { id: 'host-1', name: 'Docs' },
					client: { agents: { remove } },
					peer: 'build-box',
				} as never)
			);

			await removeAgent('build-box:host-1', { json: true });

			expect(withPeerAgent).toHaveBeenCalledWith(
				{ peer: 'build-box', agent: 'host-1' },
				expect.any(Function)
			);
			expect(remove).toHaveBeenCalledWith('host-1');
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: true,
				agentId: 'host-1',
				peer: 'build-box',
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
});

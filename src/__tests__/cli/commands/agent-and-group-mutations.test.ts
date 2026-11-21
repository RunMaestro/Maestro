// Source: src/__tests__/cli/commands/remove-agent.test.ts
// Source: src/__tests__/cli/commands/rename-group.test.ts
import { describe as describeSourceSuite, afterEach as cleanupAfterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { removeAgent } from '../../../cli/commands/remove-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';
import { formatSuccess } from '../../../cli/output/formatter';
import { renameGroup } from '../../../cli/commands/rename-group';
import { resolveGroupId } from '../../../cli/services/storage';
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
	vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
	vi.mocked(formatError).mockImplementation((msg) => `Error: ${msg}`);
	vi.mocked(formatSuccess).mockImplementation((msg) => `Success: ${msg}`);
});
cleanupAfterEach(() => vi.restoreAllMocks());
describeSourceSuite('remove-agent', () => {
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
	});
});
describeSourceSuite('rename-group', () => {
	function mockSend(result: Record<string, unknown>) {
		let captured: Record<string, unknown> = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
					captured = payload;
					return Promise.resolve(result);
				}),
			} as never)
		);
		return () => captured;
	}

	describe('rename-group command', () => {
		let processExitSpy: MockInstance;

		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('__exit__');
			});
		});

		it('renames a group and sends groupId + name', async () => {
			const getPayload = mockSend({ success: true });
			await renameGroup('group-1', 'Frontend', {});
			const p = getPayload();
			expect(p.type).toBe('rename_group');
			expect(p.groupId).toBe('group-1');
			expect(p.name).toBe('Frontend');
			expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('Frontend'));
		});

		it('rejects an empty name', async () => {
			await expect(renameGroup('group-1', '  ', {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith('New name must not be empty');
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('fails when the group cannot be resolved', async () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Group not found: nope');
			});
			await expect(renameGroup('nope', 'Name', {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith('Group not found: nope');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('reports a server failure', async () => {
			mockSend({ success: false, error: 'Group renaming not configured' });
			await expect(renameGroup('group-1', 'Name', {})).rejects.toThrow('__exit__');
			expect(formatError).toHaveBeenCalledWith('Group renaming not configured');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});

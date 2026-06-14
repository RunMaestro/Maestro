/**
 * @file remove-group.test.ts
 * @description Tests for the remove-group CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock storage service
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	getSessionsByGroup: vi.fn(() => []),
	readGroups: vi.fn(() => [{ id: 'group-1', name: 'Backend' }]),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { removeGroup } from '../../../cli/commands/remove-group';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveGroupId, getSessionsByGroup } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

function mockDeleteResult(result: { success: boolean; error?: string }) {
	vi.mocked(withMaestroClient).mockImplementation(async (action) => {
		const mockClient = {
			sendCommand: vi.fn().mockResolvedValue({ type: 'delete_group_result', ...result }),
		};
		return action(mockClient as never);
	});
}

describe('remove-group command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		vi.mocked(getSessionsByGroup).mockReturnValue([]);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('successful deletion', () => {
		it('should delete an empty group', async () => {
			mockDeleteResult({ success: true });

			await removeGroup('group-1', {});

			expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('group-1'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should send the resolved group ID in the payload', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({ type: 'delete_group_result', success: true });
					}),
				};
				return action(mockClient as never);
			});

			await removeGroup('group-1', {});

			expect(sentPayload.type).toBe('delete_group');
			expect(sentPayload.groupId).toBe('group-1');
		});

		it('should output JSON when --json flag is set', async () => {
			mockDeleteResult({ success: true });

			await removeGroup('group-1', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.groupId).toBe('group-1');
			expect(parsed.ungrouped).toBe(0);
		});
	});

	describe('non-empty group guard', () => {
		it('should refuse a non-empty group without --force', async () => {
			vi.mocked(getSessionsByGroup).mockReturnValue([{ id: 'a' }, { id: 'b' }] as never);

			await expect(removeGroup('group-1', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('2 agent(s)'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should delete a non-empty group with --force and report ungrouped count', async () => {
			vi.mocked(getSessionsByGroup).mockReturnValue([{ id: 'a' }, { id: 'b' }] as never);
			mockDeleteResult({ success: true });

			await removeGroup('group-1', { force: true });

			expect(withMaestroClient).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Ungrouped 2 agent(s)'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should report ungrouped count in JSON with --force', async () => {
			vi.mocked(getSessionsByGroup).mockReturnValue([{ id: 'a' }] as never);
			mockDeleteResult({ success: true });

			await removeGroup('group-1', { force: true, json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.ungrouped).toBe(1);
		});
	});

	describe('validation and error handling', () => {
		it('should error when the group cannot be resolved', async () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Group not found: nope');
			});

			await expect(removeGroup('nope', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith('Group not found: nope');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle server returning failure', async () => {
			mockDeleteResult({ success: false, error: 'Group deletion not configured' });

			await expect(removeGroup('group-1', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith('Group deletion not configured');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await expect(removeGroup('group-1', { json: true })).rejects.toThrow('__exit__');

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('App not running');
		});
	});
});

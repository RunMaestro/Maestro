/**
 * @file create-group.test.ts
 * @description Tests for the create-group CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createGroup } from '../../../cli/commands/create-group';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('create-group command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('successful creation', () => {
		it('should create a group with just a name', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_group_result',
							success: true,
							groupId: 'group-id-123',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createGroup('My Group', {});

			expect(sentPayload.type).toBe('create_group');
			expect(sentPayload.name).toBe('My Group');
			expect(sentPayload.emoji).toBeUndefined();
			expect(sentPayload).not.toHaveProperty('parentGroupId');
			expect(formatSuccess).toHaveBeenCalledWith('Created group "My Group"');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('group-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should send emoji when provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_group_result',
							success: true,
							groupId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createGroup('Team', { emoji: '🚀' });

			expect(sentPayload.emoji).toBe('🚀');
		});

		it('should send parent group when provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_group_result',
							success: true,
							groupId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createGroup('Project', { parent: 'company' });

			expect(sentPayload.parentGroupId).toBe('company');
		});

		it('should output JSON when --json flag is set', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_group_result',
						success: true,
						groupId: 'json-id',
					}),
				};
				return action(mockClient as never);
			});

			await createGroup('JSON Group', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.groupId).toBe('json-id');
			expect(parsed.name).toBe('JSON Group');
		});
	});

	describe('validation errors', () => {
		it('should reject an empty name', async () => {
			await createGroup('   ', {});

			expect(formatError).toHaveBeenCalledWith('Group name must not be empty');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject an empty name in JSON mode', async () => {
			await createGroup('', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('must not be empty');
		});
	});

	describe('error handling', () => {
		it('should handle server returning failure', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_group_result',
						success: false,
						error: 'Group creation not configured',
					}),
				};
				return action(mockClient as never);
			});

			await createGroup('Nope', {});

			expect(formatError).toHaveBeenCalledWith('Group creation not configured');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await createGroup('No App', {});

			expect(formatError).toHaveBeenCalledWith('App not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await createGroup('No App', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});

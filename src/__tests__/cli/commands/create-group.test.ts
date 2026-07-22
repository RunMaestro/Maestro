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
		// process.exit halts execution in production; model that by throwing so a
		// failed command does not fall through into result processing.
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
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
			await expect(createGroup('   ', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith('Group name must not be empty');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject an empty name in JSON mode', async () => {
			await expect(createGroup('', { json: true })).rejects.toThrow('__exit__');

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

			await expect(createGroup('Nope', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith('Group creation not configured');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await expect(createGroup('No App', {})).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith('App not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await expect(createGroup('No App', { json: true })).rejects.toThrow('__exit__');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});

	describe('appearance (icon/color)', () => {
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

		it('sends normalized icon and uppercased color, echoing the persisted group', async () => {
			const getPayload = mockSend({
				type: 'create_group_result',
				success: true,
				groupId: 'g1',
				group: { id: 'g1', name: 'Team', emoji: '📂', icon: 'rocket', color: '#EF4444' },
			});

			await createGroup('Team', { icon: 'rocket', color: '#ef4444' });

			const p = getPayload();
			expect(p.icon).toBe('rocket');
			expect(p.color).toBe('#EF4444');
			expect(processExitSpy).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rocket'));
		});

		it('accepts plugin-namespaced icon and color IDs', async () => {
			const getPayload = mockSend({
				type: 'create_group_result',
				success: true,
				groupId: 'g2',
				group: {
					id: 'g2',
					name: 'Team',
					emoji: '📂',
					icon: 'com.acme/bright/bolt',
					color: 'com.acme/bright/sun',
				},
			});

			await createGroup('Team', { icon: 'com.acme/bright/bolt', color: 'com.acme/bright/sun' });

			const p = getPayload();
			expect(p.icon).toBe('com.acme/bright/bolt');
			expect(p.color).toBe('com.acme/bright/sun');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('rejects --emoji together with --icon', async () => {
			await expect(createGroup('Team', { emoji: '🚀', icon: 'rocket' })).rejects.toThrow(
				'__exit__'
			);

			expect(formatError).toHaveBeenCalledWith('--emoji and --icon are mutually exclusive');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an invalid icon ID before sending', async () => {
			const getPayload = mockSend({ type: 'create_group_result', success: true, groupId: 'g' });

			await expect(createGroup('Team', { icon: 'not-an-icon' })).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid icon'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(getPayload()).toEqual({}); // never sent
		});

		it('rejects an invalid color before sending', async () => {
			await expect(createGroup('Team', { color: 'red' })).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid color'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('reports a version mismatch when appearance is requested but not echoed', async () => {
			mockSend({ type: 'create_group_result', success: true, groupId: 'g' }); // no group echo

			await expect(createGroup('Team', { icon: 'rocket' })).rejects.toThrow('__exit__');

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('too old'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});

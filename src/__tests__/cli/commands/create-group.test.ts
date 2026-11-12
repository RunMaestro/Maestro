/**
 * @file create-group.test.ts
 * @description Tests for the create-group CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group } from '../../../shared/types';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => undefined),
	readGroups: vi.fn(() => [] as Group[]),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createGroup } from '../../../cli/commands/create-group';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readGroups, resolveGroupId } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

/** Capture the payload the command sends, and reply with `result`. */
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

/** Pretend the desktop persisted this group, so the readback check passes. */
function persisted(group: Partial<Group> & { id: string }): void {
	vi.mocked(readGroups).mockReturnValue([
		{ name: 'GROUP', emoji: '\u{1F4C2}', collapsed: false, ...group } as Group,
	]);
}

describe('create-group command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		vi.mocked(readGroups).mockReturnValue([]);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('successful creation', () => {
		it('should create a group with just a name', async () => {
			const payload = mockSend({
				type: 'create_group_result',
				success: true,
				groupId: 'group-id-123',
			});
			persisted({ id: 'group-id-123', name: 'MY GROUP' });

			await createGroup('My Group', {});

			expect(payload().type).toBe('create_group');
			expect(payload().name).toBe('My Group');
			expect(payload().emoji).toBeUndefined();
			expect(payload()).not.toHaveProperty('parentGroupId');
			expect(formatSuccess).toHaveBeenCalledWith('Created group "My Group"');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('group-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should send emoji when provided', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			persisted({ id: 'id-1', name: 'TEAM', emoji: '🚀' });

			await createGroup('Team', { emoji: '🚀' });

			expect(payload().emoji).toBe('🚀');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should send a built-in icon and normalize its case', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			persisted({ id: 'id-1', name: 'TEAM', icon: 'rocket' });

			await createGroup('Team', { icon: 'Rocket' });

			expect(payload().icon).toBe('rocket');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should uppercase a hex color before sending it', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			persisted({ id: 'id-1', name: 'TEAM', color: '#EF4444' });

			await createGroup('Team', { color: '#ef4444' });

			expect(payload().color).toBe('#EF4444');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should accept a plugin-namespaced icon id', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			persisted({ id: 'id-1', name: 'TEAM', icon: 'my-plugin/my-pack/my-icon' });

			await createGroup('Team', { icon: 'my-plugin/my-pack/my-icon' });

			expect(payload().icon).toBe('my-plugin/my-pack/my-icon');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should combine an icon with a color', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			persisted({ id: 'id-1', name: 'TEAM', icon: 'shield', color: '#22C55E' });

			await createGroup('Team', { icon: 'shield', color: '#22c55e' });

			expect(payload().icon).toBe('shield');
			expect(payload().color).toBe('#22C55E');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should resolve a partial parent group ID', async () => {
			const payload = mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			vi.mocked(resolveGroupId).mockReturnValue('group-company-full');
			persisted({ id: 'id-1', name: 'PROJECT', parentGroupId: 'group-company-full' });

			await createGroup('Project', { parent: 'company' });

			expect(resolveGroupId).toHaveBeenCalledWith('company');
			expect(payload().parentGroupId).toBe('group-company-full');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should output the persisted group when --json is set', async () => {
			mockSend({ type: 'create_group_result', success: true, groupId: 'json-id' });
			persisted({ id: 'json-id', name: 'JSON GROUP', icon: 'star', color: '#3B82F6' });

			await createGroup('JSON Group', { json: true, icon: 'star', color: '#3b82f6' });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.groupId).toBe('json-id');
			expect(parsed.group).toMatchObject({ icon: 'star', color: '#3B82F6' });
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

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('must not be empty');
		});

		it('should reject --emoji and --icon together', async () => {
			await createGroup('Team', { emoji: '🚀', icon: 'rocket' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not both'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should reject an unknown icon before sending anything', async () => {
			await createGroup('Team', { icon: 'not-an-icon' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown icon'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should reject a malformed color before sending anything', async () => {
			await createGroup('Team', { color: 'reddish' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid color'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should fail without sending when the parent cannot be resolved', async () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Group not found: nope');
			});

			await createGroup('Project', { parent: 'nope' });

			expect(formatError).toHaveBeenCalledWith('Group not found: nope');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('version-mismatch guard', () => {
		it('should fail when the desktop reported success but stored no icon', async () => {
			mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			// An older desktop accepts create_group and drops the icon field.
			persisted({ id: 'id-1', name: 'TEAM' });

			await createGroup('Team', { icon: 'rocket' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not stored as requested'));
			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('older than this CLI'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should fail when the group is missing entirely after the write', async () => {
			mockSend({ type: 'create_group_result', success: true, groupId: 'id-1' });
			vi.mocked(readGroups).mockReturnValue([]);

			await createGroup('Team', {});

			expect(formatError).toHaveBeenCalledWith(
				expect.stringContaining('was not found after the write')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('error handling', () => {
		it('should handle server returning failure', async () => {
			mockSend({
				type: 'create_group_result',
				success: false,
				error: 'Group creation not configured',
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

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});

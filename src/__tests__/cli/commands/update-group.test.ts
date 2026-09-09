/**
 * @file update-group.test.ts
 * @description Tests for the update-group CLI command: flag parsing, explicit
 * clearing, reparenting, and the readback guard that stops the command
 * reporting success when the desktop silently ignored a field.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group } from '../../../shared/types';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => undefined),
	readGroups: vi.fn(() => [] as Group[]),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateGroup } from '../../../cli/commands/update-group';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readGroups, resolveGroupId } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

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

function persisted(group: Partial<Group> & { id: string }): void {
	vi.mocked(readGroups).mockReturnValue([
		{ name: 'TEAM', emoji: '\u{1F4C2}', collapsed: false, ...group } as Group,
	]);
}

describe('update-group command', () => {
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

	describe('setting fields', () => {
		it('should send a rename as update_group', async () => {
			const payload = mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1', name: 'NEW NAME' });

			await updateGroup('g1', { name: 'New Name' });

			expect(payload().type).toBe('update_group');
			expect(payload().groupId).toBe('g1');
			expect(payload().name).toBe('New Name');
			expect(formatSuccess).toHaveBeenCalledWith('Updated group g1');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should normalize icon case and color case before sending', async () => {
			const payload = mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1', icon: 'briefcase', color: '#A855F7' });

			await updateGroup('g1', { icon: 'Briefcase', color: '#a855f7' });

			expect(payload().icon).toBe('briefcase');
			expect(payload().color).toBe('#A855F7');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should resolve a partial parent group ID', async () => {
			const payload = mockSend({ type: 'update_group_result', success: true });
			vi.mocked(resolveGroupId).mockImplementation((id: string) =>
				id === 'comp' ? 'group-company' : id
			);
			persisted({ id: 'g1', parentGroupId: 'group-company' });

			await updateGroup('g1', { parent: 'comp' });

			expect(payload().parentGroupId).toBe('group-company');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should output the persisted group when --json is set', async () => {
			mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1', name: 'TEAM', icon: 'zap', color: '#EAB308' });

			await updateGroup('g1', { json: true, icon: 'zap', color: '#eab308' });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.groupId).toBe('g1');
			expect(parsed.group).toMatchObject({ icon: 'zap', color: '#EAB308' });
		});
	});

	describe('clearing fields', () => {
		it('should send an explicit clear list', async () => {
			const payload = mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1' });

			await updateGroup('g1', { clearIcon: true, clearColor: true });

			expect(payload().clear).toEqual(['icon', 'color']);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should promote to top level when --clear-parent is passed', async () => {
			const payload = mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1' });

			await updateGroup('g1', { clearParent: true });

			expect(payload().clear).toEqual(['parent']);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should accept a cleared emoji that fell back to the default folder', async () => {
			mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1', emoji: '\u{1F4C2}' });

			await updateGroup('g1', { clearEmoji: true });

			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should fail when a cleared field is still stored', async () => {
			mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1', color: '#EF4444' });

			await updateGroup('g1', { clearColor: true });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('color is still #EF4444'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('validation errors', () => {
		it('should reject an update that changes nothing', async () => {
			await updateGroup('g1', {});

			expect(formatError).toHaveBeenCalledWith('Nothing to update');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should reject --emoji together with --icon', async () => {
			await updateGroup('g1', { emoji: '🚀', icon: 'rocket' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not both'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should reject setting and clearing the same field', async () => {
			await updateGroup('g1', { color: '#EF4444', clearColor: true });

			expect(formatError).toHaveBeenCalledWith('Cannot both set and clear color');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should reject an unknown icon before sending anything', async () => {
			await updateGroup('g1', { icon: 'sparkle-pony' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Unknown icon'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('should fail when the group ID cannot be resolved', async () => {
			vi.mocked(resolveGroupId).mockImplementation(() => {
				throw new Error('Group not found: zz');
			});

			await updateGroup('zz', { name: 'X' });

			expect(formatError).toHaveBeenCalledWith('Group not found: zz');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('version-mismatch guard', () => {
		it('should fail when the desktop reported success but stored no color', async () => {
			mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1' });

			await updateGroup('g1', { color: '#EF4444' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not stored as requested'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should fail when the reparent did not take', async () => {
			mockSend({ type: 'update_group_result', success: true });
			persisted({ id: 'g1' });

			await updateGroup('g1', { parent: 'group-company' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('parent is (top level)'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('error handling', () => {
		it('should report a desktop-side rejection', async () => {
			mockSend({ type: 'update_group_result', success: false, error: 'Group not found' });

			await updateGroup('g1', { name: 'X' });

			expect(formatError).toHaveBeenCalledWith('Group not found');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should report a connection failure in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await updateGroup('g1', { name: 'X', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});

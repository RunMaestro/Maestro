/**
 * @file update-group.test.ts
 * @description Tests for the update-group CLI command (name/appearance/parent
 * updates, explicit clearing, validation, and version-mismatch handling).
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async () => {
	const actual = await vi.importActual<typeof import('../../../cli/services/maestro-client')>(
		'../../../cli/services/maestro-client'
	);
	return { ...actual, withMaestroClient: vi.fn() };
});
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateGroup } from '../../../cli/commands/update-group';
import { withMaestroClient, UnsupportedCommandError } from '../../../cli/services/maestro-client';
import { resolveGroupId } from '../../../cli/services/storage';
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

function mockReject(error: Error) {
	vi.mocked(withMaestroClient).mockRejectedValue(error);
}

describe('update-group command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('updates the name and echoes the persisted group', async () => {
		const getPayload = mockSend({
			type: 'update_group_result',
			success: true,
			groupId: 'g1',
			group: { id: 'g1', name: 'FRONTEND', emoji: '📂' },
		});

		await updateGroup('g1', { name: 'frontend' });

		const p = getPayload();
		expect(p.type).toBe('update_group');
		expect(p.groupId).toBe('g1');
		expect(p.name).toBe('frontend');
		expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('g1'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('sends normalized icon + color', async () => {
		const getPayload = mockSend({
			type: 'update_group_result',
			success: true,
			groupId: 'g1',
			group: { id: 'g1', name: 'TEAM', emoji: '📂', icon: 'rocket', color: '#EF4444' },
		});

		await updateGroup('g1', { icon: 'rocket', color: '#ef4444' });

		const p = getPayload();
		expect(p.icon).toBe('rocket');
		expect(p.color).toBe('#EF4444');
	});

	it('sends explicit clear flags', async () => {
		const getPayload = mockSend({
			type: 'update_group_result',
			success: true,
			groupId: 'g1',
			group: { id: 'g1', name: 'TEAM', emoji: '📂' },
		});

		await updateGroup('g1', { clearIcon: true, clearColor: true, clearParent: true });

		const p = getPayload();
		expect(p.clear).toEqual(['icon', 'color', 'parent']);
	});

	it('resolves and sends a new parent', async () => {
		const getPayload = mockSend({
			type: 'update_group_result',
			success: true,
			groupId: 'child',
			group: { id: 'child', name: 'CHILD', emoji: '📂', parentGroupId: 'parent' },
		});

		await updateGroup('child', { parent: 'parent' });

		expect(getPayload().parentGroupId).toBe('parent');
	});

	it('rejects a no-op update', async () => {
		await expect(updateGroup('g1', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('No updates specified'));
	});

	it('rejects setting and clearing the same field', async () => {
		await expect(updateGroup('g1', { icon: 'rocket', clearIcon: true })).rejects.toThrow(
			'__exit__'
		);
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Cannot combine --icon'));
	});

	it('rejects --emoji together with --icon', async () => {
		await expect(updateGroup('g1', { emoji: '🚀', icon: 'rocket' })).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('--emoji and --icon are mutually exclusive');
	});

	it('rejects making a group its own parent', async () => {
		await expect(updateGroup('g1', { parent: 'g1' })).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('its own parent'));
	});

	it('reports a version mismatch when the desktop does not support update_group', async () => {
		mockReject(new UnsupportedCommandError('update_group'));

		await expect(updateGroup('g1', { name: 'x' })).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('too old'));
	});

	it('reports a version mismatch when appearance is requested but not echoed', async () => {
		mockSend({ type: 'update_group_result', success: true, groupId: 'g1' }); // no group echo

		await expect(updateGroup('g1', { icon: 'rocket' })).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('too old'));
	});

	it('surfaces a server-reported failure', async () => {
		mockSend({ type: 'update_group_result', success: false, error: 'Group not found' });

		await expect(updateGroup('missing', { name: 'x' })).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Group not found');
	});

	it('outputs JSON when --json is set', async () => {
		mockSend({
			type: 'update_group_result',
			success: true,
			groupId: 'g1',
			group: { id: 'g1', name: 'TEAM', emoji: '📂', icon: 'rocket' },
		});

		await updateGroup('g1', { icon: 'rocket', json: true });

		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.success).toBe(true);
		expect(parsed.group.icon).toBe('rocket');
	});
});

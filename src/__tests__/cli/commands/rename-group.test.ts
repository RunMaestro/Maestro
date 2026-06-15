/**
 * @file rename-group.test.ts
 * @description Tests for the rename-group CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { renameGroup } from '../../../cli/commands/rename-group';
import { withMaestroClient } from '../../../cli/services/maestro-client';
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

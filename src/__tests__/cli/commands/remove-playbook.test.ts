/**
 * @file remove-playbook.test.ts
 * @description Tests for the remove-playbook CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { removePlaybook } from '../../../cli/commands/remove-playbook';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

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

describe('remove-playbook command', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends delete_playbook with sessionId + playbookId', async () => {
		const getPayload = mockSend({ success: true });
		await removePlaybook('agent-1', 'pb-42', {});
		const p = getPayload();
		expect(p.type).toBe('delete_playbook');
		expect(p.sessionId).toBe('agent-1');
		expect(p.playbookId).toBe('pb-42');
	});

	it('rejects an empty playbook id', async () => {
		await expect(removePlaybook('agent-1', '   ', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Playbook ID must not be empty');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Playbook deletion not configured' });
		await expect(removePlaybook('agent-1', 'pb-1', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Playbook deletion not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

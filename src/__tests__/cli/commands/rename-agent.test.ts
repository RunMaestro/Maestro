/**
 * @file rename-agent.test.ts
 * @description Tests for the rename-agent CLI command
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

import { renameAgent } from '../../../cli/commands/rename-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
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

describe('rename-agent command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('renames an agent and sends the correct payload', async () => {
		const getPayload = mockSend({ success: true });

		await renameAgent('agent-1', 'New Name', {});

		const p = getPayload();
		expect(p.type).toBe('rename_session');
		expect(p.sessionId).toBe('agent-1');
		expect(p.newName).toBe('New Name');
		expect(formatSuccess).toHaveBeenCalledWith(expect.stringContaining('New Name'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('trims the new name', async () => {
		const getPayload = mockSend({ success: true });
		await renameAgent('agent-1', '  Trimmed  ', {});
		expect(getPayload().newName).toBe('Trimmed');
	});

	it('rejects an empty name without opening a connection', async () => {
		await expect(renameAgent('agent-1', '   ', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('New name must not be empty');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects a name longer than 100 characters', async () => {
		await expect(renameAgent('agent-1', 'x'.repeat(101), {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('New name must be 100 characters or less');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('fails when the agent cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: nope');
		});
		await expect(renameAgent('nope', 'Name', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Agent not found: nope');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Session renaming not configured' });
		await expect(renameAgent('agent-1', 'Name', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Session renaming not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('emits JSON on success', async () => {
		mockSend({ success: true });
		await renameAgent('agent-1', 'Name', { json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(parsed.success).toBe(true);
		expect(parsed.sessionId).toBe('agent-1');
	});
});

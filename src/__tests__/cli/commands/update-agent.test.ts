/**
 * @file update-agent.test.ts
 * @description Tests for the update-agent CLI command (group + cwd mutation).
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	resolveGroupId: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateAgent } from '../../../cli/commands/update-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, resolveGroupId } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('update-agent command', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('errors when neither --group nor --cwd is provided', async () => {
		await updateAgent('agent-1', {});

		expect(formatError).toHaveBeenCalledWith('Specify at least one of --group or --cwd');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends move_session_to_group when --group is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp' });

		expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
		expect(resolveGroupId).toHaveBeenCalledWith('grp');
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'move_session_to_group',
				sessionId: 'full-session-id',
				groupId: 'full-group-id',
			}),
			'move_session_to_group_result'
		);
		expect(formatSuccess).toHaveBeenCalledWith('Updated agent full-session-id');
	});

	it('treats --group none as ungroup (null) without calling resolveGroupId', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'move_session_to_group_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'none' });

		expect(resolveGroupId).not.toHaveBeenCalled();
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'move_session_to_group', groupId: null }),
			'move_session_to_group_result'
		);
	});

	it('sends update_session_cwd with absolute resolved path', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_cwd_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/some/path' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_cwd',
				sessionId: 'full-session-id',
				newCwd: '/tmp/some/path',
			}),
			'update_session_cwd_result'
		);
	});

	it('fans out to both messages when --group and --cwd are both provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo' });

		expect(sendCommand).toHaveBeenCalledTimes(2);
		expect(sendCommand.mock.calls[0][0].type).toBe('move_session_to_group');
		expect(sendCommand.mock.calls[1][0].type).toBe('update_session_cwd');
	});

	it('surfaces the renderer error when cwd update is refused (agent running)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const sendCommand = vi.fn().mockResolvedValue({
				type: 'update_session_cwd_result',
				success: false,
				error: 'Agent process is running; stop it before changing cwd',
			});
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { cwd: '/tmp/foo' });

		expect(formatError).toHaveBeenCalledWith(
			'Agent process is running; stop it before changing cwd'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('emits JSON on success when --json is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(resolveGroupId).mockReturnValue('full-group-id');
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'move_session_to_group_result', success: true })
			.mockResolvedValueOnce({ type: 'update_session_cwd_result', success: true });
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { group: 'grp', cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({
			success: true,
			agentId: 'full-session-id',
			group: 'full-group-id',
			cwd: '/tmp/foo',
		});
	});

	it('errors when agent ID cannot be resolved', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: xyz');
		});

		await updateAgent('xyz', { group: 'grp' });

		expect(formatError).toHaveBeenCalledWith('Agent not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('errors when --json is set and command fails', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection lost'));

		await updateAgent('agent-1', { cwd: '/tmp/foo', json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed).toMatchObject({ success: false, error: 'Connection lost' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

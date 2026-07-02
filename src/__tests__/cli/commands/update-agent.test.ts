/**
 * @file update-agent.test.ts
 * @description Tests for the update-agent CLI command (group + cwd mutation).
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import path from 'path';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	resolveGroupId: vi.fn(),
	getSessionById: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateAgent } from '../../../cli/commands/update-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../../../cli/services/storage';
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

	it('errors when no mutable field is provided', async () => {
		await updateAgent('agent-1', {});

		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('Specify at least one field to update')
		);
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
				newCwd: path.resolve('/tmp/some/path'),
			}),
			'update_session_cwd_result'
		);
	});

	it('sends update_session_ssh enabling a remote with --ssh-remote and --ssh-cwd', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'remote-7', sshCwd: '/srv/app' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sessionId: 'full-session-id',
				sshPatch: { enabled: true, remoteId: 'remote-7', workingDirOverride: '/srv/app' },
			}),
			'update_session_ssh_result'
		);
	});

	it('treats --ssh-remote none as reverting to local (enabled:false, remoteId:null)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { sshRemote: 'none' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { enabled: false, remoteId: null },
			}),
			'update_session_ssh_result'
		);
	});

	it('maps --sync-history-to-remote to a syncHistory-only patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_ssh_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'true' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_ssh',
				sshPatch: { syncHistory: true },
			}),
			'update_session_ssh_result'
		);
	});

	it('sends update_session_config for editable settings (nudge, model, env)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', {
			nudge: 'stay focused',
			model: 'opus',
			env: ['FOO=bar', 'BAZ=qux'],
		});

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				sessionId: 'full-session-id',
				configPatch: {
					nudgeMessage: 'stay focused',
					customModel: 'opus',
					customEnvVars: { FOO: 'bar', BAZ: 'qux' },
				},
			}),
			'update_session_config_result'
		);
	});

	it('maps an empty-string text field to a null clear in the config patch', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { nudge: '' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { nudgeMessage: null },
			}),
			'update_session_config_result'
		);
	});

	it('encodes --token-source tui as the enableMaestroP/maestroPMode pair', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'tui' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				configPatch: { enableMaestroP: true, maestroPMode: 'interactive' },
			}),
			'update_session_config_result'
		);
	});

	it('rejects an invalid --token-source value before contacting the app', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand } as never);
		});

		await updateAgent('agent-1', { tokenSource: 'bogus' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--token-source expects'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('rejects --token-source on a non-Claude agent', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'codex',
		} as never);
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { tokenSource: 'tui' });

		// The guard fires before any send (in production process.exit terminates;
		// the test's exit mock is a no-op, so we assert the guard itself fired).
		expect(formatError).toHaveBeenCalledWith(
			expect.stringContaining('only applies to Claude Code agents')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('refuses --provider without --force', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn();
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex' });

		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--force to confirm'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends a toolType patch for --provider with --force', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'full-session-id',
			toolType: 'claude-code',
		} as never);
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'update_session_config_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);

		await updateAgent('agent-1', { provider: 'codex', force: true });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'update_session_config',
				sessionId: 'full-session-id',
				configPatch: { toolType: 'codex' },
			}),
			'update_session_config_result'
		);
	});

	it('rejects a non-boolean --sync-history-to-remote value', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('full-session-id');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			return action({ sendCommand: vi.fn() } as never);
		});

		await updateAgent('agent-1', { syncHistoryToRemote: 'maybe' });

		expect(formatError).toHaveBeenCalledWith(
			'--sync-history-to-remote expects true or false, got "maybe"'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
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
			cwd: path.resolve('/tmp/foo'),
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

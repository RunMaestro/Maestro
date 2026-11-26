/**
 * @file claude-slash-command-probe.test.ts
 * @description Tests for src/main/agents/claude-slash-command-probe.ts - the
 * zero-token `/help` probe that fills the slash-command list for agents whose
 * turns run through maestro-p (whose TUI announces no commands).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(
		async (_remote: unknown, options: { command: string; args: string[] }) => ({
			command: 'ssh',
			args: ['box', options.command, ...options.args],
		})
	),
	execSshCommand: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildSshCommand, execSshCommand } from '../../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	clearClaudeSlashCommandCache,
	parseInitSlashCommands,
	probeClaudeSlashCommands,
	probeClaudeSlashCommandsCached,
	probeClaudeSlashCommandsRemoteCached,
} from '../../../main/agents/claude-slash-command-probe';

const initLine = (commands: string[]) =>
	JSON.stringify({ type: 'system', subtype: 'init', slash_commands: commands }) + '\n';

beforeEach(() => {
	vi.mocked(execFileNoThrow).mockReset();
	vi.mocked(execSshCommand).mockReset();
	vi.mocked(buildSshCommand).mockClear();
	clearClaudeSlashCommandCache();
});

describe('parseInitSlashCommands', () => {
	it('reads the commands from the init event among other lines', () => {
		const stdout = 'warning: something\n' + initLine(['/help', '/compact']) + '{"type":"result"}\n';
		expect(parseInitSlashCommands(stdout)).toEqual(['/help', '/compact']);
	});

	it('returns null when no init event names commands', () => {
		expect(parseInitSlashCommands('{"type":"result"}\n')).toBeNull();
		expect(parseInitSlashCommands('')).toBeNull();
	});
});

describe('probeClaudeSlashCommands', () => {
	// A probe that persisted its session would leave a stray `/help` transcript
	// in the folder's session list every time it ran.
	it('runs /help without persisting a session', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toEqual(['/help']);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/bin/claude',
			[
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
				'--no-session-persistence',
				'--',
				'/help',
			],
			'/proj'
		);
	});

	it('passes the environment it is given', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});
		const env = { CLAUDE_CONFIG_DIR: '/cfg' };

		await probeClaudeSlashCommands('/bin/claude', '/proj', env);

		expect(execFileNoThrow).toHaveBeenCalledWith('/bin/claude', expect.any(Array), '/proj', {
			env,
		});
	});

	it('asks again without the flag when claude is too old to know it', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({
				stdout: '',
				stderr: "error: unknown option '--no-session-persistence'",
				exitCode: 1,
			})
			.mockResolvedValueOnce({ stdout: initLine(['/help']), stderr: '', exitCode: 0 });

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toEqual(['/help']);
		expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).not.toContain('--no-session-persistence');
	});

	it('returns null when claude fails with no output', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toBeNull();
	});
});

describe('probeClaudeSlashCommandsCached', () => {
	it('probes once per binary, folder, and config dir', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});

		const env = { CLAUDE_CONFIG_DIR: '/cfg-a' };
		await Promise.all([
			probeClaudeSlashCommandsCached('/bin/claude', '/proj', env),
			probeClaudeSlashCommandsCached('/bin/claude', '/proj', env),
		]);
		await probeClaudeSlashCommandsCached('/bin/claude', '/proj', env);
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);

		await probeClaudeSlashCommandsCached('/bin/claude', '/proj', { CLAUDE_CONFIG_DIR: '/cfg-b' });
		await probeClaudeSlashCommandsCached('/bin/claude', '/other', env);
		expect(execFileNoThrow).toHaveBeenCalledTimes(3);
	});

	it('does not cache a failed probe', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1 })
			.mockResolvedValueOnce({ stdout: initLine(['/help']), stderr: '', exitCode: 0 });

		const env = {};
		await expect(probeClaudeSlashCommandsCached('/bin/claude', '/proj', env)).resolves.toBeNull();
		await expect(probeClaudeSlashCommandsCached('/bin/claude', '/proj', env)).resolves.toEqual([
			'/help',
		]);
	});
});

describe('probeClaudeSlashCommandsRemoteCached', () => {
	const remote = (id: string) =>
		({
			id,
			name: id,
			host: `${id}.example.com`,
			remoteEnv: { FOO: '1' },
		}) as unknown as SshRemoteConfig;

	it('runs the probe on the remote, in the folder there, never on this machine', async () => {
		vi.mocked(execSshCommand).mockResolvedValue({
			stdout: '\u001b[?25l' + initLine(['/help', '/deploy']).replace('\n', '\r\n'),
			stderr: '',
			exitCode: 0,
		});

		await expect(
			probeClaudeSlashCommandsRemoteCached(remote('box'), 'claude', '/srv/project')
		).resolves.toEqual(['/help', '/deploy']);
		expect(buildSshCommand).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'box' }),
			expect.objectContaining({
				command: 'claude',
				cwd: '/srv/project',
				env: { FOO: '1' },
				args: expect.arrayContaining(['--print', '--no-session-persistence', '--', '/help']),
			})
		);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('probes each remote once, and never shares one list between remotes', async () => {
		vi.mocked(execSshCommand).mockImplementation(async (config) => ({
			stdout: initLine([`/${(config as SshRemoteConfig).id}-only`]),
			stderr: '',
			exitCode: 0,
		}));

		const a = await probeClaudeSlashCommandsRemoteCached(remote('a'), 'claude', '/srv/p');
		const again = await probeClaudeSlashCommandsRemoteCached(remote('a'), 'claude', '/srv/p');
		const b = await probeClaudeSlashCommandsRemoteCached(remote('b'), 'claude', '/srv/p');
		expect(a).toEqual(['/a-only']);
		expect(again).toEqual(['/a-only']);
		expect(b).toEqual(['/b-only']);
		expect(execSshCommand).toHaveBeenCalledTimes(2);
	});

	it("probes with the agent's own account, and keeps one list per account", async () => {
		vi.mocked(execSshCommand).mockImplementation(async (_config, command) => ({
			stdout: initLine([`/${(command as { args: string[] }).args.length}`]),
			stderr: '',
			exitCode: 0,
		}));

		await probeClaudeSlashCommandsRemoteCached(remote('box'), 'claude', '/srv/p', {
			CLAUDE_CONFIG_DIR: '~/.claude-work',
		});
		await probeClaudeSlashCommandsRemoteCached(remote('box'), 'claude', '/srv/p', {
			CLAUDE_CONFIG_DIR: '~/.claude-home',
		});
		expect(buildSshCommand).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.objectContaining({ env: { FOO: '1', CLAUDE_CONFIG_DIR: '~/.claude-work' } })
		);
		// Two accounts on one remote: two probes, never a shared list.
		expect(execSshCommand).toHaveBeenCalledTimes(2);
	});

	it('gives no list for an unreachable remote and asks again next time', async () => {
		vi.mocked(execSshCommand).mockResolvedValue({ stdout: '', stderr: 'timed out', exitCode: 255 });

		await expect(
			probeClaudeSlashCommandsRemoteCached(remote('down'), 'claude', '/srv/p')
		).resolves.toBeNull();
		await probeClaudeSlashCommandsRemoteCached(remote('down'), 'claude', '/srv/p');
		expect(execSshCommand).toHaveBeenCalledTimes(2);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
});

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

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import {
	clearClaudeSlashCommandCache,
	parseInitSlashCommands,
	probeClaudeSlashCommands,
	probeClaudeSlashCommandsCached,
} from '../../../main/agents/claude-slash-command-probe';

const initLine = (commands: string[]) =>
	JSON.stringify({ type: 'system', subtype: 'init', slash_commands: commands }) + '\n';

beforeEach(() => {
	vi.mocked(execFileNoThrow).mockReset();
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

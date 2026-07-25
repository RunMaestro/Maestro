/**
 * Tests for src/main/utils/worktree-setup-script.ts
 *
 * Covers the post-create worktree setup script runner: the no-op path when
 * nothing is configured, MAESTRO_* env exposure, local vs SSH dispatch, and
 * failure/timeout reporting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/remote-git', () => ({
	execShellRemote: vi.fn(),
}));

vi.mock('../../../main/runtime/getShellPath', () => ({
	getShellPath: vi.fn(async () => '/usr/local/bin:/usr/bin'),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { execShellRemote } from '../../../main/utils/remote-git';
import { isWindows } from '../../../shared/platformDetection';
import {
	runWorktreeSetupScript,
	buildSetupScriptEnv,
	resolveSetupShell,
	WORKTREE_SETUP_TIMEOUT_MS,
} from '../../../main/utils/worktree-setup-script';

const mockExecFile = vi.mocked(execFileNoThrow);
const mockExecShellRemote = vi.mocked(execShellRemote);
const mockIsWindows = vi.mocked(isWindows);

const CONTEXT = {
	worktreePath: '/repos/worktrees/feature-x',
	branchName: 'feature-x',
	mainRepoPath: '/repos/app',
	baseBranch: 'main',
};

const OK: ExecResult = { stdout: 'installed 42 packages', stderr: '', exitCode: 0 };

const SSH_REMOTE: SshRemoteConfig = {
	id: 'remote-1',
	name: 'build box',
	host: 'build.example.com',
	username: 'dev',
} as SshRemoteConfig;

beforeEach(() => {
	vi.clearAllMocks();
	mockIsWindows.mockReturnValue(false);
	mockExecFile.mockResolvedValue(OK);
	mockExecShellRemote.mockResolvedValue(OK);
});

describe('buildSetupScriptEnv', () => {
	it('exposes worktree, branch, and repo paths', () => {
		expect(buildSetupScriptEnv(CONTEXT)).toEqual({
			MAESTRO_WORKTREE_PATH: '/repos/worktrees/feature-x',
			MAESTRO_WORKTREE_BRANCH: 'feature-x',
			MAESTRO_MAIN_REPO_PATH: '/repos/app',
			MAESTRO_BASE_BRANCH: 'main',
		});
	});

	it('omits the base branch when the caller did not specify one', () => {
		const env = buildSetupScriptEnv({ ...CONTEXT, baseBranch: undefined });
		expect(env).not.toHaveProperty('MAESTRO_BASE_BRANCH');
	});
});

describe('resolveSetupShell', () => {
	it('uses cmd.exe on Windows', () => {
		mockIsWindows.mockReturnValue(true);
		const shell = resolveSetupShell();
		expect(shell.args('npm ci')).toEqual(['/d', '/s', '/c', 'npm ci']);
	});

	it('uses a POSIX shell elsewhere', () => {
		const shell = resolveSetupShell();
		expect(shell.args('npm ci')).toEqual(['-c', 'npm ci']);
	});
});

describe('runWorktreeSetupScript', () => {
	it('does nothing when no script is configured', async () => {
		const result = await runWorktreeSetupScript(undefined, CONTEXT);

		expect(result).toEqual({ success: true, ran: false, stdout: '', stderr: '' });
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it('treats a whitespace-only script as unconfigured', async () => {
		const result = await runWorktreeSetupScript('   \n  ', CONTEXT);

		expect(result.ran).toBe(false);
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it('runs the script in the worktree with MAESTRO_* env and a timeout', async () => {
		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT);

		expect(result).toMatchObject({ success: true, ran: true, exitCode: 0 });

		const [, args, cwd, options] = mockExecFile.mock.calls[0];
		expect(args).toEqual(['-c', './setup.sh']);
		expect(cwd).toBe('/repos/worktrees/feature-x');
		expect(options).toMatchObject({
			timeout: WORKTREE_SETUP_TIMEOUT_MS,
			env: expect.objectContaining({
				MAESTRO_WORKTREE_PATH: '/repos/worktrees/feature-x',
				MAESTRO_WORKTREE_BRANCH: 'feature-x',
				MAESTRO_MAIN_REPO_PATH: '/repos/app',
				PATH: '/usr/local/bin:/usr/bin',
			}),
		});
		expect(mockExecShellRemote).not.toHaveBeenCalled();
	});

	it('runs over SSH when the worktree lives on a remote host', async () => {
		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT, SSH_REMOTE);

		expect(result.success).toBe(true);
		expect(mockExecFile).not.toHaveBeenCalled();
		expect(mockExecShellRemote).toHaveBeenCalledWith('./setup.sh', SSH_REMOTE, {
			cwd: '/repos/worktrees/feature-x',
			env: expect.objectContaining({ MAESTRO_WORKTREE_BRANCH: 'feature-x' }),
			timeoutMs: WORKTREE_SETUP_TIMEOUT_MS,
		});
	});

	it('reports a non-zero exit with the script stderr', async () => {
		mockExecFile.mockResolvedValue({ stdout: '', stderr: 'setup.sh: not found', exitCode: 127 });

		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT);

		expect(result).toMatchObject({
			success: false,
			ran: true,
			exitCode: 127,
			error: 'setup.sh: not found',
		});
	});

	it('falls back to the exit code when the script writes nothing to stderr', async () => {
		mockExecFile.mockResolvedValue({ stdout: '', stderr: '', exitCode: 3 });

		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT);

		expect(result.error).toBe('Setup script exited with code 3');
	});

	it('surfaces timeouts as a dedicated message', async () => {
		mockExecFile.mockResolvedValue({ stdout: '', stderr: 'ETIMEDOUT', exitCode: 'ETIMEDOUT' });

		const result = await runWorktreeSetupScript('sleep 99999', CONTEXT);

		expect(result.success).toBe(false);
		expect(result.error).toContain('timed out');
	});

	it('truncates very long output to a tail', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'x'.repeat(10_000), stderr: '', exitCode: 0 });

		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT);

		expect(result.stdout.length).toBeLessThan(10_000);
		expect(result.stdout.startsWith('...(truncated)')).toBe(true);
	});

	it('still runs the script when the login-shell PATH probe fails', async () => {
		const { getShellPath } = await import('../../../main/runtime/getShellPath');
		vi.mocked(getShellPath).mockRejectedValueOnce(new Error('no shell'));

		const result = await runWorktreeSetupScript('./setup.sh', CONTEXT);

		expect(result.success).toBe(true);
		expect(mockExecFile).toHaveBeenCalled();
	});
});

/**
 * Tests for src/main/utils/remote-git.ts
 *
 * Tests cover remote git execution utilities that execute git commands
 * on remote hosts via SSH, including worktree management and parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock dependencies
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

// Import mocked modules
import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';

// Import functions under test
import {
	execGitRemote,
	execGit,
	listWorktreesRemote,
	worktreeInfoRemote,
	worktreeCheckoutRemote,
	worktreeSetupRemote,
	getRepoRootRemote,
} from '../../../main/utils/remote-git';

// Typed mock references
const mockExecFileNoThrow = vi.mocked(execFileNoThrow);
const mockBuildSshCommand = vi.mocked(buildSshCommand);

/**
 * Helper to create an SshRemoteConfig for tests.
 */
function createSshRemote(overrides?: Partial<SshRemoteConfig>): SshRemoteConfig {
	return {
		id: 'test-remote',
		name: 'Test Remote',
		host: 'test-host.example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '/home/testuser/.ssh/id_rsa',
		enabled: true,
		...overrides,
	};
}

/**
 * Helper to create a successful ExecResult.
 */
function successResult(stdout: string, stderr = ''): ExecResult {
	return { stdout, stderr, exitCode: 0 };
}

/**
 * Helper to create a failed ExecResult.
 */
function failResult(stderr: string, exitCode = 1, stdout = ''): ExecResult {
	return { stdout, stderr, exitCode };
}

describe('remote-git.ts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: buildSshCommand returns a mock SSH command
		mockBuildSshCommand.mockResolvedValue({
			command: 'ssh',
			args: ['mock-args'],
		});
	});

	// =========================================================================
	// execGitRemote
	// =========================================================================
	describe('execGitRemote', () => {
		it('should call buildSshCommand with correct remote command options', async () => {
			const sshRemote = createSshRemote({ remoteEnv: { GIT_AUTHOR_NAME: 'Test' } });
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			await execGitRemote(['status', '--porcelain'], {
				sshRemote,
				remoteCwd: '/remote/repo',
			});

			expect(mockBuildSshCommand).toHaveBeenCalledWith(sshRemote, {
				command: 'git',
				args: ['status', '--porcelain'],
				cwd: '/remote/repo',
				env: { GIT_AUTHOR_NAME: 'Test' },
			});
		});

		it('should pass buildSshCommand result to execFileNoThrow', async () => {
			const sshRemote = createSshRemote();
			mockBuildSshCommand.mockResolvedValue({
				command: '/usr/bin/ssh',
				args: ['-p', '2222', 'user@host', 'git status'],
			});
			mockExecFileNoThrow.mockResolvedValue(successResult('clean'));

			await execGitRemote(['status'], { sshRemote, remoteCwd: '/repo' });

			expect(mockExecFileNoThrow).toHaveBeenCalledWith('/usr/bin/ssh', [
				'-p',
				'2222',
				'user@host',
				'git status',
			]);
		});

		it('should return the result from execFileNoThrow', async () => {
			const sshRemote = createSshRemote();
			const expectedResult = successResult('M file.txt\n');
			mockExecFileNoThrow.mockResolvedValue(expectedResult);

			const result = await execGitRemote(['status', '--porcelain'], {
				sshRemote,
				remoteCwd: '/repo',
			});

			expect(result).toEqual(expectedResult);
		});

		it('should pass undefined remoteCwd when not specified', async () => {
			const sshRemote = createSshRemote();
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			await execGitRemote(['version'], { sshRemote });

			expect(mockBuildSshCommand).toHaveBeenCalledWith(sshRemote, {
				command: 'git',
				args: ['version'],
				cwd: undefined,
				env: undefined,
			});
		});

		it('should pass remoteEnv from sshRemote config', async () => {
			const sshRemote = createSshRemote({
				remoteEnv: { PATH: '/custom/bin', HOME: '/remote/home' },
			});
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			await execGitRemote(['log'], { sshRemote, remoteCwd: '/repo' });

			expect(mockBuildSshCommand).toHaveBeenCalledWith(
				sshRemote,
				expect.objectContaining({
					env: { PATH: '/custom/bin', HOME: '/remote/home' },
				})
			);
		});

		it('should return failed result when command fails', async () => {
			const sshRemote = createSshRemote();
			const failedResult = failResult('fatal: not a git repository', 128);
			mockExecFileNoThrow.mockResolvedValue(failedResult);

			const result = await execGitRemote(['status'], {
				sshRemote,
				remoteCwd: '/not-a-repo',
			});

			expect(result).toEqual(failedResult);
		});
	});

	// =========================================================================
	// execGit
	// =========================================================================
	describe('execGit', () => {
		it('should dispatch to local execution when sshRemote is not provided', async () => {
			const expectedResult = successResult('On branch main\n');
			mockExecFileNoThrow.mockResolvedValue(expectedResult);

			const result = await execGit(['status'], '/local/repo');

			expect(mockExecFileNoThrow).toHaveBeenCalledWith('git', ['status'], '/local/repo');
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(result).toEqual(expectedResult);
		});

		it('should dispatch to local execution when sshRemote is null', async () => {
			const expectedResult = successResult('');
			mockExecFileNoThrow.mockResolvedValue(expectedResult);

			const result = await execGit(['log'], '/local/repo', null);

			expect(mockExecFileNoThrow).toHaveBeenCalledWith('git', ['log'], '/local/repo');
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(result).toEqual(expectedResult);
		});

		it('should dispatch to remote execution when sshRemote is provided', async () => {
			const sshRemote = createSshRemote();
			const expectedResult = successResult('abc1234\n');
			mockExecFileNoThrow.mockResolvedValue(expectedResult);

			const result = await execGit(
				['rev-parse', 'HEAD'],
				'/local/repo',
				sshRemote,
				'/remote/repo'
			);

			expect(mockBuildSshCommand).toHaveBeenCalledWith(sshRemote, {
				command: 'git',
				args: ['rev-parse', 'HEAD'],
				cwd: '/remote/repo',
				env: undefined,
			});
			expect(result).toEqual(expectedResult);
		});

		it('should pass remoteCwd to remote execution', async () => {
			const sshRemote = createSshRemote();
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			await execGit(['status'], '/local', sshRemote, '/remote/cwd');

			expect(mockBuildSshCommand).toHaveBeenCalledWith(
				sshRemote,
				expect.objectContaining({ cwd: '/remote/cwd' })
			);
		});
	});

	// =========================================================================
	// listWorktreesRemote (MOST IMPORTANT - porcelain parsing)
	// =========================================================================
	describe('listWorktreesRemote', () => {
		const sshRemote = createSshRemote();

		it('should parse standard worktree list output with multiple entries', async () => {
			const porcelainOutput = [
				'worktree /home/user/project',
				'HEAD abc1234def5678901234567890abcdef12345678',
				'branch refs/heads/main',
				'',
				'worktree /home/user/project-feature',
				'HEAD 1234567890abcdef1234567890abcdef12345678',
				'branch refs/heads/feature-branch',
				'',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(2);
			expect(result.data![0]).toEqual({
				path: '/home/user/project',
				head: 'abc1234def5678901234567890abcdef12345678',
				branch: 'main',
				isBare: false,
			});
			expect(result.data![1]).toEqual({
				path: '/home/user/project-feature',
				head: '1234567890abcdef1234567890abcdef12345678',
				branch: 'feature-branch',
				isBare: false,
			});
		});

		it('should handle bare worktrees', async () => {
			const porcelainOutput = [
				'worktree /home/user/bare-repo.git',
				'HEAD abc1234def5678901234567890abcdef12345678',
				'bare',
				'',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/bare-repo.git', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
			expect(result.data![0]).toEqual({
				path: '/home/user/bare-repo.git',
				head: 'abc1234def5678901234567890abcdef12345678',
				branch: null,
				isBare: true,
			});
		});

		it('should handle detached HEAD (branch = null)', async () => {
			const porcelainOutput = [
				'worktree /home/user/project',
				'HEAD abc1234def5678901234567890abcdef12345678',
				'branch refs/heads/main',
				'',
				'worktree /home/user/project-detached',
				'HEAD fedcba9876543210fedcba9876543210fedcba98',
				'detached',
				'',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(2);
			expect(result.data![1]).toEqual({
				path: '/home/user/project-detached',
				head: 'fedcba9876543210fedcba9876543210fedcba98',
				branch: null,
				isBare: false,
			});
		});

		it('should strip refs/heads/ prefix from branch names', async () => {
			const porcelainOutput = [
				'worktree /repo',
				'HEAD aaaa',
				'branch refs/heads/feature/nested/branch-name',
				'',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data![0].branch).toBe('feature/nested/branch-name');
		});

		it('should handle trailing entry without final newline', async () => {
			// No trailing newline after last entry
			const porcelainOutput = [
				'worktree /home/user/project',
				'HEAD abc123',
				'branch refs/heads/main',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
			expect(result.data![0]).toEqual({
				path: '/home/user/project',
				head: 'abc123',
				branch: 'main',
				isBare: false,
			});
		});

		it('should handle empty output (no worktrees)', async () => {
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			const result = await listWorktreesRemote('/repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([]);
		});

		it('should return empty array on command failure', async () => {
			mockExecFileNoThrow.mockResolvedValue(
				failResult('fatal: not a git repository', 128)
			);

			const result = await listWorktreesRemote('/not-a-repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual([]);
		});

		it('should handle single worktree entry with trailing blank line', async () => {
			const porcelainOutput = [
				'worktree /home/user/project',
				'HEAD abc123',
				'branch refs/heads/develop',
				'',
				'', // extra trailing blank line
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
		});

		it('should handle multiple worktrees including bare and detached', async () => {
			const porcelainOutput = [
				'worktree /home/user/main-repo',
				'HEAD aaaa1111',
				'branch refs/heads/main',
				'',
				'worktree /home/user/feature-wt',
				'HEAD bbbb2222',
				'branch refs/heads/feature-x',
				'',
				'worktree /home/user/detached-wt',
				'HEAD cccc3333',
				'detached',
				'',
			].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/home/user/main-repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(3);
			expect(result.data![0].branch).toBe('main');
			expect(result.data![1].branch).toBe('feature-x');
			expect(result.data![2].branch).toBeNull();
			expect(result.data![2].isBare).toBe(false);
		});

		it('should default head to empty string when HEAD line is missing', async () => {
			// Unusual but handle gracefully: no HEAD line
			const porcelainOutput = ['worktree /repo', 'branch refs/heads/main', ''].join('\n');

			mockExecFileNoThrow.mockResolvedValue(successResult(porcelainOutput));

			const result = await listWorktreesRemote('/repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
			expect(result.data![0].head).toBe('');
		});

		it('should pass correct arguments to execGitRemote', async () => {
			mockExecFileNoThrow.mockResolvedValue(successResult(''));

			await listWorktreesRemote('/remote/repo', sshRemote);

			expect(mockBuildSshCommand).toHaveBeenCalledWith(sshRemote, {
				command: 'git',
				args: ['worktree', 'list', '--porcelain'],
				cwd: '/remote/repo',
				env: undefined,
			});
		});
	});

	// =========================================================================
	// worktreeInfoRemote
	// =========================================================================
	describe('worktreeInfoRemote', () => {
		const sshRemote = createSshRemote();

		it('should return exists:false when path does not exist', async () => {
			// First call: shell command to check path existence
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('NOT_EXISTS'));

			const result = await worktreeInfoRemote('/nonexistent', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ exists: false, isWorktree: false });
		});

		it('should return exists:true, isWorktree:false when path exists but is not git', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('not a git repository', 128));

			const result = await worktreeInfoRemote('/some/directory', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ exists: true, isWorktree: false });
		});

		it('should return isWorktree:false for regular git repo (gitDir == gitCommonDir)', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// rev-parse --git-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// rev-parse --git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// rev-parse --abbrev-ref HEAD
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('main\n'));
			// rev-parse --show-toplevel
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/home/user/project\n'));

			const result = await worktreeInfoRemote('/home/user/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				exists: true,
				isWorktree: false,
				currentBranch: 'main',
				repoRoot: '/home/user/project',
			});
		});

		it('should return isWorktree:true when gitDir != gitCommonDir', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// rev-parse --git-dir
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/home/user/project/.git/worktrees/feature\n')
			);
			// rev-parse --git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/home/user/project/.git\n'));
			// rev-parse --abbrev-ref HEAD
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('feature\n'));
			// Shell: dirname to get repo root from common dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/home/user/project\n'));

			const result = await worktreeInfoRemote('/home/user/project-feature', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toEqual({
				exists: true,
				isWorktree: true,
				currentBranch: 'feature',
				repoRoot: '/home/user/project',
			});
		});

		it('should return error when path existence check fails', async () => {
			mockExecFileNoThrow.mockResolvedValueOnce(
				failResult('SSH connection refused', 255)
			);

			const result = await worktreeInfoRemote('/some/path', sshRemote);

			expect(result.success).toBe(false);
			expect(result.error).toBe('SSH connection refused');
		});

		it('should handle branch being undefined when rev-parse fails', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// rev-parse --git-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// rev-parse --git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// rev-parse --abbrev-ref HEAD fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('HEAD not found', 128));
			// rev-parse --show-toplevel
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/repo\n'));

			const result = await worktreeInfoRemote('/repo', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.currentBranch).toBeUndefined();
		});

		it('should return error when git-dir check fails', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// rev-parse --git-dir fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('error', 1));

			const result = await worktreeInfoRemote('/broken-repo', sshRemote);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to get git directory');
		});

		it('should fall back to gitDir when git-common-dir check fails', async () => {
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// rev-parse --is-inside-work-tree
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// rev-parse --git-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// rev-parse --git-common-dir fails (old git version)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('unknown option', 1));
			// gitDir == gitCommonDir (fallback), so isWorktree = false
			// rev-parse --abbrev-ref HEAD
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('develop\n'));
			// rev-parse --show-toplevel
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/project\n'));

			const result = await worktreeInfoRemote('/project', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.isWorktree).toBe(false);
			expect(result.data!.currentBranch).toBe('develop');
		});
	});

	// =========================================================================
	// worktreeCheckoutRemote
	// =========================================================================
	describe('worktreeCheckoutRemote', () => {
		const sshRemote = createSshRemote();

		it('should return error with hasUncommittedChanges when status shows changes', async () => {
			// git status --porcelain returns changes
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(' M file.txt\n'));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'feature',
				false,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.hasUncommittedChanges).toBe(true);
			expect(result.data!.error).toContain('uncommitted changes');
		});

		it('should checkout existing branch', async () => {
			// git status --porcelain (clean)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// rev-parse --verify branchName (branch exists)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('abc123\n'));
			// git checkout branchName
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'feature',
				false,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
			expect(result.data!.hasUncommittedChanges).toBe(false);
		});

		it('should create branch when it does not exist and createIfMissing is true', async () => {
			// git status --porcelain (clean)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// rev-parse --verify branchName (branch does not exist)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('', 128));
			// git checkout -b branchName
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'new-feature',
				true,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
		});

		it('should return error when branch does not exist and createIfMissing is false', async () => {
			// git status --porcelain (clean)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// rev-parse --verify branchName (branch does not exist)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('', 128));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'nonexistent',
				false,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.hasUncommittedChanges).toBe(false);
			expect(result.data!.error).toContain("'nonexistent'");
			expect(result.data!.error).toContain('does not exist');
		});

		it('should return error when git status check fails', async () => {
			// git status --porcelain fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('connection error', 255));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'main',
				false,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.hasUncommittedChanges).toBe(false);
			expect(result.data!.error).toBe('Failed to check git status');
		});

		it('should return error when checkout fails', async () => {
			// git status --porcelain (clean)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// rev-parse --verify (branch exists)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('abc123\n'));
			// git checkout fails
			mockExecFileNoThrow.mockResolvedValueOnce(
				failResult('error: pathspec did not match', 1)
			);

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'broken-branch',
				false,
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.error).toContain('pathspec');
		});

		it('should treat empty status output as clean working tree', async () => {
			// git status --porcelain returns empty (with just whitespace)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('   \n  '));
			// rev-parse --verify (branch does not exist)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('', 128));

			const result = await worktreeCheckoutRemote(
				'/worktree',
				'new-branch',
				false,
				sshRemote
			);

			// Since stdout.trim().length > 0 is false for whitespace-only, it's clean
			// Actually '   \n  '.trim() = '' so length is 0 -> clean
			expect(result.data!.hasUncommittedChanges).toBe(false);
		});
	});

	// =========================================================================
	// worktreeSetupRemote
	// =========================================================================
	describe('worktreeSetupRemote', () => {
		const sshRemote = createSshRemote();

		it('should reject nested worktree (worktree path inside main repo)', async () => {
			// realpath returns resolved paths
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/home/user/project\n/home/user/project/worktree\n')
			);

			const result = await worktreeSetupRemote(
				'/home/user/project',
				'/home/user/project/worktree',
				'feature',
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.error).toContain('cannot be inside the main repository');
		});

		it('should create new worktree when path does not exist and branch exists', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/home/user/project\n/home/user/project-wt\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('NOT_EXISTS'));
			// Branch exists check
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('abc123\n'));
			// git worktree add
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));

			const result = await worktreeSetupRemote(
				'/home/user/project',
				'/home/user/project-wt',
				'feature',
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
			expect(result.data!.created).toBe(true);
			expect(result.data!.currentBranch).toBe('feature');
			expect(result.data!.branchMismatch).toBe(false);
		});

		it('should create new worktree with new branch when branch does not exist', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/home/user/project\n/home/user/project-wt\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('NOT_EXISTS'));
			// Branch does NOT exist
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('', 128));
			// git worktree add -b branchName
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));

			const result = await worktreeSetupRemote(
				'/home/user/project',
				'/home/user/project-wt',
				'new-feature',
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
			expect(result.data!.created).toBe(true);
		});

		it('should reuse existing worktree and report branch mismatch', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/home/user/project\n/home/user/project-wt\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// Is inside work tree -> yes
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/home/user/project/.git\n'));
			// git-dir of main repo
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// Compare paths -> SAME
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('SAME'));
			// Current branch
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('other-branch\n'));

			const result = await worktreeSetupRemote(
				'/home/user/project',
				'/home/user/project-wt',
				'feature',
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
			expect(result.data!.created).toBe(false);
			expect(result.data!.currentBranch).toBe('other-branch');
			expect(result.data!.requestedBranch).toBe('feature');
			expect(result.data!.branchMismatch).toBe(true);
		});

		it('should return error when path existence check fails', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('SSH error', 255));

			const result = await worktreeSetupRemote(
				'/a',
				'/b',
				'branch',
				sshRemote
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('SSH error');
		});

		it('should return error when worktree creation fails', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('NOT_EXISTS'));
			// Branch exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('abc\n'));
			// git worktree add fails
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('fatal: already exists'));

			const result = await worktreeSetupRemote(
				'/a',
				'/b',
				'branch',
				sshRemote
			);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.error).toContain('already exists');
		});

		it('should handle existing non-empty non-git directory', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// Is inside work tree -> fails (not a git repo)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('not a git repository', 128));
			// ls -A check (directory is not empty)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('some-file.txt'));

			const result = await worktreeSetupRemote('/a', '/b', 'branch', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.error).toContain('not a git worktree');
		});

		it('should remove empty non-git directory and create worktree', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// Is inside work tree -> fails (not a git repo)
			mockExecFileNoThrow.mockResolvedValueOnce(failResult('not a git repository', 128));
			// ls -A check (directory is empty)
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// rmdir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));
			// Branch exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('abc\n'));
			// git worktree add
			mockExecFileNoThrow.mockResolvedValueOnce(successResult(''));

			const result = await worktreeSetupRemote('/a', '/b', 'branch', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(true);
			expect(result.data!.created).toBe(true);
		});

		it('should detect worktree belonging to different repository', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// Is inside work tree -> yes
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/other-project/.git\n'));
			// git-dir of main repo
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// Compare paths -> DIFFERENT
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('DIFFERENT'));

			const result = await worktreeSetupRemote('/a', '/b', 'branch', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.success).toBe(false);
			expect(result.data!.error).toContain('different repository');
		});

		it('should not report branch mismatch when requested branch is empty', async () => {
			// Check nested
			mockExecFileNoThrow.mockResolvedValueOnce(
				successResult('/a\n/b\n')
			);
			// Check path exists
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('EXISTS'));
			// Is inside work tree -> yes
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('true'));
			// git-common-dir
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('/a/.git\n'));
			// git-dir of main repo
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('.git\n'));
			// Compare paths -> SAME
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('SAME'));
			// Current branch
			mockExecFileNoThrow.mockResolvedValueOnce(successResult('some-branch\n'));

			const result = await worktreeSetupRemote('/a', '/b', '', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data!.branchMismatch).toBe(false);
		});
	});

	// =========================================================================
	// getRepoRootRemote
	// =========================================================================
	describe('getRepoRootRemote', () => {
		const sshRemote = createSshRemote();

		it('should return trimmed repo root on success', async () => {
			mockExecFileNoThrow.mockResolvedValue(successResult('/home/user/project\n'));

			const result = await getRepoRootRemote('/home/user/project/sub', sshRemote);

			expect(result.success).toBe(true);
			expect(result.data).toBe('/home/user/project');
		});

		it('should return error on failure', async () => {
			mockExecFileNoThrow.mockResolvedValue(
				failResult('fatal: not a git repository', 128)
			);

			const result = await getRepoRootRemote('/not-a-repo', sshRemote);

			expect(result.success).toBe(false);
			expect(result.error).toBe('fatal: not a git repository');
		});

		it('should return default error message when stderr is empty', async () => {
			mockExecFileNoThrow.mockResolvedValue(failResult('', 128));

			const result = await getRepoRootRemote('/not-a-repo', sshRemote);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Not a git repository');
		});

		it('should pass correct args to execGitRemote', async () => {
			mockExecFileNoThrow.mockResolvedValue(successResult('/repo\n'));

			await getRepoRootRemote('/repo/subdir', sshRemote);

			expect(mockBuildSshCommand).toHaveBeenCalledWith(sshRemote, {
				command: 'git',
				args: ['rev-parse', '--show-toplevel'],
				cwd: '/repo/subdir',
				env: undefined,
			});
		});
	});
});

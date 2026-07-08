/**
 * Integration tests for the Git IPC handlers
 *
 * These tests verify the Git-related IPC handlers that provide
 * git operations used across the application.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerGitHandlers } from '../../main/ipc/handlers/git';
import * as execFile from '../../main/utils/execFile';
import path from 'path';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: vi.fn(() => []),
	},
}));

// Mock the execFile module
vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
	execFileBufferNoThrow: vi.fn(),
}));

// Mock the logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the cliDetection module
vi.mock('../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn().mockResolvedValue('gh'),
	getCachedGhStatus: vi.fn().mockReturnValue(null),
	setCachedGhStatus: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		realpath: vi.fn(async (filePath: string) => filePath),
		rmdir: vi.fn(),
		rm: vi.fn(),
	},
}));

// Mock chokidar
vi.mock('chokidar', () => ({
	default: {
		watch: vi.fn(() => ({
			on: vi.fn().mockReturnThis(),
			close: vi.fn().mockResolvedValue(undefined),
		})),
	},
}));

// Mock gitSettingsStore
vi.mock('../../main/services/gitSettingsStore', () => ({
	gitSettingsStore: {
		get: vi.fn(),
	},
}));

const { mockGetSshRemoteById } = vi.hoisted(() => ({
	mockGetSshRemoteById: vi.fn(),
}));

vi.mock('../../main/stores', () => ({
	getSshRemoteById: mockGetSshRemoteById,
}));

// Mock getShellPath
vi.mock('../../main/runtime/getShellPath', () => ({
	getShellPath: vi.fn().mockResolvedValue('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'),
}));

// Mock remote-git
vi.mock('../../main/utils/remote-git', () => ({
	execGitRemote: vi.fn(),
	execGit: vi.fn(),
	worktreeInfoRemote: vi.fn(),
	worktreeSetupRemote: vi.fn(),
	worktreeCheckoutRemote: vi.fn(),
	listWorktreesRemote: vi.fn(),
	getRepoRootRemote: vi.fn(),
}));

// Mock remote filesystem helpers used by SSH-aware git handlers
vi.mock('../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
}));

// Mock child_process for spawnSync (used in git:showFile for images)
// The handler uses require('child_process') at runtime - need vi.hoisted for proper hoisting
const { mockSpawnSync } = vi.hoisted(() => ({
	mockSpawnSync: vi.fn(),
}));

vi.mock('child_process', () => ({
	spawnSync: mockSpawnSync,
	// Include other exports that might be needed
	spawn: vi.fn(),
	exec: vi.fn(),
	execSync: vi.fn(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
	fork: vi.fn(),
}));

describe('Git IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockSettingsStore: any;
	const enabledSshRemote = {
		id: 'ssh-remote-123',
		enabled: true,
		host: 'example.com',
		user: 'testuser',
		privateKeyPath: '/path/to/key',
		knownHostsPath: '/path/to/known_hosts',
	};

	const enableSshRemote = () => {
		mockSettingsStore.get.mockReturnValue([enabledSshRemote]);
	};

	beforeEach(async () => {
		// Clear mocks
		vi.clearAllMocks();

		mockSettingsStore = {
			get: vi.fn().mockReturnValue([]),
		};
		mockGetSshRemoteById.mockImplementation((id: string) => {
			const remotes = mockSettingsStore.get('sshRemotes', []) as Array<{ id: string }>;
			return remotes.find((remote) => remote.id === id);
		});

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers with mock settings store
		registerGitHandlers({
			settingsStore: mockSettingsStore,
		});

		// Set up execGit mock to dispatch to local or remote
		const remoteGit = await import('../../main/utils/remote-git');
		vi.mocked(remoteGit.execGit).mockImplementation(
			async (args, localCwd, sshRemote, remoteCwd) => {
				if (sshRemote) {
					return remoteGit.execGitRemote(args, { sshRemote, remoteCwd: remoteCwd ?? localCwd });
				} else {
					return execFile.execFileNoThrow('git', args, localCwd);
				}
			}
		);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all 27 git handlers', () => {
			const expectedChannels = [
				'git:status',
				'git:diff',
				'git:isRepo',
				'git:init',
				'git:numstat',
				'git:branch',
				'git:remote',
				'git:branches',
				'git:tags',
				'git:info',
				'git:log',
				'git:commitCount',
				'git:show',
				'git:showFile',
				'git:worktreeInfo',
				'git:getRepoRoot',
				'git:worktreeSetup',
				'git:worktreeCheckout',
				'git:createPR',
				'git:checkGhCli',
				'git:getDefaultBranch',
				'git:listWorktrees',
				'git:scanWorktreeDirectory',
				'git:watchWorktreeDirectory',
				'git:unwatchWorktreeDirectory',
				'git:removeWorktree',
				'git:createGist',
			];

			expect(handlers.size).toBe(27);
			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('git:status', () => {
		it('should return stdout from execFileNoThrow on success', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'M  file.txt\nA  new.txt\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:status');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['status', '--porcelain'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: 'M  file.txt\nA  new.txt\n',
				stderr: '',
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:status');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});

		it('should pass cwd parameter correctly', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:status');
			await handler!({} as any, '/custom/path');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['status', '--porcelain'],
				'/custom/path'
			);
		});

		it('should return empty stdout for clean repository', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:status');
			const result = await handler!({} as any, '/clean/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: '',
			});
		});

		it('should use provided remote cwd for SSH status checks', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.execGitRemote).mockResolvedValue({
				stdout: ' M remote-file.ts\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:status');
			const result = await handler!({} as any, '/local/session', 'ssh-remote-123', '/remote/repo');

			expect(remoteGit.execGitRemote).toHaveBeenCalledWith(['status', '--porcelain'], {
				sshRemote: enabledSshRemote,
				remoteCwd: '/remote/repo',
			});
			expect(result).toEqual({
				stdout: ' M remote-file.ts\n',
				stderr: '',
			});
		});
	});

	describe('git:diff', () => {
		it('should return diff output for unstaged changes', async () => {
			const diffOutput = `diff --git a/file.txt b/file.txt
index abc1234..def5678 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+new line
 line 2
 line 3`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: diffOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:diff');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('git', ['diff'], '/test/repo');
			expect(result).toEqual({
				stdout: diffOutput,
				stderr: '',
			});
		});

		it('should return diff for specific file when file path is provided', async () => {
			const fileDiff = `diff --git a/specific.txt b/specific.txt
index 1234567..abcdefg 100644
--- a/specific.txt
+++ b/specific.txt
@@ -1 +1 @@
-old content
+new content`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: fileDiff,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:diff');
			const result = await handler!({} as any, '/test/repo', 'specific.txt');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['diff', 'specific.txt'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: fileDiff,
				stderr: '',
			});
		});

		it('should return empty diff when no changes exist', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:diff');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: '',
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:diff');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});
	});

	describe('git:isRepo', () => {
		it('should return true when directory is inside a git work tree', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'true\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:isRepo');
			const result = await handler!({} as any, '/valid/git/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--is-inside-work-tree'],
				'/valid/git/repo'
			);
			expect(result).toBe(true);
		});

		it('should return false when not a git repository', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository (or any of the parent directories): .git',
				exitCode: 128,
			});

			const handler = handlers.get('git:isRepo');
			const result = await handler!({} as any, '/not/a/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--is-inside-work-tree'],
				'/not/a/repo'
			);
			expect(result).toBe(false);
		});

		it('should return false for non-zero exit codes', async () => {
			// Test with different non-zero exit code
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'error',
				exitCode: 1,
			});

			const handler = handlers.get('git:isRepo');
			const result = await handler!({} as any, '/some/path');

			expect(result).toBe(false);
		});
	});

	describe('git:numstat', () => {
		it('should return parsed numstat output for changed files', async () => {
			const numstatOutput = `10\t5\tfile1.ts
3\t0\tfile2.ts
0\t20\tfile3.ts`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: numstatOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:numstat');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['diff', '--numstat'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: numstatOutput,
				stderr: '',
			});
		});

		it('should return empty stdout when no changes exist', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:numstat');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: '',
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:numstat');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});

		it('should handle binary files in numstat output', async () => {
			// Git uses "-\t-\t" for binary files
			const numstatOutput = `10\t5\tfile1.ts
-\t-\timage.png`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: numstatOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:numstat');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: numstatOutput,
				stderr: '',
			});
		});
	});

	describe('git:branch', () => {
		it('should return current branch name trimmed', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'main\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branch');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: 'main',
				stderr: '',
			});
		});

		it('should return HEAD for detached HEAD state', async () => {
			// When in detached HEAD state, git rev-parse --abbrev-ref HEAD returns 'HEAD'
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'HEAD\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branch');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: 'HEAD',
				stderr: '',
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:branch');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});

		it('should handle feature branch names', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'feature/my-new-feature\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branch');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: 'feature/my-new-feature',
				stderr: '',
			});
		});
	});

	describe('git:remote', () => {
		it('should return remote URL for origin', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'git@github.com:user/repo.git\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:remote');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['remote', 'get-url', 'origin'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: 'git@github.com:user/repo.git',
				stderr: '',
			});
		});

		it('should return HTTPS remote URL', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'https://github.com/user/repo.git\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:remote');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: 'https://github.com/user/repo.git',
				stderr: '',
			});
		});

		it('should return stderr when no remote configured', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: "fatal: No such remote 'origin'",
				exitCode: 2,
			});

			const handler = handlers.get('git:remote');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: "fatal: No such remote 'origin'",
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:remote');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});
	});

	describe('git:branches', () => {
		it('should return array of branch names', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'main\nfeature/awesome\nfix/bug-123\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branches');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['branch', '-a', '--format=%(refname:short)'],
				'/test/repo'
			);
			expect(result).toEqual({
				branches: ['main', 'feature/awesome', 'fix/bug-123'],
			});
		});

		it('should deduplicate local and remote branches', async () => {
			// When a branch exists both locally and on origin
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'main\norigin/main\nfeature/foo\norigin/feature/foo\ndevelop\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branches');
			const result = await handler!({} as any, '/test/repo');

			// parseGitBranches removes 'origin/' prefix and deduplicates
			expect(result).toEqual({
				branches: ['main', 'feature/foo', 'develop'],
			});
		});

		it('should filter out HEAD from branch list', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'main\nHEAD\norigin/HEAD\nfeature/test\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branches');
			const result = await handler!({} as any, '/test/repo');

			// parseGitBranches filters out HEAD
			expect(result).toEqual({
				branches: ['main', 'feature/test'],
			});
		});

		it('should return empty array when no branches exist', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:branches');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				branches: [],
			});
		});

		it('should return empty array with stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:branches');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				branches: [],
				stderr: 'fatal: not a git repository',
			});
		});
	});

	describe('git:tags', () => {
		it('should return array of tag names', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'v1.0.0\nv1.1.0\nv2.0.0-beta\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:tags');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('git', ['tag', '--list'], '/test/repo');
			expect(result).toEqual({
				tags: ['v1.0.0', 'v1.1.0', 'v2.0.0-beta'],
			});
		});

		it('should handle tags with special characters', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'release/1.0\nhotfix-2023.01.15\nmy_tag_v1\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:tags');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				tags: ['release/1.0', 'hotfix-2023.01.15', 'my_tag_v1'],
			});
		});

		it('should return empty array when no tags exist', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:tags');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				tags: [],
			});
		});

		it('should return empty array with stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:tags');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				tags: [],
				stderr: 'fatal: not a git repository',
			});
		});
	});

	describe('git:info', () => {
		it('should return combined git info object with all fields', async () => {
			// The handler runs 4 parallel git commands
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'main\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git remote get-url origin (remote)
					stdout: 'git@github.com:user/repo.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git status --porcelain (uncommitted changes)
					stdout: 'M  file1.ts\nA  file2.ts\n?? untracked.txt\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-list --left-right --count @{upstream}...HEAD (behind/ahead)
					stdout: '3\t5\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:info');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				branch: 'main',
				remote: 'git@github.com:user/repo.git',
				behind: 3,
				ahead: 5,
				uncommittedChanges: 3,
			});
		});

		it('should return partial info when remote command fails', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'feature/my-branch\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git remote get-url origin (remote) - fails, no remote
					stdout: '',
					stderr: "fatal: No such remote 'origin'",
					exitCode: 2,
				})
				.mockResolvedValueOnce({
					// git status --porcelain (uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-list --left-right --count @{upstream}...HEAD
					stdout: '0\t2\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:info');
			const result = await handler!({} as any, '/test/repo');

			// Remote should be empty string when command fails
			expect(result).toEqual({
				branch: 'feature/my-branch',
				remote: '',
				behind: 0,
				ahead: 2,
				uncommittedChanges: 0,
			});
		});

		it('should return zero behind/ahead when upstream is not set', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'new-branch\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git remote get-url origin (remote)
					stdout: 'https://github.com/user/repo.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git status --porcelain (uncommitted changes)
					stdout: 'M  changed.ts\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-list --left-right --count @{upstream}...HEAD - fails, no upstream
					stdout: '',
					stderr: "fatal: no upstream configured for branch 'new-branch'",
					exitCode: 128,
				});

			const handler = handlers.get('git:info');
			const result = await handler!({} as any, '/test/repo');

			// behind/ahead should default to 0 when upstream check fails
			expect(result).toEqual({
				branch: 'new-branch',
				remote: 'https://github.com/user/repo.git',
				behind: 0,
				ahead: 0,
				uncommittedChanges: 1,
			});
		});

		it('should handle clean repo with no changes and in sync with upstream', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'main\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git remote get-url origin (remote)
					stdout: 'git@github.com:user/repo.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git status --porcelain (uncommitted changes) - empty
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-list --left-right --count @{upstream}...HEAD - in sync
					stdout: '0\t0\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:info');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				branch: 'main',
				remote: 'git@github.com:user/repo.git',
				behind: 0,
				ahead: 0,
				uncommittedChanges: 0,
			});
		});

		it('should handle detached HEAD state', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch) - detached HEAD returns 'HEAD'
					stdout: 'HEAD\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git remote get-url origin (remote)
					stdout: 'git@github.com:user/repo.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git status --porcelain (uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-list - fails in detached HEAD (no upstream)
					stdout: '',
					stderr: 'fatal: HEAD does not point to a branch',
					exitCode: 128,
				});

			const handler = handlers.get('git:info');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				branch: 'HEAD',
				remote: 'git@github.com:user/repo.git',
				behind: 0,
				ahead: 0,
				uncommittedChanges: 0,
			});
		});
	});

	describe('git:log', () => {
		it('should return parsed log entries with correct structure', async () => {
			// Mock output with COMMIT_START marker format
			const logOutput = `COMMIT_STARTabc123456789|John Doe|2024-01-15T10:30:00+00:00|HEAD -> main, origin/main|Initial commit

 2 files changed, 50 insertions(+), 10 deletions(-)
COMMIT_STARTdef987654321|Jane Smith|2024-01-14T09:00:00+00:00||Add feature

 1 file changed, 25 insertions(+)`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: logOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				[
					'log',
					'--max-count=100',
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
				],
				'/test/repo'
			);

			expect(result).toEqual({
				entries: [
					{
						hash: 'abc123456789',
						shortHash: 'abc1234',
						author: 'John Doe',
						date: '2024-01-15T10:30:00+00:00',
						refs: ['HEAD -> main', 'origin/main'],
						subject: 'Initial commit',
						additions: 50,
						deletions: 10,
					},
					{
						hash: 'def987654321',
						shortHash: 'def9876',
						author: 'Jane Smith',
						date: '2024-01-14T09:00:00+00:00',
						refs: [],
						subject: 'Add feature',
						additions: 25,
						deletions: 0,
					},
				],
				error: null,
			});
		});

		it('should use custom limit parameter', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			await handler!({} as any, '/test/repo', { limit: 50 });

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				[
					'log',
					'--max-count=50',
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
				],
				'/test/repo'
			);
		});

		it('should include search filter when provided', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			await handler!({} as any, '/test/repo', { search: 'bugfix' });

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				[
					'log',
					'--max-count=100',
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
					'--all',
					'--grep=bugfix',
					'-i',
				],
				'/test/repo'
			);
		});

		it('should return empty entries when no commits exist', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				entries: [],
				error: null,
			});
		});

		it('should return error when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				entries: [],
				error: 'fatal: not a git repository',
			});
		});

		it('should handle commit subject containing pipe characters', async () => {
			// Pipe character in commit subject should be preserved
			const logOutput = `COMMIT_STARTabc123|Author|2024-01-15T10:00:00+00:00||Fix: handle a | b condition

 1 file changed, 5 insertions(+)`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: logOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo');

			expect(result.entries[0].subject).toBe('Fix: handle a | b condition');
		});

		it('should handle commits without shortstat (no file changes)', async () => {
			// Merge commits or empty commits may not have shortstat
			const logOutput = `COMMIT_STARTabc1234567890abcdef1234567890abcdef12345678|Author|2024-01-15T10:00:00+00:00|HEAD -> main|Merge branch 'feature'`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: logOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo');

			expect(result.entries[0]).toEqual({
				hash: 'abc1234567890abcdef1234567890abcdef12345678',
				shortHash: 'abc1234',
				author: 'Author',
				date: '2024-01-15T10:00:00+00:00',
				refs: ['HEAD -> main'],
				subject: "Merge branch 'feature'",
				additions: 0,
				deletions: 0,
			});
		});

		it('should parse deletion-only shortstat entries', async () => {
			const logOutput = `COMMIT_STARTabc123456789|John Doe|2024-01-15T10:30:00+00:00||Remove obsolete file

 1 file changed, 12 deletions(-)`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: logOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo');

			expect(result.entries[0]).toEqual(
				expect.objectContaining({
					additions: 0,
					deletions: 12,
					subject: 'Remove obsolete file',
				})
			);
		});

		it('should use SSH remote execution when sshRemoteId is provided', async () => {
			// Mock the remote config
			mockSettingsStore.get.mockReturnValue([
				{
					id: 'ssh-remote-123',
					enabled: true,
					host: 'example.com',
					user: 'testuser',
					privateKeyPath: '/path/to/key',
					knownHostsPath: '/path/to/known_hosts',
				},
			]);

			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.execGitRemote).mockResolvedValue({
				stdout: `COMMIT_STARTabc123|John Doe|2024-01-15T10:30:00+00:00|HEAD -> main|Initial commit

  2 files changed, 50 insertions(+), 10 deletions(-)
COMMIT_STARTdef987654321|Jane Smith|2024-01-14T09:00:00+00:00||Add feature

  1 file changed, 25 insertions(+)`,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:log');
			const result = await handler!({} as any, '/test/repo', undefined, 'ssh-remote-123');

			expect(remoteGit.execGitRemote).toHaveBeenCalledWith(
				[
					'log',
					'--max-count=100',
					'--pretty=format:COMMIT_START%H|%an|%ad|%D|%s',
					'--date=iso-strict',
					'--shortstat',
				],
				{
					sshRemote: {
						id: 'ssh-remote-123',
						enabled: true,
						host: 'example.com',
						user: 'testuser',
						privateKeyPath: '/path/to/key',
						knownHostsPath: '/path/to/known_hosts',
					},
					remoteCwd: '/test/repo',
				}
			);
			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].subject).toBe('Initial commit');
		});
	});

	describe('git:commitCount', () => {
		it('should return commit count number', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '142\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-list', '--count', 'HEAD'],
				'/test/repo'
			);
			expect(result).toEqual({
				count: 142,
				error: null,
			});
		});

		it('should return 0 when repository has no commits', async () => {
			// Empty repo or unborn branch returns error
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: "fatal: bad revision 'HEAD'",
				exitCode: 128,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/empty/repo');

			expect(result).toEqual({
				count: 0,
				error: "fatal: bad revision 'HEAD'",
			});
		});

		it('should return error when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				count: 0,
				error: 'fatal: not a git repository',
			});
		});

		it('should use SSH remote execution when sshRemoteId is provided for git:commitCount', async () => {
			// Mock the remote config
			mockSettingsStore.get.mockReturnValue([
				{
					id: 'ssh-remote-123',
					enabled: true,
					host: 'example.com',
					user: 'testuser',
					privateKeyPath: '/path/to/key',
					knownHostsPath: '/path/to/known_hosts',
				},
			]);

			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.execGitRemote).mockResolvedValue({
				stdout: '250\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/test/repo', 'ssh-remote-123');

			expect(remoteGit.execGitRemote).toHaveBeenCalledWith(['rev-list', '--count', 'HEAD'], {
				sshRemote: {
					id: 'ssh-remote-123',
					enabled: true,
					host: 'example.com',
					user: 'testuser',
					privateKeyPath: '/path/to/key',
					knownHostsPath: '/path/to/known_hosts',
				},
				remoteCwd: '/test/repo',
			});
			expect(result).toEqual({
				count: 250,
				error: null,
			});
		});

		it('should handle large commit counts', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '50000\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/large/repo');

			expect(result).toEqual({
				count: 50000,
				error: null,
			});
		});

		it('should return 0 for non-numeric output', async () => {
			// Edge case: if somehow git returns non-numeric output
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'not a number\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:commitCount');
			const result = await handler!({} as any, '/test/repo');

			// parseInt returns NaN for "not a number", || 0 returns 0
			expect(result).toEqual({
				count: 0,
				error: null,
			});
		});
	});

	describe('git:show', () => {
		it('should return commit details with stat and patch', async () => {
			const showOutput = `commit abc123456789abcdef1234567890abcdef12345678
Author: John Doe <john@example.com>
Date:   Mon Jan 15 10:30:00 2024 +0000

    Add new feature

 src/feature.ts | 25 +++++++++++++++++++++++++
 1 file changed, 25 insertions(+)

diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1,25 @@
+// New feature code here
+export function newFeature() {
+  return true;
+}`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: showOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/test/repo', 'abc123456789');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['show', '--stat', '--patch', 'abc123456789'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: showOutput,
				stderr: '',
			});
		});

		it('should return stderr for invalid commit hash', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: bad object invalidhash123',
				exitCode: 128,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/test/repo', 'invalidhash123');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['show', '--stat', '--patch', 'invalidhash123'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: bad object invalidhash123',
			});
		});

		it('should handle short commit hashes', async () => {
			const showOutput = `commit abc1234
Author: Jane Doe <jane@example.com>
Date:   Tue Jan 16 14:00:00 2024 +0000

    Fix bug

 src/fix.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: showOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/test/repo', 'abc1234');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['show', '--stat', '--patch', 'abc1234'],
				'/test/repo'
			);
			expect(result).toEqual({
				stdout: showOutput,
				stderr: '',
			});
		});

		it('should return stderr when not a git repo', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/not/a/repo', 'abc123');

			expect(result).toEqual({
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
		});

		it('should use SSH remote execution when sshRemoteId is provided for git:show', async () => {
			// Mock the remote config
			mockSettingsStore.get.mockReturnValue([
				{
					id: 'ssh-remote-123',
					enabled: true,
					host: 'example.com',
					user: 'testuser',
					privateKeyPath: '/path/to/key',
					knownHostsPath: '/path/to/known_hosts',
				},
			]);

			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.execGitRemote).mockResolvedValue({
				stdout: `commit abc123456789
Author: Test Author <test@example.com>
Date:   Mon Jan 15 10:30:00 2024 +0000

    Test commit

diff --git a/test.txt b/test.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/test.txt
@@ -0,0 +1 @@
+test content`,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/test/repo', 'abc123456789', 'ssh-remote-123');

			expect(remoteGit.execGitRemote).toHaveBeenCalledWith(
				['show', '--stat', '--patch', 'abc123456789'],
				{
					sshRemote: {
						id: 'ssh-remote-123',
						enabled: true,
						host: 'example.com',
						user: 'testuser',
						privateKeyPath: '/path/to/key',
						knownHostsPath: '/path/to/known_hosts',
					},
					remoteCwd: '/test/repo',
				}
			);
			expect(result).toEqual({
				stdout: expect.stringContaining('Test commit'),
				stderr: '',
			});
		});

		it('should handle merge commits with multiple parents', async () => {
			const mergeShowOutput = `commit def789012345abcdef789012345abcdef12345678
Merge: abc1234 xyz5678
Author: Developer <dev@example.com>
Date:   Wed Jan 17 09:00:00 2024 +0000

    Merge branch 'feature' into main

 src/merged.ts | 10 ++++++++++
 1 file changed, 10 insertions(+)`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: mergeShowOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:show');
			const result = await handler!({} as any, '/test/repo', 'def789012345');

			expect(result).toEqual({
				stdout: mergeShowOutput,
				stderr: '',
			});
		});
	});

	describe('git:showFile', () => {
		beforeEach(() => {
			// Reset image-read mocks before each test in this describe block.
			mockSpawnSync.mockReset();
			vi.mocked(execFile.execFileBufferNoThrow).mockReset();
		});

		it('should return file content for text files', async () => {
			const fileContent = `import React from 'react';

export function Component() {
  return <div>Hello World</div>;
}`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: fileContent,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'src/Component.tsx');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['show', 'HEAD:src/Component.tsx'],
				'/test/repo'
			);
			expect(result).toEqual({
				content: fileContent,
			});
		});

		it('should return error when file not found in commit', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: "fatal: path 'nonexistent.txt' does not exist in 'HEAD'",
				exitCode: 128,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'nonexistent.txt');

			expect(result).toEqual({
				error: "fatal: path 'nonexistent.txt' does not exist in 'HEAD'",
			});
		});

		it('should return error for invalid commit reference', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: "fatal: invalid object name 'invalidref'",
				exitCode: 128,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'invalidref', 'file.txt');

			expect(result).toEqual({
				error: "fatal: invalid object name 'invalidref'",
			});
		});

		it('should recognize image files and read them via the async buffer exec', async () => {
			vi.mocked(execFile.execFileBufferNoThrow).mockResolvedValue({
				stdout: Buffer.from(''),
				stderr: '',
				exitCode: 1,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'assets/logo.gif');

			expect(execFile.execFileBufferNoThrow).toHaveBeenCalledWith(
				'git',
				['show', 'HEAD:assets/logo.gif'],
				'/test/repo',
				50 * 1024 * 1024
			);
			expect(result).toEqual({
				error: 'Failed to read file from git',
			});
		});

		it('should return base64 data URL for image files read from git', async () => {
			const imageBytes = Buffer.from('image-bytes');
			vi.mocked(execFile.execFileBufferNoThrow).mockResolvedValue({
				stdout: imageBytes,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'assets/logo.png');

			expect(result).toEqual({
				content: `data:image/png;base64,${imageBytes.toString('base64')}`,
			});
		});

		it('should handle different git refs (tags, branches, commit hashes)', async () => {
			const fileContent = 'version = "1.0.0"';

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: fileContent,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:showFile');

			// Test with tag
			await handler!({} as any, '/test/repo', 'v1.0.0', 'package.json');
			expect(execFile.execFileNoThrow).toHaveBeenLastCalledWith(
				'git',
				['show', 'v1.0.0:package.json'],
				'/test/repo'
			);

			// Test with branch
			await handler!({} as any, '/test/repo', 'feature/new-feature', 'config.ts');
			expect(execFile.execFileNoThrow).toHaveBeenLastCalledWith(
				'git',
				['show', 'feature/new-feature:config.ts'],
				'/test/repo'
			);

			// Test with short commit hash
			await handler!({} as any, '/test/repo', 'abc1234', 'README.md');
			expect(execFile.execFileNoThrow).toHaveBeenLastCalledWith(
				'git',
				['show', 'abc1234:README.md'],
				'/test/repo'
			);
		});

		it('should return fallback error when image buffer exec fails without stderr', async () => {
			vi.mocked(execFile.execFileBufferNoThrow).mockResolvedValue({
				stdout: Buffer.from(''),
				stderr: '',
				exitCode: 128,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'missing.gif');

			expect(result).toEqual({
				error: 'Failed to read file from git',
			});
		});

		it('should return fallback error for text files when execFile fails with no stderr', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			const handler = handlers.get('git:showFile');
			const result = await handler!({} as any, '/test/repo', 'HEAD', 'missing.txt');

			expect(result).toEqual({
				error: 'Failed to read file from git',
			});
		});

		it('should handle file paths with special characters', async () => {
			const fileContent = 'content';

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: fileContent,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:showFile');
			await handler!({} as any, '/test/repo', 'HEAD', 'path with spaces/file (1).txt');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['show', 'HEAD:path with spaces/file (1).txt'],
				'/test/repo'
			);
		});
	});

	describe('git:worktreeInfo', () => {
		it('should return exists: false when path does not exist', async () => {
			// Mock fs.access to throw (path doesn't exist)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/nonexistent/path');

			// createIpcHandler wraps the result with success: true
			expect(result).toEqual({
				success: true,
				exists: false,
				isWorktree: false,
			});
		});

		it('should return isWorktree: false when path exists but is not a git repo', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			// Mock git rev-parse --is-inside-work-tree to fail (not a git repo)
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: false,
			});
		});

		it('should return worktree info when path is a worktree', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			// Setup mock responses for the sequence of git commands
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir (different = worktree)
					stdout: '/main/repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'feature/my-branch\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --show-toplevel (repo root)
					stdout: '/worktree/path\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/worktree/path');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature/my-branch',
				repoRoot: '/main/repo',
			});
		});

		it('should return isWorktree: false when path is a main git repo', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			// Setup mock responses for main repo (git-dir equals git-common-dir)
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir (same as git-dir = not a worktree)
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (branch)
					stdout: 'main\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --show-toplevel (repo root)
					stdout: '/main/repo\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/main/repo');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: false,
				currentBranch: 'main',
				repoRoot: '/main/repo',
			});
		});

		it('should handle detached HEAD state in worktree', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir (different = worktree)
					stdout: '/main/repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (detached HEAD)
					stdout: 'HEAD\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --show-toplevel
					stdout: '/worktree/path\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/worktree/path');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'HEAD',
				repoRoot: '/main/repo',
			});
		});

		it('should handle branch command failure gracefully', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (fails - empty repo)
					stdout: '',
					stderr: "fatal: bad revision 'HEAD'",
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --show-toplevel
					stdout: '/main/repo\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/main/repo');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: false,
				currentBranch: undefined,
				repoRoot: '/main/repo',
			});
		});

		it('should fall back to git-dir as common dir and omit repo root when toplevel lookup fails', async () => {
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: unable to read common dir',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					stdout: 'main\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: not a git repository',
					exitCode: 128,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/main/repo');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: false,
				currentBranch: 'main',
				repoRoot: undefined,
			});
		});

		it('should resolve relative git common dirs when reporting worktree repo root', async () => {
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '../main-repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: 'feature/relative\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '/worktrees/feature\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/parent/worktrees/feature');

			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature/relative',
				repoRoot: path.resolve('/parent/worktrees/feature', '../main-repo'),
			});
		});

		it('should return an error when git directory lookup fails', async () => {
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: unable to read git dir',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: 'main\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '/main/repo\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/main/repo');

			expect(result).toEqual({
				success: false,
				error: 'Error: Failed to get git directory',
			});
		});

		it('should return worktree info from SSH remote helper', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeInfoRemote).mockResolvedValue({
				success: true,
				data: {
					exists: true,
					isWorktree: true,
					currentBranch: 'feature/remote',
					repoRoot: '/remote/main',
				},
			});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/remote/worktree', 'ssh-remote-123');

			expect(remoteGit.worktreeInfoRemote).toHaveBeenCalledWith(
				'/remote/worktree',
				enabledSshRemote
			);
			expect(result).toEqual({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature/remote',
				repoRoot: '/remote/main',
			});
		});

		it('should return an error when SSH worktree info fails', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeInfoRemote).mockResolvedValue({
				success: false,
				error: 'permission denied',
			});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/remote/worktree', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: permission denied',
			});
		});

		it('should use fallback error when SSH worktree info fails without an error', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeInfoRemote).mockResolvedValue({
				success: false,
			});

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/remote/worktree', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: Remote worktreeInfo failed',
			});
		});

		it('should return an error for disabled SSH remotes', async () => {
			mockSettingsStore.get.mockReturnValue([{ ...enabledSshRemote, enabled: false }]);

			const handler = handlers.get('git:worktreeInfo');
			const result = await handler!({} as any, '/remote/worktree', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: SSH remote not found: ssh-remote-123',
			});
		});
	});

	describe('git:getRepoRoot', () => {
		it('should return repository root path', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '/Users/dev/my-project\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/Users/dev/my-project/src');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--show-toplevel'],
				'/Users/dev/my-project/src'
			);
			// createIpcHandler wraps the result with success: true
			expect(result).toEqual({
				success: true,
				root: '/Users/dev/my-project',
			});
		});

		it('should throw error when not in a git repository', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository (or any of the parent directories): .git',
				exitCode: 128,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/not/a/repo');

			// createIpcHandler catches the error and returns success: false with "Error: " prefix
			expect(result).toEqual({
				success: false,
				error: 'Error: fatal: not a git repository (or any of the parent directories): .git',
			});
		});

		it('should return root from deeply nested directory', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '/Users/dev/project\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/Users/dev/project/src/components/ui/buttons');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--show-toplevel'],
				'/Users/dev/project/src/components/ui/buttons'
			);
			expect(result).toEqual({
				success: true,
				root: '/Users/dev/project',
			});
		});

		it('should handle paths with spaces', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '/Users/dev/My Projects/awesome project\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/Users/dev/My Projects/awesome project/src');

			expect(result).toEqual({
				success: true,
				root: '/Users/dev/My Projects/awesome project',
			});
		});

		it('should return error with fallback message when stderr is empty', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/some/path');

			// When stderr is empty, the handler throws with "Not a git repository", createIpcHandler adds "Error: " prefix
			expect(result).toEqual({
				success: false,
				error: 'Error: Not a git repository',
			});
		});

		it('should return repository root from SSH remote helper', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.getRepoRootRemote).mockResolvedValue({
				success: true,
				data: '/remote/repo',
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/remote/repo/src', 'ssh-remote-123');

			expect(remoteGit.getRepoRootRemote).toHaveBeenCalledWith(
				'/remote/repo/src',
				enabledSshRemote
			);
			expect(result).toEqual({
				success: true,
				root: '/remote/repo',
			});
		});

		it('should return an error when SSH repo root lookup fails', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.getRepoRootRemote).mockResolvedValue({
				success: false,
				error: 'not a git repository',
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/remote/path', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: not a git repository',
			});
		});

		it('should use fallback error when SSH repo root lookup fails without an error', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.getRepoRootRemote).mockResolvedValue({
				success: false,
			});

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/remote/path', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: Not a git repository',
			});
		});

		it('should return an error when SSH repo root remote is missing', async () => {
			mockSettingsStore.get.mockReturnValue([]);

			const handler = handlers.get('git:getRepoRoot');
			const result = await handler!({} as any, '/remote/path', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: SSH remote not found: ssh-remote-123',
			});
		});
	});

	describe('git:worktreeSetup', () => {
		it('should create worktree via SSH remote helper', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeSetupRemote).mockResolvedValue({
				success: true,
				data: {
					success: true,
					created: true,
					currentBranch: 'feature/remote',
					requestedBranch: 'feature/remote',
					branchMismatch: false,
				},
			});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/remote/main',
				'/remote/worktrees/feature',
				'feature/remote',
				'ssh-remote-123'
			);

			expect(remoteGit.worktreeSetupRemote).toHaveBeenCalledWith(
				'/remote/main',
				'/remote/worktrees/feature',
				'feature/remote',
				enabledSshRemote,
				undefined
			);
			expect(result).toEqual({
				success: true,
				created: true,
				currentBranch: 'feature/remote',
				requestedBranch: 'feature/remote',
				branchMismatch: false,
			});
		});

		it('should throw when SSH worktree setup fails', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeSetupRemote).mockResolvedValue({
				success: false,
				error: 'remote git worktree add failed',
			});

			const handler = handlers.get('git:worktreeSetup');

			await expect(
				handler!(
					{} as any,
					'/remote/main',
					'/remote/worktrees/feature',
					'feature/remote',
					'ssh-remote-123'
				)
			).rejects.toThrow('remote git worktree add failed');
		});

		it('should throw fallback error when SSH worktree setup fails without an error', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeSetupRemote).mockResolvedValue({
				success: false,
			});

			const handler = handlers.get('git:worktreeSetup');

			await expect(
				handler!(
					{} as any,
					'/remote/main',
					'/remote/worktrees/feature',
					'feature/remote',
					'ssh-remote-123'
				)
			).rejects.toThrow('Remote worktreeSetup failed');
		});

		it('should throw when SSH worktree setup remote is missing', async () => {
			mockSettingsStore.get.mockReturnValue([]);

			const handler = handlers.get('git:worktreeSetup');

			await expect(
				handler!(
					{} as any,
					'/remote/main',
					'/remote/worktrees/feature',
					'feature/remote',
					'ssh-remote-123'
				)
			).rejects.toThrow('SSH remote not found: ssh-remote-123');
		});

		it('should create worktree successfully with new branch', async () => {
			// Mock fs.access to throw (path doesn't exist)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockRejectedValue(new Error('ENOENT'));

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch doesn't exist)
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git worktree add -b branchName worktreePath
					stdout: "Preparing worktree (new branch 'feature-branch')",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'feature-branch'],
				'/main/repo'
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'add', '-b', 'feature-branch', '/worktrees/feature'],
				'/main/repo'
			);
			expect(result).toEqual({
				success: true,
				created: true,
				currentBranch: 'feature-branch',
				requestedBranch: 'feature-branch',
				branchMismatch: false,
			});
		});

		it('should create worktree with existing branch', async () => {
			// Mock fs.access to throw (path doesn't exist)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockRejectedValue(new Error('ENOENT'));

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123456789',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git worktree add worktreePath branchName
					stdout: "Preparing worktree (checking out 'existing-branch')",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/existing',
				'existing-branch'
			);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'add', '/worktrees/existing', 'existing-branch'],
				'/main/repo'
			);
			expect(result).toEqual({
				success: true,
				created: true,
				currentBranch: 'existing-branch',
				requestedBranch: 'existing-branch',
				branchMismatch: false,
			});
		});

		it('should return existing worktree info when path already exists with same branch', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir
					stdout: '/main/repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir (main repo)
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD
					stdout: 'feature-branch\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: true,
				created: false,
				currentBranch: 'feature-branch',
				requestedBranch: 'feature-branch',
				branchMismatch: false,
			});
		});

		it('should return branchMismatch when existing worktree has different branch', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir
					stdout: '/main/repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir (main repo)
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --abbrev-ref HEAD (different branch)
					stdout: 'other-branch\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: true,
				created: false,
				currentBranch: 'other-branch',
				requestedBranch: 'feature-branch',
				branchMismatch: true,
			});
		});

		it('should keep existing worktree when repo comparison and branch lookup fail', async () => {
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: unable to read common dir',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: ambiguous argument HEAD',
					exitCode: 128,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: true,
				created: false,
				currentBranch: '',
				requestedBranch: 'feature-branch',
				branchMismatch: true,
			});
		});

		it('should reject nested worktree path inside main repo', async () => {
			const handler = handlers.get('git:worktreeSetup');
			// Worktree path is inside the main repo
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/main/repo/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: false,
				error:
					'Worktree path cannot be inside the main repository. Please use a sibling directory (e.g., ../my-worktree) instead.',
			});
		});

		it('should fail when path exists but is not a git repo and not empty', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			// Mock readdir to return non-empty contents
			vi.mocked(fsPromises.default.readdir).mockResolvedValue([
				'file1.txt' as unknown as import('fs').Dirent,
				'file2.txt' as unknown as import('fs').Dirent,
			]);

			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git rev-parse --is-inside-work-tree (not a git repo)
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/existing',
				'feature-branch'
			);

			expect(result).toEqual({
				success: false,
				error: 'Path exists but is not a git worktree or repository (and is not empty)',
			});
		});

		it('should remove empty directory and create worktree', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			// Mock readdir to return empty directory
			vi.mocked(fsPromises.default.readdir).mockResolvedValue([]);

			// Mock rmdir to succeed
			vi.mocked(fsPromises.default.rmdir).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree (not a git repo)
					stdout: '',
					stderr: 'fatal: not a git repository',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git worktree add
					stdout: 'Preparing worktree',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!({} as any, '/main/repo', '/worktrees/empty', 'feature-branch');

			expect(fsPromises.default.rmdir).toHaveBeenCalledWith(expect.stringContaining('empty'));
			expect(result).toEqual({
				success: true,
				created: true,
				currentBranch: 'feature-branch',
				requestedBranch: 'feature-branch',
				branchMismatch: false,
			});
		});

		it('should fail when worktree belongs to a different repository', async () => {
			// Mock fs.access to succeed (path exists)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockResolvedValue(undefined);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --is-inside-work-tree
					stdout: 'true\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-common-dir (different repo)
					stdout: '/different/repo/.git\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --git-dir (main repo)
					stdout: '.git\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: false,
				error: 'Worktree path belongs to a different repository',
			});
		});

		it('should handle git worktree creation failure', async () => {
			// Mock fs.access to throw (path doesn't exist)
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockRejectedValue(new Error('ENOENT'));

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch doesn't exist)
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git worktree add -b fails
					stdout: '',
					stderr: "fatal: 'feature-branch' is already checked out at '/other/path'",
					exitCode: 128,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: false,
				error: "fatal: 'feature-branch' is already checked out at '/other/path'",
			});
		});

		it('should return fallback error when worktree creation fails without stderr', async () => {
			const fsPromises = await import('fs/promises');
			vi.mocked(fsPromises.default.access).mockRejectedValue(new Error('ENOENT'));

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 128,
				});

			const handler = handlers.get('git:worktreeSetup');
			const result = await handler!(
				{} as any,
				'/main/repo',
				'/worktrees/feature',
				'feature-branch'
			);

			expect(result).toEqual({
				success: false,
				error: 'Failed to create worktree',
			});
		});
	});

	describe('git:worktreeCheckout', () => {
		it('should checkout a branch via SSH remote helper', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeCheckoutRemote).mockResolvedValue({
				success: true,
				data: {
					success: true,
					hasUncommittedChanges: false,
				},
			});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!(
				{} as any,
				'/remote/worktree',
				'feature/remote',
				true,
				'ssh-remote-123'
			);

			expect(remoteGit.worktreeCheckoutRemote).toHaveBeenCalledWith(
				'/remote/worktree',
				'feature/remote',
				true,
				enabledSshRemote
			);
			expect(result).toEqual({
				success: true,
				hasUncommittedChanges: false,
			});
		});

		it('should throw when SSH checkout fails', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeCheckoutRemote).mockResolvedValue({
				success: false,
				error: 'remote checkout failed',
			});

			const handler = handlers.get('git:worktreeCheckout');

			await expect(
				handler!({} as any, '/remote/worktree', 'feature/remote', false, 'ssh-remote-123')
			).rejects.toThrow('remote checkout failed');
		});

		it('should throw fallback error when SSH checkout fails without an error', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.worktreeCheckoutRemote).mockResolvedValue({
				success: false,
			});

			const handler = handlers.get('git:worktreeCheckout');

			await expect(
				handler!({} as any, '/remote/worktree', 'feature/remote', false, 'ssh-remote-123')
			).rejects.toThrow('Remote worktreeCheckout failed');
		});

		it('should throw when SSH checkout remote is missing', async () => {
			mockSettingsStore.get.mockReturnValue([]);

			const handler = handlers.get('git:worktreeCheckout');

			await expect(
				handler!({} as any, '/remote/worktree', 'feature/remote', false, 'ssh-remote-123')
			).rejects.toThrow('SSH remote not found: ssh-remote-123');
		});

		it('should switch branch successfully in worktree', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123456789',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git checkout branchName
					stdout: "Switched to branch 'feature-branch'",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'feature-branch', false);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['status', '--porcelain'],
				'/worktree/path'
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'feature-branch'],
				'/worktree/path'
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', 'feature-branch'],
				'/worktree/path'
			);
			expect(result).toEqual({
				success: true,
				hasUncommittedChanges: false,
			});
		});

		it('should fail when worktree has uncommitted changes', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git status --porcelain (has uncommitted changes)
				stdout: 'M  modified.ts\nA  added.ts\n?? untracked.ts\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'feature-branch', false);

			expect(execFile.execFileNoThrow).toHaveBeenCalledTimes(1);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['status', '--porcelain'],
				'/worktree/path'
			);
			expect(result).toEqual({
				success: false,
				hasUncommittedChanges: true,
				error: 'Worktree has uncommitted changes. Please commit or stash them first.',
			});
		});

		it('should fail when branch does not exist and createIfMissing is false', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch doesn't exist)
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'nonexistent-branch', false);

			expect(execFile.execFileNoThrow).toHaveBeenCalledTimes(2);
			expect(result).toEqual({
				success: false,
				hasUncommittedChanges: false,
				error: "Branch 'nonexistent-branch' does not exist",
			});
		});

		it('should create branch when it does not exist and createIfMissing is true', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch doesn't exist)
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git checkout -b branchName
					stdout: "Switched to a new branch 'new-feature'",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'new-feature', true);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', '-b', 'new-feature'],
				'/worktree/path'
			);
			expect(result).toEqual({
				success: true,
				hasUncommittedChanges: false,
			});
		});

		it('should fail when git status command fails', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git status --porcelain (command fails)
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/not/a/worktree', 'feature-branch', false);

			expect(result).toEqual({
				success: false,
				hasUncommittedChanges: false,
				error: 'Failed to check git status',
			});
		});

		it('should fail when checkout command fails', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git checkout fails
					stdout: '',
					stderr: "error: pathspec 'feature-branch' did not match any file(s) known to git",
					exitCode: 1,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'feature-branch', false);

			expect(result).toEqual({
				success: false,
				hasUncommittedChanges: false,
				error: "error: pathspec 'feature-branch' did not match any file(s) known to git",
			});
		});

		it('should return fallback error when checkout fails without stderr', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git checkout fails without stderr
					stdout: '',
					stderr: '',
					exitCode: 1,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'feature-branch', false);

			expect(result).toEqual({
				success: false,
				hasUncommittedChanges: false,
				error: 'Checkout failed',
			});
		});

		it('should handle branch names with slashes', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (no uncommitted changes)
					stdout: '',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git checkout
					stdout: "Switched to branch 'feature/my-awesome-feature'",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!(
				{} as any,
				'/worktree/path',
				'feature/my-awesome-feature',
				false
			);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', 'feature/my-awesome-feature'],
				'/worktree/path'
			);
			expect(result).toEqual({
				success: true,
				hasUncommittedChanges: false,
			});
		});

		it('should detect only whitespace in status as no uncommitted changes', async () => {
			// Edge case: status with only whitespace should be treated as clean
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git status --porcelain (only whitespace/newlines)
					stdout: '   \n  \n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify branchName (branch exists)
					stdout: 'abc123',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git checkout
					stdout: "Switched to branch 'main'",
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:worktreeCheckout');
			const result = await handler!({} as any, '/worktree/path', 'main', false);

			// The handler checks statusResult.stdout.trim().length > 0
			// "   \n  \n".trim() = "" which has length 0, so no uncommitted changes
			expect(result).toEqual({
				success: true,
				hasUncommittedChanges: false,
			});
		});
	});

	describe('git:createPR', () => {
		it('should create PR successfully via gh CLI', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create
					stdout: 'https://github.com/user/repo/pull/123',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!(
				{} as any,
				'/worktree/path',
				'main',
				'Add new feature',
				'This PR adds a new feature'
			);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'HEAD'],
				'/worktree/path',
				expect.objectContaining({ PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' })
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				[
					'pr',
					'create',
					'--base',
					'main',
					'--title',
					'Add new feature',
					'--body',
					'This PR adds a new feature',
				],
				'/worktree/path',
				expect.objectContaining({ PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' })
			);
			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/123',
			});
		});

		it('should return error when gh CLI is not installed', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create fails - not installed
					stdout: '',
					stderr: 'command not found: gh',
					exitCode: 127,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(result).toEqual({
				success: false,
				error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
			});
		});

		it('should return error when gh is not recognized', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create fails - not recognized (Windows)
					stdout: '',
					stderr: "'gh' is not recognized as an internal or external command",
					exitCode: 1,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(result).toEqual({
				success: false,
				error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
			});
		});

		it('should return error when push fails', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git push -u origin HEAD fails
				stdout: '',
				stderr: 'fatal: unable to access remote repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(result).toEqual({
				success: false,
				error: 'Failed to push branch: fatal: unable to access remote repository',
			});
		});

		it('should return error when gh pr create fails', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create fails with generic error
					stdout: '',
					stderr: 'pull request already exists for branch feature-branch',
					exitCode: 1,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(result).toEqual({
				success: false,
				error: 'pull request already exists for branch feature-branch',
			});
		});

		it('should use custom gh path when provided', async () => {
			// Mock resolveGhPath to return the custom path
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('/opt/homebrew/bin/gh');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create with custom path
					stdout: 'https://github.com/user/repo/pull/456',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!(
				{} as any,
				'/worktree/path',
				'main',
				'Title',
				'Body',
				'/opt/homebrew/bin/gh'
			);

			expect(cliDetection.resolveGhPath).toHaveBeenCalledWith('/opt/homebrew/bin/gh');
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'/opt/homebrew/bin/gh',
				['pr', 'create', '--base', 'main', '--title', 'Title', '--body', 'Body'],
				'/worktree/path',
				expect.objectContaining({ PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' })
			);
			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/456',
			});
		});

		it('should proceed without enriched PATH when getShellPath rejects', async () => {
			// Force getShellPath to reject
			const shellPathModule = await import('../../main/runtime/getShellPath');
			vi.mocked(shellPathModule.getShellPath).mockRejectedValueOnce(
				new Error('Shell exited with code 1')
			);

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create
					stdout: 'https://github.com/user/repo/pull/789',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			// Both subprocess calls should proceed with undefined env (default)
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'HEAD'],
				'/worktree/path',
				undefined
			);
			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/789',
			});
		});

		it('should proceed without enriched PATH when getShellPath returns an empty path', async () => {
			const shellPathModule = await import('../../main/runtime/getShellPath');
			vi.mocked(shellPathModule.getShellPath).mockResolvedValueOnce('');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: 'https://github.com/user/repo/pull/790',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'HEAD'],
				'/worktree/path',
				undefined
			);
			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/790',
			});
		});

		it('should stringify non-Error getShellPath failures and continue with default PATH', async () => {
			const shellPathModule = await import('../../main/runtime/getShellPath');
			vi.mocked(shellPathModule.getShellPath).mockRejectedValueOnce('shell unavailable');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: 'https://github.com/user/repo/pull/791',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'HEAD'],
				'/worktree/path',
				undefined
			);
			expect(result).toEqual({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/791',
			});
		});

		it('should return fallback error when gh fails without stderr', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git push -u origin HEAD
					stdout: 'Everything up-to-date',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh pr create fails without stderr
					stdout: '',
					stderr: '',
					exitCode: 1,
				});

			const handler = handlers.get('git:createPR');
			const result = await handler!({} as any, '/worktree/path', 'main', 'Title', 'Body');

			expect(result).toEqual({
				success: false,
				error: 'Failed to create PR',
			});
		});
	});

	describe('git:checkGhCli', () => {
		beforeEach(async () => {
			// Reset the cached gh status before each test
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.getCachedGhStatus).mockReturnValue(null);
			// Reset resolveGhPath to return 'gh' by default
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('gh');
		});

		it('should return installed: true and authenticated: true when gh is installed and authed', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// gh --version
					stdout:
						'gh version 2.40.1 (2024-01-15)\nhttps://github.com/cli/cli/releases/tag/v2.40.1\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh auth status
					stdout: 'github.com\n  ✓ Logged in to github.com account username (keyring)\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('gh', ['--version']);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('gh', ['auth', 'status']);
			expect(result).toEqual({
				installed: true,
				authenticated: true,
			});
		});

		it('should return installed: false when gh is not installed', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// gh --version fails
				stdout: '',
				stderr: 'command not found: gh',
				exitCode: 127,
			});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any);

			expect(execFile.execFileNoThrow).toHaveBeenCalledTimes(1);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('gh', ['--version']);
			expect(result).toEqual({
				installed: false,
				authenticated: false,
			});
		});

		it('should not cache missing gh result when checking a custom ghPath', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('/custom/path/gh');
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'no such file or directory',
				exitCode: 127,
			});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any, '/custom/path/gh');

			expect(result).toEqual({
				installed: false,
				authenticated: false,
			});
			expect(cliDetection.setCachedGhStatus).not.toHaveBeenCalled();
		});

		it('should return installed: true and authenticated: false when gh is installed but not authed', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// gh --version
					stdout: 'gh version 2.40.1 (2024-01-15)\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh auth status - not authenticated
					stdout: '',
					stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
					exitCode: 1,
				});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('gh', ['--version']);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('gh', ['auth', 'status']);
			expect(result).toEqual({
				installed: true,
				authenticated: false,
			});
		});

		it('should use cached result when available and no custom ghPath', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.getCachedGhStatus).mockReturnValue({
				installed: true,
				authenticated: true,
			});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any);

			// Should not call execFileNoThrow because cached result is used
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(result).toEqual({
				installed: true,
				authenticated: true,
			});
		});

		it('should bypass cache when custom ghPath is provided', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			// Cache has a result
			vi.mocked(cliDetection.getCachedGhStatus).mockReturnValue({
				installed: true,
				authenticated: true,
			});
			// Custom path resolved
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('/opt/homebrew/bin/gh');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// gh --version
					stdout: 'gh version 2.40.1\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh auth status - not authenticated
					stdout: '',
					stderr: 'Not logged in',
					exitCode: 1,
				});

			const handler = handlers.get('git:checkGhCli');
			const result = await handler!({} as any, '/opt/homebrew/bin/gh');

			// Should bypass cache and check with custom path
			expect(cliDetection.resolveGhPath).toHaveBeenCalledWith('/opt/homebrew/bin/gh');
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('/opt/homebrew/bin/gh', ['--version']);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith('/opt/homebrew/bin/gh', [
				'auth',
				'status',
			]);
			expect(result).toEqual({
				installed: true,
				authenticated: false,
			});
		});

		it('should cache result when checking without custom ghPath', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// gh --version
					stdout: 'gh version 2.40.1\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh auth status
					stdout: 'Logged in\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:checkGhCli');
			await handler!({} as any);

			// Should cache the result
			expect(cliDetection.setCachedGhStatus).toHaveBeenCalledWith(true, true);
		});

		it('should not cache result when using custom ghPath', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('/custom/path/gh');

			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// gh --version
					stdout: 'gh version 2.40.1\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// gh auth status
					stdout: 'Logged in\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:checkGhCli');
			await handler!({} as any, '/custom/path/gh');

			// Should NOT cache when custom path is used
			expect(cliDetection.setCachedGhStatus).not.toHaveBeenCalled();
		});
	});

	describe('git:getDefaultBranch', () => {
		it('should return branch from remote when HEAD branch is available', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git remote show origin
				stdout: `* remote origin
  Fetch URL: git@github.com:user/repo.git
  Push  URL: git@github.com:user/repo.git
  HEAD branch: main
  Remote branches:
    develop tracked
    main    tracked`,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['remote', 'show', 'origin'],
				'/test/repo'
			);
			// createIpcHandler wraps with success: true
			expect(result).toEqual({
				success: true,
				branch: 'main',
			});
		});

		it('should return master when remote reports master as HEAD branch', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git remote show origin
				stdout: `* remote origin
  Fetch URL: git@github.com:user/repo.git
  Push  URL: git@github.com:user/repo.git
  HEAD branch: master
  Remote branches:
    master tracked`,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				success: true,
				branch: 'master',
			});
		});

		it('should fallback to main branch when remote check fails but main exists locally', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git remote show origin - fails (no remote or network error)
					stdout: '',
					stderr: 'fatal: unable to access remote',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify main - succeeds
					stdout: 'abc123def456\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['remote', 'show', 'origin'],
				'/test/repo'
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'main'],
				'/test/repo'
			);
			expect(result).toEqual({
				success: true,
				branch: 'main',
			});
		});

		it('should fallback to master branch when remote fails and main does not exist', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git remote show origin - fails
					stdout: '',
					stderr: 'fatal: unable to access remote',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify main - fails (main doesn't exist)
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify master - succeeds
					stdout: 'abc123def456\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'master'],
				'/test/repo'
			);
			expect(result).toEqual({
				success: true,
				branch: 'master',
			});
		});

		it('should return error when neither main nor master exist and remote fails', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git remote show origin - fails
					stdout: '',
					stderr: 'fatal: no remote',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify main - fails
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify master - fails
					stdout: '',
					stderr: 'fatal: Needed a single revision',
					exitCode: 128,
				});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			// createIpcHandler wraps error with success: false and error prefix
			expect(result).toEqual({
				success: false,
				error: 'Error: Could not determine default branch',
			});
		});

		it('should handle custom default branch names from remote', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				// git remote show origin - with custom default branch
				stdout: `* remote origin
  Fetch URL: git@github.com:user/repo.git
  HEAD branch: develop
  Remote branches:
    develop tracked`,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				success: true,
				branch: 'develop',
			});
		});

		it('should fallback when remote output does not contain HEAD branch line', async () => {
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					// git remote show origin - succeeds but no HEAD branch line
					stdout: `* remote origin
  Fetch URL: git@github.com:user/repo.git
  Push  URL: git@github.com:user/repo.git
  Remote branches:
    main tracked`,
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					// git rev-parse --verify main - succeeds
					stdout: 'abc123\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:getDefaultBranch');
			const result = await handler!({} as any, '/test/repo');

			// Should fallback to local main branch check
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--verify', 'main'],
				'/test/repo'
			);
			expect(result).toEqual({
				success: true,
				branch: 'main',
			});
		});
	});

	describe('git:listWorktrees', () => {
		it('should list worktrees via SSH remote helper', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			const worktrees = [
				{
					path: '/remote/main',
					head: 'abc123',
					branch: 'main',
					isBare: false,
				},
				{
					path: '/remote/feature',
					head: 'def456',
					branch: 'feature/remote',
					isBare: false,
				},
			];
			vi.mocked(remoteGit.listWorktreesRemote).mockResolvedValue({
				success: true,
				data: worktrees,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/remote/main', 'ssh-remote-123');

			expect(remoteGit.listWorktreesRemote).toHaveBeenCalledWith('/remote/main', enabledSshRemote);
			expect(result).toEqual({
				success: true,
				worktrees,
			});
		});

		it('should return an error when SSH list worktrees fails', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.listWorktreesRemote).mockResolvedValue({
				success: false,
				error: 'remote worktree list failed',
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/remote/main', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: remote worktree list failed',
			});
		});

		it('should use fallback error when SSH list worktrees fails without an error', async () => {
			enableSshRemote();
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteGit.listWorktreesRemote).mockResolvedValue({
				success: false,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/remote/main', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: Remote listWorktrees failed',
			});
		});

		it('should return an error when SSH list worktrees remote is missing', async () => {
			mockSettingsStore.get.mockReturnValue([]);

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/remote/main', 'ssh-remote-123');

			expect(result).toEqual({
				success: false,
				error: 'Error: SSH remote not found: ssh-remote-123',
			});
		});

		it('should return list of worktrees with parsed details', async () => {
			const porcelainOutput = `worktree /home/user/project
HEAD abc123def456789
branch refs/heads/main

worktree /home/user/project-feature
HEAD def456abc789012
branch refs/heads/feature/new-feature

`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'list', '--porcelain'],
				'/home/user/project'
			);
			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project',
						head: 'abc123def456789',
						branch: 'main',
						isBare: false,
					},
					{
						path: '/home/user/project-feature',
						head: 'def456abc789012',
						branch: 'feature/new-feature',
						isBare: false,
					},
				],
			});
		});

		it('should return empty list when not a git repository', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/not/a/repo');

			expect(result).toEqual({
				success: true,
				worktrees: [],
			});
		});

		it('should return empty list when no worktrees exist', async () => {
			// Edge case: git worktree list returns nothing (shouldn't happen normally,
			// as main repo is always listed, but testing defensive code)
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/test/repo');

			expect(result).toEqual({
				success: true,
				worktrees: [],
			});
		});

		it('should handle detached HEAD state in worktree', async () => {
			const porcelainOutput = `worktree /home/user/project
HEAD abc123def456789
branch refs/heads/main

worktree /home/user/project-detached
HEAD def456abc789012
detached

`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project');

			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project',
						head: 'abc123def456789',
						branch: 'main',
						isBare: false,
					},
					{
						path: '/home/user/project-detached',
						head: 'def456abc789012',
						branch: null,
						isBare: false,
					},
				],
			});
		});

		it('should handle bare repository entry', async () => {
			const porcelainOutput = `worktree /home/user/project.git
bare

`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project.git');

			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project.git',
						head: '',
						branch: null,
						isBare: true,
					},
				],
			});
		});

		it('should handle output without trailing newline', async () => {
			// Test the edge case where there's no trailing newline after the last entry
			const porcelainOutput = `worktree /home/user/project
HEAD abc123def456789
branch refs/heads/main`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project');

			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project',
						head: 'abc123def456789',
						branch: 'main',
						isBare: false,
					},
				],
			});
		});

		it('should default missing head and branch on final worktree entry', async () => {
			const porcelainOutput = 'worktree /home/user/project-no-head';

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project');

			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project-no-head',
						head: '',
						branch: null,
						isBare: false,
					},
				],
			});
		});

		it('should handle multiple worktrees with various branch formats', async () => {
			const porcelainOutput = `worktree /home/user/project
HEAD abc123
branch refs/heads/main

worktree /home/user/worktree-1
HEAD def456
branch refs/heads/feature/deep/nested/branch

worktree /home/user/worktree-2
HEAD ghi789
branch refs/heads/bugfix-123

`;

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: porcelainOutput,
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:listWorktrees');
			const result = await handler!({} as any, '/home/user/project');

			expect(result).toEqual({
				success: true,
				worktrees: [
					{
						path: '/home/user/project',
						head: 'abc123',
						branch: 'main',
						isBare: false,
					},
					{
						path: '/home/user/worktree-1',
						head: 'def456',
						branch: 'feature/deep/nested/branch',
						isBare: false,
					},
					{
						path: '/home/user/worktree-2',
						head: 'ghi789',
						branch: 'bugfix-123',
						isBare: false,
					},
				],
			});
		});
	});

	describe('git:scanWorktreeDirectory', () => {
		let mockFs: typeof import('fs/promises').default;

		beforeEach(async () => {
			mockFs = (await import('fs/promises')).default;
		});

		it('should scan SSH remote directories using remote filesystem and git helpers', async () => {
			enableSshRemote();
			const remoteFs = await import('../../main/utils/remote-fs');
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
				success: true,
				data: [
					{ name: 'remote-worktree', isDirectory: true },
					{ name: '.hidden', isDirectory: true },
					{ name: 'README.md', isDirectory: false },
				] as any,
			});
			vi.mocked(remoteGit.execGitRemote).mockImplementation(async (args, options: any) => {
				const cwd = String(options.remoteCwd);
				if (cwd.endsWith('/remote-worktree')) {
					if (args.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--show-toplevel')) {
						return { stdout: '/remote/parent/remote-worktree\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--git-dir')) {
						return {
							stdout: '/remote/main/.git/worktrees/remote-worktree\n',
							stderr: '',
							exitCode: 0,
						};
					}
					if (args.includes('--git-common-dir')) {
						return { stdout: '/remote/main/.git\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--abbrev-ref')) {
						return { stdout: 'feature/remote\n', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/remote/parent/', 'ssh-remote-123');

			expect(remoteFs.readDirRemote).toHaveBeenCalledWith('/remote/parent/', enabledSshRemote);
			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: '/remote/parent/remote-worktree',
						name: 'remote-worktree',
						isWorktree: true,
						branch: 'feature/remote',
						repoRoot: '/remote/main',
					},
				],
			});
		});

		it('should scan SSH paths without trailing slash and resolve relative and root repo roots', async () => {
			enableSshRemote();
			const remoteFs = await import('../../main/utils/remote-fs');
			const remoteGit = await import('../../main/utils/remote-git');
			vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
				success: true,
				data: [
					{ name: 'relative-worktree', isDirectory: true },
					{ name: 'root-worktree', isDirectory: true },
				] as any,
			});
			vi.mocked(remoteGit.execGitRemote).mockImplementation(async (args, options: any) => {
				const cwd = String(options.remoteCwd);

				if (args.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args.includes('--show-toplevel')) {
					return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 };
				}

				if (cwd.endsWith('/relative-worktree')) {
					if (args.includes('--git-dir')) {
						return {
							stdout: '../main/.git/worktrees/relative-worktree\n',
							stderr: '',
							exitCode: 0,
						};
					}
					if (args.includes('--git-common-dir')) {
						return { stdout: '../main/.git\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--abbrev-ref')) {
						return { stdout: 'feature/relative\n', stderr: '', exitCode: 0 };
					}
				}

				if (cwd.endsWith('/root-worktree')) {
					if (args.includes('--git-dir')) {
						return { stdout: '/.git/worktrees/root-worktree\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--git-common-dir')) {
						return { stdout: '/.git\n', stderr: '', exitCode: 0 };
					}
					if (args.includes('--abbrev-ref')) {
						return { stdout: 'feature/root\n', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/remote/parent', 'ssh-remote-123');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: '/remote/parent/relative-worktree',
						name: 'relative-worktree',
						isWorktree: true,
						branch: 'feature/relative',
						repoRoot: '/remote/parent/main',
					},
					{
						path: '/remote/parent/root-worktree',
						name: 'root-worktree',
						isWorktree: true,
						branch: 'feature/root',
						repoRoot: '/',
					},
				],
			});
		});

		it('should include SSH repos with null metadata when git metadata fallbacks fail', async () => {
			enableSshRemote();
			const remoteFs = await import('../../main/utils/remote-fs');
			const remoteGit = await import('../../main/utils/remote-git');
			let showToplevelCalls = 0;

			vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
				success: true,
				data: [{ name: 'broken-metadata', isDirectory: true }] as any,
			});
			vi.mocked(remoteGit.execGitRemote).mockImplementation(async (args, options: any) => {
				const cwd = String(options.remoteCwd);

				if (args.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args.includes('--show-toplevel')) {
					showToplevelCalls += 1;
					if (showToplevelCalls === 1) {
						return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 };
					}
					return { stdout: '', stderr: 'fatal: unable to read toplevel', exitCode: 128 };
				}
				if (
					args.includes('--git-dir') ||
					args.includes('--git-common-dir') ||
					args.includes('--abbrev-ref')
				) {
					return { stdout: '', stderr: 'fatal: unable to read metadata', exitCode: 128 };
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/remote/parent', 'ssh-remote-123');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: '/remote/parent/broken-metadata',
						name: 'broken-metadata',
						isWorktree: false,
						branch: null,
						repoRoot: '/remote/parent/broken-metadata',
					},
				],
			});
		});

		it('should return an empty list when SSH directory reads fail', async () => {
			enableSshRemote();
			const remoteFs = await import('../../main/utils/remote-fs');
			vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
				success: false,
				error: 'permission denied',
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/remote/parent', 'ssh-remote-123');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [],
				scanFailed: true,
			});
		});

		it('should find git repositories and worktrees in directory', async () => {
			// Mock fs.readdir to return directory entries
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'main-repo', isDirectory: () => true },
				{ name: 'worktree-feature', isDirectory: () => true },
				{ name: 'regular-folder', isDirectory: () => true },
			] as any);

			// Mock git commands for each subdirectory
			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				// main-repo: regular git repo
				if (cwdStr.endsWith('main-repo')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'main\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/main-repo', stderr: '', exitCode: 0 };
					}
				}

				// worktree-feature: a git worktree
				if (cwdStr.endsWith('worktree-feature')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/worktree-feature', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return {
							stdout: '/parent/main-repo/.git/worktrees/worktree-feature',
							stderr: '',
							exitCode: 0,
						};
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '/parent/main-repo/.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'feature-branch\n', stderr: '', exitCode: 0 };
					}
				}

				// regular-folder: not a git repo
				if (cwdStr.endsWith('regular-folder')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
					}
				}

				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			expect(mockFs.readdir).toHaveBeenCalledWith('/parent', { withFileTypes: true });
			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: path.join('/parent', 'main-repo'),
						name: 'main-repo',
						isWorktree: false,
						branch: 'main',
						repoRoot: '/parent/main-repo',
					},
					{
						path: path.join('/parent', 'worktree-feature'),
						name: 'worktree-feature',
						isWorktree: true,
						branch: 'feature-branch',
						repoRoot: '/parent/main-repo',
					},
				],
			});
		});

		it('should exclude hidden directories', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: '.git', isDirectory: () => true },
				{ name: '.hidden', isDirectory: () => true },
				{ name: 'visible-repo', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				if (cwdStr.endsWith('visible-repo')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'main\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/visible-repo', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			// Should only include visible-repo, not .git or .hidden
			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: path.join('/parent', 'visible-repo'),
						name: 'visible-repo',
						isWorktree: false,
						branch: 'main',
						repoRoot: '/parent/visible-repo',
					},
				],
			});
		});

		it('should skip files (non-directories)', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'repo-dir', isDirectory: () => true },
				{ name: 'file.txt', isDirectory: () => false },
				{ name: 'README.md', isDirectory: () => false },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				if (cwdStr.endsWith('repo-dir')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'develop\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/repo-dir', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			// Should only include repo-dir directory
			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: path.join('/parent', 'repo-dir'),
						name: 'repo-dir',
						isWorktree: false,
						branch: 'develop',
						repoRoot: '/parent/repo-dir',
					},
				],
			});
		});

		it('should fall back to resolved paths when realpath lookup fails', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'repo-dir', isDirectory: () => true },
			] as any);
			vi.mocked(mockFs.realpath)
				.mockRejectedValueOnce(new Error('realpath failed for subdir'))
				.mockRejectedValueOnce(new Error('realpath failed for toplevel'));

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				if (cwdStr.endsWith('repo-dir')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/repo-dir', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'main\n', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: path.join('/parent', 'repo-dir'),
						name: 'repo-dir',
						isWorktree: false,
						branch: 'main',
						repoRoot: '/parent/repo-dir',
					},
				],
			});
		});

		it('should return empty array when directory has no git repos', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'folder1', isDirectory: () => true },
				{ name: 'folder2', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'fatal: not a git repository',
				exitCode: 128,
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [],
			});
		});

		it('should return empty array when directory is empty', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([]);

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/empty/parent');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [],
			});
		});

		it('should handle readdir errors gracefully', async () => {
			vi.mocked(mockFs.readdir).mockRejectedValue(new Error('ENOENT: no such file or directory'));

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/nonexistent/path');

			// The handler catches errors and returns empty gitSubdirs
			expect(result).toEqual({
				success: true,
				gitSubdirs: [],
				scanFailed: true,
			});
		});

		it('should handle null branch when git branch command fails', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'detached-repo', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--git-dir')) {
					return { stdout: '.git', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--git-common-dir')) {
					return { stdout: '.git', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					// Branch command fails (e.g., empty repo)
					return { stdout: '', stderr: 'fatal: ambiguous argument', exitCode: 128 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: '/parent/detached-repo', stderr: '', exitCode: 0 };
				}

				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			expect(result).toEqual({
				success: true,
				gitSubdirs: [
					{
						path: path.join('/parent', 'detached-repo'),
						name: 'detached-repo',
						isWorktree: false,
						branch: null,
						repoRoot: '/parent/detached-repo',
					},
				],
			});
		});

		it('should correctly calculate repo root for worktrees with relative git-common-dir', async () => {
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'my-worktree', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: '/parent/my-worktree', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--git-dir')) {
					// Worktree has a different git-dir
					return { stdout: '../main-repo/.git/worktrees/my-worktree', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--git-common-dir')) {
					// Relative path to main repo's .git
					return { stdout: '../main-repo/.git', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: 'feature-xyz\n', stderr: '', exitCode: 0 };
				}

				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			// The repoRoot should be resolved from the relative git-common-dir
			expect(result.gitSubdirs[0].isWorktree).toBe(true);
			expect(result.gitSubdirs[0].branch).toBe('feature-xyz');
			expect(result.gitSubdirs[0].repoRoot).toMatch(/main-repo$/);
		});

		it('should exclude subdirectories that are inside a repo but not worktree roots', async () => {
			// Simulates a directory like "build/" inside a worktree that passes --is-inside-work-tree
			// but whose --show-toplevel points to the parent worktree, not itself
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'actual-worktree', isDirectory: () => true },
				{ name: 'build', isDirectory: () => true },
				{ name: 'src', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				if (cwdStr.endsWith('actual-worktree')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/actual-worktree', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'feature-branch\n', stderr: '', exitCode: 0 };
					}
				}

				// build/ and src/ are subdirectories inside actual-worktree's repo
				if (cwdStr.endsWith('/build') || cwdStr.endsWith('/src')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						// Toplevel points to the worktree root, NOT to build/ or src/
						return { stdout: '/parent/actual-worktree', stderr: '', exitCode: 0 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			// Only actual-worktree should be included; build/ and src/ should be filtered out
			expect(result.gitSubdirs).toHaveLength(1);
			expect(result.gitSubdirs[0].name).toBe('actual-worktree');
			expect(result.gitSubdirs[0].branch).toBe('feature-branch');
		});

		it('should exclude subdirectories where --show-toplevel fails', async () => {
			// Simulates a directory where git rev-parse --show-toplevel returns a non-zero exit code
			// (e.g., corrupted repo, permission denied). Should be treated as invalid worktree.
			vi.mocked(mockFs.readdir).mockResolvedValue([
				{ name: 'good-worktree', isDirectory: () => true },
				{ name: 'broken-repo', isDirectory: () => true },
			] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdStr = String(cwd);

				if (cwdStr.endsWith('good-worktree')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						return { stdout: '/parent/good-worktree', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--git-common-dir')) {
						return { stdout: '.git', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--abbrev-ref')) {
						return { stdout: 'main\n', stderr: '', exitCode: 0 };
					}
				}

				if (cwdStr.endsWith('/broken-repo')) {
					if (args?.includes('--is-inside-work-tree')) {
						return { stdout: 'true\n', stderr: '', exitCode: 0 };
					}
					if (args?.includes('--show-toplevel')) {
						// Simulate failure (e.g., permission denied, corrupted .git)
						return { stdout: '', stderr: 'fatal: unable to read tree', exitCode: 128 };
					}
				}

				return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
			});

			const handler = handlers.get('git:scanWorktreeDirectory');
			const result = await handler!({} as any, '/parent');

			// Only good-worktree should be included; broken-repo should be filtered out
			expect(result.gitSubdirs).toHaveLength(1);
			expect(result.gitSubdirs[0].name).toBe('good-worktree');
		});
	});

	describe('git:watchWorktreeDirectory', () => {
		let mockFs: typeof import('fs/promises').default;
		let mockChokidar: typeof import('chokidar').default;

		beforeEach(async () => {
			mockFs = (await import('fs/promises')).default;
			mockChokidar = (await import('chokidar')).default;
		});

		it('should return polling guidance for SSH remote sessions', async () => {
			const handler = handlers.get('git:watchWorktreeDirectory');
			const result = await handler!(
				{} as any,
				'session-remote',
				'/remote/worktrees',
				'ssh-remote-123'
			);

			expect(mockFs.access).not.toHaveBeenCalled();
			expect(mockChokidar.watch).not.toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				isRemote: true,
				message: 'File watching not available for remote sessions. Use polling instead.',
			});
		});

		it('should start watching a valid directory and return success', async () => {
			// Mock fs.access to succeed (directory exists)
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			// Mock chokidar.watch
			const mockWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const handler = handlers.get('git:watchWorktreeDirectory');
			const result = await handler!({} as any, 'session-123', '/parent/worktrees');

			expect(mockFs.access).toHaveBeenCalledWith('/parent/worktrees');
			expect(mockChokidar.watch).toHaveBeenCalledWith('/parent/worktrees', {
				ignored: [/(^|[/\\])\../, expect.any(RegExp)],
				persistent: true,
				ignoreInitial: true,
				depth: 1,
			});
			expect(mockWatcher.on).toHaveBeenCalledWith('addDir', expect.any(Function));
			expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
			expect(result).toEqual({ success: true });
		});

		it('should log watcher error events without failing setup', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let errorCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'error') {
						errorCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const handler = handlers.get('git:watchWorktreeDirectory');
			const result = await handler!({} as any, 'session-error', '/parent/worktrees');

			expect(result).toEqual({ success: true });
			expect(errorCallback).toBeDefined();

			errorCallback!(new Error('watch failed'));

			const { logger } = await import('../../main/utils/logger');
			expect(logger.error).toHaveBeenCalledWith(
				'[Git] Worktree watcher error for session session-error: Error: watch failed'
			);
		});

		it('should close existing watcher before starting new one for same session', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			const mockWatcher1 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn().mockResolvedValue(undefined),
			};
			const mockWatcher2 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch)
				.mockReturnValueOnce(mockWatcher1 as any)
				.mockReturnValueOnce(mockWatcher2 as any);

			const handler = handlers.get('git:watchWorktreeDirectory');

			// First watch
			await handler!({} as any, 'session-123', '/path/1');
			expect(mockWatcher1.close).not.toHaveBeenCalled();

			// Second watch for same session should close first watcher
			await handler!({} as any, 'session-123', '/path/2');
			expect(mockWatcher1.close).toHaveBeenCalled();
		});

		it('should return error when directory does not exist', async () => {
			vi.mocked(mockFs.access).mockRejectedValue(new Error('ENOENT: no such file or directory'));

			const handler = handlers.get('git:watchWorktreeDirectory');
			const result = await handler!({} as any, 'session-456', '/nonexistent/path');

			// The handler catches errors and returns success: false with error message
			// The handler's explicit return { success: false, error } overrides createIpcHandler's success: true
			expect(result).toEqual({
				success: false,
				error: 'Error: ENOENT: no such file or directory',
			});
			// Should not attempt to watch
			expect(mockChokidar.watch).not.toHaveBeenCalled();
		});

		it('should handle watcher setup errors', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			// Mock chokidar.watch to throw an error
			vi.mocked(mockChokidar.watch).mockImplementation(() => {
				throw new Error('Failed to initialize watcher');
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			const result = await handler!({} as any, 'session-789', '/some/path');

			// The handler's explicit return { success: false, error } overrides createIpcHandler's success: true
			expect(result).toEqual({
				success: false,
				error: 'Error: Failed to initialize watcher',
			});
		});

		it('should set up addDir event handler that emits worktree:discovered', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			// Mock window for event emission
			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			// Mock git commands for the discovered directory
			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: '/parent/worktrees/new-worktree', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: 'feature-branch\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-emit', '/parent/worktrees');

			// Verify addDir handler was registered
			expect(addDirCallback).toBeDefined();

			// Simulate directory addition
			await addDirCallback!('/parent/worktrees/new-worktree');

			// Fast-forward past debounce
			await vi.advanceTimersByTimeAsync(600);

			// Should emit worktree:discovered event
			expect(mockWindow.webContents.send).toHaveBeenCalledWith('worktree:discovered', {
				sessionId: 'session-emit',
				worktree: {
					path: '/parent/worktrees/new-worktree',
					name: 'new-worktree',
					branch: 'feature-branch',
				},
			});

			vi.useRealTimers();
		});

		it('should skip emitting event when directory is the watched path itself', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-skip', '/parent/worktrees');

			// Simulate root directory being reported (should be skipped)
			await addDirCallback!('/parent/worktrees');

			await vi.advanceTimersByTimeAsync(600);

			// Should not emit any events
			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should skip emitting event for main/master/HEAD branches', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			// Mock git commands - return main branch
			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: String(cwd), stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: 'main\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-main', '/parent/worktrees');

			// Simulate directory with main branch
			await addDirCallback!('/parent/worktrees/main-clone');

			await vi.advanceTimersByTimeAsync(600);

			// Should not emit events for main/master branches
			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should skip non-git directories', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			// Mock git commands - not a git repo
			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-nongit', '/parent/worktrees');

			// Simulate non-git directory
			await addDirCallback!('/parent/worktrees/regular-folder');

			await vi.advanceTimersByTimeAsync(600);

			// Should not emit events for non-git directories
			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should debounce rapid directory additions', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			// Track which paths were checked
			const checkedPaths: string[] = [];
			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					checkedPaths.push(cwd as string);
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: String(cwd), stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: 'feature\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-debounce', '/parent/worktrees');

			// Simulate rapid directory additions
			await addDirCallback!('/parent/worktrees/dir1');
			await vi.advanceTimersByTimeAsync(100);
			await addDirCallback!('/parent/worktrees/dir2');
			await vi.advanceTimersByTimeAsync(100);
			await addDirCallback!('/parent/worktrees/dir3');

			// Fast-forward past debounce
			await vi.advanceTimersByTimeAsync(600);

			// Debouncing is keyed per discovered directory, so distinct directories all process.
			expect(checkedPaths).toEqual([
				'/parent/worktrees/dir1',
				'/parent/worktrees/dir2',
				'/parent/worktrees/dir3',
			]);

			vi.useRealTimers();
		});

		it('should clear pending debounce timer when restarting watcher for the same session', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher1 = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher1;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			const mockWatcher2 = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch)
				.mockReturnValueOnce(mockWatcher1 as any)
				.mockReturnValueOnce(mockWatcher2 as any);

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-restart', '/parent/worktrees');
			await addDirCallback!('/parent/worktrees/new-worktree');
			await handler!({} as any, 'session-restart', '/other/worktrees');

			await vi.advanceTimersByTimeAsync(600);

			expect(mockWatcher1.close).toHaveBeenCalled();
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should skip discovered directories when toplevel lookup fails', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: '', stderr: 'fatal: unable to read tree', exitCode: 128 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-toplevel-fails', '/parent/worktrees');
			await addDirCallback!('/parent/worktrees/broken-worktree');

			await vi.advanceTimersByTimeAsync(600);

			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should skip discovered directories nested inside another worktree', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: '/parent/worktrees/main-worktree\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-nested', '/parent/worktrees');
			await addDirCallback!('/parent/worktrees/main-worktree/build');

			await vi.advanceTimersByTimeAsync(600);

			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should skip emitting when renderer window is unavailable after branch lookup fails', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(true),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: String(cwd), stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: '', stderr: 'fatal: ambiguous argument HEAD', exitCode: 128 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const handler = handlers.get('git:watchWorktreeDirectory');
			await handler!({} as any, 'session-destroyed-window', '/parent/worktrees');
			await addDirCallback!('/parent/worktrees/feature-worktree');

			await vi.advanceTimersByTimeAsync(600);

			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});
	});

	describe('git:unwatchWorktreeDirectory', () => {
		let mockFs: typeof import('fs/promises').default;
		let mockChokidar: typeof import('chokidar').default;

		beforeEach(async () => {
			mockFs = (await import('fs/promises')).default;
			mockChokidar = (await import('chokidar')).default;
		});

		it('should close watcher and return success', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			const mockWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			// First set up a watcher
			const watchHandler = handlers.get('git:watchWorktreeDirectory');
			await watchHandler!({} as any, 'session-unwatch', '/some/path');

			// Now unwatch it
			const unwatchHandler = handlers.get('git:unwatchWorktreeDirectory');
			const result = await unwatchHandler!({} as any, 'session-unwatch');

			expect(mockWatcher.close).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('should return success even when no watcher exists for session', async () => {
			const handler = handlers.get('git:unwatchWorktreeDirectory');
			const result = await handler!({} as any, 'nonexistent-session');

			expect(result).toEqual({ success: true });
		});

		it('should clear pending debounce timers', async () => {
			vi.useFakeTimers();

			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			let addDirCallback: Function | undefined;
			const mockWatcher = {
				on: vi.fn((event: string, cb: Function) => {
					if (event === 'addDir') {
						addDirCallback = cb;
					}
					return mockWatcher;
				}),
				close: vi.fn().mockResolvedValue(undefined),
			};
			vi.mocked(mockChokidar.watch).mockReturnValue(mockWatcher as any);

			const mockWindow = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					send: vi.fn(),
					isDestroyed: vi.fn().mockReturnValue(false),
				},
			};
			const { BrowserWindow } = await import('electron');
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow] as any);

			vi.mocked(execFile.execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				if (args?.includes('--is-inside-work-tree')) {
					return { stdout: 'true\n', stderr: '', exitCode: 0 };
				}
				if (args?.includes('--show-toplevel')) {
					return { stdout: String(cwd), stderr: '', exitCode: 0 };
				}
				if (args?.includes('--abbrev-ref')) {
					return { stdout: 'feature\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const watchHandler = handlers.get('git:watchWorktreeDirectory');
			await watchHandler!({} as any, 'session-timer', '/some/path');

			// Trigger a directory add that starts the debounce timer
			await addDirCallback!('/some/path/new-dir');
			await vi.advanceTimersByTimeAsync(100); // Don't complete debounce

			// Unwatch should clear the timer
			const unwatchHandler = handlers.get('git:unwatchWorktreeDirectory');
			await unwatchHandler!({} as any, 'session-timer');

			// Advance past the original debounce timeout
			await vi.advanceTimersByTimeAsync(600);

			// No event should have been emitted because timer was cleared
			expect(mockWindow.webContents.send).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should handle multiple watch/unwatch cycles for same session', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);

			const mockWatchers = [
				{ on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) },
				{ on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) },
				{ on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) },
			];
			vi.mocked(mockChokidar.watch)
				.mockReturnValueOnce(mockWatchers[0] as any)
				.mockReturnValueOnce(mockWatchers[1] as any)
				.mockReturnValueOnce(mockWatchers[2] as any);

			const watchHandler = handlers.get('git:watchWorktreeDirectory');
			const unwatchHandler = handlers.get('git:unwatchWorktreeDirectory');

			// First cycle
			await watchHandler!({} as any, 'session-cycle', '/path/1');
			await unwatchHandler!({} as any, 'session-cycle');
			expect(mockWatchers[0].close).toHaveBeenCalled();

			// Second cycle
			await watchHandler!({} as any, 'session-cycle', '/path/2');
			await unwatchHandler!({} as any, 'session-cycle');
			expect(mockWatchers[1].close).toHaveBeenCalled();

			// Third cycle
			await watchHandler!({} as any, 'session-cycle', '/path/3');
			await unwatchHandler!({} as any, 'session-cycle');
			expect(mockWatchers[2].close).toHaveBeenCalled();
		});
	});

	describe('git:removeWorktree', () => {
		let mockFs: typeof import('fs/promises').default;

		beforeEach(async () => {
			mockFs = (await import('fs/promises')).default;
		});

		it('should remove a worktree through git worktree remove', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/worktrees/feature');

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'remove', '/worktrees/feature'],
				'/worktrees/feature'
			);
			expect(mockFs.rm).not.toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('should pass --force to git worktree remove when requested', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/worktrees/feature', true);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'remove', '--force', '/worktrees/feature'],
				'/worktrees/feature'
			);
			expect(result).toEqual({ success: true });
		});

		it('should skip dirty-check and recursively remove when forced git removal fails', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);
			vi.mocked(mockFs.rm).mockResolvedValue(undefined);
			vi.mocked(execFile.execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'fatal: contains modified or untracked files',
				exitCode: 128,
			});

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/worktrees/dirty', true);

			expect(execFile.execFileNoThrow).toHaveBeenCalledTimes(1);
			expect(mockFs.rm).toHaveBeenCalledWith('/worktrees/dirty', {
				recursive: true,
				force: true,
			});
			expect(result).toEqual({ success: true });
		});

		it('should refuse non-forced removal when the worktree has uncommitted changes', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: contains modified or untracked files',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					stdout: 'M  src/file.ts\n?? new-file.ts\n',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/worktrees/dirty');

			expect(mockFs.rm).not.toHaveBeenCalled();
			expect(result).toEqual({
				success: false,
				error: 'Worktree has uncommitted changes. Use force option to delete anyway.',
				hasUncommittedChanges: true,
			});
		});

		it('should fall back to recursive directory removal for clean non-worktree paths', async () => {
			vi.mocked(mockFs.access).mockResolvedValue(undefined);
			vi.mocked(mockFs.rm).mockResolvedValue(undefined);
			vi.mocked(execFile.execFileNoThrow)
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'fatal: not a git worktree',
					exitCode: 128,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 0,
				});

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/worktrees/clean-folder');

			expect(mockFs.rm).toHaveBeenCalledWith('/worktrees/clean-folder', {
				recursive: true,
				force: true,
			});
			expect(result).toEqual({ success: true });
		});

		it('should return an error when the target cannot be accessed', async () => {
			vi.mocked(mockFs.access).mockRejectedValue(new Error('ENOENT: no such file or directory'));

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/missing/worktree');

			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(mockFs.rm).not.toHaveBeenCalled();
			expect(result).toEqual({
				success: false,
				error: 'ENOENT: no such file or directory',
			});
		});

		it('should stringify non-Error failures when remove target cannot be accessed', async () => {
			vi.mocked(mockFs.access).mockRejectedValue('permission denied');

			const handler = handlers.get('git:removeWorktree');
			const result = await handler!({} as any, '/missing/worktree');

			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(mockFs.rm).not.toHaveBeenCalled();
			expect(result).toEqual({
				success: false,
				error: 'permission denied',
			});
		});
	});

	describe('git:createGist', () => {
		beforeEach(async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('gh');
		});

		it('should create a public gist with description', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'https://gist.github.com/user/abc123\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'report.md', '# Report', 'Coverage report', true);

			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['gist', 'create', '--filename', 'report.md', '--desc', 'Coverage report', '--public', '-'],
				undefined,
				{ input: '# Report' }
			);
			expect(result).toEqual({
				success: true,
				gistUrl: 'https://gist.github.com/user/abc123',
			});
		});

		it('should create a private gist without description using a custom gh path', async () => {
			const cliDetection = await import('../../main/utils/cliDetection');
			vi.mocked(cliDetection.resolveGhPath).mockResolvedValue('/opt/homebrew/bin/gh');
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: 'https://gist.github.com/user/private123\n',
				stderr: '',
				exitCode: 0,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!(
				{} as any,
				'notes.txt',
				'private notes',
				'',
				false,
				'/opt/homebrew/bin/gh'
			);

			expect(cliDetection.resolveGhPath).toHaveBeenCalledWith('/opt/homebrew/bin/gh');
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'/opt/homebrew/bin/gh',
				['gist', 'create', '--filename', 'notes.txt', '-'],
				undefined,
				{ input: 'private notes' }
			);
			expect(result).toEqual({
				success: true,
				gistUrl: 'https://gist.github.com/user/private123',
			});
		});

		it('should report when gh is not installed', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'command not found: gh',
				exitCode: 127,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'file.txt', 'content', '', false);

			expect(result).toEqual({
				success: false,
				error: 'GitHub CLI (gh) is not installed. Please install it to create gists.',
			});
		});

		it('should report when gh is not recognized on Windows shells', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: "'gh' is not recognized as an internal or external command",
				exitCode: 1,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'file.txt', 'content', '', false);

			expect(result).toEqual({
				success: false,
				error: 'GitHub CLI (gh) is not installed. Please install it to create gists.',
			});
		});

		it('should report when gh is not authenticated', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'You are not logged into any GitHub hosts',
				exitCode: 1,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'file.txt', 'content', '', false);

			expect(result).toEqual({
				success: false,
				error: 'GitHub CLI is not authenticated. Please run "gh auth login" first.',
			});
		});

		it('should return generic gist creation failures', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: 'HTTP 422: validation failed',
				exitCode: 1,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'file.txt', 'content', '', false);

			expect(result).toEqual({
				success: false,
				error: 'HTTP 422: validation failed',
			});
		});

		it('should return fallback error when gh fails without stderr', async () => {
			vi.mocked(execFile.execFileNoThrow).mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 1,
			});

			const handler = handlers.get('git:createGist');
			const result = await handler!({} as any, 'file.txt', 'content', '', false);

			expect(result).toEqual({
				success: false,
				error: 'Failed to create gist',
			});
		});
	});
});

/**
 * Tests for src/renderer/services/git.ts
 * Git operations service that wraps IPC calls to main process
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { gitService } from '../../../renderer/services/git';

// Mock the window.maestro.git object
const mockGit = {
	isRepo: vi.fn(),
	status: vi.fn(),
	branch: vi.fn(),
	diff: vi.fn(),
	numstat: vi.fn(),
	remote: vi.fn(),
	branches: vi.fn(),
	tags: vi.fn(),
};

// Setup mock before each test
beforeEach(() => {
	vi.clearAllMocks();

	// Ensure window.maestro.git is mocked
	(window as any).maestro = {
		...(window as any).maestro,
		git: mockGit,
	};

	// Mock console.error to prevent noise in test output
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('gitService', () => {
	describe('isRepo', () => {
		test('returns true when directory is a git repository', async () => {
			mockGit.isRepo.mockResolvedValue(true);

			const result = await gitService.isRepo('/path/to/repo');

			expect(result).toBe(true);
			expect(mockGit.isRepo).toHaveBeenCalledWith('/path/to/repo', undefined);
		});

		test('returns false when directory is not a git repository', async () => {
			mockGit.isRepo.mockResolvedValue(false);

			const result = await gitService.isRepo('/path/to/non-repo');

			expect(result).toBe(false);
			expect(mockGit.isRepo).toHaveBeenCalledWith('/path/to/non-repo', undefined);
		});

		test('passes sshRemoteId for remote repository check', async () => {
			mockGit.isRepo.mockResolvedValue(true);

			const result = await gitService.isRepo('/remote/path', 'ssh-remote-123');

			expect(result).toBe(true);
			expect(mockGit.isRepo).toHaveBeenCalledWith('/remote/path', 'ssh-remote-123');
		});

		test('returns false and logs error when IPC call fails', async () => {
			mockGit.isRepo.mockRejectedValue(new Error('IPC error'));

			const result = await gitService.isRepo('/path/to/repo');

			expect(result).toBe(false);
			expect(console.error).toHaveBeenCalledWith('Git isRepo error:', expect.any(Error));
		});
	});

	describe('getStatus', () => {
		test('returns empty files array when status is clean', async () => {
			mockGit.status.mockResolvedValue({ stdout: '' });
			mockGit.branch.mockResolvedValue({ stdout: 'main' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.files).toEqual([]);
			expect(result.branch).toBe('main');
		});

		test('parses single modified file correctly', async () => {
			// Porcelain format: XY PATH where X=staged status, Y=unstaged status
			// 'M ' means modified in index (staged)
			// The format is: XY<space>PATH where XY are exactly 2 chars
			mockGit.status.mockResolvedValue({ stdout: 'M  src/file.ts' });
			mockGit.branch.mockResolvedValue({ stdout: 'main' });

			const result = await gitService.getStatus('/path/to/repo');

			// The code reads substring(0,2) for status and substring(3) for path
			// 'M  src/file.ts' => status='M ', path='src/file.ts'
			expect(result.files).toEqual([{ path: 'src/file.ts', status: 'M ' }]);
		});

		test('parses multiple files with different statuses', async () => {
			const statusOutput = `M  modified.ts
A  added.ts
D  deleted.ts
?? untracked.ts`;
			mockGit.status.mockResolvedValue({ stdout: statusOutput });
			mockGit.branch.mockResolvedValue({ stdout: 'feature' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.files).toHaveLength(4);
			expect(result.files[0]).toEqual({ path: 'modified.ts', status: 'M ' });
			expect(result.files[1]).toEqual({ path: 'added.ts', status: 'A ' });
			expect(result.files[2]).toEqual({ path: 'deleted.ts', status: 'D ' });
			expect(result.files[3]).toEqual({ path: 'untracked.ts', status: '??' });
		});

		test('handles rename format (path -> newpath)', async () => {
			mockGit.status.mockResolvedValue({ stdout: 'R  old.ts -> new.ts' });
			mockGit.branch.mockResolvedValue({ stdout: 'main' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.files).toEqual([{ path: 'old.ts', status: 'R ' }]);
		});

		test('extracts branch name from branch output', async () => {
			mockGit.status.mockResolvedValue({ stdout: '' });
			mockGit.branch.mockResolvedValue({ stdout: 'feature/my-branch\n' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.branch).toBe('feature/my-branch');
		});

		test('returns undefined branch when branch output is empty', async () => {
			mockGit.status.mockResolvedValue({ stdout: '' });
			mockGit.branch.mockResolvedValue({ stdout: '' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.branch).toBeUndefined();
		});

		test('returns empty files array on error', async () => {
			mockGit.status.mockRejectedValue(new Error('Git error'));
			mockGit.branch.mockRejectedValue(new Error('Git error'));

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.files).toEqual([]);
			expect(console.error).toHaveBeenCalledWith('Git status error:', expect.any(Error));
		});

		test('handles porcelain status codes correctly', async () => {
			// Full set of common status codes
			const statusOutput = `MM both-modified.ts
AM added-then-modified.ts
UU both-changed-in-merge.ts`;
			mockGit.status.mockResolvedValue({ stdout: statusOutput });
			mockGit.branch.mockResolvedValue({ stdout: 'main' });

			const result = await gitService.getStatus('/path/to/repo');

			expect(result.files).toEqual([
				{ path: 'both-modified.ts', status: 'MM' },
				{ path: 'added-then-modified.ts', status: 'AM' },
				{ path: 'both-changed-in-merge.ts', status: 'UU' },
			]);
		});
	});

	describe('getDiff', () => {
		test('returns diff for all files when no files specified', async () => {
			const diffOutput = 'diff --git a/file.ts b/file.ts\n+new line';
			mockGit.diff.mockResolvedValue({ stdout: diffOutput });

			const result = await gitService.getDiff('/path/to/repo');

			expect(result.diff).toBe(diffOutput);
			// When no files are specified, sshRemoteId defaults to undefined
			expect(mockGit.diff).toHaveBeenCalledWith('/path/to/repo', undefined, undefined);
		});

		test('returns diff for all files when empty array specified', async () => {
			const diffOutput = 'diff content';
			mockGit.diff.mockResolvedValue({ stdout: diffOutput });

			const result = await gitService.getDiff('/path/to/repo', []);

			expect(result.diff).toBe(diffOutput);
			// sshRemoteId defaults to undefined
			expect(mockGit.diff).toHaveBeenCalledWith('/path/to/repo', undefined, undefined);
		});

		test('returns diff for specific files when files array provided', async () => {
			const diffOutput1 = 'diff for file1';
			const diffOutput2 = 'diff for file2';
			mockGit.diff
				.mockResolvedValueOnce({ stdout: diffOutput1 })
				.mockResolvedValueOnce({ stdout: diffOutput2 });

			const result = await gitService.getDiff('/path/to/repo', ['file1.ts', 'file2.ts']);

			expect(result).toEqual({ diff: `${diffOutput1}\n${diffOutput2}` });
			// sshRemoteId defaults to undefined
			expect(mockGit.diff).toHaveBeenNthCalledWith(1, '/path/to/repo', 'file1.ts', undefined);
			expect(mockGit.diff).toHaveBeenNthCalledWith(2, '/path/to/repo', 'file2.ts', undefined);
		});

		test('passes sshRemoteId for remote diff', async () => {
			mockGit.diff.mockResolvedValue({ stdout: 'remote diff' });

			const result = await gitService.getDiff('/remote/path', undefined, 'ssh-remote-123');

			expect(result.diff).toBe('remote diff');
			expect(mockGit.diff).toHaveBeenCalledWith('/remote/path', undefined, 'ssh-remote-123');
		});

		test('returns empty diff string on error', async () => {
			mockGit.diff.mockRejectedValue(new Error('Git diff error'));

			const result = await gitService.getDiff('/path/to/repo');

			expect(result.diff).toBe('');
			expect(console.error).toHaveBeenCalledWith('Git diff error:', expect.any(Error));
		});
	});

	describe('getNumstat', () => {
		test('parses numstat output correctly', async () => {
			const numstatOutput = `10\t5\tsrc/file1.ts
20\t3\tsrc/file2.ts`;
			mockGit.numstat.mockResolvedValue({ stdout: numstatOutput });

			const result = await gitService.getNumstat('/path/to/repo');

			expect(result.files).toEqual([
				{ path: 'src/file1.ts', additions: 10, deletions: 5 },
				{ path: 'src/file2.ts', additions: 20, deletions: 3 },
			]);
		});

		test('handles binary files with - - format', async () => {
			const numstatOutput = `-\t-\timage.png
5\t2\ttext.ts`;
			mockGit.numstat.mockResolvedValue({ stdout: numstatOutput });

			const result = await gitService.getNumstat('/path/to/repo');

			expect(result.files).toEqual([
				{ path: 'image.png', additions: 0, deletions: 0 },
				{ path: 'text.ts', additions: 5, deletions: 2 },
			]);
		});

		test('returns empty files array when stdout is empty', async () => {
			mockGit.numstat.mockResolvedValue({ stdout: '' });

			const result = await gitService.getNumstat('/path/to/repo');

			expect(result.files).toEqual([]);
		});

		test('returns empty files array on error', async () => {
			mockGit.numstat.mockRejectedValue(new Error('Git numstat error'));

			const result = await gitService.getNumstat('/path/to/repo');

			expect(result.files).toEqual([]);
			expect(console.error).toHaveBeenCalledWith('Git numstat error:', expect.any(Error));
		});

		test('skips lines with fewer than 3 parts', async () => {
			const numstatOutput = `10\t5\tvalid.ts
invalid_line`;
			mockGit.numstat.mockResolvedValue({ stdout: numstatOutput });

			const result = await gitService.getNumstat('/path/to/repo');

			expect(result.files).toEqual([{ path: 'valid.ts', additions: 10, deletions: 5 }]);
		});
	});

	describe('getRemoteBrowserUrl', () => {
		test('converts SSH format to browser URL', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'git@github.com:user/repo.git\n' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('converts HTTPS format to browser URL', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'https://github.com/user/repo.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('converts HTTP format to browser URL', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'http://github.com/user/repo.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('http://github.com/user/repo');
		});

		test('converts ssh:// protocol format to browser URL', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'ssh://git@github.com/user/repo.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('converts ssh:// without git@ to browser URL', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'ssh://github.com/user/repo.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('returns null when remote stdout is empty', async () => {
			mockGit.remote.mockResolvedValue({ stdout: '' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBeNull();
		});

		test('returns null when remote stdout is undefined', async () => {
			mockGit.remote.mockResolvedValue({});

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBeNull();
		});

		test('returns null on error', async () => {
			mockGit.remote.mockRejectedValue(new Error('Git remote error'));

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBeNull();
			expect(console.error).toHaveBeenCalledWith('Git remote error:', expect.any(Error));
		});

		test('returns null for unparseable URL formats', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'some-random-string' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBeNull();
		});

		test('handles HTTPS URL without .git suffix', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'https://github.com/user/repo' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('handles SSH URL without .git suffix', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'git@github.com:user/repo' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://github.com/user/repo');
		});

		test('handles GitLab SSH format', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'git@gitlab.com:group/project.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://gitlab.com/group/project');
		});

		test('handles Bitbucket SSH format', async () => {
			mockGit.remote.mockResolvedValue({ stdout: 'git@bitbucket.org:workspace/repo.git' });

			const result = await gitService.getRemoteBrowserUrl('/path/to/repo');

			expect(result).toBe('https://bitbucket.org/workspace/repo');
		});
	});

	describe('getBranches', () => {
		test('returns branches array from result', async () => {
			mockGit.branches.mockResolvedValue({ branches: ['main', 'develop', 'feature/test'] });

			const result = await gitService.getBranches('/path/to/repo');

			expect(result).toEqual(['main', 'develop', 'feature/test']);
			expect(mockGit.branches).toHaveBeenCalledWith('/path/to/repo', undefined);
		});

		test('passes sshRemoteId for remote branches', async () => {
			mockGit.branches.mockResolvedValue({ branches: ['main'] });

			const result = await gitService.getBranches('/remote/path', 'ssh-remote-123');

			expect(result).toEqual(['main']);
			expect(mockGit.branches).toHaveBeenCalledWith('/remote/path', 'ssh-remote-123');
		});

		test('returns empty array when result.branches is undefined', async () => {
			mockGit.branches.mockResolvedValue({});

			const result = await gitService.getBranches('/path/to/repo');

			expect(result).toEqual([]);
		});

		test('returns empty array on error', async () => {
			mockGit.branches.mockRejectedValue(new Error('Git branches error'));

			const result = await gitService.getBranches('/path/to/repo');

			expect(result).toEqual([]);
			expect(console.error).toHaveBeenCalledWith('Git branches error:', expect.any(Error));
		});
	});

	describe('getTags', () => {
		test('returns tags array from result', async () => {
			mockGit.tags.mockResolvedValue({ tags: ['v1.0.0', 'v1.1.0', 'v2.0.0'] });

			const result = await gitService.getTags('/path/to/repo');

			expect(result).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0']);
			expect(mockGit.tags).toHaveBeenCalledWith('/path/to/repo', undefined);
		});

		test('passes sshRemoteId for remote tags', async () => {
			mockGit.tags.mockResolvedValue({ tags: ['v1.0.0'] });

			const result = await gitService.getTags('/remote/path', 'ssh-remote-123');

			expect(result).toEqual(['v1.0.0']);
			expect(mockGit.tags).toHaveBeenCalledWith('/remote/path', 'ssh-remote-123');
		});

		test('returns empty array when result.tags is undefined', async () => {
			mockGit.tags.mockResolvedValue({});

			const result = await gitService.getTags('/path/to/repo');

			expect(result).toEqual([]);
		});

		test('returns empty array on error', async () => {
			mockGit.tags.mockRejectedValue(new Error('Git tags error'));

			const result = await gitService.getTags('/path/to/repo');

			expect(result).toEqual([]);
			expect(console.error).toHaveBeenCalledWith('Git tags error:', expect.any(Error));
		});
	});
});

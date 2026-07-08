/**
 * Tests for git preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createGitApi } from '../../main/preload/git';

describe('Git Preload API', () => {
	let api: ReturnType<typeof createGitApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createGitApi();
	});

	describe('status', () => {
		it('should invoke git:status with cwd', async () => {
			mockInvoke.mockResolvedValue('M src/file.ts');

			const result = await api.status('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:status',
				'/home/user/project',
				undefined,
				undefined
			);
			expect(result).toBe('M src/file.ts');
		});

		it('should invoke git:status with SSH remote parameters', async () => {
			mockInvoke.mockResolvedValue('M src/file.ts');

			await api.status('/home/user/project', 'remote-1', '/remote/cwd');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:status',
				'/home/user/project',
				'remote-1',
				'/remote/cwd'
			);
		});
	});

	describe('diff', () => {
		it('should invoke git:diff with cwd and optional file', async () => {
			mockInvoke.mockResolvedValue('diff output');

			const result = await api.diff('/home/user/project', 'src/file.ts');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:diff',
				'/home/user/project',
				'src/file.ts',
				undefined,
				undefined
			);
			expect(result).toBe('diff output');
		});

		it('should invoke git:diff without file', async () => {
			mockInvoke.mockResolvedValue('full diff');

			await api.diff('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:diff',
				'/home/user/project',
				undefined,
				undefined,
				undefined
			);
		});
	});

	describe('isRepo', () => {
		it('should invoke git:isRepo and return true for git repo', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.isRepo('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:isRepo',
				'/home/user/project',
				undefined,
				undefined
			);
			expect(result).toBe(true);
		});

		it('should return false for non-git directory', async () => {
			mockInvoke.mockResolvedValue(false);

			const result = await api.isRepo('/home/user/not-a-repo');

			expect(result).toBe(false);
		});
	});

	describe('branch', () => {
		it('should invoke git:branch and return current branch', async () => {
			mockInvoke.mockResolvedValue({ stdout: 'main', stderr: '' });

			const result = await api.branch('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:branch',
				'/home/user/project',
				undefined,
				undefined
			);
			expect(result.stdout).toBe('main');
		});
	});

	describe('status detail operations', () => {
		it.each([
			{
				name: 'numstat',
				call: () => api.numstat('/home/user/project', 'remote-1', '/remote/project'),
				channel: 'git:numstat',
				args: ['/home/user/project', 'remote-1', '/remote/project'],
				response: { stdout: '1\t2\tsrc/file.ts', stderr: '' },
			},
			{
				name: 'branches',
				call: () => api.branches('/home/user/project', 'remote-1', '/remote/project'),
				channel: 'git:branches',
				args: ['/home/user/project', 'remote-1', '/remote/project'],
				response: { stdout: '* main\n  feature', stderr: '' },
			},
			{
				name: 'tags',
				call: () => api.tags('/home/user/project', 'remote-1', '/remote/project'),
				channel: 'git:tags',
				args: ['/home/user/project', 'remote-1', '/remote/project'],
				response: { stdout: 'v1.0.0', stderr: '' },
			},
			{
				name: 'remote',
				call: () => api.remote('/home/user/project', 'remote-1', '/remote/project'),
				channel: 'git:remote',
				args: ['/home/user/project', 'remote-1', '/remote/project'],
				response: { stdout: 'git@github.com:owner/repo.git', stderr: '' },
			},
		])(
			'should invoke git:$name with SSH remote context',
			async ({ call, channel, args, response }) => {
				mockInvoke.mockResolvedValue(response);

				const result = await call();

				expect(mockInvoke).toHaveBeenCalledWith(channel, ...args);
				expect(result).toEqual(response);
			}
		);
	});

	describe('info', () => {
		it('should invoke git:info and return comprehensive info', async () => {
			const mockInfo = {
				branch: 'main',
				remote: 'origin',
				behind: 2,
				ahead: 1,
				uncommittedChanges: 3,
			};
			mockInvoke.mockResolvedValue(mockInfo);

			const result = await api.info('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:info',
				'/home/user/project',
				undefined,
				undefined
			);
			expect(result).toEqual(mockInfo);
		});
	});

	describe('log', () => {
		it('should invoke git:log with options', async () => {
			const mockEntries = [
				{
					hash: 'abc123',
					shortHash: 'abc',
					author: 'User',
					date: '2024-01-01',
					refs: ['HEAD'],
					subject: 'Initial commit',
				},
			];
			mockInvoke.mockResolvedValue({ entries: mockEntries, error: null });

			const result = await api.log('/home/user/project', { limit: 10, search: 'fix' });

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:log',
				'/home/user/project',
				{
					limit: 10,
					search: 'fix',
				},
				undefined
			);
			expect(result.entries).toEqual(mockEntries);
		});
	});

	describe('history operations', () => {
		it.each([
			{
				name: 'commitCount',
				call: () => api.commitCount('/home/user/project', 'remote-1'),
				channel: 'git:commitCount',
				args: ['/home/user/project', 'remote-1'],
				response: { count: 42, error: null },
			},
			{
				name: 'show',
				call: () => api.show('/home/user/project', 'abc123', 'remote-1'),
				channel: 'git:show',
				args: ['/home/user/project', 'abc123', 'remote-1'],
				response: { stdout: 'commit abc123', stderr: '' },
			},
			{
				name: 'showFile',
				call: () => api.showFile('/home/user/project', 'HEAD', 'src/file.ts'),
				channel: 'git:showFile',
				args: ['/home/user/project', 'HEAD', 'src/file.ts'],
				response: { content: 'export const value = 1;' },
			},
		])(
			'should invoke git:$name and return the handler result',
			async ({ call, channel, args, response }) => {
				mockInvoke.mockResolvedValue(response);

				const result = await call();

				expect(mockInvoke).toHaveBeenCalledWith(channel, ...args);
				expect(result).toEqual(response);
			}
		);
	});

	describe('worktreeInfo', () => {
		it('should invoke git:worktreeInfo', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature-branch',
				repoRoot: '/home/user/project',
			});

			const result = await api.worktreeInfo('/home/user/worktree');

			expect(mockInvoke).toHaveBeenCalledWith('git:worktreeInfo', '/home/user/worktree', undefined);
			expect(result.success).toBe(true);
			expect(result.isWorktree).toBe(true);
		});
	});

	describe('worktree management operations', () => {
		it.each([
			{
				name: 'getRepoRoot',
				call: () => api.getRepoRoot('/home/user/project', 'remote-1'),
				channel: 'git:getRepoRoot',
				args: ['/home/user/project', 'remote-1'],
				response: { success: true, root: '/home/user/project' },
			},
			{
				name: 'worktreeCheckout',
				call: () => api.worktreeCheckout('/home/user/worktree', 'feature', true, 'remote-1'),
				channel: 'git:worktreeCheckout',
				args: ['/home/user/worktree', 'feature', true, 'remote-1'],
				response: { success: true, hasUncommittedChanges: false },
			},
			{
				name: 'getDefaultBranch',
				call: () => api.getDefaultBranch('/home/user/project'),
				channel: 'git:getDefaultBranch',
				args: ['/home/user/project'],
				response: { success: true, branch: 'main' },
			},
			{
				name: 'scanWorktreeDirectory',
				call: () => api.scanWorktreeDirectory('/home/user/worktrees', 'remote-1'),
				channel: 'git:scanWorktreeDirectory',
				args: ['/home/user/worktrees', 'remote-1'],
				response: {
					gitSubdirs: [
						{ path: '/home/user/worktrees/feature', name: 'feature', branch: 'feature' },
					],
				},
			},
			{
				name: 'watchWorktreeDirectory',
				call: () => api.watchWorktreeDirectory('session-1', '/home/user/worktrees', 'remote-1'),
				channel: 'git:watchWorktreeDirectory',
				args: ['session-1', '/home/user/worktrees', 'remote-1'],
				response: { success: true, isRemote: true, message: 'Polling required' },
			},
			{
				name: 'unwatchWorktreeDirectory',
				call: () => api.unwatchWorktreeDirectory('session-1'),
				channel: 'git:unwatchWorktreeDirectory',
				args: ['session-1'],
				response: { success: true },
			},
			{
				name: 'removeWorktree',
				call: () => api.removeWorktree('/home/user/worktree', true),
				channel: 'git:removeWorktree',
				args: ['/home/user/worktree', true],
				response: { success: true },
			},
		])(
			'should invoke git:$name and preserve arguments',
			async ({ call, channel, args, response }) => {
				mockInvoke.mockResolvedValue(response);

				const result = await call();

				expect(mockInvoke).toHaveBeenCalledWith(channel, ...args);
				expect(result).toEqual(response);
			}
		);
	});

	describe('worktreeSetup', () => {
		it('should invoke git:worktreeSetup with all parameters', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				created: true,
				currentBranch: 'feature-branch',
			});

			const result = await api.worktreeSetup(
				'/home/user/project',
				'/home/user/worktree',
				'feature-branch',
				'remote-1',
				'main'
			);

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:worktreeSetup',
				'/home/user/project',
				'/home/user/worktree',
				'feature-branch',
				'remote-1',
				'main'
			);
			expect(result.success).toBe(true);
			expect(result.created).toBe(true);
		});
	});

	describe('createPR', () => {
		it('should invoke git:createPR', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/user/repo/pull/123',
			});

			const result = await api.createPR('/home/user/worktree', 'main', 'Feature Title', 'PR body');

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:createPR',
				'/home/user/worktree',
				'main',
				'Feature Title',
				'PR body',
				undefined
			);
			expect(result.success).toBe(true);
			expect(result.prUrl).toBe('https://github.com/user/repo/pull/123');
		});
	});

	describe('checkGhCli', () => {
		it('should invoke git:checkGhCli', async () => {
			mockInvoke.mockResolvedValue({ installed: true, authenticated: true });

			const result = await api.checkGhCli();

			expect(mockInvoke).toHaveBeenCalledWith('git:checkGhCli', undefined);
			expect(result.installed).toBe(true);
			expect(result.authenticated).toBe(true);
		});
	});

	describe('createGist', () => {
		it('should invoke git:createGist', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				gistUrl: 'https://gist.github.com/user/abc123',
			});

			const result = await api.createGist('file.txt', 'content', 'description', true);

			expect(mockInvoke).toHaveBeenCalledWith(
				'git:createGist',
				'file.txt',
				'content',
				'description',
				true,
				undefined
			);
			expect(result.success).toBe(true);
			expect(result.gistUrl).toBe('https://gist.github.com/user/abc123');
		});
	});

	describe('listWorktrees', () => {
		it('should invoke git:listWorktrees', async () => {
			const mockWorktrees = [
				{ path: '/home/user/project', head: 'abc123', branch: 'main', isBare: false },
				{ path: '/home/user/worktree', head: 'def456', branch: 'feature', isBare: false },
			];
			mockInvoke.mockResolvedValue({ worktrees: mockWorktrees });

			const result = await api.listWorktrees('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith('git:listWorktrees', '/home/user/project', undefined);
			expect(result.worktrees).toEqual(mockWorktrees);
		});
	});

	describe('onWorktreeDiscovered', () => {
		it('should register event listener and return cleanup function', () => {
			const callback = vi.fn();

			const cleanup = api.onWorktreeDiscovered(callback);

			expect(mockOn).toHaveBeenCalledWith('worktree:discovered', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback with worktree data', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, data: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'worktree:discovered') {
					registeredHandler = handler;
				}
			});

			api.onWorktreeDiscovered(callback);

			const data = {
				sessionId: 'session-123',
				worktree: { path: '/home/user/worktree', name: 'feature', branch: 'feature-branch' },
			};
			registeredHandler!({}, data);

			expect(callback).toHaveBeenCalledWith(data);
		});

		it('should remove the registered listener when cleanup is called', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, data: unknown) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'worktree:discovered') {
					registeredHandler = handler;
				}
			});

			const cleanup = api.onWorktreeDiscovered(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('worktree:discovered', registeredHandler!);
		});
	});
});

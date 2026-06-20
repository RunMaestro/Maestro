import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';

const execFileAsync = promisify(execFile);

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
let tempRoot: string;

async function waitForAssertion(assertion: () => void, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	if (lastError) {
		throw lastError;
	}
}

type WatcherHandler = (targetPath: string) => void | Promise<void>;

const electronState = {
	windows: [] as Array<{
		isDestroyed: () => boolean;
		webContents: {
			isDestroyed: () => boolean;
			send: ReturnType<typeof vi.fn>;
		};
	}>,
};

const chokidarState = {
	watchers: [] as Array<{
		watchPath: string;
		handlers: Map<string, WatcherHandler>;
		close: ReturnType<typeof vi.fn>;
	}>,
	watch: vi.fn((watchPath: string) => {
		const handlers = new Map<string, WatcherHandler>();
		const watcher = {
			on: vi.fn((event: string, handler: WatcherHandler) => {
				handlers.set(event, handler);
				return watcher;
			}),
			close: vi.fn().mockResolvedValue(undefined),
		};
		chokidarState.watchers.push({ watchPath, handlers, close: watcher.close });
		return watcher;
	}),
};

const settingsStoreState = {
	sshRemotes: [] as SshRemoteConfig[],
};

const remoteGitState = {
	execGit: vi.fn(),
	worktreeInfoRemote: vi.fn(),
	worktreeSetupRemote: vi.fn(),
	worktreeCheckoutRemote: vi.fn(),
	listWorktreesRemote: vi.fn(),
	getRepoRootRemote: vi.fn(),
};

const remoteFsState = {
	readDirRemote: vi.fn(),
};

const sshRemote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Remote One',
	host: 'remote.example.com',
	port: 22,
	username: 'maestro',
	privateKeyPath: '/keys/maestro',
	enabled: true,
};

async function runGit(cwd: string, args: string[]) {
	return execFileAsync('git', args, { cwd });
}

async function createRepo(options: { dirty?: boolean } = {}) {
	const repoPath = path.join(tempRoot, `repo-${Math.random().toString(16).slice(2)}`);
	await fs.mkdir(repoPath, { recursive: true });
	await runGit(repoPath, ['init', '-b', 'main']);
	await runGit(repoPath, ['config', 'user.email', 'integration@example.test']);
	await runGit(repoPath, ['config', 'user.name', 'Integration Test']);
	await fs.writeFile(path.join(repoPath, 'notes.md'), '# Notes\n\nInitial content.\n', 'utf8');
	await fs.writeFile(path.join(repoPath, 'image.txt'), 'text content from head\n', 'utf8');
	await runGit(repoPath, ['add', '.']);
	await runGit(repoPath, ['commit', '-m', 'initial commit']);
	await runGit(repoPath, ['tag', 'v1.0.0']);
	await runGit(repoPath, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);

	if (options.dirty) {
		await fs.appendFile(path.join(repoPath, 'notes.md'), '\nChanged line.\n', 'utf8');
		await fs.writeFile(path.join(repoPath, 'draft.md'), '# Draft\n', 'utf8');
	}

	return repoPath;
}

async function createFakeGhCli() {
	const scriptPath = path.join(tempRoot, 'fake-gh.js');
	await fs.writeFile(
		scriptPath,
		`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.MAESTRO_GH_ARGS_LOG) {
  fs.appendFileSync(process.env.MAESTRO_GH_ARGS_LOG, args.join(' ') + '\\n');
}
if (args[0] === '--version') {
  console.log('gh version 2.0.0');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('Logged in to github.com');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/example/repo/pull/123');
  process.exit(0);
}
if (args[0] === 'gist' && args[1] === 'create') {
  const input = fs.readFileSync(0, 'utf8');
  if (process.env.MAESTRO_GH_STDIN_LOG) {
    fs.writeFileSync(process.env.MAESTRO_GH_STDIN_LOG, input);
  }
  console.log('https://gist.github.com/example/abc123');
  process.exit(0);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(1);
`,
		'utf8'
	);
	await fs.chmod(scriptPath, 0o755);
	return scriptPath;
}

async function invoke(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	expect(handler, `missing handler for ${channel}`).toBeDefined();
	return handler!({ sender: { id: 1 } }, ...args);
}

describe('git IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-git-ipc-'));

		vi.doMock('electron', () => ({
			ipcMain: {
				handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn(),
			},
			BrowserWindow: {
				getAllWindows: vi.fn(() => electronState.windows),
			},
		}));
		vi.doMock('chokidar', () => ({
			default: {
				watch: chokidarState.watch,
			},
		}));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		}));
		vi.doMock('../../main/utils/sentry', () => ({
			captureMessage: vi.fn(),
		}));
		vi.doMock('../../main/stores', () => ({
			getSshRemoteById: vi.fn((id: string) =>
				settingsStoreState.sshRemotes.find((remote) => remote.id === id)
			),
		}));
		vi.doMock('../../main/utils/remote-git', async () => {
			const actual = await vi.importActual<typeof import('../../main/utils/remote-git')>(
				'../../main/utils/remote-git'
			);
			return {
				...actual,
				execGit: vi.fn(
					(args: string[], cwd: string, sshRemote?: SshRemoteConfig, remoteCwd?: string) => {
						if (sshRemote) {
							return remoteGitState.execGit(args, cwd, sshRemote, remoteCwd);
						}
						return actual.execGit(args, cwd, sshRemote, remoteCwd);
					}
				),
				worktreeInfoRemote: remoteGitState.worktreeInfoRemote,
				worktreeSetupRemote: remoteGitState.worktreeSetupRemote,
				worktreeCheckoutRemote: remoteGitState.worktreeCheckoutRemote,
				listWorktreesRemote: remoteGitState.listWorktreesRemote,
				getRepoRootRemote: remoteGitState.getRepoRootRemote,
			};
		});
		vi.doMock('../../main/utils/remote-fs', async () => {
			const actual = await vi.importActual<typeof import('../../main/utils/remote-fs')>(
				'../../main/utils/remote-fs'
			);
			return {
				...actual,
				readDirRemote: remoteFsState.readDirRemote,
			};
		});

		electronState.windows = [];
		chokidarState.watchers = [];
		settingsStoreState.sshRemotes = [];
		remoteGitState.execGit.mockReset();
		remoteGitState.worktreeInfoRemote.mockReset();
		remoteGitState.worktreeSetupRemote.mockReset();
		remoteGitState.worktreeCheckoutRemote.mockReset();
		remoteGitState.listWorktreesRemote.mockReset();
		remoteGitState.getRepoRootRemote.mockReset();
		remoteFsState.readDirRemote.mockReset();
		chokidarState.watch.mockClear();
		delete process.env.MAESTRO_GH_ARGS_LOG;
		delete process.env.MAESTRO_GH_STDIN_LOG;

		const { registerGitHandlers } = await import('../../main/ipc/handlers/git');
		registerGitHandlers({
			settingsStore: {
				get: vi.fn((key: string, defaultValue: unknown) =>
					key === 'sshRemotes' ? settingsStoreState.sshRemotes : defaultValue
				),
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.useRealTimers();
		delete process.env.MAESTRO_GH_ARGS_LOG;
		delete process.env.MAESTRO_GH_STDIN_LOG;
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it('runs basic git handlers against a real dirty repository', async () => {
		const repoPath = await createRepo({ dirty: true });

		const status = await invoke('git:status', repoPath);
		expect(status.stdout).toContain('M notes.md');
		expect(status.stdout).toContain('?? draft.md');

		const diff = await invoke('git:diff', repoPath, 'notes.md');
		expect(diff.stdout).toContain('Changed line.');

		const isRepo = await invoke('git:isRepo', repoPath);
		expect(isRepo).toBe(true);

		const numstat = await invoke('git:numstat', repoPath);
		expect(numstat.stdout).toContain('notes.md');

		const branch = await invoke('git:branch', repoPath);
		expect(branch.stdout).toBe('main');

		const remote = await invoke('git:remote', repoPath);
		expect(remote.stdout).toBe('https://github.com/example/repo.git');

		const branches = await invoke('git:branches', repoPath);
		expect(branches.branches).toContain('main');

		const tags = await invoke('git:tags', repoPath);
		expect(tags.tags).toEqual(['v1.0.0']);

		const info = await invoke('git:info', repoPath);
		expect(info).toEqual(
			expect.objectContaining({
				branch: 'main',
				remote: 'https://github.com/example/repo.git',
				uncommittedChanges: 2,
			})
		);

		const log = await invoke('git:log', repoPath, { limit: 5, search: 'initial' });
		expect(log.entries).toEqual([
			expect.objectContaining({
				shortHash: expect.any(String),
				author: 'Integration Test',
				subject: 'initial commit',
			}),
		]);

		const commitCount = await invoke('git:commitCount', repoPath);
		expect(commitCount).toEqual({ count: 1, error: null });

		const show = await invoke('git:show', repoPath, 'HEAD');
		expect(show.stdout).toContain('initial commit');

		const showFile = await invoke('git:showFile', repoPath, 'HEAD', 'image.txt');
		expect(showFile).toEqual({ content: 'text content from head\n' });
	});

	it('creates, checks out, scans, lists, and removes local git worktrees', async () => {
		const repoPath = await createRepo();
		const resolvedRepoPath = await fs.realpath(repoPath);
		const worktreePath = path.join(tempRoot, 'worktree-feature');

		const repoRoot = await invoke('git:getRepoRoot', repoPath);
		expect(repoRoot).toEqual({ success: true, root: resolvedRepoPath });

		const missingInfo = await invoke('git:worktreeInfo', path.join(tempRoot, 'missing'));
		expect(missingInfo).toEqual({ success: true, exists: false, isWorktree: false });

		const nestedSetup = await invoke(
			'git:worktreeSetup',
			repoPath,
			path.join(repoPath, 'nested-worktree'),
			'feature/nested'
		);
		expect(nestedSetup).toEqual(
			expect.objectContaining({
				success: false,
				error: expect.stringContaining('cannot be inside the main repository'),
			})
		);

		await fs.mkdir(worktreePath);
		const setup = await invoke('git:worktreeSetup', repoPath, worktreePath, 'feature/integration');
		const resolvedWorktreePath = await fs.realpath(worktreePath);
		expect(setup).toEqual({
			success: true,
			created: true,
			currentBranch: 'feature/integration',
			requestedBranch: 'feature/integration',
			branchMismatch: false,
		});

		const worktreeInfo = await invoke('git:worktreeInfo', worktreePath);
		expect(worktreeInfo).toEqual(
			expect.objectContaining({
				exists: true,
				isWorktree: true,
				currentBranch: 'feature/integration',
				repoRoot: resolvedRepoPath,
			})
		);

		const checkout = await invoke('git:worktreeCheckout', worktreePath, 'feature/next', true);
		expect(checkout).toEqual({ success: true, hasUncommittedChanges: false });

		const listed = await invoke('git:listWorktrees', repoPath);
		expect(listed.worktrees).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: resolvedRepoPath, branch: 'main' }),
				expect.objectContaining({ path: resolvedWorktreePath, branch: 'feature/next' }),
			])
		);

		const scanned = await invoke('git:scanWorktreeDirectory', tempRoot);
		expect(scanned.gitSubdirs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: repoPath, isWorktree: false, branch: 'main' }),
				expect.objectContaining({ path: worktreePath, isWorktree: true, branch: 'feature/next' }),
			])
		);

		const remove = await invoke('git:removeWorktree', worktreePath, true);
		expect(remove).toEqual({ success: true });
		await expect(fs.access(worktreePath)).rejects.toThrow();
	});

	it('routes SSH worktree handlers and remote directory scans through mocked remote boundaries', async () => {
		settingsStoreState.sshRemotes = [sshRemote];
		remoteGitState.worktreeInfoRemote.mockResolvedValue({
			success: true,
			data: {
				exists: true,
				isWorktree: true,
				currentBranch: 'feature/remote',
				repoRoot: '/remote/main',
			},
		});
		remoteGitState.getRepoRootRemote.mockResolvedValue({ success: true, data: '/remote/main' });
		remoteGitState.worktreeSetupRemote.mockResolvedValue({
			success: true,
			data: {
				success: true,
				created: true,
				currentBranch: 'feature/remote',
				requestedBranch: 'feature/remote',
				branchMismatch: false,
			},
		});
		remoteGitState.worktreeCheckoutRemote.mockResolvedValue({
			success: true,
			data: { success: true, hasUncommittedChanges: false },
		});
		remoteGitState.listWorktreesRemote.mockResolvedValue({
			success: true,
			data: [{ path: '/remote/main', head: 'abc123', branch: 'main', isBare: false }],
		});
		remoteFsState.readDirRemote.mockImplementation(async (dir: string) => ({
			success: true,
			data:
				dir === '/remote/parent'
					? [
							{ name: '.hidden', isDirectory: true, isSymlink: false },
							{ name: 'repo', isDirectory: true, isSymlink: false },
							{ name: 'worktree', isDirectory: true, isSymlink: false },
							{ name: 'plain', isDirectory: true, isSymlink: false },
						]
					: [],
		}));
		remoteGitState.execGit.mockImplementation(async (args: string[], cwd: string) => {
			const command = args.join(' ');
			if (cwd.endsWith('/plain')) {
				return { stdout: '', stderr: 'not a repo', exitCode: 1 };
			}
			if (command === 'rev-parse --is-inside-work-tree') {
				return { stdout: 'true\n', stderr: '', exitCode: 0 };
			}
			if (command === 'rev-parse --show-toplevel') {
				return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 };
			}
			if (command === 'rev-parse --git-dir') {
				return {
					stdout: cwd.endsWith('/worktree') ? '/remote/main/.git/worktrees/worktree\n' : '.git\n',
					stderr: '',
					exitCode: 0,
				};
			}
			if (command === 'rev-parse --git-common-dir') {
				return {
					stdout: cwd.endsWith('/worktree') ? '/remote/main/.git\n' : '.git\n',
					stderr: '',
					exitCode: 0,
				};
			}
			if (command === 'rev-parse --abbrev-ref HEAD') {
				return {
					stdout: cwd.endsWith('/worktree') ? 'feature/remote\n' : 'main\n',
					stderr: '',
					exitCode: 0,
				};
			}
			return { stdout: '', stderr: `unexpected ${command}`, exitCode: 1 };
		});

		await expect(invoke('git:worktreeInfo', '/remote/main/worktree', 'remote-1')).resolves.toEqual(
			expect.objectContaining({
				success: true,
				currentBranch: 'feature/remote',
				repoRoot: '/remote/main',
			})
		);
		await expect(invoke('git:getRepoRoot', '/remote/main', 'remote-1')).resolves.toEqual({
			success: true,
			root: '/remote/main',
		});
		await expect(
			invoke(
				'git:worktreeSetup',
				'/remote/main',
				'/remote/main-worktree',
				'feature/remote',
				'remote-1'
			)
		).resolves.toEqual(
			expect.objectContaining({
				success: true,
				currentBranch: 'feature/remote',
			})
		);
		await expect(
			invoke('git:worktreeCheckout', '/remote/main-worktree', 'feature/other', true, 'remote-1')
		).resolves.toEqual({ success: true, hasUncommittedChanges: false });
		await expect(invoke('git:listWorktrees', '/remote/main', 'remote-1')).resolves.toEqual({
			success: true,
			worktrees: [{ path: '/remote/main', head: 'abc123', branch: 'main', isBare: false }],
		});

		const scanned = await invoke('git:scanWorktreeDirectory', '/remote/parent', 'remote-1');
		expect(scanned.gitSubdirs).toEqual([
			{
				path: '/remote/parent/repo',
				name: 'repo',
				isWorktree: false,
				branch: 'main',
				repoRoot: '/remote/parent/repo',
			},
			{
				path: '/remote/parent/worktree',
				name: 'worktree',
				isWorktree: true,
				branch: 'feature/remote',
				repoRoot: '/remote/main',
			},
		]);

		settingsStoreState.sshRemotes = [];
		const missingRemote = await invoke('git:getRepoRoot', '/remote/main', 'remote-1');
		expect(missingRemote).toMatchObject({
			success: false,
			error: expect.stringContaining('SSH remote not found'),
		});
	});

	it('discovers new local worktrees through the directory watcher and cleans it up', async () => {
		const parentRoot = path.join(tempRoot, 'watch-parent');
		await fs.mkdir(parentRoot, { recursive: true });
		const parentPath = await fs.realpath(parentRoot);
		const discoveredPath = path.join(parentPath, 'feature-watch');
		await runGit(parentPath, ['init', '-b', 'main', discoveredPath]);
		await runGit(discoveredPath, ['config', 'user.email', 'integration@example.test']);
		await runGit(discoveredPath, ['config', 'user.name', 'Integration Test']);
		await fs.writeFile(path.join(discoveredPath, 'notes.md'), '# Watch\n', 'utf8');
		await runGit(discoveredPath, ['add', '.']);
		await runGit(discoveredPath, ['commit', '-m', 'watch commit']);
		await runGit(discoveredPath, ['checkout', '-b', 'feature/watch']);

		const send = vi.fn();
		electronState.windows = [
			{
				isDestroyed: () => false,
				webContents: {
					isDestroyed: () => false,
					send,
				},
			},
		];

		await expect(invoke('git:watchWorktreeDirectory', 'session-1', parentPath)).resolves.toEqual({
			success: true,
		});
		expect(chokidarState.watchers).toHaveLength(1);
		expect(chokidarState.watchers[0].watchPath).toBe(parentPath);

		await chokidarState.watchers[0].handlers.get('addDir')?.(discoveredPath);

		await waitForAssertion(() =>
			expect(send).toHaveBeenCalledWith('worktree:discovered', {
				sessionId: 'session-1',
				worktree: {
					path: discoveredPath,
					name: 'feature-watch',
					branch: 'feature/watch',
				},
			})
		);

		await expect(invoke('git:unwatchWorktreeDirectory', 'session-1')).resolves.toEqual({
			success: true,
		});
		expect(chokidarState.watchers[0].close).toHaveBeenCalledOnce();
	});

	it('checks gh, creates PRs against a local bare remote, and creates gists with a custom gh binary', async () => {
		const ghPath = await createFakeGhCli();
		const ghArgsLog = path.join(tempRoot, 'gh-args.log');
		const ghStdinLog = path.join(tempRoot, 'gh-stdin.log');
		process.env.MAESTRO_GH_ARGS_LOG = ghArgsLog;
		process.env.MAESTRO_GH_STDIN_LOG = ghStdinLog;

		await expect(invoke('git:checkGhCli', ghPath)).resolves.toEqual({
			installed: true,
			authenticated: true,
		});

		const repoPath = await createRepo();
		const bareRemotePath = path.join(tempRoot, 'origin.git');
		await runGit(tempRoot, ['init', '--bare', bareRemotePath]);
		await runGit(repoPath, ['remote', 'set-url', 'origin', bareRemotePath]);
		await runGit(repoPath, ['checkout', '-b', 'feature/pr']);
		await fs.appendFile(path.join(repoPath, 'notes.md'), '\nPR line.\n', 'utf8');
		await runGit(repoPath, ['add', 'notes.md']);
		await runGit(repoPath, ['commit', '-m', 'prepare pr']);

		const pr = await invoke(
			'git:createPR',
			repoPath,
			'main',
			'Integration PR',
			'Body from integration',
			ghPath
		);
		expect(pr).toEqual({
			success: true,
			prUrl: 'https://github.com/example/repo/pull/123',
		});

		const gist = await invoke(
			'git:createGist',
			'notes.md',
			'# Gist body\n',
			'Integration gist',
			true,
			ghPath
		);
		expect(gist).toEqual({
			success: true,
			gistUrl: 'https://gist.github.com/example/abc123',
		});

		const ghArgs = await fs.readFile(ghArgsLog, 'utf8');
		expect(ghArgs).toContain('--version');
		expect(ghArgs).toContain('auth status');
		expect(ghArgs).toContain(
			'pr create --base main --title Integration PR --body Body from integration'
		);
		expect(ghArgs).toContain('gist create --filename notes.md --desc Integration gist --public -');
		await expect(fs.readFile(ghStdinLog, 'utf8')).resolves.toBe('# Gist body\n');
	});
});

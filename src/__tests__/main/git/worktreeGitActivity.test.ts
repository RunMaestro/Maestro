import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import { execFileNoThrow } from '../../../main/utils/execFile';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn().mockResolvedValue({ command: 'ssh', args: ['remote-git'] }),
}));

const root = path.resolve('git-activity-fixture');
const sibling = path.resolve('git-activity-sibling');
const success: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
let gate: typeof import('../../../main/git/worktreeActivity');
let git: typeof import('../../../main/utils/remote-git');

beforeEach(async () => {
	vi.resetModules();
	vi.mocked(fs.realpath)
		.mockReset()
		.mockImplementation(async (p) => String(p));
	vi.mocked(execFileNoThrow).mockReset().mockResolvedValue(success);
	gate = await import('../../../main/git/worktreeActivity');
	git = await import('../../../main/utils/remote-git');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function reserve() {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.length).toBeGreaterThan(0);
	return hold;
}

describe('shared local Git admission', () => {
	it.each(['execGit', 'execGitReadOnly'] as const)(
		'%s registers before asynchronous setup and retains sibling exclusion until exit',
		async (method) => {
			let finish!: (result: ExecResult) => void;
			vi.mocked(execFileNoThrow).mockImplementationOnce(
				() => new Promise((resolve) => (finish = resolve))
			);
			const run = git[method](['fetch'], sibling);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			finish(success);
			await expect(run).resolves.toEqual(success);
			(await reserve()).release();
		}
	);

	it('global Git activity cannot cross a reservation while resolving a sibling/alias', async () => {
		const hold = await reserve();
		for (const cwd of [root, path.join(root, 'child'), sibling, 'unknown', ''])
			await expect(git.execGit(['checkout', 'topic'], cwd)).rejects.toThrow('reserved');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		hold.release();
		await expect(git.execGit(['checkout', 'topic'], sibling)).resolves.toEqual(success);
	});

	it.each([
		['sibling checkout', sibling],
		['symlink alias', path.resolve('git-activity-alias')],
		['nested repository', path.join(sibling, 'nested')],
		['not-yet-created target', path.join(sibling, 'missing', 'new-checkout')],
		['unrelated repository', path.resolve('git-activity-unrelated')],
	])('keeps the global fallback for an in-flight %s', async (_label, cwd) => {
		// Git admission must not depend on a successful cwd/common-directory probe.
		vi.mocked(fs.realpath).mockImplementation(async (p) => {
			if (p === cwd) throw new Error('Identity lookup is unavailable');
			return String(p);
		});
		let finish!: (result: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const run = git.execGit(['fetch'], cwd);
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		finish(success);
		await run;
		const hold = await reserve();
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		hold.release();
	});

	it.each(['inherited', 'explicit'] as const)(
		'blocks %s environment repository redirects before starting any child',
		async (source) => {
			const env = {
				GIT_DIR: path.join(root, '.git'),
				GIT_COMMON_DIR: path.join(root, '.git'),
				GIT_WORK_TREE: root,
				GIT_INDEX_FILE: path.join(root, 'other-index'),
				GIT_OBJECT_DIRECTORY: path.join(root, '.git', 'objects'),
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'core.worktree',
				GIT_CONFIG_VALUE_0: root,
			};
			if (source === 'inherited')
				for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
			const hold = await reserve();
			await expect(
				git.execGit(['fetch'], sibling, null, undefined, source === 'explicit' ? { env } : {})
			).rejects.toThrow('reserved');
			await expect(git.execGitReadOnly(['fetch'], sibling)).rejects.toThrow('reserved');
			expect(execFileNoThrow).not.toHaveBeenCalled();
			hold.release();
		}
	);

	it.each([
		['-C', sibling, '-C', root, 'fetch'],
		['--git-dir', path.join(root, '.git'), '--work-tree', root, 'fetch'],
		[`--git-dir=${path.join(root, '.git')}`, `--work-tree=${root}`, 'fetch'],
		['--config-env=core.worktree=WORKTREE_TARGET', 'fetch'],
		['-c', 'core.hooksPath=elsewhere', 'commit', '--allow-empty', '-m', 'hook'],
		['-c', 'alias.redirect=!git -C elsewhere fetch', 'redirect'],
		['-C', sibling, 'rev-parse', '--git-common-dir'],
		['rev-parse', '--git-common-dir', '--resolve-git-dir', sibling],
	])('never exempts repository or hook overrides in read-only argv %j', async (...args) => {
		const hold = await reserve();
		await expect(git.execGitReadOnly(args, sibling)).rejects.toThrow('reserved');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		hold.release();
	});

	it('a common-directory probe cannot narrow the outer hold across identity changes', async () => {
		const alias = path.resolve('git-identity-alias');
		let destination = sibling;
		vi.mocked(fs.realpath).mockImplementation(async (p) => (p === alias ? destination : String(p)));
		const release = await gate.beginWorktreeGitActivity();
		let identityReady!: (result: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (identityReady = resolve))
		);
		const probe = git.execGitReadOnly(['rev-parse', '--git-common-dir'], alias);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		identityReady({ ...success, stdout: path.join(sibling, '.git') });
		await probe;
		// A later command can see a different .git pointer or symlink target.
		destination = root;
		expect(await fs.realpath(alias)).toBe(root);
		for (const target of [root, sibling, path.join(root, 'nested')])
			expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'mutation-busy' }],
			});
		release();
		(await reserve()).release();
	});

	it('Git admitted during cleanup target resolution wins before the reservation is installed', async () => {
		let targetReady!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() => new Promise<string>((resolve) => (targetReady = resolve))
		);
		const pending = gate.reserveWorktreeCleanup(root);
		let finish!: (result: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const run = git.execGit(['fetch'], sibling);
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		targetReady(root);
		expect(await pending).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		finish(success);
		await run;
		(await reserve()).release();
	});

	it('keeps arbitrary hook/setup work global between commands and concurrent operations', async () => {
		const releaseSetup = await gate.beginWorktreeGitActivity();
		const releaseHook = await gate.beginWorktreeGitActivity();
		await git.execGit(['rev-parse', '--git-common-dir'], sibling);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		releaseSetup();
		await git.execGit(['fetch'], root);
		expect(await gate.reserveWorktreeCleanup(sibling)).toMatchObject({ status: 'blocked' });
		releaseHook();
		const hold = await reserve();
		await expect(gate.beginWorktreeGitActivity()).rejects.toThrow('reserved');
		hold.release();
	});

	it('streaming and generic Git participants share the same conservative guard', async () => {
		const release = await gate.beginWorktreeGitActivity();
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		release();
		const hold = await reserve();
		await expect(gate.beginWorktreeGitActivity()).rejects.toThrow('reserved');
		hold.release();
	});

	it.each([
		['checkout', 'topic'],
		['worktree', 'remove', '../child'],
		['worktree', 'list', '--porcelain', '-z', '--expire=now'],
		['symbolic-ref', 'HEAD', 'refs/heads/topic'],
		['config', 'core.bare', 'true'],
		['-C', sibling, 'reset', '--hard'],
		['--git-dir=other', 'fetch'],
		['-c', 'alias.mutate=!touch marker', 'mutate'],
		['status', '--porcelain'],
		['remote', 'get-url', 'origin', '--push'],
	])('does not exempt caller-labeled read-only argv %j', async (...args) => {
		const hold = await reserve();
		await expect(git.execGitReadOnly(args, sibling)).rejects.toThrow('reserved');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		hold.release();
		(await reserve()).release();
	});

	it('does not exempt execGit through argv, optional-lock env or repository overrides', async () => {
		const hold = await reserve();
		await expect(
			git.execGit(['rev-parse', '--git-dir'], sibling, null, undefined, {
				env: { GIT_OPTIONAL_LOCKS: '0', GIT_DIR: sibling, GIT_WORK_TREE: root },
			})
		).rejects.toThrow('reserved');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		hold.release();
	});

	it.each([
		['rev-parse', '--git-common-dir'],
		['rev-parse', '--git-dir'],
		['rev-parse', '--show-toplevel'],
		['rev-parse', '--verify', 'HEAD'],
		['ls-files', '--stage', '-v', '-z'],
		['remote', 'get-url', 'origin'],
		['worktree', 'list', '--porcelain', '-z'],
		['symbolic-ref', '--quiet', '--short', 'HEAD'],
		[
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.untrackedCache=false',
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--ignored=traditional',
			'--ignore-submodules=none',
		],
	])('allows only the exact fixed cleanup query %j under a hold', async (...args) => {
		const hold = await reserve();
		await expect(git.execGitReadOnly(args, root)).resolves.toEqual(success);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'git',
			['-c', 'core.fsmonitor=false', ...args],
			root,
			{
				timeout: git.READ_ONLY_GIT_TIMEOUT_MS,
				env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
			}
		);
		await expect(git.execGit(['fetch'], sibling)).rejects.toThrow('reserved');
		hold.release();
	});

	it.each(['execGit', 'execGitReadOnly'] as const)(
		'%s captures mutable argv before any async admission',
		async (method) => {
			const args = ['rev-parse', '--git-dir'];
			const run = git[method](args, root);
			args.splice(0, args.length, 'reset', '--hard');
			await run;
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				method === 'execGitReadOnly'
					? ['-c', 'core.fsmonitor=false', 'rev-parse', '--git-dir']
					: ['rev-parse', '--git-dir'],
				root,
				...(method === 'execGitReadOnly'
					? [expect.objectContaining({ timeout: git.READ_ONLY_GIT_TIMEOUT_MS })]
					: [])
			);
		}
	);

	it.each(['failure', 'exception'] as const)('releases on execution %s', async (outcome) => {
		if (outcome === 'failure') {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({ ...success, exitCode: 1 });
			expect((await git.execGit(['fetch'], sibling)).exitCode).toBe(1);
		} else {
			vi.mocked(execFileNoThrow).mockRejectedValueOnce(new Error('spawn failed'));
			await expect(git.execGit(['fetch'], sibling)).rejects.toThrow('spawn failed');
		}
		(await reserve()).release();
	});

	it('a polling deadline retains activity until the actual child settles', async () => {
		vi.useFakeTimers();
		let finish!: (result: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const run = git.execGitReadOnly(['fetch'], sibling, null, undefined, 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await run).toMatchObject({ exitCode: 'ETIMEDOUT' });
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		finish(success);
		await vi.advanceTimersByTimeAsync(0);
		(await reserve()).release();
	});

	it('SSH never enters local exclusion or probes local paths', async () => {
		const hold = await reserve();
		vi.mocked(fs.realpath).mockClear();
		await expect(
			git.execGit(
				['fetch'],
				'/remote/repo',
				{
					id: 'remote',
					name: 'Remote',
					host: 'host',
					port: 22,
					username: 'user',
					privateKeyPath: '/key',
					enabled: true,
				},
				'/remote/repo'
			)
		).resolves.toEqual(success);
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(execFileNoThrow).toHaveBeenCalledWith('ssh', ['remote-git']);
		hold.release();
	});
});

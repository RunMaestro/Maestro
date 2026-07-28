/**
 * @file pr-creator.test.ts
 * @description Tests for the shared gh-CLI pull request helper (Board F3). This
 * is the ONE PR implementation - the `git:createPR` IPC handler and the Board's
 * per-card "open PR when done" both go through it - so the contract locked in
 * here is what both callers get:
 *   - target branch resolution order: explicit -> repo default -> `main`;
 *   - the branch is pushed BEFORE `gh pr create`, and a failed push never
 *     reaches gh;
 *   - gh failures come back as `{ success: false, error }` rather than throwing,
 *     with the "gh is not installed" case mapped to a human message.
 * `execFile`, gh detection, and the shell PATH probe are all mocked, so no git
 * or network is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileNoThrow = vi.fn();
const resolveGhPath = vi.fn();
const getShellPath = vi.fn();

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => execFileNoThrow(...args),
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: (...args: unknown[]) => resolveGhPath(...args),
}));
vi.mock('../../../main/runtime/getShellPath', () => ({
	getShellPath: (...args: unknown[]) => getShellPath(...args),
}));

import { createPullRequest, resolveDefaultBranch } from '../../../main/utils/pr-creator';

const WORKTREE = '/repos/worktrees/board/b1/c1';
const MAIN_REPO = '/repos/project';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 });

/** Every `execFileNoThrow` call as `[command, ...args]`, for order assertions. */
function calls(): string[][] {
	return execFileNoThrow.mock.calls.map((c) => [c[0] as string, ...(c[1] as string[])]);
}

/**
 * Route each mocked exec by its command + first arg, so a test only has to
 * describe the calls it cares about. Anything unlisted succeeds silently.
 */
function routeExec(routes: Record<string, ReturnType<typeof ok>>) {
	execFileNoThrow.mockImplementation((command: string, args: string[] = []) => {
		const key = `${command} ${args[0] ?? ''}`.trim();
		return Promise.resolve(routes[key] ?? ok());
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveGhPath.mockResolvedValue('/usr/bin/gh');
	getShellPath.mockResolvedValue('/usr/local/bin:/usr/bin');
	routeExec({});
});

describe('resolveDefaultBranch', () => {
	it('reads the default branch off the remote', async () => {
		routeExec({ 'git remote': ok('  HEAD branch: develop\n') });
		expect(await resolveDefaultBranch(MAIN_REPO)).toBe('develop');
	});

	it('falls back to a local main when the remote does not answer', async () => {
		routeExec({ 'git remote': fail('no such remote') });
		expect(await resolveDefaultBranch(MAIN_REPO)).toBe('main');
	});

	it('falls back to master when there is no local main', async () => {
		execFileNoThrow.mockImplementation((command: string, args: string[] = []) => {
			if (args[0] === 'remote') return Promise.resolve(fail('no such remote'));
			if (args[0] === 'rev-parse' && args[2] === 'main')
				return Promise.resolve(fail('unknown revision'));
			return Promise.resolve(ok());
		});
		expect(await resolveDefaultBranch(MAIN_REPO)).toBe('master');
	});

	it('returns null when nothing resolves', async () => {
		execFileNoThrow.mockResolvedValue(fail('nope'));
		expect(await resolveDefaultBranch(MAIN_REPO)).toBeNull();
	});
});

describe('createPullRequest target branch resolution', () => {
	it('uses an explicit target branch without probing the repo', async () => {
		routeExec({ [`${'/usr/bin/gh'} pr`]: ok('https://github.com/o/r/pull/7') });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			mainRepoCwd: MAIN_REPO,
			targetBranch: 'rc',
			title: 'T',
			body: 'B',
		});

		expect(result).toMatchObject({ success: true, targetBranch: 'rc' });
		// No default-branch probe at all when the caller named the base.
		expect(calls().some((c) => c[1] === 'remote')).toBe(false);
		expect(calls()).toContainEqual([
			'/usr/bin/gh',
			'pr',
			'create',
			'--base',
			'rc',
			'--title',
			'T',
			'--body',
			'B',
		]);
	});

	it('resolves the repo default branch from the MAIN repo, not the worktree', async () => {
		routeExec({
			'git remote': ok('HEAD branch: develop'),
			'/usr/bin/gh pr': ok('https://github.com/o/r/pull/8'),
		});
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			mainRepoCwd: MAIN_REPO,
			title: 'T',
			body: 'B',
		});

		expect(result.targetBranch).toBe('develop');
		const remoteCall = execFileNoThrow.mock.calls.find((c) => (c[1] as string[])[0] === 'remote');
		expect(remoteCall?.[2]).toBe(MAIN_REPO);
	});

	it('falls back to main when the repo default cannot be resolved', async () => {
		execFileNoThrow.mockImplementation((command: string, args: string[] = []) => {
			if (command === '/usr/bin/gh') return Promise.resolve(ok('https://github.com/o/r/pull/9'));
			if (args[0] === 'push') return Promise.resolve(ok());
			return Promise.resolve(fail('nope'));
		});
		const result = await createPullRequest({ worktreePath: WORKTREE, title: 'T', body: 'B' });
		expect(result).toMatchObject({ success: true, targetBranch: 'main' });
	});

	it('probes the worktree itself when no main repo is given', async () => {
		routeExec({
			'git remote': ok('HEAD branch: trunk'),
			'/usr/bin/gh pr': ok('https://github.com/o/r/pull/10'),
		});
		await createPullRequest({ worktreePath: WORKTREE, title: 'T', body: 'B' });
		const remoteCall = execFileNoThrow.mock.calls.find((c) => (c[1] as string[])[0] === 'remote');
		expect(remoteCall?.[2]).toBe(WORKTREE);
	});
});

describe('createPullRequest push + create', () => {
	it('pushes the branch from the worktree before creating the PR', async () => {
		routeExec({ '/usr/bin/gh pr': ok('https://github.com/o/r/pull/11') });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'Ship it',
			body: 'Body',
		});

		expect(result).toEqual({
			success: true,
			prUrl: 'https://github.com/o/r/pull/11',
			targetBranch: 'main',
		});
		const ordered = calls();
		const pushAt = ordered.findIndex((c) => c[1] === 'push');
		const createAt = ordered.findIndex((c) => c[0] === '/usr/bin/gh');
		expect(pushAt).toBeGreaterThanOrEqual(0);
		expect(createAt).toBeGreaterThan(pushAt);
		expect(ordered[pushAt]).toEqual(['git', 'push', '-u', 'origin', 'HEAD']);
		// Pushed from the worktree, which is the checkout holding the branch.
		expect(execFileNoThrow.mock.calls[pushAt][2]).toBe(WORKTREE);
	});

	it('runs git and gh with the user shell PATH so hooks find their tools', async () => {
		routeExec({ '/usr/bin/gh pr': ok('https://github.com/o/r/pull/12') });
		await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
		});
		const pushCall = execFileNoThrow.mock.calls.find((c) => (c[1] as string[])[0] === 'push');
		expect((pushCall?.[3] as NodeJS.ProcessEnv).PATH).toBe('/usr/local/bin:/usr/bin');
	});

	it('still creates the PR when the shell PATH probe fails, and warns', async () => {
		getShellPath.mockRejectedValue(new Error('no shell'));
		routeExec({ '/usr/bin/gh pr': ok('https://github.com/o/r/pull/13') });
		const warn = vi.fn();
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
			warn,
		});
		expect(result.success).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('no shell'));
	});

	it('honors a custom gh path', async () => {
		resolveGhPath.mockResolvedValue('/opt/gh/bin/gh');
		routeExec({ '/opt/gh/bin/gh pr': ok('https://github.com/o/r/pull/14') });
		const log = vi.fn();
		await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
			ghPath: '/opt/gh/bin/gh',
			log,
		});
		expect(resolveGhPath).toHaveBeenCalledWith('/opt/gh/bin/gh');
		expect(log).toHaveBeenCalledWith('Using gh CLI at: /opt/gh/bin/gh');
	});
});

describe('createPullRequest failures', () => {
	it('reports a failed push and never calls gh', async () => {
		routeExec({ 'git push': fail('rejected: non-fast-forward') });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
		});

		expect(result).toEqual({
			success: false,
			targetBranch: 'main',
			error: 'Failed to push branch: rejected: non-fast-forward',
		});
		expect(calls().some((c) => c[0] === '/usr/bin/gh')).toBe(false);
	});

	it('propagates a gh error verbatim', async () => {
		routeExec({ '/usr/bin/gh pr': fail('a pull request already exists') });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
		});
		expect(result).toEqual({
			success: false,
			targetBranch: 'main',
			error: 'a pull request already exists',
		});
	});

	it('maps a missing gh binary to an actionable message', async () => {
		routeExec({ '/usr/bin/gh pr': fail('gh: command not found') });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
		});
		expect(result.error).toBe('GitHub CLI (gh) is not installed. Please install it to create PRs.');
	});

	it('falls back to a generic message when gh fails silently', async () => {
		routeExec({ '/usr/bin/gh pr': { stdout: '', stderr: '', exitCode: 1 } });
		const result = await createPullRequest({
			worktreePath: WORKTREE,
			targetBranch: 'main',
			title: 'T',
			body: 'B',
		});
		expect(result.error).toBe('Failed to create PR');
	});
});

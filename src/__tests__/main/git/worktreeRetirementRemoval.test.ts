import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredRetiredWorktree, StoredSession } from '../../../main/stores/types';
import { createKeyedWriteQueue } from '../../../shared/keyedWriteQueue';

const adapter = vi.hoisted(() => ({ api: vi.fn(), beforeRemove: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: async () => 'retirement-fixture-gh',
	getExpandedEnv: () => process.env,
}));
vi.mock('../../../main/utils/execFile', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../../main/utils/execFile')>();
	return {
		...original,
		execFileNoThrow: async (...args: Parameters<typeof original.execFileNoThrow>) => {
			if (args[0] === 'retirement-fixture-gh') return adapter.api(args[1]);
			if (args[0] === 'git' && args[1]?.[0] === 'worktree' && args[1][1] === 'remove')
				await adapter.beforeRemove(args[1], args[2]);
			return original.execFileNoThrow(...args);
		},
	};
});
import { execFileNoThrow } from '../../../main/utils/execFile';
import { WorktreeRetirement } from '../../../main/git/worktreeRetirement';
import { WorktreeRetirementHost } from '../../../main/git/worktreeRetirementHost';

const dirs: string[] = [];
beforeEach(() => {
	adapter.api.mockReset();
	adapter.beforeRemove.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every destructive command targets this test's newly initialized repository. */
async function setup(method: 'merge' | 'squash' | 'rebase' = 'merge', withSubmodule = false) {
	const dir = realpathSync(mkdtempSync(join(process.cwd(), '.retirement-removal-')));
	dirs.push(dir);
	const parent = join(dir, 'parent');
	const root = join(dir, 'child with spaces');
	mkdirSync(parent);
	const git = async (cwd: string, ...args: string[]) => {
		const result = await execFileNoThrow('git', args, cwd);
		if (result.exitCode !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	await git(parent, 'init', '--initial-branch=rc');
	await git(parent, 'config', 'user.name', 'Retirement Fixture');
	await git(parent, 'config', 'user.email', 'fixture@example.invalid');
	await git(parent, 'config', 'commit.gpgsign', 'false');
	await git(parent, 'config', 'core.autocrlf', 'false');
	writeFileSync(join(parent, 'saved.txt'), 'initial\n');
	writeFileSync(join(parent, '.gitignore'), 'ignored/\n');
	await git(parent, 'add', '.');
	await git(parent, 'commit', '-m', 'initial');
	await git(parent, 'remote', 'add', 'origin', 'https://github.com/fork/project.git');
	await git(parent, 'worktree', 'add', '-b', 'feature', root);
	writeFileSync(join(root, 'saved.txt'), 'saved feature\n');
	if (withSubmodule) {
		const initial = await git(root, 'rev-parse', 'HEAD');
		await git(root, 'update-index', '--add', '--cacheinfo', `160000,${initial},nested`);
		mkdirSync(join(root, 'nested'));
	}
	await git(root, 'add', 'saved.txt');
	await git(root, 'commit', '-m', 'feature');
	const head = await git(root, 'rev-parse', 'HEAD');
	if (method === 'merge') await git(parent, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
	if (method === 'squash') {
		await git(parent, 'merge', '--squash', 'feature');
		await git(parent, 'commit', '-m', 'squashed feature');
	}
	if (method === 'rebase') {
		writeFileSync(join(parent, 'base.txt'), 'advance base\n');
		await git(parent, 'add', 'base.txt');
		await git(parent, 'commit', '-m', 'advance base');
		await git(parent, 'cherry-pick', head);
	}
	const merged = await git(parent, 'rev-parse', 'HEAD');
	const repository = (owner: string) => ({ name: 'project', owner: { login: owner } });
	const remote = {
		number: 7,
		title: 'Saved feature',
		html_url: 'https://github.com/upstream/project/pull/7',
		state: 'closed',
		merged: true,
		merged_at: '2026-11-05T09:00:00Z',
		merge_commit_sha: merged,
		draft: false,
		head: { repo: repository('fork'), ref: 'feature', sha: head },
		base: { repo: repository('upstream'), ref: 'rc' },
	};
	adapter.api.mockImplementation(async (args: string[]) => {
		const endpoint = args.find((arg) => arg.startsWith('repos/'));
		const data =
			endpoint === 'repos/fork/project'
				? { ...repository('fork'), fork: true, parent: repository('upstream') }
				: endpoint === 'repos/upstream/project/pulls'
					? [[remote]]
					: remote;
		return { stdout: JSON.stringify(data), stderr: '', exitCode: 0 };
	});
	const child: StoredSession = {
		id: 'child',
		name: 'Saved child',
		toolType: 'codex',
		cwd: root,
		projectRoot: root,
		parentSessionId: 'parent',
		worktreeBranch: 'feature',
	};
	const parentSession: StoredSession = {
		id: 'parent',
		name: 'Parent',
		toolType: 'codex',
		cwd: parent,
		projectRoot: parent,
	};
	let sessions = [child, parentSession];
	let generation = 1;
	const archive: StoredRetiredWorktree[] = [];
	const queue = createKeyedWriteQueue();
	const fence = new WorktreeRetirement();
	const persist = vi.fn(async (updates: StoredSession[]) => {
		sessions = sessions.map((s) => updates.find((update) => update.id === s.id) ?? s);
		generation++;
	});
	const reconcile = vi.fn(async (record: StoredRetiredWorktree) => {
		archive.push(record);
		sessions = sessions.filter((s) => s.id !== record.session.id);
		generation++;
	});
	fence.bindRegistrationSource({
		read: () => sessions,
		generation: () => generation,
		enqueue: (operation) => queue.enqueue('sessions', operation),
		persistPrepared: persist,
		reconcileRetired: reconcile,
	});
	const identity = {};
	const client = fence.admitClient('primary');
	if (!client.ok) throw new Error(client.reason);
	client.loaded(identity);
	let invalidated = () => {};
	const release = vi.fn();
	const request = vi.fn(
		async (command: import('../../../shared/worktreeRetirement').RetirementRendererCommand) => ({
			ok: true as const,
			token: command.kind === 'prepare' ? command.request.token : command.token,
			revision: 1,
			...(command.kind === 'prepare' ? { snapshots: [child, parentSession] } : {}),
		})
	);
	const host = new WorktreeRetirementHost(fence, 60000);
	const prepared = await host.prepare('child', {
		identity,
		request,
		release,
		onInvalidated: (callback) => {
			invalidated = callback;
			return () => {};
		},
	});
	if (!prepared.ok) throw new Error(prepared.reason);
	const watchers = vi.fn(async () => {});
	return {
		dir,
		root,
		parent,
		head,
		merged,
		git,
		fence,
		host,
		identity,
		remote,
		archive,
		reconcile,
		release,
		request,
		watchers,
		token: prepared.token,
		remove: () => host.remove(prepared.token, identity, watchers),
		invalidate: () => {
			client.invalidate();
			invalidated();
		},
	};
}

describe('checked worktree removal with real local Git fixtures', () => {
	it.each(['merge', 'squash', 'rebase'] as const)(
		'removes a clean %s checkout from its surviving parent and preserves the branch',
		async (method) => {
			const f = await setup(method);
			expect(await f.remove()).toEqual({ status: 'removed' });
			expect(existsSync(f.root)).toBe(false);
			expect(await f.git(f.parent, 'rev-parse', 'feature')).toBe(f.head);
			expect(await f.git(f.parent, 'rev-parse', 'HEAD')).toBe(f.merged);
			expect(f.archive).toHaveLength(1);
			expect(f.archive[0]).toMatchObject({
				head: f.head,
				session: { id: 'child', name: 'Saved child' },
			});
			expect(f.watchers).toHaveBeenCalledOnce();
			expect(f.release).toHaveBeenCalledOnce();
			expect(f.fence.state(f.root)).toBe('removed');
			expect(f.fence.admit([f.parent]).ok).toBe(true);
			expect(adapter.beforeRemove).toHaveBeenCalledExactlyOnceWith(
				['worktree', 'remove', '--', f.root],
				f.parent
			);
		}
	);
	it.each([
		'tracked',
		'untracked',
		'ignored',
		'assume-unchanged',
		'skip-worktree',
		'extra-commit',
		'locked',
	])('refuses %s data or ownership without running removal', async (kind) => {
		const f = await setup();
		if (kind === 'tracked') writeFileSync(join(f.root, 'saved.txt'), 'unsaved\n');
		if (kind === 'untracked') writeFileSync(join(f.root, 'new.txt'), 'unsaved\n');
		if (kind === 'ignored') {
			mkdirSync(join(f.root, 'ignored'));
			writeFileSync(join(f.root, 'ignored', 'secret'), 'unsaved\n');
		}
		if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
			await f.git(f.root, 'update-index', `--${kind}`, 'saved.txt');
			writeFileSync(join(f.root, 'saved.txt'), 'hidden unsaved\n');
		}
		if (kind === 'extra-commit') {
			writeFileSync(join(f.root, 'saved.txt'), 'additional commit\n');
			await f.git(f.root, 'commit', '-am', 'unmerged extra');
		}
		if (kind === 'locked') await f.git(f.parent, 'worktree', 'lock', f.root);
		expect((await f.remove()).status).toBe('blocked');
		expect(existsSync(f.root)).toBe(true);
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
		expect(f.archive).toHaveLength(0);
		expect(f.fence.state(f.root)).toBe('available');
	});
	it.each(['unmerged', 'closed', 'head', 'base', 'repository', 'timestamp', 'merge-sha', 'auth'])(
		'rejects fresh remote %s evidence',
		async (kind) => {
			const f = await setup();
			if (kind === 'unmerged') {
				f.remote.state = 'open';
				f.remote.merged = false;
			}
			if (kind === 'closed') f.remote.merged = false;
			if (kind === 'head') f.remote.head.sha = 'a'.repeat(40);
			// Change ONLY the independently re-read detail, after discovery.
			const original = adapter.api.getMockImplementation()!;
			adapter.api.mockImplementation(async (args: string[]) => {
				const result = await original(args);
				if (args.includes('repos/upstream/project/pulls/7')) {
					const remote = JSON.parse(result.stdout);
					if (kind === 'base') remote.base.ref = 'changed';
					if (kind === 'repository') remote.base.repo.owner.login = 'other';
					if (kind === 'timestamp') remote.merged_at = 'unknown';
					if (kind === 'merge-sha') remote.merge_commit_sha = null;
					if (kind === 'auth') return { stdout: '', stderr: 'unauthorized', exitCode: 1 };
					return { ...result, stdout: JSON.stringify(remote) };
				}
				return result;
			});
			expect((await f.remove()).status).toBe('blocked');
			expect(adapter.beforeRemove).not.toHaveBeenCalled();
			expect(existsSync(f.root)).toBe(true);
		}
	);
	it('owner loss during remote confirmation wins over a late positive response', async () => {
		const f = await setup();
		const original = adapter.api.getMockImplementation()!;
		adapter.api.mockImplementation(async (args: string[]) => {
			if (args.includes('repos/upstream/project/pulls/7')) f.invalidate();
			return original(args);
		});
		expect((await f.remove()).status).toBe('blocked');
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
	});
	it('refuses clean submodule entries even when the submodule is unpopulated', async () => {
		const f = await setup('merge', true);
		expect(await f.git(f.root, 'status', '--porcelain')).toBe('');
		expect(await f.remove()).toMatchObject({
			status: 'blocked',
			reason: expect.stringContaining('Submodule'),
		});
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
	});
	it('refuses ambiguous merged PRs when a branch has been reused', async () => {
		const f = await setup();
		const original = adapter.api.getMockImplementation()!;
		adapter.api.mockImplementation(async (args: string[]) =>
			args.includes('repos/upstream/project/pulls')
				? {
						stdout: JSON.stringify([[f.remote, { ...f.remote, number: 8 }]]),
						stderr: '',
						exitCode: 0,
					}
				: original(args)
		);
		expect((await f.remove()).status).toBe('blocked');
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
	});
	it('coalesces concurrent commits and cannot abort or unlock a running removal', async () => {
		const f = await setup();
		let finish!: () => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		adapter.beforeRemove.mockImplementationOnce(async () => {
			started();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		const pending = f.remove();
		expect(f.remove()).toBe(pending);
		await running;
		f.invalidate();
		expect(f.host.abort(f.token, f.identity)).toBe(false);
		expect(f.fence.admit([f.parent]).ok).toBe(false);
		finish();
		expect(await pending).toEqual({ status: 'removed' });
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('keeps Git refusal fenced without force or retrying the destructive command', async () => {
		const f = await setup();
		adapter.beforeRemove.mockImplementationOnce(async () => {
			await f.git(f.parent, 'worktree', 'lock', f.root);
		});
		expect((await f.remove()).status).toBe('pending');
		expect((await f.remove()).status).toBe('pending');
		expect(existsSync(f.root)).toBe(true);
		expect(f.fence.state(f.root)).toBe('removing');
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
		expect(f.release).not.toHaveBeenCalled();
	});
	it('preserves late untracked data when Git refuses the non-force removal', async () => {
		const f = await setup();
		adapter.beforeRemove.mockImplementationOnce(async () => {
			writeFileSync(join(f.root, 'late.txt'), 'external write\n');
		});
		expect((await f.remove()).status).toBe('pending');
		expect(existsSync(join(f.root, 'late.txt'))).toBe(true);
		expect(f.archive).toHaveLength(0);
		expect(f.fence.state(f.root)).toBe('removing');
	});
	it.each(['watchers', 'persistence', 'renderer'])(
		'retries failed %s settlement after deletion without removing twice',
		async (kind) => {
			const f = await setup();
			if (kind === 'watchers') f.watchers.mockRejectedValueOnce(new Error('watcher pending'));
			if (kind === 'persistence') f.reconcile.mockRejectedValueOnce(new Error('disk full'));
			// Renderer failure must occur on COMPLETE, after both pre-removal checks.
			if (kind === 'renderer') {
				f.request.mockReset();
				f.request.mockImplementation(async (command) => {
					if (command.kind === 'complete') throw new Error('completion unavailable');
					return { ok: true, token: f.token, revision: 1 };
				});
			}
			expect((await f.remove()).status).toBe('pending');
			expect(existsSync(f.root)).toBe(false);
			expect(f.fence.state(f.root)).toBe('removing');
			expect(f.release).not.toHaveBeenCalled();
			f.request.mockImplementation(async () => ({ ok: true, token: f.token, revision: 1 }));
			expect(await f.remove()).toEqual({ status: 'removed' });
			expect(adapter.beforeRemove).toHaveBeenCalledOnce();
			expect(f.archive).toHaveLength(1);
		}
	);
});

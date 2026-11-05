import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetirementIntent } from '../../../main/git/worktreeRetirementRecovery';
import { inspectRetirementOutcome } from '../../../main/git/worktreeRetirementRecovery';
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
	const journal: RetirementIntent[] = [];
	const writeIntent = vi.fn(async (intent: RetirementIntent) => {
		const copy = structuredClone(intent);
		const index = journal.findIndex((entry) => entry.archive.id === copy.archive.id);
		if (index < 0) journal.push(copy);
		else journal[index] = copy;
	});
	const queue = createKeyedWriteQueue();
	const fence = new WorktreeRetirement();
	const persist = vi.fn(async (updates: StoredSession[]) => {
		sessions = sessions.map((s) => updates.find((update) => update.id === s.id) ?? s);
		generation++;
	});
	const reconcile = vi.fn(async (record: StoredRetiredWorktree) => {
		if (!archive.some((saved) => saved.id === record.id)) archive.push(record);
		sessions = sessions.filter((s) => s.id !== record.session.id);
		generation++;
	});
	const source = {
		read: () => sessions,
		generation: () => generation,
		enqueue: <T>(operation: () => Promise<T>) => queue.enqueue('sessions', operation),
		persistPrepared: persist,
		reconcileRetired: reconcile,
		writeRetirementIntent: writeIntent,
	};
	fence.bindRegistrationSource(source);
	const identity = {};
	const client = fence.admitClient('primary');
	if (!client.ok) throw new Error(client.reason);
	client.loaded(identity);
	let invalidated = () => {};
	const release = vi.fn();
	const request = vi.fn(
		async (command: import('../../../shared/worktreeRetirement').RetirementRendererCommand) => ({
			ok: true as const,
			token:
				command.kind === 'prepare' || command.kind === 'recover'
					? command.request.token
					: command.token,
			revision: 1,
			...(command.kind === 'prepare' ? { snapshots: [child, parentSession] } : {}),
		})
	);
	const discovery = vi.fn(async () => {});
	const host = new WorktreeRetirementHost(fence, 60000, discovery);
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
		journal,
		writeIntent,
		source,
		reconcile,
		release,
		request,
		watchers,
		discovery,
		token: prepared.token,
		remove: () => host.remove(prepared.token, identity, watchers),
		invalidate: () => {
			client.invalidate();
			invalidated();
		},
	};
}

describe('checked worktree removal with real local Git fixtures', () => {
	async function recoverPresent() {
		const f = await setup();
		adapter.beforeRemove.mockRejectedValueOnce(new Error('interrupted before Git'));
		expect((await f.remove()).status).toBe('pending');
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(structuredClone(f.journal));
		restarted.bindRegistrationSource(f.source);
		const renderer = {};
		const client = restarted.admitClient('primary');
		if (!client.ok) throw new Error(client.reason);
		client.loaded(renderer);
		const id = f.journal[0].archive.id;
		return {
			...f,
			restarted,
			renderer,
			client,
			id,
			cancel: () => restarted.cancelRecoveredRemoval(id, renderer),
		};
	}

	async function recoverRemoved(archived = false) {
		const f = await setup();
		if (archived) {
			const reply = f.request.getMockImplementation()!;
			f.request.mockImplementation(async (command) => {
				if (command.kind === 'complete') throw new Error('lost renderer');
				return reply(command);
			});
		} else f.watchers.mockRejectedValueOnce(new Error('lost watcher'));
		expect((await f.remove()).status).toBe('pending');
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(structuredClone(f.journal));
		restarted.bindRegistrationSource(f.source);
		const renderer = {};
		const client = restarted.admitClient('primary');
		if (!client.ok) throw new Error(client.reason);
		client.loaded(renderer);
		const request = vi.fn(
			async (command: import('../../../shared/worktreeRetirement').RetirementRendererCommand) => ({
				ok: true as const,
				token:
					command.kind === 'recover' || command.kind === 'prepare'
						? command.request.token
						: command.token,
				revision: 7,
			})
		);
		let invalidate = () => {};
		const release = vi.fn();
		const adapter = {
			identity: renderer,
			request,
			release,
			onInvalidated: (callback: () => void) => {
				invalidate = callback;
				return () => {};
			},
		};
		const watchers = vi.fn(async () => {});
		const host = new WorktreeRetirementHost(restarted, 60000, watchers);
		const id = f.journal[0].archive.id;
		return {
			...f,
			restarted,
			renderer,
			client,
			request,
			release,
			watchers,
			host,
			id,
			adapter,
			recover: () => host.recover(id, adapter),
			invalidate: () => {
				client.invalidate();
				invalidate();
			},
		};
	}
	it.each([false, true])(
		'completes restored removed outcome (already archived %s) without repeating Git',
		async (archived) => {
			const f = await recoverRemoved(archived);
			const original = structuredClone(f.journal[0]);
			expect(await f.recover()).toEqual({ status: 'removed' });
			expect(f.archive).toEqual([original.archive]);
			expect(f.journal).toEqual([{ ...original, phase: 'settled' }]);
			expect(f.restarted.pendingRecoveries()).toEqual([]);
			expect(f.restarted.admit([f.parent]).ok).toBe(true);
			expect(f.restarted.admit([f.root], { allowMissing: true }).ok).toBe(false);
			expect(f.release).toHaveBeenCalledOnce();
			expect(f.watchers).toHaveBeenCalledOnce();
			expect(adapter.beforeRemove).toHaveBeenCalledOnce();
			expect((await f.recover()).status).toBe('blocked');
		}
	);
	it('retries archive durability with the same renderer token and original snapshot', async () => {
		const f = await recoverRemoved();
		f.reconcile.mockRejectedValueOnce(new Error('archive disk full'));
		expect(await f.recover()).toMatchObject({ status: 'pending', reason: 'archive disk full' });
		expect(f.restarted.admit([f.parent]).ok).toBe(false);
		expect(f.release).not.toHaveBeenCalled();
		expect(await f.recover()).toEqual({ status: 'removed' });
		expect(f.request.mock.calls.filter(([c]) => c.kind === 'recover')).toHaveLength(1);
		expect(f.archive).toHaveLength(1);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('retains a completed renderer and both fences until final journal durability succeeds', async () => {
		const f = await recoverRemoved();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementationOnce(async () => {
			throw new Error('journal disk full');
		});
		expect(await f.recover()).toMatchObject({ status: 'pending', reason: 'journal disk full' });
		expect(f.archive).toHaveLength(1);
		expect(f.journal[0].phase).toBe('removing');
		expect(f.restarted.admit([f.parent]).ok).toBe(false);
		f.writeIntent.mockImplementation(write);
		expect(await f.recover()).toEqual({ status: 'removed' });
		expect(f.request.mock.calls.filter(([c]) => c.kind === 'recover')).toHaveLength(1);
		expect(f.archive).toHaveLength(1);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it.each(['watchers', 'archive', 'renderer', 'journal'] as const)(
		'keeps recovery fenced after primary reload during %s',
		async (stage) => {
			const f = await recoverRemoved();
			if (stage === 'watchers')
				f.watchers.mockImplementationOnce(async () => {
					f.invalidate();
				});
			if (stage === 'archive') {
				const reconcile = f.reconcile.getMockImplementation()!;
				f.reconcile.mockImplementationOnce(async (record) => {
					await reconcile(record);
					f.invalidate();
				});
			}
			if (stage === 'renderer') {
				const reply = f.request.getMockImplementation()!;
				let first = true;
				f.request.mockImplementation(async (command) => {
					if (command.kind === 'complete' && first) {
						first = false;
						f.invalidate();
					}
					return reply(command);
				});
			}
			if (stage === 'journal') {
				const write = f.writeIntent.getMockImplementation()!;
				f.writeIntent.mockImplementationOnce(async (intent) => {
					await write(intent);
					f.invalidate();
				});
			}
			expect((await f.recover()).status).toBe('pending');
			expect(f.restarted.admit([f.parent]).ok).toBe(false);
			expect(f.release).not.toHaveBeenCalled();
			f.client.loaded(f.renderer); // same IPC sender, NEW primary document
			expect(await f.recover()).toEqual({ status: 'removed' });
			const starts = f.request.mock.calls
				.filter(([c]) => c.kind === 'recover')
				.map(([c]) => c.kind === 'recover' && c.request.token);
			expect(starts).toHaveLength(2);
			expect(starts[0]).not.toBe(starts[1]);
			expect(f.archive).toHaveLength(1);
			expect(adapter.beforeRemove).toHaveBeenCalledOnce();
		}
	);
	it('shares one recovery runner and excludes cancellation and untrusted owners while draining', async () => {
		const f = await recoverRemoved();
		let finish!: () => void;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.watchers.mockImplementationOnce(() => {
			started();
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		const first = f.recover();
		await ready;
		expect(f.recover()).toBe(first);
		expect(await f.host.recover(f.id, { ...f.adapter, identity: {} })).toMatchObject({
			status: 'blocked',
		});
		expect(await f.restarted.cancelRecoveredRemoval(f.id, f.renderer)).toMatchObject({ ok: false });
		expect(f.restarted.admit([f.parent]).ok).toBe(false);
		finish();
		expect(await first).toEqual({ status: 'removed' });
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('retries a lost prepare reply with the same wire identity', async () => {
		const f = await recoverRemoved();
		f.request.mockRejectedValueOnce(new Error('reply lost'));
		expect((await f.recover()).status).toBe('pending');
		expect(await f.recover()).toEqual({ status: 'removed' });
		const starts = f.request.mock.calls.filter(([c]) => c.kind === 'recover');
		expect(starts).toHaveLength(2);
		expect(starts[0]).toEqual(starts[1]);
	});

	it('refuses unloaded/foreign recovery owners before asking any renderer', async () => {
		const f = await recoverRemoved();
		expect(await f.host.recover(f.id, { ...f.adapter, identity: {} })).toMatchObject({
			status: 'blocked',
		});
		f.client.invalidate();
		expect((await f.recover()).status).toBe('blocked');
		expect(f.request).not.toHaveBeenCalled();
		f.client.loaded(f.renderer);
		expect(await f.recover()).toEqual({ status: 'removed' });
	});
	it('detects a same-sender reload using the Main document revision even without an adapter callback', async () => {
		const f = await recoverRemoved();
		f.watchers.mockImplementationOnce(async () => {
			f.client.invalidate();
			f.client.loaded(f.renderer);
		});
		expect((await f.recover()).status).toBe('pending');
		expect(f.release).not.toHaveBeenCalled();
		expect(await f.recover()).toEqual({ status: 'removed' });
		const starts = f.request.mock.calls.filter(([c]) => c.kind === 'recover');
		expect(starts).toHaveLength(2);
		expect(starts[0]).not.toEqual(starts[1]);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('refuses completion for a fully present outcome before freezing the renderer', async () => {
		const f = await recoverPresent();
		const request = vi.fn();
		const host = new WorktreeRetirementHost(f.restarted, 60000, async () => {});
		expect(
			await host.recover(f.id, {
				identity: f.renderer,
				request,
				release: vi.fn(),
				onInvalidated: () => () => {},
			})
		).toMatchObject({ status: 'pending', reason: expect.stringContaining('still present') });
		expect(request).not.toHaveBeenCalled();
		expect(await f.cancel()).toEqual({ ok: true });
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('durably cancels a fully present recovery and requires a fresh preparation', async () => {
		const f = await recoverPresent();
		const original = structuredClone(f.source.read());
		expect(await f.cancel()).toEqual({ ok: true });
		expect(f.journal[0].phase).toBe('cancelled');
		expect(f.source.read()).toEqual(original);
		expect(f.archive).toEqual([]);
		expect(existsSync(f.root)).toBe(true);
		expect(f.restarted.pendingRecoveries()).toEqual([]);
		for (const p of [f.root, f.parent]) {
			const admission = f.restarted.admit([p]);
			expect(admission.ok).toBe(true);
			if (admission.ok) admission.release();
		}
		const prepared = await f.restarted.prepareRegisteredForRenderer('child', f.renderer);
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) throw new Error(prepared.reason);
		await f.restarted.beginRemoval(prepared.token);
		expect(f.journal).toHaveLength(2);
		expect(f.journal[1].archive.id).not.toBe(f.id);
		const next = new WorktreeRetirement();
		next.restoreRetirements(f.journal);
		expect(next.pendingRecoveries()).toHaveLength(1);
		expect(next.pendingRecoveries()[0].id).toBe(f.journal[1].archive.id);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('restores cancelled history without fencing the preserved checkout or parent', async () => {
		const f = await recoverPresent();
		expect(await f.cancel()).toEqual({ ok: true });
		const next = new WorktreeRetirement();
		next.restoreRetirements(f.journal);
		expect(next.pendingRecoveries()).toEqual([]);
		expect(next.admit([f.root]).ok).toBe(true);
		expect(next.admit([f.parent]).ok).toBe(true);
	});
	it('cannot cancel a live Git runner using its durable journal id', async () => {
		const f = await setup();
		adapter.beforeRemove.mockImplementationOnce(async () => {
			expect(
				await f.fence.cancelRecoveredRemoval(f.journal[0].archive.id, f.identity)
			).toMatchObject({ ok: false });
			expect(f.fence.admit([f.root]).ok).toBe(false);
			expect(f.fence.admit([f.parent]).ok).toBe(false);
		});
		expect(await f.remove()).toEqual({ status: 'removed' });
		expect(f.journal[0].phase).toBe('settled');
	});
	it('requires the sole loaded primary and a current recovery id to cancel', async () => {
		const f = await recoverPresent();
		expect(await f.restarted.cancelRecoveredRemoval(f.id, {})).toMatchObject({ ok: false });
		expect(await f.restarted.cancelRecoveredRemoval('unknown', f.renderer)).toMatchObject({
			ok: false,
		});
		f.client.invalidate();
		expect(await f.cancel()).toMatchObject({ ok: false });
		expect(f.journal[0].phase).toBe('removing');
		expect(f.restarted.admit([f.parent]).ok).toBe(false);
	});
	it('holds both fences through an uncertain cancellation flush and retries the same id', async () => {
		const f = await recoverPresent();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementationOnce(async (intent) => {
			await write(intent);
			expect(f.restarted.admit([f.root]).ok).toBe(false);
			expect(f.restarted.admit([f.parent]).ok).toBe(false);
			throw new Error('uncertain cancellation flush');
		});
		expect(await f.cancel()).toMatchObject({ ok: false, reason: 'uncertain cancellation flush' });
		expect(f.journal[0].phase).toBe('cancelled');
		expect(f.restarted.state(f.root)).toBe('removing');
		expect(await f.cancel()).toEqual({ ok: true });
		expect(f.journal).toHaveLength(1);
		expect(f.journal[0].archive.id).toBe(f.id);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('rejects a late cancellation acknowledgement across reload of the same IPC sender', async () => {
		const f = await recoverPresent();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementationOnce(async (intent) => {
			await write(intent);
			f.client.invalidate();
			f.client.loaded(f.renderer);
		});
		expect(await f.cancel()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('changed during persistence'),
		});
		expect(f.restarted.admit([f.parent]).ok).toBe(false);
		expect(await f.cancel()).toEqual({ ok: true });
	});
	it.each(['registration', 'checkout', 'head'])(
		'refuses cancellation after %s replacement instead of trusting registry presence',
		async (kind) => {
			const f = await recoverPresent();
			if (kind === 'registration') f.source.read()[0].name = 'Changed';
			if (kind === 'checkout') {
				renameSync(f.root, join(f.dir, 'preserved-child'));
				mkdirSync(f.root);
			}
			if (kind === 'head') {
				writeFileSync(join(f.root, 'extra.txt'), 'unreviewed');
				await f.git(f.root, 'add', '.');
				await f.git(f.root, 'commit', '-m', 'unreviewed');
			}
			expect(await f.cancel()).toMatchObject({ ok: false });
			expect(f.restarted.admit([f.parent]).ok).toBe(false);
			expect(f.journal[0].phase).toBe('removing');
			expect(adapter.beforeRemove).toHaveBeenCalledOnce();
		}
	);
	it('serializes concurrent cancellation and refuses removed outcomes', async () => {
		const f = await recoverPresent();
		const results = await Promise.all([f.cancel(), f.cancel()]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(f.journal).toHaveLength(1);
		const removed = await setup();
		removed.watchers.mockRejectedValueOnce(new Error('lost completion'));
		expect((await removed.remove()).status).toBe('pending');
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(removed.journal);
		restarted.bindRegistrationSource(removed.source);
		const client = restarted.admitClient('primary');
		if (!client.ok) throw new Error(client.reason);
		const renderer = {};
		client.loaded(renderer);
		expect(
			await restarted.cancelRecoveredRemoval(removed.journal[0].archive.id, renderer)
		).toMatchObject({ ok: false });
		expect(restarted.admit([removed.parent]).ok).toBe(false);
		expect(removed.journal[0].phase).toBe('removing');
	});
	it('makes the original archive durable before Git and keeps owner loss fenced during that write', async () => {
		const f = await setup();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementationOnce(async (intent) => {
			expect(f.fence.state(f.root)).toBe('removing');
			f.invalidate();
			expect(f.host.abort(f.token, f.identity)).toBe(false);
			expect(adapter.beforeRemove).not.toHaveBeenCalled();
			await write(intent);
		});
		adapter.beforeRemove.mockImplementationOnce(async () => {
			expect(f.journal[0]).toMatchObject({
				phase: 'removing',
				checkout: { head: f.head },
				archive: { session: { name: 'Saved child' } },
			});
			expect(f.archive).toHaveLength(0);
		});
		expect(await f.remove()).toEqual({ status: 'removed' });
	});
	it('never starts Git after a failed intent flush, even when the cache already contains it', async () => {
		const f = await setup();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementationOnce(async (intent) => {
			await write(intent);
			throw new Error('disk full');
		});
		expect(await f.remove()).toMatchObject({ status: 'pending', reason: 'disk full' });
		expect((await f.remove()).status).toBe('pending');
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
		expect(existsSync(f.root)).toBe(true);
		expect(f.fence.admit([f.parent]).ok).toBe(false);
		expect(await inspectRetirementOutcome(f.journal[0])).toEqual({ state: 'present' });
	});
	it('restores both fences before startup admits a recovery primary, without restoring old wire authority', async () => {
		const f = await setup();
		adapter.beforeRemove.mockImplementationOnce(async () => {
			await f.git(f.parent, 'worktree', 'lock', f.root);
		});
		expect((await f.remove()).status).toBe('pending');
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(f.journal);
		expect(restarted.admit([f.root]).ok).toBe(false);
		expect(restarted.admit([f.parent]).ok).toBe(false);
		expect(restarted.admitClient('web').ok).toBe(false);
		expect(restarted.admitClient('secondary').ok).toBe(false);
		const client = restarted.admitClient('primary');
		expect(client.ok).toBe(true);
		expect(restarted.admitClient('primary').ok).toBe(false);
		if (client.ok) {
			client.loaded({});
			client.invalidate();
			client.release();
		}
		expect(restarted.state(f.root)).toBe('removing');
		restarted.bindRegistrationSource(f.source);
		expect(await restarted.reconcileRecoveredRemoval(f.journal[0].archive.id)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('still present'),
		});
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
		expect(f.archive).toHaveLength(0);
	});
	it('recovers a lost successful Git result by observing disk, with the same archive id and no second removal', async () => {
		const f = await setup();
		f.watchers.mockRejectedValueOnce(new Error('lost completion'));
		expect((await f.remove()).status).toBe('pending');
		expect(f.journal[0].phase).toBe('removing');
		expect(await inspectRetirementOutcome(f.journal[0])).toEqual({ state: 'removed' });
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(structuredClone(f.journal));
		restarted.bindRegistrationSource(f.source);
		const [pending] = restarted.pendingRecoveries();
		expect(await restarted.reconcileRecoveredRemoval(pending.id)).toEqual({ ok: true });
		expect(await restarted.reconcileRecoveredRemoval(pending.id)).toEqual({ ok: true });
		expect(f.archive).toHaveLength(1);
		expect(f.archive[0].id).toBe(pending.id);
		expect(restarted.state(f.root)).toBe('removing');
		expect(restarted.admit([f.parent]).ok).toBe(false);
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it.each(['child', 'admin', 'branch', 'parent'])(
		'refuses ambiguous recovery after %s replacement',
		async (kind) => {
			const f = await setup();
			f.watchers.mockRejectedValueOnce(new Error('lost completion'));
			expect((await f.remove()).status).toBe('pending');
			const intent = f.journal[0];
			if (kind === 'child') mkdirSync(f.root);
			if (kind === 'admin') mkdirSync(intent.checkout.ownership!.gitDir, { recursive: true });
			if (kind === 'branch') await f.git(f.parent, 'branch', '-D', 'feature');
			if (kind === 'parent') renameSync(join(f.parent, '.git'), join(f.parent, '.git-preserved'));
			const restarted = new WorktreeRetirement();
			restarted.restoreRetirements(f.journal);
			restarted.bindRegistrationSource(f.source);
			expect(await restarted.reconcileRecoveredRemoval(intent.archive.id)).toMatchObject({
				ok: false,
			});
			expect(restarted.admit([f.parent]).ok).toBe(false);
			expect(f.archive).toHaveLength(0);
			expect(adapter.beforeRemove).toHaveBeenCalledOnce();
		}
	);
	it('retains a settled tombstone across restart while releasing the surviving parent', async () => {
		const f = await setup();
		expect(await f.remove()).toEqual({ status: 'removed' });
		const restarted = new WorktreeRetirement();
		restarted.restoreRetirements(f.journal);
		expect(restarted.state(f.root)).toBe('removed');
		expect(restarted.admit([f.root], { allowMissing: true }).ok).toBe(false);
		expect(restarted.admit([f.parent]).ok).toBe(true);
		expect(restarted.pendingRecoveries()).toEqual([]);
	});
	it('keeps removing fenced until the completed journal flush succeeds', async () => {
		const f = await setup();
		const write = f.writeIntent.getMockImplementation()!;
		f.writeIntent.mockImplementation(async (intent) => {
			if (intent.phase === 'settled') throw new Error('completion disk full');
			await write(intent);
		});
		expect(await f.remove()).toMatchObject({ status: 'pending', reason: 'completion disk full' });
		expect(f.journal[0].phase).toBe('removing');
		expect(f.fence.admit([f.parent]).ok).toBe(false);
		f.writeIntent.mockImplementation(write);
		expect(await f.remove()).toEqual({ status: 'removed' });
		expect(adapter.beforeRemove).toHaveBeenCalledOnce();
	});
	it('rejects malformed or duplicate journals and late restoration instead of losing fences', async () => {
		const f = await setup();
		f.watchers.mockRejectedValueOnce(new Error('lost completion'));
		await f.remove();
		for (const input of [
			null,
			[null],
			[f.journal[0], f.journal[0]],
			[{ ...f.journal[0], version: 2 }],
		]) {
			expect(() => new WorktreeRetirement().restoreRetirements(input)).toThrow();
		}
		const late = new WorktreeRetirement();
		late.admitClient('primary');
		expect(() => late.restoreRetirements(f.journal)).toThrow('precede admissions');
	});
	it.each(['merge', 'squash', 'rebase'] as const)(
		'removes a clean %s checkout from its surviving parent and preserves the branch',
		async (method) => {
			const f = await setup(method);
			expect(await f.remove()).toEqual({ status: 'removed' });
			expect(existsSync(f.root)).toBe(false);
			expect(await f.git(f.parent, 'rev-parse', 'feature')).toBe(f.head);
			expect(await f.git(f.parent, 'rev-parse', 'HEAD')).toBe(f.merged);
			expect(f.archive).toHaveLength(1);
			expect(f.journal).toHaveLength(1);
			expect(f.journal[0]).toMatchObject({ phase: 'settled', archive: f.archive[0] });
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
	it('drains discovery before the durable intent and Git, then settles watchers again', async () => {
		const f = await setup();
		let resume!: () => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		f.discovery.mockImplementationOnce(async () => {
			started();
			await new Promise<void>((resolve) => {
				resume = resolve;
			});
		});
		const removal = f.remove();
		await entered;
		expect(f.journal).toHaveLength(0);
		expect(adapter.beforeRemove).not.toHaveBeenCalled();
		expect(f.fence.state(f.root)).toBe('preparing');
		resume();
		expect(await removal).toEqual({ status: 'removed' });
		expect(f.discovery).toHaveBeenCalledOnce();
		expect(f.watchers).toHaveBeenCalledOnce();
	});
	it.each(['close failure', 'owner loss', 'new ignored data'])(
		'rechecks safety after draining discovery: %s',
		async (failure) => {
			const f = await setup();
			f.discovery.mockImplementationOnce(async () => {
				if (failure === 'close failure') throw new Error('watcher close failed');
				if (failure === 'owner loss') f.invalidate();
				if (failure === 'new ignored data') {
					mkdirSync(join(f.root, 'ignored'));
					writeFileSync(join(f.root, 'ignored', 'saved.txt'), 'keep');
				}
			});
			expect((await f.remove()).status).toBe('blocked');
			expect(adapter.beforeRemove).not.toHaveBeenCalled();
			expect(f.journal).toHaveLength(0);
			expect(existsSync(f.root)).toBe(true);
		}
	);

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

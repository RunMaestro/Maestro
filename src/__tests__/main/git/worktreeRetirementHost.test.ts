import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeRetirement } from '../../../main/git/worktreeRetirement';
import {
	WorktreeRetirementHost,
	type RetirementRenderer,
} from '../../../main/git/worktreeRetirementHost';
import type {
	RetirementRendererCommand,
	RetirementRendererReply,
} from '../../../shared/worktreeRetirement';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(process.cwd(), '.retirement-host-'));
	dirs.push(dir);
	const root = join(dir, 'child');
	const parent = join(dir, 'parent');
	mkdirSync(root);
	mkdirSync(parent);
	const fence = new WorktreeRetirement();
	const identity = {};
	const client = fence.admitClient('primary');
	if (!client.ok) throw new Error(client.reason);
	client.loaded(identity);
	const checkout = {
		path: root,
		head: 'a'.repeat(40),
		generation: 1,
		ownership: {
			sessionId: 'child',
			parentSessionId: 'parent',
			parentPath: parent,
			commonDir: join(parent, '.git'),
			gitDir: join(parent, '.git/worktrees/child'),
			branch: 'feature',
		},
	};
	fence.register(checkout);
	vi.spyOn(fence, 'prepareRegisteredForRenderer').mockImplementation(async (_id, sender) =>
		fence.prepareForRenderer(checkout, sender)
	);
	const revalidate = vi
		.spyOn(fence, 'revalidateRegistered')
		.mockImplementation(async (token) =>
			fence.tokenState(token) === 'preparing'
				? { ok: true }
				: { ok: false, reason: 'owner invalidated' }
		);
	let invalidated = () => {};
	let wire = '';
	const renderer: RetirementRenderer = {
		identity,
		request: vi.fn(async (command: RetirementRendererCommand): Promise<RetirementRendererReply> => {
			if (command.kind === 'prepare') {
				wire = command.request.token;
				return { ok: true, token: wire, revision: 7 };
			}
			return { ok: true, token: wire, revision: 7 };
		}),
		release: vi.fn(),
		onInvalidated: vi.fn((callback) => {
			invalidated = callback;
			return vi.fn();
		}),
	};
	const host = new WorktreeRetirementHost(fence, 1000);
	return {
		host,
		fence,
		root,
		parent,
		identity,
		renderer,
		client,
		revalidate,
		wire: () => wire,
		invalidate: () => {
			client.invalidate();
			invalidated();
		},
	};
}

describe('Main-owned renderer retirement protocol', () => {
	it('binds fresh opaque ids to Main objects, rechecks the revision and fences both checkouts', async () => {
		const f = setup();
		const result = await f.host.prepare('child', f.renderer);
		expect(result).toEqual({ ok: true, token: f.wire(), revision: 7 });
		expect(f.renderer.request).toHaveBeenCalledTimes(2);
		expect(f.revalidate).toHaveBeenCalledTimes(1);
		expect(f.fence.admit([f.root]).ok).toBe(false);
		expect(f.fence.admit([f.parent]).ok).toBe(false);
		expect((await f.host.validate(f.wire(), {})).ok).toBe(false);
		expect(f.host.abort(f.wire(), {})).toBe(false);
		expect(f.host.abort(f.wire(), f.identity)).toBe(true);
		expect(f.renderer.release).toHaveBeenCalledWith('child', f.wire());
		expect(f.fence.admit([f.root]).ok).toBe(true);
	});
	it('keeps an old wire id from aborting a later reservation', async () => {
		const f = setup();
		const first = await f.host.prepare('child', f.renderer);
		if (!first.ok) throw new Error(first.reason);
		expect(f.host.abort(first.token, f.identity)).toBe(true);
		const second = await f.host.prepare('child', f.renderer);
		if (!second.ok) throw new Error(second.reason);
		expect(second.token).not.toBe(first.token);
		expect(f.host.abort(first.token, f.identity)).toBe(false);
		expect(f.fence.state(f.root)).toBe('preparing');
		expect(f.host.abort(second.token, f.identity)).toBe(true);
	});
	it('refuses a renderer that is not the loaded primary', async () => {
		const f = setup();
		f.renderer.identity = {};
		expect(await f.host.prepare('child', f.renderer)).toMatchObject({ ok: false });
		expect(f.renderer.request).not.toHaveBeenCalled();
	});
	it.each(['token', 'revision', 'refusal', 'throw'])(
		'aborts a bad %s acknowledgement and releases the matching freeze',
		async (kind) => {
			const f = setup();
			vi.mocked(f.renderer.request).mockImplementationOnce(async (command) => {
				if (command.kind !== 'prepare') throw new Error('unexpected');
				if (kind === 'throw') throw new Error('transport gone');
				if (kind === 'refusal') return { ok: false, reason: 'editor open' };
				return {
					ok: true,
					token: kind === 'token' ? 'forged' : command.request.token,
					revision: kind === 'revision' ? NaN : 7,
				};
			});
			expect(await f.host.prepare('child', f.renderer)).toMatchObject({ ok: false });
			expect(f.fence.state(f.root)).toBe('available');
			expect(f.renderer.release).toHaveBeenCalledOnce();
		}
	);
	it('rejects a stale revision on the second round trip', async () => {
		const f = setup();
		vi.mocked(f.renderer.request).mockImplementation(async (command) => ({
			ok: true,
			token: command.kind === 'prepare' ? command.request.token : 'stale',
			revision: 7,
		}));
		expect(await f.host.prepare('child', f.renderer)).toMatchObject({ ok: false });
		expect(f.revalidate).not.toHaveBeenCalled();
		expect(f.fence.state(f.root)).toBe('available');
	});
	it('expires a pending prepare once and rejects its late positive reply', async () => {
		const f = setup();
		let answer!: (reply: RetirementRendererReply) => void;
		let token = '';
		vi.mocked(f.renderer.request).mockImplementationOnce((command) => {
			if (command.kind === 'prepare') token = command.request.token;
			return new Promise((resolve) => {
				answer = resolve;
			});
		});
		const pending = f.host.prepare('child', f.renderer);
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.fence.state(f.root)).toBe('available');
		answer({ ok: true, token, revision: 7 });
		expect(await pending).toMatchObject({ ok: false });
		expect(f.renderer.release).toHaveBeenCalledOnce();
	});
	it('owner loss wins while final trusted revalidation is awaiting', async () => {
		const f = setup();
		let finish!: () => void;
		f.revalidate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ ok: true });
				})
		);
		const pending = f.host.prepare('child', f.renderer);
		await vi.advanceTimersByTimeAsync(0);
		f.invalidate();
		finish();
		expect(await pending).toMatchObject({ ok: false });
		expect(f.renderer.release).toHaveBeenCalledOnce();
	});
	it('expiration during the renderer revision check cannot validate a late acknowledgement', async () => {
		const f = setup();
		let answer!: (reply: RetirementRendererReply) => void;
		let wire = '';
		vi.mocked(f.renderer.request)
			.mockImplementationOnce(async (command) => ({
				ok: true,
				token: command.kind === 'prepare' ? command.request.token : '',
				revision: 7,
			}))
			.mockImplementationOnce(
				(command) =>
					new Promise((resolve) => {
						if (command.kind !== 'check') throw new Error('expected revision check');
						wire = command.token;
						answer = resolve;
					})
			);
		const pending = f.host.prepare('child', f.renderer);
		await vi.advanceTimersByTimeAsync(1000);
		answer({ ok: true, token: wire, revision: 7 });
		expect(await pending).toMatchObject({ ok: false });
		expect(f.fence.state(f.root)).toBe('available');
		expect(f.renderer.release).toHaveBeenCalledOnce();
	});
	it('timeout, abort and owner loss cannot thaw removing', async () => {
		const f = setup();
		await f.host.prepare('child', f.renderer);
		const verified = await f.host.validate(f.wire(), f.identity);
		if (!verified.ok) throw new Error(verified.reason);
		expect(f.fence.commit(verified.token)).toBe(true);
		f.invalidate();
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.host.abort(f.wire(), f.identity)).toBe(false);
		expect(f.fence.state(f.root)).toBe('removing');
		expect(f.renderer.release).not.toHaveBeenCalled();
		expect(f.fence.admit([f.parent]).ok).toBe(false);
	});
	it('rejects changed trusted registration after the renderer has prepared', async () => {
		const f = setup();
		f.revalidate.mockResolvedValueOnce({ ok: false, reason: 'registration changed' });
		expect(await f.host.prepare('child', f.renderer)).toMatchObject({
			ok: false,
			reason: 'registration changed',
		});
		expect(f.renderer.release).toHaveBeenCalledOnce();
	});
});

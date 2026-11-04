import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('crypto', async (original) => {
	const actual = await original<typeof import('crypto')>();
	return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));

describe('standalone permission relay registry mutation activity', () => {
	const target = path.resolve('permission-registry-target');
	const decision = { behavior: 'allow' as const, updatedInput: { command: 'example' } };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let registry: typeof import('../../../main/permission-relay/registry');
	let releases: Array<() => void>;
	let cleanups: Array<() => void>;
	let subscriptions: Array<() => void>;
	let active: number;
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reserve(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	const busy = async () =>
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	function register(sessionId = 'agent-ai') {
		const binding = registry.registerSpawn({ sessionId, tabId: 'tab' });
		cleanups.push(binding.cleanup);
		return binding;
	}
	function listen(callback: Parameters<typeof registry.subscribePendingPermissions>[0]) {
		const off = registry.subscribePendingPermissions(callback);
		subscriptions.push(off);
		return off;
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		releases = [];
		cleanups = [];
		subscriptions = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			return () => {
				active--;
				release();
			};
		});
		registry = await import('../../../main/permission-relay/registry');
	});
	afterEach(() => {
		for (const release of releases) release();
		for (const off of subscriptions) off();
		for (const cleanup of cleanups) cleanup();
		expect(registry.relayRegistryStats()).toEqual({ bindings: 0, pending: 0 });
		expect(active).toBe(0);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses registration before token generation under %s',
		async (root) => {
			await idle(root);
			expect(() => register()).toThrow(/reserved/);
			expect(randomBytes).not.toHaveBeenCalled();
			expect(registry.relayRegistryStats()).toEqual({ bindings: 0, pending: 0 });
		}
	);

	it.each(['cleanup', 'resolve', 'unknown response'])(
		'refuses %s before pending changes or timer cancellation and permits retry',
		async (operation) => {
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			const snapshot = registry.getPendingPermissionSnapshot();
			const hold = await idle();
			const cancel = vi.spyOn(globalThis, 'clearTimeout');
			expect(() =>
				operation === 'cleanup'
					? binding.cleanup()
					: registry.resolvePending(operation === 'resolve' ? 'request' : 'unknown', decision)
			).toThrow(/reserved/);
			expect(cancel).not.toHaveBeenCalled();
			expect(registry.lookupBinding(binding.token)).toEqual({
				sessionId: 'agent-ai',
				tabId: 'tab',
			});
			expect(registry.getPendingPermissionSnapshot()).toEqual(snapshot);
			expect(registry.relayRegistryStats()).toEqual({ bindings: 1, pending: 1 });
			hold.release();
			expect(registry.resolvePending('request', decision)).toBe(true);
			await expect(pending).resolves.toBe(decision);
		}
	);

	it('admits token generation and nested registration synchronously', async () => {
		const actual = await vi.importActual<typeof import('crypto')>('crypto');
		vi.mocked(randomBytes).mockImplementationOnce(() => {
			expect(active).toBe(1);
			register('nested-agent');
			expect(active).toBe(1);
			return actual.randomBytes(32);
		});
		const binding = register();
		expect(registry.lookupBinding(binding.token)?.sessionId).toBe('agent-ai');
		expect(registry.relayRegistryStats().bindings).toBe(2);
		await idle();
	});

	it('releases registration on token failure with the identical error', async () => {
		const error = new Error('entropy unavailable');
		vi.mocked(randomBytes).mockImplementationOnce(() => {
			expect(active).toBe(1);
			throw error;
		});
		try {
			register();
			expect.unreachable('Expected token generation to fail');
		} catch (failure) {
			expect(failure).toBe(error);
		}
		expect(registry.relayRegistryStats().bindings).toBe(0);
		await idle();
	});

	it('holds timer cancellation and status delivery while preserving the exact decision', async () => {
		const binding = register();
		const pending = registry.createPending('request', binding.token);
		const version = registry.getPendingPermissionSnapshot().version;
		const clear = globalThis.clearTimeout;
		vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce((timer) => {
			expect(active).toBe(1);
			clear(timer);
		});
		const callback = vi.fn((snapshot) => {
			expect(active).toBe(1);
			expect(snapshot).toEqual({ version: version + 1, processIds: [] });
		});
		listen(callback);
		expect(registry.resolvePending('request', decision)).toBe(true);
		await expect(pending).resolves.toBe(decision);
		expect(callback).toHaveBeenCalledOnce();
		expect(registry.resolvePending('request', decision)).toBe(false);
		await idle();
	});

	it('holds cleanup notifications, denies matching requests and preserves another spawn', async () => {
		const a = register();
		const b = register('other-agent');
		const decisions = ['one', 'two'].map((id) => registry.createPending(id, a.token));
		const other = registry.createPending('other', b.token);
		const off = listen((snapshot) => {
			expect(active).toBe(1);
			expect(snapshot.processIds).toEqual(['other-agent']);
		});
		expect(a.cleanup()).toBeUndefined();
		off();
		for (const pending of decisions)
			await expect(pending).resolves.toEqual({
				behavior: 'deny',
				message: 'Agent process exited.',
			});
		expect(registry.lookupBinding(a.token)).toBeUndefined();
		expect(registry.lookupBinding(b.token)?.sessionId).toBe('other-agent');
		expect(registry.resolvePending('other', decision)).toBe(true);
		await expect(other).resolves.toBe(decision);
		await idle();
	});

	it.each(['cleanup', 'resolve'])(
		'keeps reentrant %s callbacks admitted while a new decision is settled',
		async (operation) => {
			const a = register();
			const b = register('other-agent');
			const pending = registry.createPending('request', a.token);
			const other = registry.createPending('other', b.token);
			const off = listen(() => {
				off();
				expect(active).toBe(1);
				const inner = listen(() => expect(active).toBe(2));
				expect(registry.resolvePending('other', decision)).toBe(true);
				inner();
				register('new-agent');
				expect(active).toBe(1);
			});
			if (operation === 'cleanup') a.cleanup();
			else expect(registry.resolvePending('request', decision)).toBe(true);
			await pending;
			await expect(other).resolves.toBe(decision);
			await idle();
		}
	);

	it.each(['cleanup', 'resolve'])(
		'releases %s on listener failure without replacing its synchronous error',
		async (operation) => {
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			const error = new Error('status listener failed');
			listen(() => {
				expect(active).toBe(1);
				throw error;
			});
			try {
				if (operation === 'cleanup') binding.cleanup();
				else registry.resolvePending('request', decision);
				expect.unreachable('Expected listener to fail');
			} catch (failure) {
				expect(failure).toBe(error);
			}
			expect(registry.relayRegistryStats().pending).toBe(0);
			// Existing resolution order: cleanup resolves before notification; a
			// throwing response listener leaves its removed request unresolved.
			if (operation === 'cleanup')
				await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
			await idle();
		}
	);

	it.each(['cleanup', 'resolve'])(
		'releases %s after timer-cancellation failure and allows the pending request to be retried',
		async (operation) => {
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			const error = new Error('timer cancellation failed');
			vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
				expect(active).toBe(1);
				throw error;
			});
			try {
				if (operation === 'cleanup') binding.cleanup();
				else registry.resolvePending('request', decision);
				expect.unreachable('Expected timer cancellation to fail');
			} catch (failure) {
				expect(failure).toBe(error);
			}
			expect(registry.relayRegistryStats().pending).toBe(1);
			const hold = await idle();
			hold.release();
			expect(registry.resolvePending('request', decision)).toBe(true);
			await expect(pending).resolves.toBe(decision);
		}
	);

	it('refuses repeated no-op cleanup under a reservation', async () => {
		const binding = register();
		binding.cleanup();
		const hold = await idle();
		expect(binding.cleanup).toThrow(/reserved/);
		hold.release();
		expect(binding.cleanup()).toBeUndefined();
		expect(registry.resolvePending('unknown', decision)).toBe(false);
	});

	it.each(['cleanup', 'resolve'])(
		'keeps %s settlement and independently observed native close separate',
		async (operation) => {
			const child = new EventEmitter();
			child.on('error', () => {});
			vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			withWorktreeTurnActivity(
				(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
				() => {}
			);
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			if (operation === 'cleanup') binding.cleanup();
			else registry.resolvePending('request', decision);
			await pending;
			child.emit('error', new Error('native failure before close'));
			child.emit('exit', 0);
			await busy();
			child.emit('close', 0);
			await idle();
		}
	);

	it.each(['cleanup', 'resolve'])(
		'holds %s notification through reentrant native close',
		async (operation) => {
			const child = new EventEmitter();
			vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
			const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
			withWorktreeTurnActivity(
				(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
				() => {}
			);
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			listen(() => {
				expect(active).toBe(2);
				child.emit('close', 0);
				expect(active).toBe(1);
			});
			if (operation === 'cleanup') binding.cleanup();
			else registry.resolvePending('request', decision);
			await pending;
			await idle();
		}
	);
});

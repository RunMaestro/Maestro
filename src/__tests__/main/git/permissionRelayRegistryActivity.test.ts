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
	let retained: number;
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
		retained = 0;
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
		expect(active).toBe(retained);
		vi.restoreAllMocks();
		vi.useRealTimers();
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
		'refuses %s before registry changes or timer cancellation and permits retry',
		async (operation) => {
			const binding = register();
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
			expect(registry.relayRegistryStats()).toEqual({ bindings: 1, pending: 0 });
			hold.release();
			const pending = registry.createPending('request', binding.token);
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
			expect(active).toBeGreaterThan(0);
			clear(timer);
		});
		const callback = vi.fn((snapshot) => {
			expect(active).toBeGreaterThan(0);
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
			expect(active).toBeGreaterThan(0);
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
				expect(active).toBeGreaterThan(0);
				const inner = listen(() => expect(active).toBeGreaterThan(1));
				expect(registry.resolvePending('other', decision)).toBe(true);
				inner();
				register('new-agent');
				expect(active).toBeGreaterThan(0);
			});
			if (operation === 'cleanup') a.cleanup();
			else expect(registry.resolvePending('request', decision)).toBe(true);
			await pending;
			await expect(other).resolves.toBe(decision);
			await idle();
		}
	);

	it.each(['cleanup', 'resolve'])(
		'preserves %s listener errors and retains unresolved decision work',
		async (operation) => {
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			const error = new Error('status listener failed');
			listen(() => {
				expect(active).toBeGreaterThan(0);
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
			if (operation === 'cleanup') {
				await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
				await idle();
			} else {
				retained = 1;
				await busy();
			}
		}
	);

	it.each(['cleanup', 'resolve'])(
		'releases %s after timer-cancellation failure and allows the pending request to be retried',
		async (operation) => {
			const binding = register();
			const pending = registry.createPending('request', binding.token);
			const error = new Error('timer cancellation failed');
			vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
				expect(active).toBeGreaterThan(0);
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
			await busy();
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
				expect(active).toBe(operation === 'cleanup' ? 2 : 3);
				child.emit('close', 0);
				expect(active).toBe(operation === 'cleanup' ? 1 : 2);
			});
			if (operation === 'cleanup') binding.cleanup();
			else registry.resolvePending('request', decision);
			await pending;
			await idle();
		}
	);
	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses pending setup before timer creation or notification under %s',
		async (root) => {
			const binding = register();
			const notify = vi.fn();
			listen(notify);
			const snapshot = registry.getPendingPermissionSnapshot();
			const hold = await idle(root);
			const schedule = vi.spyOn(globalThis, 'setTimeout');
			expect(() => registry.createPending('request', binding.token)).toThrow(/reserved/);
			expect(schedule).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(registry.getPendingPermissionSnapshot()).toEqual(snapshot);
			expect(registry.relayRegistryStats()).toEqual({ bindings: 1, pending: 0 });
			hold.release();
			const pending = registry.createPending('request', binding.token);
			expect(registry.resolvePending('request', decision)).toBe(true);
			await expect(pending).resolves.toBe(decision);
		}
	);

	it('admits pending setup while reservation canonicalization is still pending', async () => {
		const binding = register();
		let canonicalize!: (root: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() => new Promise<string>((resolve) => (canonicalize = resolve))
		);
		const reservation = reserve();
		const listener = vi.fn(() => expect(active).toBe(1));
		const off = listen(listener);
		const pending = registry.createPending('request', binding.token);
		expect(listener).toHaveBeenCalledOnce();
		off();
		canonicalize(target);
		expect(await reservation).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		registry.resolvePending('request', decision);
		await pending;
	});

	it('holds timer setup, unref and reentrant decision delivery through synchronous completion', async () => {
		const binding = register();
		const schedule = globalThis.setTimeout;
		const unref = vi.fn();
		vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback, delay) => {
			expect(active).toBe(1);
			const timer = schedule(callback, delay);
			const original = timer.unref.bind(timer);
			vi.spyOn(timer, 'unref').mockImplementation(() => {
				expect(active).toBe(1);
				unref();
				return original();
			});
			return timer;
		});
		const version = registry.getPendingPermissionSnapshot().version;
		const off = listen((snapshot) => {
			expect(active).toBe(1);
			expect(snapshot).toEqual({ version: version + 1, processIds: ['agent-ai'] });
			off();
			const nested = listen(() => expect(active).toBe(2));
			expect(registry.resolvePending('request', decision)).toBe(true);
			nested();
			expect(active).toBe(1);
		});
		const pending = registry.createPending('request', binding.token, 1234);
		expect(unref).toHaveBeenCalledOnce();
		expect(globalThis.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1234);
		await expect(pending).resolves.toBe(decision);
		await idle();
	});

	it.each(['timer', 'unref', 'notification'])(
		'retains unobserved timer work on %s setup failure with unchanged rejection and residue',
		async (stage) => {
			vi.useFakeTimers();
			const binding = register();
			const error = new Error(`${stage} failed`);
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (stage === 'notification')
				listen(() => {
					expect(active).toBe(1);
					throw error;
				});
			else {
				const schedule = globalThis.setTimeout;
				vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback, delay) => {
					expect(active).toBe(1);
					if (stage === 'timer') throw error;
					timer = schedule(callback, delay);
					vi.spyOn(timer, 'unref').mockImplementationOnce(() => {
						expect(active).toBe(1);
						throw error;
					});
					return timer;
				});
			}
			let pending!: ReturnType<typeof registry.createPending>;
			expect(() => (pending = registry.createPending('request', binding.token))).not.toThrow();
			await expect(pending).rejects.toBe(error);
			await busy();
			expect(registry.relayRegistryStats().pending).toBe(stage === 'notification' ? 1 : 0);
			for (const off of subscriptions) off();
			binding.cleanup();
			if (stage === 'timer') {
				retained = 1;
				await busy();
			} else {
				vi.runOnlyPendingTimers();
				await idle();
			}
		}
	);

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses subscribe and repeated unsubscribe before changing listeners under %s',
		async (root) => {
			const binding = register();
			const oldListener = vi.fn();
			const off = listen(oldListener);
			const newListener = vi.fn();
			const hold = await idle(root);
			expect(() => listen(newListener)).toThrow(/reserved/);
			expect(off).toThrow(/reserved/);
			hold.release();
			const pending = registry.createPending('request', binding.token);
			expect(oldListener).toHaveBeenCalledOnce();
			expect(newListener).not.toHaveBeenCalled();
			off();
			const stop = listen(newListener);
			registry.resolvePending('request', decision);
			await pending;
			expect(oldListener).toHaveBeenCalledOnce();
			expect(newListener).toHaveBeenCalledOnce();
			stop();
			await idle(root);
			expect(off).toThrow(/reserved/);
		}
	);

	it.each(['subscribe', 'unsubscribe'])(
		'holds %s Set mutation and releases on the identical synchronous error',
		async (operation) => {
			const listener = vi.fn();
			const off = operation === 'unsubscribe' ? listen(listener) : undefined;
			const method = operation === 'subscribe' ? 'add' : 'delete';
			const original = Set.prototype[method];
			const error = new Error('listener set failed');
			const mutate = vi.spyOn(Set.prototype, method).mockImplementation(function (
				this: Set<unknown>,
				value
			) {
				if (value === listener) {
					expect(active).toBe(1);
					throw error;
				}
				return Reflect.apply(original, this, [value]);
			});
			try {
				expect(() => (off ? off() : listen(listener))).toThrow(error);
			} finally {
				mutate.mockRestore();
			}
			expect(active).toBe(0);
			if (off) off();
			await idle();
		}
	);

	it('keeps pending creation admitted through reentrant native close', async () => {
		const child = new EventEmitter();
		vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
		const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
		withWorktreeTurnActivity(
			(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
			() => {}
		);
		const binding = register();
		const off = listen(() => {
			expect(active).toBe(2);
			child.emit('close', 0);
			expect(active).toBe(1);
		});
		const pending = registry.createPending('request', binding.token);
		off();
		await busy();
		registry.resolvePending('request', decision);
		await pending;
	});
	it.each(['resolve', 'cleanup', 'expiry'])(
		'keeps standalone pending activity through %s after setup returns',
		async (completion) => {
			vi.useFakeTimers();
			const binding = register();
			const pending = registry.createPending('lifetime', binding.token, 20);
			for (const root of [target, path.join(target, 'child'), path.resolve('elsewhere')])
				expect(await reserve(root)).toMatchObject({
					status: 'blocked',
					blockers: [{ code: 'mutation-busy' }],
				});
			if (completion === 'resolve') registry.resolvePending('lifetime', decision);
			else if (completion === 'cleanup') binding.cleanup();
			else vi.advanceTimersByTime(20);
			await expect(pending).resolves.toMatchObject({
				behavior: completion === 'resolve' ? 'allow' : 'deny',
			});
			expect(vi.getTimerCount()).toBe(0);
			await idle();
		}
	);

	it('retains independent timers and decisions across concurrent expiry', async () => {
		vi.useFakeTimers();
		const binding = register();
		const first = registry.createPending('first', binding.token, 10);
		const second = registry.createPending('second', binding.token, 30);
		vi.advanceTimersByTime(10);
		await expect(first).resolves.toMatchObject({ behavior: 'deny' });
		await busy();
		expect(registry.relayRegistryStats().pending).toBe(1);
		vi.advanceTimersByTime(20);
		await expect(second).resolves.toMatchObject({ behavior: 'deny' });
		await idle();
	});

	it.each(['older timeout', 'newer resolution'])(
		'keeps overwritten request timers independently busy after %s',
		async (firstCompletion) => {
			vi.useFakeTimers();
			const binding = register();
			const older = registry.createPending('duplicate', binding.token, 10);
			const newer = registry.createPending('duplicate', binding.token, 30);
			if (firstCompletion === 'older timeout') {
				vi.advanceTimersByTime(10);
				await expect(older).resolves.toMatchObject({ behavior: 'deny' });
				// Preserve existing duplicate-ID behavior: older expiry removes
				// the replacement entry but cannot complete its independent timer.
				expect(registry.resolvePending('duplicate', decision)).toBe(false);
				await busy();
				vi.advanceTimersByTime(20);
				await expect(newer).resolves.toMatchObject({ behavior: 'deny' });
			} else {
				registry.resolvePending('duplicate', decision);
				await expect(newer).resolves.toBe(decision);
				await busy();
				vi.advanceTimersByTime(10);
				await expect(older).resolves.toMatchObject({ behavior: 'deny' });
			}
			await idle();
		}
	);

	it('covers expiry notification and a new reentrant request independently', async () => {
		vi.useFakeTimers();
		const binding = register();
		const pending = registry.createPending('expires', binding.token, 10);
		let next!: ReturnType<typeof registry.createPending>;
		const off = listen((snapshot) => {
			expect(active).toBeGreaterThan(0);
			expect(snapshot.processIds).toEqual([]);
			off();
			next = registry.createPending('next', binding.token, 30);
		});
		vi.advanceTimersByTime(10);
		await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
		await busy();
		registry.resolvePending('next', decision);
		await expect(next).resolves.toBe(decision);
		await idle();
	});

	it('retains an unresolved decision after its expiry listener throws', async () => {
		vi.useFakeTimers();
		const binding = register();
		const pending = registry.createPending('expires', binding.token, 10);
		const error = new Error('expiry notification');
		listen(() => {
			expect(active).toBe(1);
			throw error;
		});
		expect(() => vi.advanceTimersByTime(10)).toThrow(error);
		expect(vi.getTimerCount()).toBe(0);
		expect(registry.relayRegistryStats().pending).toBe(0);
		const settled = vi.fn();
		void pending.then(settled, settled);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		retained = 1;
		await busy();
	});

	it('retains a rejected insertion until its already-created timer actually expires', async () => {
		vi.useFakeTimers();
		const binding = register();
		const error = new Error('pending insertion');
		const set = Map.prototype.set;
		const insert = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
			this: Map<unknown, unknown>,
			key,
			value
		) {
			if (key === 'insertion') throw error;
			return set.call(this, key, value);
		});
		const pending = registry.createPending('insertion', binding.token, 10);
		insert.mockRestore();
		await expect(pending).rejects.toBe(error);
		await busy();
		vi.advanceTimersByTime(10);
		await idle();
	});

	it('keeps expiry admitted through reentrant cleanup and independent native close', async () => {
		vi.useFakeTimers();
		const child = new EventEmitter();
		vi.mocked(spawn).mockReturnValueOnce(child as ReturnType<typeof spawn>);
		const { withWorktreeTurnActivity } = await import('../../../main/git/worktreeTurnActivity');
		withWorktreeTurnActivity(
			(_start, _observe, spawnChild) => spawnChild('agent', [], {}),
			() => {}
		);
		const binding = register();
		const pending = registry.createPending('expires', binding.token, 10);
		listen(() => {
			expect(active).toBe(2);
			binding.cleanup();
			child.emit('close', 0);
			expect(active).toBe(1);
		});
		vi.advanceTimersByTime(10);
		await expect(pending).resolves.toEqual({
			behavior: 'deny',
			message: 'Permission request timed out with no response.',
		});
		await idle();
	});
});

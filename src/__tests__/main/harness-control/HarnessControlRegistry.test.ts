import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	beginGlobalWorktreeActivity,
	reserveWorktreeCleanup,
} from '../../../main/git/worktreeActivity';
import { HarnessControlRegistry } from '../../../main/harness-control/HarnessControlRegistry';
import type {
	HarnessControlCapabilities,
	HarnessControlHandle,
} from '../../../shared/harness-control/types';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));

const capabilities: HarnessControlCapabilities = {
	protocol: 'acp',
	protocolVersion: '1',
	steering: 'in-turn',
	permissionRequests: true,
	questions: false,
	elicitations: false,
	modelSwitch: false,
	modeSwitch: false,
	imagePrompts: false,
	resume: false,
};

function handleFixture(): HarnessControlHandle {
	return {
		getCapabilities: () => capabilities,
		steer: vi.fn(async ({ id, text }) => ({
			type: 'steering' as const,
			id,
			verdict: 'delivered' as const,
			detail: text,
		})),
		interrupt: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

describe('HarnessControlRegistry', () => {
	it('refuses steering when no running handle exists', async () => {
		const registry = new HarnessControlRegistry();
		await expect(registry.steer('missing', 'hello')).resolves.toMatchObject({
			verdict: 'refused',
			refusal: 'not-running',
		});
	});

	it('delegates control and exposes negotiated capabilities', async () => {
		const registry = new HarnessControlRegistry();
		const handle = handleFixture();
		registry.register('session-a', 1, handle);
		expect(registry.getCapabilities('session-a')).toEqual(capabilities);
		await expect(registry.steer('session-a', 'change course')).resolves.toMatchObject({
			verdict: 'delivered',
			detail: 'change course',
		});
		await expect(registry.interrupt('session-a')).resolves.toBe(true);
		expect(handle.interrupt).toHaveBeenCalledOnce();
	});

	it('closes a replaced handle and ignores stale cleanup', async () => {
		const registry = new HarnessControlRegistry();
		const oldHandle = handleFixture();
		const newHandle = handleFixture();
		registry.register('session-a', 1, oldHandle);
		registry.register('session-a', 2, newHandle);
		expect(oldHandle.close).toHaveBeenCalledOnce();
		expect(registry.unregister('session-a', oldHandle)).toBe(false);
		expect(registry.getCapabilities('session-a')).toEqual(capabilities);
		expect(registry.unregister('session-a', newHandle)).toBe(true);
		expect(registry.getCapabilities('session-a')).toBeNull();
	});
});

describe('HarnessControlRegistry activity', () => {
	const target = path.resolve('harness-cleanup-target');
	let registry: HarnessControlRegistry;
	let releases: Array<() => void>;

	async function reserve(root = target) {
		const result = await reserveWorktreeCleanup(root);
		if (result.status === 'reserved-partially') releases.push(result.release);
		return result;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		registry = new HarnessControlRegistry();
		releases = [];
	});

	afterEach(() => {
		for (const release of releases) release();
		vi.restoreAllMocks();
	});

	it.each(['register', 'unregister', 'forget', 'getCapabilities', 'steer', 'interrupt', 'close'])(
		'refuses %s before registry lookup, adapter access or recovery',
		async (method) => {
			const handle = handleFixture();
			registry.register('session-a', 1, handle);
			const entries = Reflect.get(registry, 'handles') as Map<string, unknown>;
			const get = vi.spyOn(entries, 'get');
			const set = vi.spyOn(entries, 'set');
			const remove = vi.spyOn(entries, 'delete');
			expect((await reserve()).status).toBe('reserved-partially');
			const run = () => {
				switch (method) {
					case 'register':
						return registry.register('session-a', 2, handleFixture());
					case 'unregister':
						return registry.unregister('session-a', handle);
					case 'forget':
						return registry.forget('session-a');
					case 'getCapabilities':
						return registry.getCapabilities('session-a');
					case 'steer':
						return registry.steer('session-a', 'text');
					case 'interrupt':
						return registry.interrupt('session-a');
					default:
						return registry.close('session-a');
				}
			};
			if (['steer', 'interrupt', 'close'].includes(method))
				await expect(run()).rejects.toThrow(/cleanup has reserved/);
			else expect(run).toThrow(/cleanup has reserved/);
			expect(get).not.toHaveBeenCalled();
			expect(set).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(handle.close).not.toHaveBeenCalled();
			expect(handle.interrupt).not.toHaveBeenCalled();
			expect(handle.steer).not.toHaveBeenCalled();
			expect(registry.has('session-a')).toBe(true);
		}
	);

	it.each([target, path.join(target, 'nested'), path.resolve('unrelated-harness-target')])(
		'conservatively refuses direct controls under a reservation at %s',
		async (root) => {
			expect((await reserve(root)).status).toBe('reserved-partially');
			await expect(registry.close('missing')).rejects.toThrow(/cleanup has reserved/);
		}
	);

	it.each(['steer', 'interrupt', 'close'] as const)(
		'retains pending %s across registry removal and replacement',
		async (method) => {
			const pending = Promise.withResolvers<void>();
			const handle = handleFixture();
			handle.steer = vi.fn<HarnessControlHandle['steer']>(async ({ id }) => {
				await pending.promise;
				return { type: 'steering', id, verdict: 'delivered' };
			});
			handle.interrupt = vi.fn(() => pending.promise);
			handle.close = vi.fn(() => pending.promise);
			registry.register('session-a', 1, handle);
			const result =
				method === 'steer' ? registry.steer('session-a', 'text') : registry[method]('session-a');
			registry.forget('session-a');
			const replacement = handleFixture();
			registry.register('session-a', 2, replacement);
			expect(await reserve()).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'mutation-busy' }],
			});
			pending.resolve();
			await result;
			expect(registry.getCapabilities('session-a')).toEqual(capabilities);
			expect(replacement.close).not.toHaveBeenCalled();
			expect((await reserve()).status).toBe('reserved-partially');
		}
	);

	it.each(['steer', 'interrupt', 'close'] as const)(
		'preserves %s failure verdicts and releases after rejected adapter work',
		async (method) => {
			const pending = Promise.withResolvers<never>();
			const handle = handleFixture();
			handle.steer = vi.fn(() => pending.promise);
			handle.interrupt = vi.fn(() => pending.promise);
			handle.close = vi.fn(() => pending.promise);
			registry.register('session-a', 1, handle);
			const result =
				method === 'steer' ? registry.steer('session-a', 'text') : registry[method]('session-a');
			expect((await reserve()).status).toBe('blocked');
			pending.reject(new Error('adapter failed'));
			if (method === 'steer')
				await expect(result).resolves.toMatchObject({
					verdict: 'unknown',
					detail: 'adapter failed',
				});
			else await expect(result).resolves.toBe(false);
			expect((await reserve()).status).toBe('reserved-partially');
		}
	);

	it.each(['resolve', 'reject'] as const)(
		'retains replacement close through unregister/forget until %s',
		async (outcome) => {
			const pending = Promise.withResolvers<void>();
			const oldHandle = handleFixture();
			oldHandle.close = vi.fn(() => pending.promise);
			const replacement = handleFixture();
			registry.register('session-a', 1, oldHandle);
			expect(registry.register('session-a', 2, replacement)).toBeUndefined();
			expect(registry.unregister('session-a', oldHandle)).toBe(false);
			expect(registry.unregister('session-a', replacement)).toBe(true);
			registry.forget('session-a');
			expect((await reserve()).status).toBe('blocked');
			if (outcome === 'resolve') pending.resolve();
			else pending.reject(new Error('close failed'));
			await pending.promise.catch(() => {});
			await Promise.resolve();
			expect((await reserve()).status).toBe('reserved-partially');
		}
	);

	it('keeps independently pending replacement generations until both settle', async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const a = handleFixture();
		const b = handleFixture();
		a.close = vi.fn(() => first.promise);
		b.close = vi.fn(() => second.promise);
		registry.register('session-a', 1, a);
		registry.register('session-a', 2, b);
		registry.register('session-a', 3, handleFixture());
		second.resolve();
		await second.promise;
		expect((await reserve()).status).toBe('blocked');
		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect((await reserve()).status).toBe('reserved-partially');
	});

	it('preserves a synchronous replacement failure and the authoritative new handle', async () => {
		const oldHandle = handleFixture();
		oldHandle.close = vi.fn(() => {
			throw new Error('synchronous close failed');
		});
		registry.register('session-a', 1, oldHandle);
		const replacement = handleFixture();
		expect(() => registry.register('session-a', 2, replacement)).toThrow(
			'synchronous close failed'
		);
		expect(registry.unregister('session-a', oldHandle)).toBe(false);
		expect(registry.unregister('session-a', replacement)).toBe(true);
		expect((await reserve()).status).toBe('reserved-partially');
	});

	it.each(['steer', 'interrupt', 'close'] as const)(
		'preserves synchronous %s adapter failures without leaking activity',
		async (method) => {
			const handle = handleFixture();
			const fail = () => {
				throw new Error('synchronous adapter failure');
			};
			handle.steer = vi.fn(fail);
			handle.interrupt = vi.fn(fail);
			handle.close = vi.fn(fail);
			registry.register('session-a', 1, handle);
			if (method === 'steer')
				await expect(registry.steer('session-a', 'text')).resolves.toMatchObject({
					verdict: 'unknown',
				});
			else await expect(registry[method]('session-a')).resolves.toBe(false);
			expect((await reserve()).status).toBe('reserved-partially');
		}
	);

	it('forwards close options synchronously after forgetting only the selected registration', async () => {
		const pending = Promise.withResolvers<void>();
		const handle = handleFixture();
		const options = { sync: true, shutdown: true };
		handle.close = vi.fn((received) => {
			expect(received).toBe(options);
			expect(registry.has('session-a')).toBe(false);
			return pending.promise;
		});
		registry.register('session-a', 1, handle);
		const result = registry.close('session-a', options);
		expect(handle.close).toHaveBeenCalledOnce();
		expect((await reserve()).status).toBe('blocked');
		pending.resolve();
		await expect(result).resolves.toBe(true);
		expect((await reserve()).status).toBe('reserved-partially');
	});

	it('retains independent producer activity after controls settle and registration disappears', async () => {
		const releaseNative = beginGlobalWorktreeActivity();
		releases.push(releaseNative);
		registry.register('session-a', 1, handleFixture());
		await registry.close('session-a');
		expect(registry.has('session-a')).toBe(false);
		expect((await reserve()).status).toBe('blocked');
		releaseNative();
		expect((await reserve()).status).toBe('reserved-partially');
	});

	it('blocks a reservation whose canonicalization overlaps a new replacement', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = reserve();
		const pending = Promise.withResolvers<void>();
		const oldHandle = handleFixture();
		oldHandle.close = vi.fn(() => pending.promise);
		registry.register('session-a', 1, oldHandle);
		registry.register('session-a', 2, handleFixture());
		canonical.resolve(target);
		expect((await reservation).status).toBe('blocked');
		pending.resolve();
		await pending.promise;
		await Promise.resolve();
		expect((await reserve()).status).toBe('reserved-partially');
	});

	it('preserves capability failure and missing-control verdicts without leaking activity', async () => {
		const handle = handleFixture();
		handle.getCapabilities = () => {
			throw new Error('capabilities failed');
		};
		registry.register('session-a', 1, handle);
		expect(registry.getCapabilities('session-a')).toBeNull();
		registry.register('session-a', 2, handle);
		expect(handle.close).not.toHaveBeenCalled();
		registry.forget('session-a');
		await expect(registry.interrupt('session-a')).resolves.toBe(false);
		await expect(registry.close('session-a')).resolves.toBe(false);
		await expect(registry.steer('session-a', 'text')).resolves.toMatchObject({
			refusal: 'not-running',
		});
		expect(registry.unregister('session-a', handle)).toBe(false);
		expect(registry.getCapabilities('session-a')).toBeNull();
		expect((await reserve()).status).toBe('reserved-partially');
	});
});

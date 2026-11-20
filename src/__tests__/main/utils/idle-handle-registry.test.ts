import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdleHandleRegistry } from '../../../main/utils/idle-handle-registry';

const IDLE_MS = 1000;

describe('createIdleHandleRegistry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeRegistry() {
		const released: string[] = [];
		const registry = createIdleHandleRegistry<{ name: string }>({
			idleMs: IDLE_MS,
			release: (value) => {
				released.push(value.name);
			},
		});
		return { registry, released };
	}

	it('returns what was added and reports its size', () => {
		const { registry } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		expect(registry.get('a')).toEqual({ name: 'alpha' });
		expect(registry.get('missing')).toBeUndefined();
		expect(registry.size).toBe(1);
	});

	it('reaps an entry nobody touched for the idle window', () => {
		const { registry, released } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		vi.advanceTimersByTime(IDLE_MS * 2 + 1);
		expect(released).toEqual(['alpha']);
		expect(registry.size).toBe(0);
	});

	it('keeps an entry that get() keeps touching', () => {
		const { registry, released } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(IDLE_MS / 2);
			registry.get('a');
		}
		expect(released).toEqual([]);
		expect(registry.size).toBe(1);
	});

	it('find() refreshes the idle clock of the match only', () => {
		const { registry, released } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		registry.add('b', { name: 'beta' });
		for (let i = 0; i < 4; i++) {
			vi.advanceTimersByTime(IDLE_MS / 2);
			expect(registry.find((value) => value.name === 'beta')).toEqual({ name: 'beta' });
		}
		expect(released).toEqual(['alpha']);
		expect(registry.find((value) => value.name === 'alpha')).toBeUndefined();
	});

	it('releases once on close, and a second close is a no-op', async () => {
		const { registry, released } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		await registry.close('a');
		await registry.close('a');
		expect(released).toEqual(['alpha']);
		expect(registry.get('a')).toBeUndefined();
	});

	it('removes the entry before releasing it', async () => {
		let seenDuringRelease: unknown = 'not called';
		const registry = createIdleHandleRegistry<string>({
			idleMs: IDLE_MS,
			release: () => {
				seenDuringRelease = registry.get('a');
			},
		});
		registry.add('a', 'alpha');
		await registry.close('a');
		expect(seenDuringRelease).toBeUndefined();
	});

	it('swallows a release that throws', async () => {
		const registry = createIdleHandleRegistry<string>({
			idleMs: IDLE_MS,
			release: () => {
				throw new Error('already closed');
			},
		});
		registry.add('a', 'alpha');
		await expect(registry.close('a')).resolves.toBeUndefined();
		expect(registry.size).toBe(0);
	});

	it('closeAll releases everything and stops the reaper', async () => {
		const { registry, released } = makeRegistry();
		registry.add('a', { name: 'alpha' });
		registry.add('b', { name: 'beta' });
		await registry.closeAll();
		expect(released.sort()).toEqual(['alpha', 'beta']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('runs no timer while nothing is open', async () => {
		const { registry } = makeRegistry();
		expect(vi.getTimerCount()).toBe(0);
		registry.add('a', { name: 'alpha' });
		expect(vi.getTimerCount()).toBe(1);
		await registry.close('a');
		expect(vi.getTimerCount()).toBe(0);
	});
});

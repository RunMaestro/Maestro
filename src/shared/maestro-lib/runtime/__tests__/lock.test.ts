import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createProcessLock,
	inspectProcessLockContent,
	startLockHeartbeat,
	type ProcessLockDeps,
	type ProcessLockSpec,
} from '../lock';

const SPEC: ProcessLockSpec = {
	fileName: 'test.lock',
	heartbeatMs: 1_000,
	staleMs: 6_000,
	bootToleranceMs: 500,
};

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BOOT = T0 - 3_600_000;

describe('createProcessLock', () => {
	let dir: string;
	let now: number;
	let alive: Set<number>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-lock-test-'));
		now = T0;
		alive = new Set([100, 200]);
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A lock as process `pid`, with the injected clock and pid probe. */
	function as(pid: number, extra: Partial<ProcessLockDeps> = {}) {
		return createProcessLock<'a' | 'b'>(dir, SPEC, {
			pid,
			now: () => now,
			bootTime: () => BOOT,
			isPidAlive: (p) => alive.has(p),
			hostname: () => 'testhost',
			...extra,
		});
	}

	const file = () => path.join(dir, SPEC.fileName);
	const written = () => JSON.parse(fs.readFileSync(file(), 'utf-8'));

	it('acquires a missing lock, creating the directory, and records pid, mode, boot, and host', () => {
		const nested = path.join(dir, 'deep', 'er');
		const lock = createProcessLock<'a'>(nested, SPEC, {
			pid: 100,
			now: () => now,
			bootTime: () => BOOT,
			isPidAlive: (p) => alive.has(p),
			hostname: () => 'testhost',
		});
		expect(lock.acquire('a')).toEqual({ acquired: true });
		const info = JSON.parse(fs.readFileSync(path.join(nested, SPEC.fileName), 'utf-8'));
		expect(info).toMatchObject({ pid: 100, mode: 'a', bootTime: BOOT, host: 'testhost' });
		expect(info.startedAt).toBe(new Date(T0).toISOString());
		expect(info.heartbeatAt).toBe(info.startedAt);
	});

	it('refuses while another live process holds it, and names the holder', () => {
		as(100).acquire('a');
		const result = as(200).acquire('b');
		expect(result.acquired).toBe(false);
		if (!result.acquired) expect(result.heldBy).toMatchObject({ pid: 100, mode: 'a' });
		expect(written().pid).toBe(100);
	});

	it('re-acquiring a lock this process holds is a success', () => {
		const lock = as(100);
		lock.acquire('a');
		expect(lock.acquire('b')).toEqual({ acquired: true });
		expect(written().mode).toBe('b');
	});

	describe('reclaiming a stale lock', () => {
		it('takes over from a pid that is gone', () => {
			as(100).acquire('a');
			alive.delete(100);
			expect(as(200).acquire('b')).toEqual({ acquired: true });
			expect(written()).toMatchObject({ pid: 200, mode: 'b' });
		});

		it('takes over from a live pid written in an earlier boot (a reused pid)', () => {
			fs.writeFileSync(
				file(),
				JSON.stringify({
					pid: 100,
					mode: 'a',
					startedAt: new Date(T0).toISOString(),
					bootTime: BOOT - 86_400_000,
				})
			);
			expect(as(200).acquire('b')).toEqual({ acquired: true });
		});

		it('takes over from a live pid whose heartbeat went quiet', () => {
			as(100).acquire('a');
			now += SPEC.staleMs + 1;
			expect(as(200).acquire('b')).toEqual({ acquired: true });
		});

		it('still honors a heartbeat exactly at the stale window', () => {
			as(100).acquire('a');
			now += SPEC.staleMs;
			expect(as(200).acquire('b').acquired).toBe(false);
		});

		it('takes over from a corrupt file', () => {
			fs.writeFileSync(file(), '{oops');
			expect(as(200).acquire('b')).toEqual({ acquired: true });
		});

		it('tolerates a small boot-time drift', () => {
			fs.writeFileSync(
				file(),
				JSON.stringify({
					pid: 100,
					mode: 'a',
					startedAt: new Date(T0).toISOString(),
					bootTime: BOOT + 400,
				})
			);
			expect(as(200).acquire('b').acquired).toBe(false);
		});
	});

	describe('inspect and holder', () => {
		it('says none for a missing file and unreadable for corrupt or pid-less content', () => {
			expect(as(100).inspect()).toEqual({ state: 'none' });
			fs.writeFileSync(file(), '{oops');
			expect(as(100).inspect()).toEqual({ state: 'unreadable' });
			fs.writeFileSync(file(), JSON.stringify({ mode: 'a' }));
			expect(as(100).inspect()).toEqual({ state: 'unreadable' });
		});

		it('says live for a fresh lock, and stale with the first reason that applies', () => {
			as(100).acquire('a');
			expect(as(200).inspect()).toMatchObject({ state: 'live', info: { pid: 100 } });

			now += SPEC.staleMs + 1;
			expect(as(200).inspect()).toMatchObject({ state: 'stale', reason: 'heartbeat quiet' });

			alive.delete(100);
			expect(as(200).inspect()).toMatchObject({ state: 'stale', reason: 'process gone' });
		});

		it('reports an earlier boot ahead of a quiet heartbeat', () => {
			as(100).acquire('a');
			now += SPEC.staleMs + 1;
			const state = as(200, { bootTime: () => BOOT + 3_600_000 }).inspect();
			expect(state).toMatchObject({ state: 'stale', reason: 'earlier boot' });
		});

		it('holder is the live holder only', () => {
			expect(as(200).holder()).toBeNull();
			as(100).acquire('a');
			expect(as(200).holder()).toMatchObject({ pid: 100 });
			alive.delete(100);
			expect(as(200).holder()).toBeNull();
		});

		it('reads a missing startedAt as epoch 0, which is stale', () => {
			fs.writeFileSync(file(), JSON.stringify({ pid: 100, mode: 'a' }));
			expect(as(200).inspect()).toMatchObject({ state: 'stale', reason: 'heartbeat quiet' });
		});
	});

	describe('touch', () => {
		it('refreshes the heartbeat and keeps this process startedAt', () => {
			const lock = as(100);
			lock.acquire('a');
			const startedAt = written().startedAt;
			now += 4_000;
			expect(lock.touch('a')).toBe('held');
			expect(written().startedAt).toBe(startedAt);
			expect(written().heartbeatAt).toBe(new Date(now).toISOString());
		});

		it('answers lost, leaving the file alone, when another live process owns it', () => {
			as(100).acquire('a');
			alive.add(200);
			now += SPEC.staleMs + 1;
			as(200).acquire('b');
			alive.add(100);
			expect(as(100).touch('a')).toBe('lost');
			expect(written().pid).toBe(200);
		});

		it('rewrites a lock that was deleted by hand', () => {
			const lock = as(100);
			lock.acquire('a');
			fs.unlinkSync(file());
			expect(lock.touch('a')).toBe('held');
			expect(written().pid).toBe(100);
		});

		it('ignores a failed write: the next beat retries', () => {
			const lock = as(100);
			lock.acquire('a');
			// A directory where the file belongs makes every write fail.
			fs.unlinkSync(file());
			fs.mkdirSync(file());
			expect(lock.touch('a')).toBe('held');
		});
	});

	describe('release', () => {
		it('removes this process lock, and an absent lock is a no-op', () => {
			const lock = as(100);
			lock.acquire('a');
			lock.release();
			expect(fs.existsSync(file())).toBe(false);
			expect(() => lock.release()).not.toThrow();
		});

		it('leaves another live holder lock in place', () => {
			as(100).acquire('a');
			as(200).release();
			expect(written().pid).toBe(100);
		});

		it('removes a stale lock of a dead process', () => {
			as(100).acquire('a');
			alive.delete(100);
			as(200).release();
			expect(fs.existsSync(file())).toBe(false);
		});
	});
});

describe('inspectProcessLockContent', () => {
	const deps = { now: () => T0, bootTime: () => BOOT, isPidAlive: () => true };

	it('classifies text the caller read itself, as inspect() would', () => {
		const raw = JSON.stringify({
			pid: 7,
			mode: 'tui',
			startedAt: new Date(T0 - 1_000).toISOString(),
			bootTime: BOOT,
		});
		expect(inspectProcessLockContent(raw, SPEC, deps)).toMatchObject({
			state: 'live',
			info: { pid: 7, mode: 'tui' },
		});
		expect(inspectProcessLockContent('nope', SPEC, deps)).toEqual({ state: 'unreadable' });
	});
});

describe('startLockHeartbeat', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('beats on the spec interval until stopped', () => {
		const touch = vi.fn(() => 'held' as const);
		const stop = startLockHeartbeat({ touch }, 'a', SPEC, vi.fn());
		vi.advanceTimersByTime(3_000);
		expect(touch).toHaveBeenCalledTimes(3);
		expect(touch).toHaveBeenCalledWith('a');
		stop();
		vi.advanceTimersByTime(5_000);
		expect(touch).toHaveBeenCalledTimes(3);
	});

	it('calls onLost once, then stops beating', () => {
		const touch = vi
			.fn<() => 'held' | 'lost'>()
			.mockReturnValueOnce('held')
			.mockReturnValue('lost');
		const onLost = vi.fn();
		startLockHeartbeat({ touch }, 'a', SPEC, onLost);
		vi.advanceTimersByTime(10_000);
		expect(onLost).toHaveBeenCalledTimes(1);
		expect(touch).toHaveBeenCalledTimes(2);
	});
});

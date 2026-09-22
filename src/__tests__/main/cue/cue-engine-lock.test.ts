/**
 * Tests for the cross-process Cue engine lock (`cue-engine-lock.ts`).
 *
 * Every test points `MAESTRO_USER_DATA` at a fresh temp directory so this
 * suite never touches the real Maestro config dir - a real lock file there
 * would collide with other parallel test workers exercising the SAME module
 * via `cue-engine.test.ts` and friends (see the `vi.mock` those files apply
 * instead, and the comment in each explaining why).
 *
 * "A different, genuinely live PID" is exercised with a real short-lived
 * child process rather than a hardcoded number - the alternative (assume PID
 * 1, or some other well-known pid, both exists and isn't this test runner)
 * is not reliably true across POSIX and Windows CI hosts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

describe('cue-engine-lock', () => {
	let tmpDir: string;
	let lockPath: string;
	const originalEnv = process.env.MAESTRO_USER_DATA;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-lock-test-'));
		lockPath = path.join(tmpDir, 'cue-engine.lock');
		process.env.MAESTRO_USER_DATA = tmpDir;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = originalEnv;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// Re-import per test for isolation - the module holds no cross-call
	// cache today, but this keeps the suite honest if one is ever added.
	async function freshModule() {
		return import('../../../main/cue/cue-engine-lock');
	}

	function writeLock(pid: number, mode: 'desktop' | 'standalone' = 'desktop') {
		fs.writeFileSync(lockPath, JSON.stringify({ pid, mode, startedAt: new Date().toISOString() }));
	}

	/** Spawn a process guaranteed alive for the duration of the test and not this test runner's own PID. */
	function spawnLiveProcess(): ChildProcess {
		return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
	}

	it('acquires the lock when none is held', async () => {
		const { acquireCueEngineLock, readCueEngineLock } = await freshModule();
		const result = acquireCueEngineLock('desktop');
		expect(result.acquired).toBe(true);

		const info = readCueEngineLock();
		expect(info?.pid).toBe(process.pid);
		expect(info?.mode).toBe('desktop');
	});

	it('reports a conflict when a genuinely different live PID holds the lock', async () => {
		const child = spawnLiveProcess();
		try {
			await new Promise((resolve) => child.once('spawn', resolve));
			writeLock(child.pid!, 'standalone');

			const { acquireCueEngineLock } = await freshModule();
			const result = acquireCueEngineLock('desktop');

			expect(result.acquired).toBe(false);
			if (!result.acquired) {
				expect(result.heldBy.pid).toBe(child.pid);
				expect(result.heldBy.mode).toBe('standalone');
			}
		} finally {
			child.kill();
		}
	});

	it('treats a lock naming a dead PID as absent (stale)', async () => {
		const child = spawnLiveProcess();
		await new Promise((resolve) => child.once('spawn', resolve));
		const deadPid = child.pid!;
		child.kill();
		await new Promise((resolve) => child.once('exit', resolve));

		writeLock(deadPid, 'desktop');

		const { acquireCueEngineLock, readCueEngineLock } = await freshModule();
		expect(readCueEngineLock()).toBeNull();

		const result = acquireCueEngineLock('standalone');
		expect(result.acquired).toBe(true);
	});

	it('re-acquiring from the SAME process is idempotent, not a conflict', async () => {
		const { acquireCueEngineLock } = await freshModule();
		const first = acquireCueEngineLock('desktop');
		const second = acquireCueEngineLock('desktop');
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(true);
	});

	it('releases the lock, letting a subsequent acquire succeed cleanly', async () => {
		const { acquireCueEngineLock, releaseCueEngineLock, readCueEngineLock } = await freshModule();
		acquireCueEngineLock('desktop');
		expect(readCueEngineLock()).not.toBeNull();

		releaseCueEngineLock();
		expect(readCueEngineLock()).toBeNull();
	});

	it('release is a no-op when a live different process holds the lock', async () => {
		const child = spawnLiveProcess();
		try {
			await new Promise((resolve) => child.once('spawn', resolve));
			writeLock(child.pid!, 'standalone');

			const { releaseCueEngineLock } = await freshModule();
			releaseCueEngineLock();

			// Ownership check must refuse to delete a lock this process does
			// not hold, defending against a stale reference stealing a live
			// engine's lock out from under it.
			expect(fs.existsSync(lockPath)).toBe(true);
		} finally {
			child.kill();
		}
	});

	it('handles a corrupt lock file as absent rather than throwing', async () => {
		const { readCueEngineLock, acquireCueEngineLock } = await freshModule();
		fs.writeFileSync(lockPath, 'not valid json{{{');

		expect(() => readCueEngineLock()).not.toThrow();
		expect(readCueEngineLock()).toBeNull();
		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
	});

	it('creates the data directory if it does not exist yet', async () => {
		const nestedDir = path.join(tmpDir, 'nested', 'deeper');
		process.env.MAESTRO_USER_DATA = nestedDir;
		const { acquireCueEngineLock } = await freshModule();

		expect(fs.existsSync(nestedDir)).toBe(false);
		const result = acquireCueEngineLock('standalone');
		expect(result.acquired).toBe(true);
		expect(fs.existsSync(path.join(nestedDir, 'cue-engine.lock'))).toBe(true);
	});
});

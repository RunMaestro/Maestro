// @vitest-environment node
/**
 * Tests for src/shared/crossProcessLock.ts
 *
 * Real filesystem in a temp dir, plus real child processes for the contention
 * tests: lost updates and double lock holders only show up between processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	atomicWriteFileSync,
	backoffDelayMs,
	FileLockTimeoutError,
	readLockHolder,
	reclaimStaleLock,
	withFileLockSync,
	type LockHolder,
} from '../../shared/crossProcessLock';
import { currentProcessIdentity, readProcessStartToken } from '../../shared/processIdentity';
import { bundleForChildProcess, runChildren } from '../helpers/childProcessBundle';

const tokensSupported = process.platform === 'linux' || process.platform === 'darwin';

function holder(overrides: Partial<LockHolder> = {}): LockHolder {
	return {
		...currentProcessIdentity(),
		instanceId: `other-${Math.random()}`,
		acquiredAt: Date.now(),
		...overrides,
	};
}

/** A pid that is guaranteed dead: a child we started and already reaped. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
	await new Promise((resolve) => child.once('exit', resolve));
	return child.pid!;
}

describe('crossProcessLock', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lock-'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('atomicWriteFileSync', () => {
		it('creates missing directories and writes the contents', () => {
			const target = path.join(dir, 'a', 'b', 'file.json');
			atomicWriteFileSync(target, '{"ok":true}');
			expect(fs.readFileSync(target, 'utf-8')).toBe('{"ok":true}');
		});

		it('replaces an existing file and leaves no temp files behind', () => {
			const target = path.join(dir, 'file.json');
			atomicWriteFileSync(target, 'one');
			atomicWriteFileSync(target, 'two');
			expect(fs.readFileSync(target, 'utf-8')).toBe('two');
			expect(fs.readdirSync(dir)).toEqual(['file.json']);
		});

		it('cleans up its temp file and keeps the target when the rename fails', () => {
			// A directory in the target's place makes the rename fail for real.
			const target = path.join(dir, 'occupied');
			fs.mkdirSync(target);
			fs.writeFileSync(path.join(target, 'keep'), 'x');

			expect(() => atomicWriteFileSync(target, 'new')).toThrow();
			expect(fs.readdirSync(dir)).toEqual(['occupied']);
			expect(fs.readdirSync(target)).toEqual(['keep']);
		});
	});

	describe('backoffDelayMs', () => {
		it('grows exponentially up to the cap, with full jitter', () => {
			expect(backoffDelayMs(0, 10, 100, () => 0.999)).toBe(9);
			expect(backoffDelayMs(2, 10, 100, () => 0.999)).toBe(39);
			expect(backoffDelayMs(10, 10, 100, () => 0.999)).toBe(99);
		});

		it('never returns zero, so a retry is never a hot loop', () => {
			expect(backoffDelayMs(0, 10, 100, () => 0)).toBe(1);
		});
	});

	describe('withFileLockSync', () => {
		it('runs the callback, returns its value, and removes the lock', () => {
			const lockPath = path.join(dir, 'x.lock');
			const seen: Array<LockHolder | null> = [];
			const result = withFileLockSync(lockPath, () => {
				seen.push(readLockHolder(lockPath));
				return 42;
			});
			expect(result).toBe(42);
			expect(seen[0]?.pid).toBe(process.pid);
			expect(fs.existsSync(lockPath)).toBe(false);
		});

		it('releases the lock when the callback throws', () => {
			const lockPath = path.join(dir, 'x.lock');
			expect(() =>
				withFileLockSync(lockPath, () => {
					throw new Error('boom');
				})
			).toThrow('boom');
			expect(fs.existsSync(lockPath)).toBe(false);
		});

		it('waits out a live holder and then times out with the holder named', () => {
			const lockPath = path.join(dir, 'x.lock');
			const live = holder();
			fs.writeFileSync(lockPath, JSON.stringify(live));
			const fn = vi.fn();

			let error: unknown;
			try {
				withFileLockSync(lockPath, fn, { timeoutMs: 100 });
			} catch (err) {
				error = err;
			}

			expect(error).toBeInstanceOf(FileLockTimeoutError);
			expect((error as FileLockTimeoutError).holder?.instanceId).toBe(live.instanceId);
			expect(fn).not.toHaveBeenCalled();
			// The live holder's lock is untouched.
			expect(readLockHolder(lockPath)?.instanceId).toBe(live.instanceId);
		});

		it('reclaims a lock whose holder has exited', async () => {
			const lockPath = path.join(dir, 'x.lock');
			fs.writeFileSync(
				lockPath,
				JSON.stringify(holder({ pid: await deadPid(), startToken: undefined }))
			);

			const fn = vi.fn(() => 'ran');
			expect(withFileLockSync(lockPath, fn, { timeoutMs: 500 })).toBe('ran');
		});

		it.runIf(tokensSupported)('reclaims a lock whose pid was recycled by another process', () => {
			const lockPath = path.join(dir, 'x.lock');
			const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
				stdio: 'ignore',
			});
			try {
				expect(readProcessStartToken(child.pid!)).toBeTruthy();
				fs.writeFileSync(lockPath, JSON.stringify(holder({ pid: child.pid!, startToken: '1' })));
				expect(withFileLockSync(lockPath, () => 'ran', { timeoutMs: 500 })).toBe('ran');
			} finally {
				child.kill('SIGKILL');
			}
		});

		it('reclaims a lock held far longer than any critical section takes', () => {
			const lockPath = path.join(dir, 'x.lock');
			fs.writeFileSync(lockPath, JSON.stringify(holder({ acquiredAt: Date.now() - 60_000 })));
			expect(withFileLockSync(lockPath, () => 'ran', { timeoutMs: 500, staleMs: 10_000 })).toBe(
				'ran'
			);
		});

		it('treats a fresh unparseable lock as a peer mid-create, and an old one as stale', () => {
			const lockPath = path.join(dir, 'x.lock');
			fs.writeFileSync(lockPath, '');
			expect(() => withFileLockSync(lockPath, vi.fn(), { timeoutMs: 100 })).toThrow(
				FileLockTimeoutError
			);

			const old = (Date.now() - 60_000) / 1000;
			fs.utimesSync(lockPath, old, old);
			expect(withFileLockSync(lockPath, () => 'ran', { timeoutMs: 500 })).toBe('ran');
		});

		it('does not delete a lock that a peer reclaimed while we held it', () => {
			const lockPath = path.join(dir, 'x.lock');
			const peer = holder();
			withFileLockSync(lockPath, () => {
				// A peer judged us stale and replaced the lock with its own.
				fs.writeFileSync(lockPath, JSON.stringify(peer));
			});
			expect(readLockHolder(lockPath)?.instanceId).toBe(peer.instanceId);
		});
	});

	describe('reclaimStaleLock', () => {
		it('removes the lock it judged stale', () => {
			const lockPath = path.join(dir, 'x.lock');
			const stale = holder();
			fs.writeFileSync(lockPath, JSON.stringify(stale));
			expect(reclaimStaleLock(lockPath, stale)).toBe(true);
			expect(fs.existsSync(lockPath)).toBe(false);
		});

		it('puts back a fresh lock that replaced the judged one (ABA)', () => {
			const lockPath = path.join(dir, 'x.lock');
			const judged = holder();
			const fresh = holder();
			// Between our read and our reclaim, a peer reclaimed `judged` and
			// acquired `fresh`. We must not destroy the peer's live lock.
			fs.writeFileSync(lockPath, JSON.stringify(fresh));

			expect(reclaimStaleLock(lockPath, judged)).toBe(false);
			expect(readLockHolder(lockPath)?.instanceId).toBe(fresh.instanceId);
			expect(fs.readdirSync(dir)).toEqual(['x.lock']);
		});

		it('reports false when the lock is already gone', () => {
			expect(reclaimStaleLock(path.join(dir, 'missing.lock'), holder())).toBe(false);
		});

		// The ABA case above is caught by the instanceId. An UNPARSEABLE lock has
		// none, and a peer between its own open and write is unparseable too, so
		// "still unparseable" would accept a lock that is not the one we judged.
		it('puts back an unparseable lock that is not the file it judged', () => {
			const lockPath = path.join(dir, 'x.lock');
			fs.writeFileSync(lockPath, ''); // A peer, mid-create.
			const judgedIno = fs.statSync(lockPath).ino + 1; // We judged a different file.

			expect(reclaimStaleLock(lockPath, null, judgedIno)).toBe(false);
			expect(fs.existsSync(lockPath)).toBe(true);
			expect(fs.readdirSync(dir)).toEqual(['x.lock']);
		});

		it('still removes the unparseable lock it did judge', () => {
			const lockPath = path.join(dir, 'x.lock');
			fs.writeFileSync(lockPath, '');

			expect(reclaimStaleLock(lockPath, null, fs.statSync(lockPath).ino)).toBe(true);
			expect(fs.existsSync(lockPath)).toBe(false);
		});
	});

	describe('across processes', () => {
		it('gives exactly one process the lock at a time and loses no updates', async () => {
			const bundle = bundleForChildProcess('shared/crossProcessLock.ts', dir, 'lock');
			const counterPath = path.join(dir, 'counter.json');
			const sectionPath = path.join(dir, 'in-section');
			const lockPath = path.join(dir, 'counter.lock');
			fs.writeFileSync(counterPath, JSON.stringify({ n: 0 }));

			const children = 6;
			const iterations = 40;
			const results = await runChildren(
				`
const fs = require('fs');
const { withFileLockSync, atomicWriteFileSync } = require(${JSON.stringify(bundle)});
let violations = 0;
for (let i = 0; i < ${iterations}; i++) {
	withFileLockSync(${JSON.stringify(lockPath)}, () => {
		// A second holder would find the sentinel already present.
		try { fs.writeFileSync(${JSON.stringify(sectionPath)}, '', { flag: 'wx' }); }
		catch { violations++; }
		const { n } = JSON.parse(fs.readFileSync(${JSON.stringify(counterPath)}, 'utf-8'));
		atomicWriteFileSync(${JSON.stringify(counterPath)}, JSON.stringify({ n: n + 1 }));
		fs.rmSync(${JSON.stringify(sectionPath)}, { force: true });
	}, { timeoutMs: 15000 });
}
process.stdout.write(String(violations));
`,
				children,
				{ dir }
			);

			for (const result of results) {
				expect(result.stderr).toBe('');
				expect(result.code).toBe(0);
				expect(result.stdout).toBe('0');
			}
			expect(JSON.parse(fs.readFileSync(counterPath, 'utf-8')).n).toBe(children * iterations);
			expect(fs.existsSync(lockPath)).toBe(false);
		}, 30_000);
	});
});

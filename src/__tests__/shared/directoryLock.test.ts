/**
 * @file directoryLock.test.ts
 * @description Behavioral tests for withDirectoryLock, the cross-process lock
 * under the agent-run store and the consult budget counter. Uses a real temp
 * directory and real fs so the atomic mkdir, the stale-lock steal, the
 * owner-token release guard and the timeout are exercised for real (mocking fs
 * would defeat the very mechanism under test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleepSync, withDirectoryLock } from '../../shared/directoryLock';

let tmpDir: string;
let lockDir: string;
let holderPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-lock-'));
	lockDir = path.join(tmpDir, 'store.lock');
	holderPath = path.join(lockDir, 'holder');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ageLock(ms: number): void {
	const past = new Date(Date.now() - ms);
	fs.utimesSync(lockDir, past, past);
}

describe('withDirectoryLock', () => {
	it('holds the lock while fn runs, returns its value, and releases', () => {
		let heldDuringFn = false;
		const result = withDirectoryLock(lockDir, () => {
			heldDuringFn = fs.existsSync(lockDir);
			return 42;
		});

		expect(result).toBe(42);
		expect(heldDuringFn).toBe(true);
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('releases the lock when fn throws, and propagates the throw', () => {
		expect(() =>
			withDirectoryLock(lockDir, () => {
				throw new Error('boom from inside fn');
			})
		).toThrow('boom from inside fn');

		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('times out on a fresh held lock without running fn, and names the lock', () => {
		fs.mkdirSync(lockDir);

		let fnRan = false;
		const start = Date.now();
		expect(() =>
			withDirectoryLock(
				lockDir,
				() => {
					fnRan = true;
				},
				{ timeoutMs: 50, label: 'test store' }
			)
		).toThrow(/test store lock timeout after 50ms/);

		expect(fnRan).toBe(false);
		// It waited for (roughly) the timeout rather than failing at once.
		expect(Date.now() - start).toBeGreaterThanOrEqual(40);
		// The contended lock belongs to the other holder: not deleted.
		expect(fs.existsSync(lockDir)).toBe(true);
	});

	it('names the lock directory in the timeout error when no label is given', () => {
		fs.mkdirSync(lockDir);

		expect(() => withDirectoryLock(lockDir, () => undefined, { timeoutMs: 20 })).toThrow(
			`${lockDir} lock timeout after 20ms`
		);
	});

	it('steals a lock older than the default stale threshold', () => {
		fs.mkdirSync(lockDir);
		fs.writeFileSync(holderPath, JSON.stringify({ token: 'dead-holder', pid: 999 }), 'utf-8');
		ageLock(90_000);

		const result = withDirectoryLock(lockDir, () => 'stolen-and-ran', { timeoutMs: 200 });

		expect(result).toBe('stolen-and-ran');
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('honors a caller-chosen stale threshold in both directions', () => {
		fs.mkdirSync(lockDir);
		ageLock(5_000);

		// Younger than the threshold: still held, so the call times out.
		expect(() =>
			withDirectoryLock(lockDir, () => undefined, { timeoutMs: 30, staleMs: 60_000 })
		).toThrow(/lock timeout/);

		// Older than the threshold: abandoned, so the call steals it.
		expect(withDirectoryLock(lockDir, () => 'ran', { timeoutMs: 30, staleMs: 1_000 })).toBe('ran');
	});

	it('does not delete the lock once ownership has changed hands', () => {
		// Our lock was declared stale and stolen mid-run: the holder token is no
		// longer ours, so release must NOT destroy the new owner's lock.
		withDirectoryLock(lockDir, () => {
			fs.writeFileSync(
				holderPath,
				JSON.stringify({ token: 'a-different-owner', pid: 12345 }),
				'utf-8'
			);
		});

		expect(fs.existsSync(lockDir)).toBe(true);
		const holder = JSON.parse(fs.readFileSync(holderPath, 'utf-8')) as { token?: string };
		expect(holder.token).toBe('a-different-owner');
	});

	it('throws an error other than a held lock straight away', () => {
		// The parent directory is the caller's to create.
		const orphan = path.join(tmpDir, 'missing-parent', 'store.lock');

		expect(() => withDirectoryLock(orphan, () => undefined)).toThrow(/ENOENT/);
	});
});

describe('sleepSync', () => {
	it('blocks for about the time asked and returns at once for zero', () => {
		const start = Date.now();
		sleepSync(30);
		expect(Date.now() - start).toBeGreaterThanOrEqual(25);

		const zeroStart = Date.now();
		sleepSync(0);
		expect(Date.now() - zeroStart).toBeLessThan(20);
	});
});

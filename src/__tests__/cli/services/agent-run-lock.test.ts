/**
 * @file agent-run-lock.test.ts
 * @description Behavioral tests for withStoreLock (F0 store write-safety). Uses a
 * real temp MAESTRO_USER_DATA dir + real fs so the atomic mkdir lock, stale-lock
 * steal, owner-token release guard, and timeout are exercised for real (mocking
 * fs would defeat the very mechanism under test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withStoreLock } from '../../../cli/services/agent-run-lock';

const LOCK_DIR_NAME = 'maestro-agent-store.lock';
const STALE_LOCK_MS = 30_000;

let tmpDir: string;
let lockDir: string;
let holderPath: string;
let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env.MAESTRO_USER_DATA;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-lock-'));
	process.env.MAESTRO_USER_DATA = tmpDir;
	lockDir = path.join(tmpDir, LOCK_DIR_NAME);
	holderPath = path.join(lockDir, 'holder');
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevEnv;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('withStoreLock', () => {
	it('runs fn, returns its value, and releases the lock dir', () => {
		expect(fs.existsSync(lockDir)).toBe(false);

		let sawLockHeld = false;
		const result = withStoreLock(() => {
			// The lock dir must exist while fn runs.
			sawLockHeld = fs.existsSync(lockDir);
			return 42;
		});

		expect(result).toBe(42);
		expect(sawLockHeld).toBe(true);
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('releases the lock dir even when fn throws, and propagates the throw', () => {
		expect(() =>
			withStoreLock(() => {
				throw new Error('boom from inside fn');
			})
		).toThrow('boom from inside fn');

		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('times out and throws when a fresh lock dir is already held, without running fn', () => {
		// A just-created (fresh) lock dir: not stale, so it cannot be stolen.
		fs.mkdirSync(lockDir);

		let fnRan = false;
		const start = Date.now();
		expect(() =>
			withStoreLock(
				() => {
					fnRan = true;
				},
				{ timeoutMs: 50 }
			)
		).toThrow(/agent-run store lock timeout after 50ms/);
		const elapsed = Date.now() - start;

		expect(fnRan).toBe(false);
		// It actually waited for (roughly) the timeout rather than failing instantly.
		expect(elapsed).toBeGreaterThanOrEqual(40);
		// The contended lock belongs to the (simulated) other holder: not deleted.
		expect(fs.existsSync(lockDir)).toBe(true);
	});

	it('steals a stale lock dir and runs fn to completion', () => {
		// A lock left behind by a crashed holder: dir present, mtime far in the past.
		fs.mkdirSync(lockDir);
		fs.writeFileSync(holderPath, JSON.stringify({ token: 'dead-holder', pid: 999 }), 'utf-8');
		const past = new Date(Date.now() - (STALE_LOCK_MS + 60_000));
		fs.utimesSync(lockDir, past, past);

		let fnRan = false;
		const result = withStoreLock(
			() => {
				fnRan = true;
				return 'stolen-and-ran';
			},
			{ timeoutMs: 200 }
		);

		expect(fnRan).toBe(true);
		expect(result).toBe('stolen-and-ran');
		// Our acquisition owned the fresh lock and released it in finally.
		expect(fs.existsSync(lockDir)).toBe(false);
	});

	it('does not delete the lock dir in finally once ownership has changed hands', () => {
		// Simulate our lock being declared stale and stolen mid-run: the holder token
		// no longer matches ours, so finally must NOT destroy the new owner's lock.
		withStoreLock(() => {
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
});

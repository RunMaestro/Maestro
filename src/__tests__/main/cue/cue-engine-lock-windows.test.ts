/**
 * Windows sharing refusals in the Cue engine lock (`cue-engine-lock.ts`).
 *
 * On Windows, `rename`, `link`, `unlink` and `mkdir` can fail with EPERM /
 * EACCES / EBUSY for a moment while another process has the path open - a
 * racing engine or `cue engine status` reading the lock is enough to make a
 * rename-over fail. The module must treat that as "busy, retry": never throw,
 * and never report a lock it did not get. CI's Linux leg cannot produce those
 * errors, so `fs` is wrapped here to inject them, and `process.platform` is
 * overridden to `win32` (the module reads it at call time). The last test pins
 * that Linux keeps throwing the same code, since there it is not transient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		renameSync: vi.fn(actual.renameSync),
		linkSync: vi.fn(actual.linkSync),
		mkdirSync: vi.fn(actual.mkdirSync),
	};
});

function sharingError(code: 'EPERM' | 'EACCES' | 'EBUSY', syscall: string): NodeJS.ErrnoException {
	const err = new Error(`${code}: operation not permitted, ${syscall}`) as NodeJS.ErrnoException;
	err.code = code;
	err.syscall = syscall;
	return err;
}

describe('cue-engine-lock on Windows: sharing refusals are busy, not errors', () => {
	const originalPlatform = process.platform;
	const originalEnv = process.env.MAESTRO_USER_DATA;
	let tmpDir: string;
	let lockPath: string;

	function setPlatform(value: string): void {
		Object.defineProperty(process, 'platform', { value, configurable: true });
	}

	/** A lock nobody can still own: foreign token, heartbeat ten minutes old. */
	function writeStaleLock(): void {
		const old = new Date(Date.now() - 10 * 60_000).toISOString();
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				pid: 999_999,
				token: 'crashed-engine',
				mode: 'standalone',
				startedAt: old,
				heartbeatAt: old,
			})
		);
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-lock-win-'));
		lockPath = path.join(tmpDir, 'cue-engine.lock');
		process.env.MAESTRO_USER_DATA = tmpDir;
		setPlatform('win32');
	});

	afterEach(() => {
		setPlatform(originalPlatform);
		vi.mocked(fs.renameSync).mockReset();
		vi.mocked(fs.linkSync).mockReset();
		vi.mocked(fs.mkdirSync).mockReset();
		if (originalEnv === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = originalEnv;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function lockModule() {
		const actual = await vi.importActual<typeof import('fs')>('fs');
		// mockReset drops the passthrough; put the real implementations back.
		vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
		vi.mocked(fs.linkSync).mockImplementation(actual.linkSync);
		vi.mocked(fs.mkdirSync).mockImplementation(actual.mkdirSync);
		return import('../../../main/cue/cue-engine-lock');
	}

	it('re-acquire retries a rename refused while another process reads the lock', async () => {
		const { acquireCueEngineLock } = await lockModule();
		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		const before = fs.readFileSync(lockPath, 'utf-8');

		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw sharingError('EPERM', 'rename');
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(2);
		expect(fs.readFileSync(lockPath, 'utf-8')).not.toBe(before);
		expect(fs.readdirSync(tmpDir)).toEqual(['cue-engine.lock']);
	});

	it('re-acquire never throws while the rename keeps being refused, and leaves our lock intact', async () => {
		const { acquireCueEngineLock, readCueEngineLock, isCueEngineLockOwnedByThisProcess } =
			await lockModule();
		expect(acquireCueEngineLock('desktop').acquired).toBe(true);

		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw sharingError('EACCES', 'rename');
		});

		// The lock on disk is still ours and live, so this is the same no-op
		// re-acquire it always was - not a lock gained through the error.
		expect(() => acquireCueEngineLock('desktop')).not.toThrow();
		const lock = readCueEngineLock();
		expect(lock && isCueEngineLockOwnedByThisProcess(lock)).toBe(true);
	});

	it('touch skips the beat instead of throwing or reporting the lock lost', async () => {
		const { acquireCueEngineLock, touchCueEngineLock } = await lockModule();
		expect(acquireCueEngineLock('standalone').acquired).toBe(true);
		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw sharingError('EBUSY', 'rename');
		});

		expect(touchCueEngineLock('standalone')).toBe('held');
	});

	it('a stale takeover retries a refused link and still acquires', async () => {
		writeStaleLock();
		const { acquireCueEngineLock } = await lockModule();
		vi.mocked(fs.linkSync).mockImplementationOnce(() => {
			throw sharingError('EPERM', 'link');
		});

		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
	});

	it('a takeover that is refused every time reports not acquired, never throws', async () => {
		writeStaleLock();
		const { acquireCueEngineLock } = await lockModule();
		vi.mocked(fs.linkSync).mockImplementation(() => {
			throw sharingError('EPERM', 'link');
		});

		let result: ReturnType<typeof acquireCueEngineLock> | undefined;
		expect(() => {
			result = acquireCueEngineLock('desktop');
		}).not.toThrow();
		expect(result?.acquired).toBe(false);
		// Not the EPERM fallback to a plain `wx` write either: on Windows that
		// code means "in use", not "this filesystem cannot hard-link".
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it('a claim directory refused by mkdir is retried, not thrown', async () => {
		writeStaleLock();
		const { acquireCueEngineLock } = await lockModule();
		const actual = await vi.importActual<typeof import('fs')>('fs');
		let refused = false;
		vi.mocked(fs.mkdirSync).mockImplementation(((
			dir: fs.PathLike,
			options?: fs.MakeDirectoryOptions
		) => {
			if (!refused && String(dir).includes('.claim-')) {
				refused = true;
				throw sharingError('EPERM', 'mkdir');
			}
			return actual.mkdirSync(dir, options);
		}) as typeof fs.mkdirSync);

		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		expect(refused).toBe(true);
	});

	it('off Windows the same code is not transient and still throws', async () => {
		setPlatform('linux');
		const { acquireCueEngineLock } = await lockModule();
		expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		vi.mocked(fs.renameSync).mockImplementation(() => {
			throw sharingError('EPERM', 'rename');
		});

		expect(() => acquireCueEngineLock('desktop')).toThrow(/EPERM/);
	});
});

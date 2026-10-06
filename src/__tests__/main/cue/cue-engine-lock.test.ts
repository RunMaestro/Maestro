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

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

// `cueEngineStop` lives beside the engine starter, which pulls in the whole
// standalone engine. Stop only reads the lock, so stub the rest out.
vi.mock('../../../cli/services/cue-standalone-engine', () => ({
	createStandaloneCueEngine: vi.fn(),
}));
vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(),
}));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(() => []),
}));

/** This process's PID namespace inode, read the same way the module reads it. */
function currentPidNsInode(): number | undefined {
	if (process.platform !== 'linux') return undefined;
	try {
		return fs.statSync('/proc/self/ns/pid').ino;
	} catch {
		return undefined;
	}
}

/** An inode guaranteed not to be ours: on a host without one, any number is foreign. */
function foreignPidNsInode(): number {
	return (currentPidNsInode() ?? 0) + 1;
}

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

	/** A PID that belonged to a process which has since exited. */
	async function deadPid(): Promise<number> {
		const child = spawnLiveProcess();
		await new Promise((resolve) => child.once('spawn', resolve));
		const pid = child.pid!;
		child.kill();
		await new Promise((resolve) => child.once('exit', resolve));
		return pid;
	}

	function writeFullLock(fields: Record<string, unknown>) {
		const now = new Date().toISOString();
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ mode: 'standalone', startedAt: now, heartbeatAt: now, ...fields })
		);
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
	// PID reuse: after a SIGKILL the lock can name an unrelated live process
	// (a reboot or a container restart hands the same small PIDs out again).
	describe('a live PID is not enough', () => {
		it('treats a live PID with a stale heartbeat as absent, so status/stop never target it', async () => {
			const child = spawnLiveProcess();
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				const old = new Date(Date.now() - 10 * 60_000).toISOString();
				fs.writeFileSync(
					lockPath,
					JSON.stringify({ pid: child.pid, mode: 'standalone', startedAt: old, heartbeatAt: old })
				);
				const { readCueEngineLock, acquireCueEngineLock } = await freshModule();
				expect(readCueEngineLock()).toBeNull();
				expect(acquireCueEngineLock('standalone').acquired).toBe(true);
			} finally {
				child.kill();
			}
		});

		it('treats a lock written during an earlier boot as absent', async () => {
			const child = spawnLiveProcess();
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				const now = new Date().toISOString();
				fs.writeFileSync(
					lockPath,
					JSON.stringify({
						pid: child.pid,
						mode: 'standalone',
						startedAt: now,
						heartbeatAt: now,
						bootTime: Date.now() - os.uptime() * 1000 - 24 * 3600_000,
					})
				);
				const { readCueEngineLock } = await freshModule();
				expect(readCueEngineLock()).toBeNull();
			} finally {
				child.kill();
			}
		});

		it('keeps honoring a fresh lock from this boot held by another live process', async () => {
			const child = spawnLiveProcess();
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				const now = new Date().toISOString();
				fs.writeFileSync(
					lockPath,
					JSON.stringify({
						pid: child.pid,
						mode: 'standalone',
						startedAt: now,
						heartbeatAt: now,
						bootTime: Date.now() - os.uptime() * 1000,
					})
				);
				const { readCueEngineLock } = await freshModule();
				expect(readCueEngineLock()?.pid).toBe(child.pid);
			} finally {
				child.kill();
			}
		});
	});

	describe('status port', () => {
		it('is written on acquire, kept by every heartbeat, and read back', async () => {
			const {
				acquireCueEngineLock,
				touchCueEngineLock,
				readCueEngineLock,
				setCueEngineLockStatusPort,
			} = await freshModule();
			setCueEngineLockStatusPort(7433);
			try {
				acquireCueEngineLock('standalone');
				expect(readCueEngineLock()?.statusPort).toBe(7433);
				expect(touchCueEngineLock('standalone')).toBe('held');
				expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).statusPort).toBe(7433);
				expect(readCueEngineLock()?.statusPort).toBe(7433);
			} finally {
				setCueEngineLockStatusPort(undefined);
			}
		});

		it('is absent when no status server runs', async () => {
			const { acquireCueEngineLock, readCueEngineLock } = await freshModule();
			acquireCueEngineLock('desktop');
			expect(readCueEngineLock()?.statusPort).toBeUndefined();
			expect('statusPort' in JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toBe(false);
		});
	});

	describe('touchCueEngineLock', () => {
		it('refreshes the heartbeat and keeps the original startedAt', async () => {
			const { acquireCueEngineLock, touchCueEngineLock } = await freshModule();
			acquireCueEngineLock('standalone');
			const before = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(touchCueEngineLock('standalone')).toBe('held');
			const after = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
			expect(after.startedAt).toBe(before.startedAt);
			expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
		});

		it("reports 'lost' when another live engine has taken the lock over", async () => {
			const child = spawnLiveProcess();
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				writeLock(child.pid!, 'desktop');
				const { touchCueEngineLock } = await freshModule();
				expect(touchCueEngineLock('standalone')).toBe('lost');
				expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(child.pid);
			} finally {
				child.kill();
			}
		});
	});

	describe('token identity', () => {
		it('writes a token and, on Linux, the PID namespace inode', async () => {
			const { acquireCueEngineLock } = await freshModule();
			acquireCueEngineLock('desktop');
			const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
			expect(typeof raw.token).toBe('string');
			expect(raw.token.length).toBeGreaterThan(0);
			expect(raw.pidNsInode).toBe(currentPidNsInode());
		});

		it('re-acquire keeps the same token and is recognized as ours', async () => {
			const { acquireCueEngineLock, readCueEngineLock, isCueEngineLockOwnedByThisProcess } =
				await freshModule();
			expect(acquireCueEngineLock('standalone').acquired).toBe(true);
			const firstToken = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token;
			expect(acquireCueEngineLock('standalone').acquired).toBe(true);
			const lock = readCueEngineLock();
			expect(lock?.token).toBe(firstToken);
			expect(lock && isCueEngineLockOwnedByThisProcess(lock)).toBe(true);
		});

		// Two containers sharing a data directory, each running its engine as
		// PID 1 under tini: the PID matches ours but the lock is not ours.
		it('reports a conflict for a foreign token even when the PID matches ours', async () => {
			writeFullLock({ pid: process.pid, token: 'someone-else', pidNsInode: currentPidNsInode() });
			const { acquireCueEngineLock, touchCueEngineLock, releaseCueEngineLock } =
				await freshModule();

			const result = acquireCueEngineLock('desktop');
			expect(result.acquired).toBe(false);
			if (!result.acquired) expect(result.heldBy.token).toBe('someone-else');

			expect(touchCueEngineLock('desktop')).toBe('lost');
			releaseCueEngineLock();
			expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token).toBe('someone-else');
		});
	});

	describe('foreign PID namespace', () => {
		it('is live while its heartbeat is fresh, even though its PID is dead here', async () => {
			const pid = await deadPid();
			writeFullLock({ pid, token: 'other-container', pidNsInode: foreignPidNsInode() });
			const { readCueEngineLock, acquireCueEngineLock } = await freshModule();

			expect(readCueEngineLock()?.token).toBe('other-container');
			expect(acquireCueEngineLock('desktop').acquired).toBe(false);
		});

		it('is stale once its heartbeat expires', async () => {
			const pid = await deadPid();
			const old = new Date(Date.now() - 10 * 60_000).toISOString();
			writeFullLock({
				pid,
				token: 'other-container',
				pidNsInode: foreignPidNsInode(),
				startedAt: old,
				heartbeatAt: old,
			});
			const { readCueEngineLock, acquireCueEngineLock } = await freshModule();

			expect(readCueEngineLock()).toBeNull();
			expect(acquireCueEngineLock('desktop').acquired).toBe(true);
		});

		it('cueEngineStop refuses to signal it by PID', async () => {
			writeFullLock({ pid: 4242, token: 'other-container', pidNsInode: foreignPidNsInode() });
			const killSpy = vi.spyOn(process, 'kill');
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const originalExitCode = process.exitCode;
			try {
				const { cueEngineStop } = await import('../../../cli/commands/cue-engine');
				await cueEngineStop({ waitMs: 0 });

				expect(killSpy).not.toHaveBeenCalledWith(4242, 'SIGTERM');
				expect(errorSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						'The running Cue engine is in a different PID namespace. Cannot safely signal it by PID.'
					)
				);
				expect(process.exitCode).toBe(1);
			} finally {
				process.exitCode = originalExitCode;
				killSpy.mockRestore();
				errorSpy.mockRestore();
			}
		});
	});

	describe('lock files written before tokens existed', () => {
		it('treats a tokenless lock naming our PID as ours', async () => {
			writeFullLock({ pid: process.pid });
			const { acquireCueEngineLock, touchCueEngineLock, readCueEngineLock } = await freshModule();

			expect(acquireCueEngineLock('standalone').acquired).toBe(true);
			expect(touchCueEngineLock('standalone')).toBe('held');
			expect(readCueEngineLock()?.token).toBeDefined();
		});

		it('treats a tokenless lock naming another live PID as foreign until stale', async () => {
			const child = spawnLiveProcess();
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				writeFullLock({ pid: child.pid });
				const { acquireCueEngineLock, readCueEngineLock, isCueEngineLockOwnedByThisProcess } =
					await freshModule();

				const lock = readCueEngineLock();
				expect(lock?.pid).toBe(child.pid);
				expect(lock && isCueEngineLockOwnedByThisProcess(lock)).toBe(false);
				expect(acquireCueEngineLock('desktop').acquired).toBe(false);

				const old = new Date(Date.now() - 10 * 60_000).toISOString();
				writeFullLock({ pid: child.pid, startedAt: old, heartbeatAt: old });
				expect(acquireCueEngineLock('desktop').acquired).toBe(true);
			} finally {
				child.kill();
			}
		});
	});

	it('creating the lock is exclusive: a lock that appears first wins', async () => {
		const child = spawnLiveProcess();
		try {
			await new Promise((resolve) => child.once('spawn', resolve));
			const { acquireCueEngineLock } = await freshModule();
			writeLock(child.pid!, 'standalone');
			const result = acquireCueEngineLock('desktop');
			expect(result.acquired).toBe(false);
		} finally {
			child.kill();
		}
	});
});

/**
 * Stale-lock TAKEOVER races. The lock token is minted once per process, so a
 * competing engine has to be a real separate process. The module is bundled
 * once with esbuild and driven by long-lived worker processes over request /
 * response files in a control directory: file polling (rather than IPC) is
 * what lets a synchronous test hook block on a competitor finishing while
 * this process sits in the middle of an acquire, touch or release.
 */
describe('cue-engine-lock: simultaneous stale takeover', () => {
	const WORKER_COUNT = 6;
	const RACE_ROUNDS = 25;

	interface Worker {
		child: ChildProcess;
		ctrlDir: string;
		seq: number;
	}
	interface WorkerReply {
		pid: number;
		acquired?: boolean;
		touch?: 'held' | 'lost';
		error?: string;
	}

	let rootDir: string;
	let bundlePath: string;
	let workerPath: string;
	const workers: Worker[] = [];

	const WORKER_SOURCE = `
const fs = require('fs');
const path = require('path');
const lock = require(process.argv[2]);
const ctrlDir = process.argv[3];
const done = new Set();
fs.writeFileSync(path.join(ctrlDir, 'ready'), '');
setInterval(() => {
	for (const name of fs.readdirSync(ctrlDir)) {
		if (!name.startsWith('req-') || !name.endsWith('.json') || done.has(name)) continue;
		done.add(name);
		const req = JSON.parse(fs.readFileSync(path.join(ctrlDir, name), 'utf-8'));
		while (Date.now() < (req.at || 0)) {}
		const reply = { pid: process.pid };
		try {
			if (req.action === 'acquire') reply.acquired = lock.acquireCueEngineLock('standalone', req.dataDir).acquired;
			if (req.action === 'touch') reply.touch = lock.touchCueEngineLock('standalone', req.dataDir);
			if (req.action === 'release') lock.releaseCueEngineLock(req.dataDir);
		} catch (err) {
			// Report instead of dying, so a throw fails the test by name rather than as a timeout.
			reply.error = String((err && err.stack) || err);
		}
		const out = path.join(ctrlDir, name.replace('req-', 'res-'));
		fs.writeFileSync(out + '.tmp', JSON.stringify(reply));
		fs.renameSync(out + '.tmp', out);
	}
}, 2);
`;

	function sleepSync(ms: number): void {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	}

	function sendRequest(worker: Worker, action: string, dataDir: string, at = 0): string {
		const id = `${++worker.seq}`;
		const req = path.join(worker.ctrlDir, `req-${id}.json`);
		fs.writeFileSync(`${req}.tmp`, JSON.stringify({ action, dataDir, at }));
		fs.renameSync(`${req}.tmp`, req);
		return path.join(worker.ctrlDir, `res-${id}.json`);
	}

	/** Blocks this process until the worker answers - for use inside a synchronous lock hook. */
	function requestSync(worker: Worker, action: string, dataDir: string): WorkerReply {
		const res = sendRequest(worker, action, dataDir);
		const deadline = Date.now() + 15_000;
		while (!fs.existsSync(res)) {
			if (Date.now() > deadline) throw new Error(`worker did not answer ${action}`);
			sleepSync(2);
		}
		return JSON.parse(fs.readFileSync(res, 'utf-8'));
	}

	async function request(
		worker: Worker,
		action: string,
		dataDir: string,
		at = 0
	): Promise<WorkerReply> {
		const res = sendRequest(worker, action, dataDir, at);
		const deadline = Date.now() + 15_000;
		while (!fs.existsSync(res)) {
			if (Date.now() > deadline) throw new Error(`worker did not answer ${action}`);
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		return JSON.parse(fs.readFileSync(res, 'utf-8'));
	}

	let round = 0;
	function freshDataDir(): string {
		const dir = path.join(rootDir, `data-${++round}`);
		fs.mkdirSync(dir);
		return dir;
	}

	/** A lock nobody can still own: foreign token, heartbeat ten minutes old. */
	function staleLockBody(): string {
		const old = new Date(Date.now() - 10 * 60_000).toISOString();
		return JSON.stringify({
			pid: 999_999,
			token: 'crashed-engine',
			mode: 'standalone',
			startedAt: old,
			heartbeatAt: old,
		});
	}

	function lockOnDisk(dataDir: string): { pid: number; token: string } {
		return JSON.parse(fs.readFileSync(path.join(dataDir, 'cue-engine.lock'), 'utf-8'));
	}

	beforeAll(async () => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-lock-race-'));
		bundlePath = path.join(rootDir, 'cue-engine-lock.cjs');
		workerPath = path.join(rootDir, 'worker.cjs');
		const esbuild = await import('esbuild');
		esbuild.buildSync({
			entryPoints: [path.resolve(__dirname, '../../../main/cue/cue-engine-lock.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: bundlePath,
			logLevel: 'silent',
		});
		fs.writeFileSync(workerPath, WORKER_SOURCE);
		for (let i = 0; i < WORKER_COUNT; i++) {
			const ctrlDir = path.join(rootDir, `ctrl-${i}`);
			fs.mkdirSync(ctrlDir);
			const child = spawn(process.execPath, [workerPath, bundlePath, ctrlDir], {
				stdio: 'ignore',
			});
			workers.push({ child, ctrlDir, seq: 0 });
		}
		const deadline = Date.now() + 15_000;
		while (!workers.every((w) => fs.existsSync(path.join(w.ctrlDir, 'ready')))) {
			if (Date.now() > deadline) throw new Error('lock workers did not start');
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}, 30_000);

	afterAll(async () => {
		// Wait for every worker to exit before removing its control directory:
		// Windows refuses (EBUSY / EPERM) to delete a directory a dying process
		// is still polling.
		await Promise.all(
			workers.map(
				(w) =>
					new Promise<void>((resolve) => {
						if (w.child.exitCode !== null || w.child.signalCode !== null) return resolve();
						w.child.once('exit', () => resolve());
						w.child.kill();
					})
			)
		);
		fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}, 30_000);

	afterEach(async () => {
		const { __setCueEngineLockTestHook } = await import('../../../main/cue/cue-engine-lock');
		__setCueEngineLockTestHook(undefined);
	});

	/** Every worker acquires at the same wall-clock instant; exactly one may win. */
	async function race(dataDir: string): Promise<void> {
		const at = Date.now() + 40;
		const replies = await Promise.all(workers.map((w) => request(w, 'acquire', dataDir, at)));
		expect(replies.filter((r) => r.error).map((r) => r.error)).toEqual([]);
		const winners = replies.filter((r) => r.acquired);
		expect(winners).toHaveLength(1);
		expect(lockOnDisk(dataDir).pid).toBe(winners[0].pid);
		const leftovers = fs.readdirSync(dataDir).filter((n) => n !== 'cue-engine.lock');
		expect(leftovers).toEqual([]);
	}

	it('exactly one of N engines takes over the same stale lock, every round', async () => {
		for (let i = 0; i < RACE_ROUNDS; i++) {
			const dataDir = freshDataDir();
			fs.writeFileSync(path.join(dataDir, 'cue-engine.lock'), staleLockBody());
			await race(dataDir);
		}
	}, 60_000);

	it('exactly one of N engines takes over a corrupt lock', async () => {
		for (let i = 0; i < 10; i++) {
			const dataDir = freshDataDir();
			fs.writeFileSync(path.join(dataDir, 'cue-engine.lock'), 'not valid json{{{');
			await race(dataDir);
		}
	}, 60_000);

	it('exactly one of N engines creates a lock when none exists', async () => {
		for (let i = 0; i < 10; i++) await race(freshDataDir());
	}, 60_000);

	describe('forced interleavings', () => {
		async function lockModule() {
			return import('../../../main/cue/cue-engine-lock');
		}

		it('backs off when a competitor finishes a takeover after we judged the lock stale', async () => {
			const { acquireCueEngineLock, __setCueEngineLockTestHook } = await lockModule();
			const dataDir = freshDataDir();
			fs.writeFileSync(path.join(dataDir, 'cue-engine.lock'), staleLockBody());
			let competitor: WorkerReply | undefined;
			__setCueEngineLockTestHook((point) => {
				if (point === 'acquireAfterJudgedStale' && !competitor) {
					competitor = requestSync(workers[0], 'acquire', dataDir);
				}
			});

			expect(acquireCueEngineLock('desktop', dataDir).acquired).toBe(false);
			expect(competitor?.acquired).toBe(true);
			expect(lockOnDisk(dataDir).pid).toBe(competitor?.pid);
			await request(workers[0], 'release', dataDir);
		});

		it('a competitor cannot take over while we hold the claim', async () => {
			const { acquireCueEngineLock, __setCueEngineLockTestHook } = await lockModule();
			const dataDir = freshDataDir();
			fs.writeFileSync(path.join(dataDir, 'cue-engine.lock'), staleLockBody());
			let competitor: WorkerReply | undefined;
			__setCueEngineLockTestHook((point) => {
				if (point === 'afterClaim' && !competitor) {
					competitor = requestSync(workers[1], 'acquire', dataDir);
				}
			});

			expect(acquireCueEngineLock('desktop', dataDir).acquired).toBe(true);
			expect(competitor?.acquired).toBe(false);
			expect(lockOnDisk(dataDir).pid).toBe(process.pid);
		});

		it('touch never overwrites a lock created after it found none', async () => {
			const { touchCueEngineLock, __setCueEngineLockTestHook } = await lockModule();
			const dataDir = freshDataDir();
			let competitor: WorkerReply | undefined;
			__setCueEngineLockTestHook((point) => {
				if (point === 'touchAfterRead' && !competitor) {
					competitor = requestSync(workers[2], 'acquire', dataDir);
				}
			});

			expect(touchCueEngineLock('desktop', dataDir)).toBe('lost');
			expect(competitor?.acquired).toBe(true);
			expect(lockOnDisk(dataDir).pid).toBe(competitor?.pid);
			await request(workers[2], 'release', dataDir);
		});

		/** Make our own lock look like a suspended owner's: our token, heartbeat long gone. */
		function ageOurLock(dataDir: string): void {
			const file = path.join(dataDir, 'cue-engine.lock');
			const old = new Date(Date.now() - 10 * 60_000).toISOString();
			const info = JSON.parse(fs.readFileSync(file, 'utf-8'));
			fs.writeFileSync(file, JSON.stringify({ ...info, heartbeatAt: old, startedAt: old }));
		}

		it("touch reports 'lost' when our stale lock is taken over between read and write", async () => {
			const { acquireCueEngineLock, touchCueEngineLock, __setCueEngineLockTestHook } =
				await lockModule();
			const dataDir = freshDataDir();
			expect(acquireCueEngineLock('desktop', dataDir).acquired).toBe(true);
			ageOurLock(dataDir);
			let competitor: WorkerReply | undefined;
			__setCueEngineLockTestHook((point) => {
				if (point === 'touchAfterRead' && !competitor) {
					competitor = requestSync(workers[3], 'acquire', dataDir);
				}
			});

			expect(touchCueEngineLock('desktop', dataDir)).toBe('lost');
			expect(competitor?.acquired).toBe(true);
			expect(lockOnDisk(dataDir).pid).toBe(competitor?.pid);
			await request(workers[3], 'release', dataDir);
		});

		it('release leaves alone a lock taken over between read and remove', async () => {
			const { acquireCueEngineLock, releaseCueEngineLock, __setCueEngineLockTestHook } =
				await lockModule();
			const dataDir = freshDataDir();
			expect(acquireCueEngineLock('desktop', dataDir).acquired).toBe(true);
			ageOurLock(dataDir);
			let competitor: WorkerReply | undefined;
			__setCueEngineLockTestHook((point) => {
				if (point === 'releaseAfterRead' && !competitor) {
					competitor = requestSync(workers[4], 'acquire', dataDir);
				}
			});

			releaseCueEngineLock(dataDir);
			expect(competitor?.acquired).toBe(true);
			expect(lockOnDisk(dataDir).pid).toBe(competitor?.pid);
			await request(workers[4], 'release', dataDir);
		});

		it('steps past an orphaned claim left by an engine killed mid-takeover', async () => {
			const { acquireCueEngineLock } = await lockModule();
			const dataDir = freshDataDir();
			const file = path.join(dataDir, 'cue-engine.lock');
			fs.writeFileSync(file, staleLockBody());
			const crypto = await import('crypto');
			const generation = crypto
				.createHash('sha256')
				.update(fs.readFileSync(file, 'utf-8'))
				.digest('hex')
				.slice(0, 16);
			const orphan = `${file}.claim-${generation}.0`;
			fs.mkdirSync(orphan);
			const longAgo = new Date(Date.now() - 10 * 60_000);
			fs.utimesSync(orphan, longAgo, longAgo);

			expect(acquireCueEngineLock('desktop', dataDir).acquired).toBe(true);
			expect(lockOnDisk(dataDir).pid).toBe(process.pid);
			expect(fs.existsSync(orphan)).toBe(false);
		});
	});
});

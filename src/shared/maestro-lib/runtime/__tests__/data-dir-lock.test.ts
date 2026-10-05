import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	acquireDataDirLock,
	readLiveCliServer,
	RUNTIME_LOCK_FILE_NAME,
	RUNTIME_LOCK_SPEC,
	type DataDirLockDeps,
	type RuntimeLockMode,
} from '../data-dir-lock';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BOOT = T0 - 3_600_000;

describe('data-dir lock', () => {
	let dir: string;
	let now: number;
	let alive: Set<number>;
	let paths: { userDataDir: string; cliServerFile: string };

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dir-lock-test-'));
		now = T0;
		alive = new Set([100, 200, 300]);
		paths = { userDataDir: dir, cliServerFile: path.join(dir, 'cli-server.json') };
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function deps(pid: number, extra: Partial<DataDirLockDeps> = {}): Partial<DataDirLockDeps> {
		return {
			pid,
			now: () => now,
			bootTime: () => BOOT,
			isPidAlive: (p) => alive.has(p),
			hostname: () => 'testhost',
			...extra,
		};
	}

	const lockFile = () => path.join(dir, RUNTIME_LOCK_FILE_NAME);

	function writeDiscovery(pid: number, startedAt = BOOT + 60_000, version?: string) {
		fs.writeFileSync(
			paths.cliServerFile,
			JSON.stringify({
				port: 7000,
				token: 'secret',
				pid,
				startedAt,
				...(version ? { version } : {}),
			})
		);
	}

	function writeLock(pid: number, mode: RuntimeLockMode, extra: Record<string, unknown> = {}) {
		fs.writeFileSync(
			lockFile(),
			JSON.stringify({
				pid,
				mode,
				startedAt: new Date(T0 - 60_000).toISOString(),
				heartbeatAt: new Date(T0 - 5_000).toISOString(),
				bootTime: BOOT,
				...extra,
			})
		);
	}

	it('uses the Cue lock timings and a file beside cli-server.json', () => {
		expect(RUNTIME_LOCK_FILE_NAME).toBe('maestro-runtime.lock');
		expect(RUNTIME_LOCK_SPEC).toMatchObject({
			heartbeatMs: 30_000,
			staleMs: 180_000,
			bootToleranceMs: 60_000,
		});
	});

	it('acquires a free directory and records the mode', () => {
		const result = acquireDataDirLock(paths, 'tui', deps(100));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.lock.mode).toBe('tui');
		expect(result.lock.info).toMatchObject({ pid: 100, mode: 'tui' });
		expect(JSON.parse(fs.readFileSync(lockFile(), 'utf-8'))).toMatchObject({
			pid: 100,
			mode: 'tui',
		});
	});

	describe('cli-server.json', () => {
		it('refuses when it names a live desktop, attachable, writing no lock', () => {
			writeDiscovery(200, BOOT + 60_000, '1.2.3');
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.refusal).toMatchObject({
				reason: 'host-running',
				attachable: true,
				host: { kind: 'desktop', pid: 200, label: 'desktop pid 200', version: '1.2.3' },
			});
			expect(fs.existsSync(lockFile())).toBe(false);
		});

		it('does not refuse for one from an earlier boot, even with a live pid', () => {
			writeDiscovery(200, BOOT - 86_400_000);
			expect(acquireDataDirLock(paths, 'tui', deps(100)).ok).toBe(true);
		});

		it('does not refuse when the pid in it is gone', () => {
			writeDiscovery(200);
			alive.delete(200);
			expect(acquireDataDirLock(paths, 'tui', deps(100)).ok).toBe(true);
		});

		it('does not refuse for a file that is not a discovery record', () => {
			fs.writeFileSync(paths.cliServerFile, '{oops');
			expect(acquireDataDirLock(paths, 'tui', deps(100)).ok).toBe(true);
		});

		it('never treats this process own pid as a rival (a detached host publishes its own file)', () => {
			writeDiscovery(100);
			expect(readLiveCliServer(paths, deps(100) as DataDirLockDeps)).toBeNull();
			expect(acquireDataDirLock(paths, 'host', deps(100)).ok).toBe(true);
		});

		it('names a detached host as headless when the lock agrees', () => {
			writeDiscovery(200);
			writeLock(200, 'host');
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.refusal).toMatchObject({
					reason: 'host-running',
					host: { kind: 'headless', pid: 200 },
				});
			}
		});

		it('step F: releases the lock it just took when a desktop published between D and E', () => {
			let reads = 0;
			const readDiscovery = vi.fn(() => {
				reads += 1;
				if (reads === 1) return undefined;
				return JSON.stringify({ port: 1, token: 't', pid: 200, startedAt: BOOT + 60_000 });
			});
			const result = acquireDataDirLock(paths, 'tui', deps(100, { readDiscovery }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.refusal.reason).toBe('host-running');
			expect(readDiscovery).toHaveBeenCalledTimes(2);
			expect(fs.existsSync(lockFile())).toBe(false);
		});
	});

	describe('a live holder of the lock', () => {
		it('a TUI holder is named, with pid, mode, start time, and host, and the answer is held', () => {
			writeLock(200, 'tui', { host: 'otherbox' });
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.refusal.reason).toBe('held');
			expect(result.refusal.message).toContain('tui pid 200');
			expect(result.refusal.message).toContain(new Date(T0 - 60_000).toISOString());
			expect(result.refusal.message).toContain('otherbox');
			if (result.refusal.reason === 'held') expect(result.refusal.holder.pid).toBe(200);
		});

		it('a desktop holder without cli-server.json is a host that is not attachable yet', () => {
			writeLock(200, 'desktop');
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.refusal).toMatchObject({
					reason: 'host-running',
					attachable: false,
					host: { kind: 'desktop', pid: 200 },
				});
			}
		});

		it('a detached host holder is headless', () => {
			writeLock(200, 'host');
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.refusal).toMatchObject({ host: { kind: 'headless' } });
			}
		});

		it('a stale holder is reclaimed', () => {
			writeLock(200, 'tui');
			alive.delete(200);
			expect(acquireDataDirLock(paths, 'tui', deps(100)).ok).toBe(true);
		});

		it('a holder from an earlier boot is reclaimed even though its pid is alive', () => {
			writeLock(200, 'tui', { bootTime: BOOT - 86_400_000 });
			expect(acquireDataDirLock(paths, 'tui', deps(100)).ok).toBe(true);
		});

		it('two acquires on one directory: the second is refused and names the first', () => {
			const first = acquireDataDirLock(paths, 'tui', deps(100));
			expect(first.ok).toBe(true);
			const second = acquireDataDirLock(paths, 'tui', deps(200));
			expect(second.ok).toBe(false);
			if (!second.ok) expect(second.refusal.message).toContain('tui pid 100');
		});
	});

	it('answers lock-failed, naming the file, when the lock cannot be created', () => {
		const blocked = { userDataDir: path.join(dir, 'file'), cliServerFile: paths.cliServerFile };
		fs.writeFileSync(blocked.userDataDir, 'not a directory');
		const result = acquireDataDirLock(blocked, 'tui', deps(100));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.refusal.reason).toBe('lock-failed');
			expect(result.refusal.message).toContain(RUNTIME_LOCK_FILE_NAME);
		}
	});

	describe('verify, the fence check before a write', () => {
		it('is ok while this process holds the lock and no host is up', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			expect(result.lock.verify()).toEqual({ ok: true });
		});

		it('fails when another process took the lock over', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			now += RUNTIME_LOCK_SPEC.staleMs + 1;
			alive.add(200);
			writeLock(200, 'tui', {
				startedAt: new Date(now).toISOString(),
				heartbeatAt: new Date(now).toISOString(),
			});
			expect(result.lock.verify()).toMatchObject({ ok: false });
		});

		it('fails when the lock file is gone', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			fs.unlinkSync(lockFile());
			expect(result.lock.verify()).toMatchObject({ ok: false });
		});

		it('fails when a desktop starts serving, naming its pid', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			writeDiscovery(200);
			const verdict = result.lock.verify();
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) expect(verdict.reason).toContain('pid 200');
		});
	});

	describe('heartbeat', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('beats the lock on the spec interval and stops on release', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			const onLost = vi.fn();
			const stop = result.lock.startHeartbeat(onLost);
			now += 30_000;
			vi.advanceTimersByTime(30_000);
			expect(JSON.parse(fs.readFileSync(lockFile(), 'utf-8')).heartbeatAt).toBe(
				new Date(now).toISOString()
			);
			expect(onLost).not.toHaveBeenCalled();
			stop();
			result.lock.release();
			expect(fs.existsSync(lockFile())).toBe(false);
		});

		it('reports a desktop that appears, once', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			const onLost = vi.fn();
			result.lock.startHeartbeat(onLost);
			writeDiscovery(200);
			vi.advanceTimersByTime(90_000);
			expect(onLost).toHaveBeenCalledTimes(1);
			expect(onLost.mock.calls[0][0]).toContain('pid 200');
		});

		it('reports a takeover by another runtime', () => {
			const result = acquireDataDirLock(paths, 'tui', deps(100));
			if (!result.ok) throw new Error('expected a lock');
			const onLost = vi.fn();
			result.lock.startHeartbeat(onLost);
			writeLock(200, 'tui', {
				startedAt: new Date(now).toISOString(),
				heartbeatAt: new Date(now).toISOString(),
			});
			vi.advanceTimersByTime(30_000);
			expect(onLost).toHaveBeenCalledWith('Another Maestro took over this data directory.');
		});
	});
});

/**
 * Tests for the desktop's data-dir guard (CO-5).
 *
 * Most cases mock the lock: the guard is a mapping from the lock's answer to
 * "claim, block, or proceed". The last block runs the real lock on a temp
 * directory (never `MAESTRO_USER_DATA`, which points at live data in an agent shell).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claimDataDirForDesktop } from '../../../main/app-lifecycle/data-dir-guard';
import {
	acquireDataDirLock,
	type DataDirLock,
	type DataDirLockResult,
	type RuntimeLockInfo,
} from '../../../shared/maestro-lib';

function fakeLock(): { lock: DataDirLock; release: ReturnType<typeof vi.fn>; stop: () => void } {
	const release = vi.fn();
	const stop = vi.fn();
	const lock: DataDirLock = {
		file: '/data/maestro-runtime.lock',
		mode: 'desktop',
		info: { pid: 1, mode: 'desktop', startedAt: new Date(0).toISOString() },
		verify: () => ({ ok: true }),
		startHeartbeat: vi.fn(() => stop),
		release,
	};
	return { lock, release, stop };
}

const holder = (mode: RuntimeLockInfo['mode'], pid = 4242): RuntimeLockInfo => ({
	pid,
	mode,
	startedAt: '2026-10-04T12:00:00.000Z',
	host: 'laptop',
});

describe('claimDataDirForDesktop (mocked lock)', () => {
	it('hands the held lock to the caller so a runtime can adopt it (DG1)', () => {
		const { lock } = fakeLock();
		const claim = claimDataDirForDesktop('/data', { acquire: () => ({ ok: true, lock }) });
		if (claim.outcome !== 'claimed') throw new Error('expected a claim');
		expect(claim.lock).toBe(lock);
	});

	it('pauses its heartbeat for the adopting runtime and resumes it if the runtime refuses', () => {
		const { lock, stop } = fakeLock();
		const claim = claimDataDirForDesktop('/data', { acquire: () => ({ ok: true, lock }) });
		if (claim.outcome !== 'claimed') throw new Error('expected a claim');
		const startHeartbeat = lock.startHeartbeat as ReturnType<typeof vi.fn>;
		expect(startHeartbeat).toHaveBeenCalledTimes(1);

		claim.pauseHeartbeat();
		claim.pauseHeartbeat();
		expect(stop).toHaveBeenCalledTimes(1);

		claim.resumeHeartbeat();
		claim.resumeHeartbeat();
		expect(startHeartbeat).toHaveBeenCalledTimes(2);
	});

	it('release after a pause releases the lock without stopping a beat that is already stopped', () => {
		const { lock, release, stop } = fakeLock();
		const claim = claimDataDirForDesktop('/data', { acquire: () => ({ ok: true, lock }) });
		if (claim.outcome !== 'claimed') throw new Error('expected a claim');
		claim.pauseHeartbeat();
		claim.release();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it('acquires the lock in mode desktop for the given data dir', () => {
		const { lock } = fakeLock();
		const acquire = vi.fn((): DataDirLockResult => ({ ok: true, lock }));
		const claim = claimDataDirForDesktop('/data', { acquire });

		expect(claim.outcome).toBe('claimed');
		expect(acquire).toHaveBeenCalledTimes(1);
		const [paths, mode] = acquire.mock.calls[0] as unknown as [{ userDataDir: string }, string];
		expect(paths.userDataDir).toBe('/data');
		expect(mode).toBe('desktop');
	});

	it('starts the heartbeat and reports a lost lock through onLost', () => {
		const { lock } = fakeLock();
		const onLost = vi.fn();
		claimDataDirForDesktop('/data', { acquire: () => ({ ok: true, lock }), onLost });

		const beat = (lock.startHeartbeat as ReturnType<typeof vi.fn>).mock.calls[0][0];
		beat('Another Maestro took over this data directory.');
		expect(onLost).toHaveBeenCalledWith('Another Maestro took over this data directory.');
	});

	it('release stops the heartbeat, then releases the lock', () => {
		const { lock, release, stop } = fakeLock();
		const order: string[] = [];
		(lock.startHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(() => {
			stop();
			order.push('stop');
		});
		release.mockImplementation(() => order.push('release'));

		const claim = claimDataDirForDesktop('/data', { acquire: () => ({ ok: true, lock }) });
		if (claim.outcome !== 'claimed') throw new Error('expected a claim');
		claim.release();

		expect(order).toEqual(['stop', 'release']);
	});

	it('blocks on a live TUI and names its pid, start time, and host', () => {
		const claim = claimDataDirForDesktop('/data', {
			acquire: () => ({
				ok: false,
				refusal: { reason: 'held', holder: holder('tui'), message: 'held' },
			}),
		});

		expect(claim.outcome).toBe('blocked');
		if (claim.outcome !== 'blocked') return;
		expect(claim.message).toContain('TUI (pid 4242)');
		expect(claim.message).toContain('Started:');
		expect(claim.message).toContain('Host: laptop');
		expect(claim.message).toContain('Quit that TUI');
	});

	it('blocks on a headless host and says how to stop it', () => {
		const claim = claimDataDirForDesktop('/data', {
			acquire: () => ({
				ok: false,
				refusal: {
					reason: 'host-running',
					attachable: true,
					host: {
						kind: 'headless',
						pid: 812,
						startedAt: 1_700_000_000_000,
						label: 'headless pid 812',
					},
					message: 'running',
				},
			}),
		});

		expect(claim.outcome).toBe('blocked');
		if (claim.outcome !== 'blocked') return;
		expect(claim.message).toContain('pid 812');
		expect(claim.message).toContain('maestro-cli host stop');
	});

	it('proceeds when another desktop holds the directory (the single-instance lock handles it)', () => {
		const claim = claimDataDirForDesktop('/data', {
			acquire: () => ({
				ok: false,
				refusal: {
					reason: 'host-running',
					attachable: true,
					host: { kind: 'desktop', pid: 99, label: 'desktop pid 99' },
					message: 'another desktop',
				},
			}),
		});

		expect(claim).toEqual({ outcome: 'proceed', reason: 'another desktop' });
	});

	it('proceeds when the lock cannot be taken, so a read-only directory does not brick the app', () => {
		const claim = claimDataDirForDesktop('/data', {
			acquire: () => ({
				ok: false,
				refusal: { reason: 'lock-failed', file: '/data/x', detail: 'EACCES', message: 'no lock' },
			}),
		});

		expect(claim).toEqual({ outcome: 'proceed', reason: 'no lock' });
	});
});

describe('claimDataDirForDesktop (real lock, temp dir)', () => {
	let dir: string;
	const releases: Array<() => void> = [];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-data-dir-guard-'));
	});

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('claims a free directory, writes the lock, and removes it on release', () => {
		const claim = claimDataDirForDesktop(dir);
		if (claim.outcome !== 'claimed') throw new Error(`expected a claim, got ${claim.outcome}`);
		releases.push(claim.release);

		const lockFile = path.join(dir, 'maestro-runtime.lock');
		expect(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).mode).toBe('desktop');

		claim.release();
		expect(fs.existsSync(lockFile)).toBe(false);
	});

	it('is blocked by a TUI that already holds the directory, and leaves its lock alone', () => {
		const tui = acquireDataDirLock(
			{ userDataDir: dir, cliServerFile: path.join(dir, 'cli-server.json') },
			'tui',
			// The parent pid: a live process that is not this one, so the lock reads as another live holder.
			{ pid: process.ppid, isPidAlive: () => true }
		);
		if (!tui.ok) throw new Error('the TUI should have taken a free directory');
		releases.push(() => tui.lock.release());

		const claim = claimDataDirForDesktop(dir);

		expect(claim.outcome).toBe('blocked');
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'maestro-runtime.lock'), 'utf-8')).mode).toBe(
			'tui'
		);
	});
});

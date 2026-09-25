// @vitest-environment node
/**
 * Tests for src/shared/processIdentity.ts
 *
 * Uses real child processes: the point of the module is to tell a live
 * process from a dead one and from an unrelated one that inherited its pid,
 * which a mocked `process.kill` cannot demonstrate on its own.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import {
	currentProcessIdentity,
	isCurrentProcess,
	probeProcess,
	readProcessStartToken,
	resetProcessIdentityCacheForTests,
} from '../../shared/processIdentity';

const tokensSupported = process.platform === 'linux' || process.platform === 'darwin';

function spawnSleeper(): ChildProcess {
	return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once('exit', () => resolve());
	});
}

describe('processIdentity', () => {
	const children: ChildProcess[] = [];

	beforeEach(() => {
		resetProcessIdentityCacheForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const child of children.splice(0)) {
			child.kill('SIGKILL');
			await exited(child);
		}
	});

	describe('currentProcessIdentity', () => {
		it('names the calling process', () => {
			const identity = currentProcessIdentity();
			expect(identity.pid).toBe(process.pid);
			expect(isCurrentProcess(identity)).toBe(true);
		});

		it.runIf(tokensSupported)('carries a start token on POSIX platforms', () => {
			const identity = currentProcessIdentity();
			expect(identity.startToken).toBeTruthy();
			expect(readProcessStartToken(process.pid)).toBe(identity.startToken);
		});

		it.runIf(process.platform === 'linux')(
			'reads the Linux token as the numeric starttime field',
			() => {
				expect(currentProcessIdentity().startToken).toMatch(/^\d+$/);
			}
		);
	});

	describe('isCurrentProcess', () => {
		it('rejects another pid', () => {
			expect(isCurrentProcess({ pid: process.pid + 1 })).toBe(false);
		});

		it.runIf(tokensSupported)('rejects our pid with a different start token', () => {
			expect(isCurrentProcess({ pid: process.pid, startToken: 'not-our-start-time' })).toBe(false);
		});
	});

	describe('probeProcess', () => {
		it('reports the calling process as alive', () => {
			expect(probeProcess(currentProcessIdentity())).toBe('alive');
		});

		it.each([0, -1, 1.5, Number.NaN])('treats pid %s as dead without probing it', (pid) => {
			// kill(0) / kill(-1) address process groups and would "succeed".
			const kill = vi.spyOn(process, 'kill');
			expect(probeProcess({ pid })).toBe('dead');
			expect(kill).not.toHaveBeenCalled();
		});

		it('reports a running child as alive and an exited one as dead', async () => {
			const child = spawnSleeper();
			children.push(child);
			const pid = child.pid!;
			const identity = { pid, startToken: readProcessStartToken(pid) ?? undefined };

			expect(probeProcess(identity)).toBe('alive');

			child.kill('SIGKILL');
			await exited(child);
			expect(probeProcess(identity)).toBe('dead');
		});

		it.runIf(tokensSupported)(
			'reports a recycled pid (live process, different start token) as dead',
			() => {
				const child = spawnSleeper();
				children.push(child);
				// The pid is alive, but the record says it belongs to a process that
				// started at a different time: exactly what a crash + pid reuse leaves.
				expect(probeProcess({ pid: child.pid!, startToken: '1' })).toBe('dead');
			}
		);

		it('falls back to pid existence for records without a token (older builds, Windows)', () => {
			const child = spawnSleeper();
			children.push(child);
			expect(probeProcess({ pid: child.pid! })).toBe('alive');
		});

		it('treats EPERM as alive: the pid exists under another user', () => {
			vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
			});
			expect(probeProcess({ pid: 999_999 })).toBe('alive');
		});

		it('treats ESRCH as dead', () => {
			vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
			});
			expect(probeProcess({ pid: 999_999 })).toBe('dead');
		});

		it('reports an unexplained probe failure as unknown, never dead', () => {
			vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('EIO'), { code: 'EIO' });
			});
			expect(probeProcess({ pid: 999_999, startToken: 'x' })).toBe('unknown');
		});
	});
});

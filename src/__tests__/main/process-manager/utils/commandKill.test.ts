/**
 * Tests for commandKill - how Stop actually terminates a command.
 *
 * The contract is deliberately blunt: SIGKILL the whole tree, synchronously,
 * with no grace period. Everything here defends one of the three ways a command
 * previously escaped:
 *
 *  - a catchable signal (SIGHUP/SIGTERM) that the target simply ignored
 *  - killing only the process group, while job control had moved the real job
 *    into a group of its own
 *  - snapshotting descendants AFTER the parent died, by which point they have
 *    been re-parented to launchd and are unfindable by ppid
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecFileSync, mockExecFile, mockIsWindows } = vi.hoisted(() => ({
	mockExecFileSync: vi.fn(() => ''),
	mockExecFile: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
	mockIsWindows: vi.fn(() => false),
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileSyncNoThrow: mockExecFileSync,
	execFileNoThrow: mockExecFile,
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mockIsWindows,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
	killProcessTreeNow,
	sweepStragglers,
} from '../../../../main/process-manager/utils/commandKill';

const PID = 4242;
const CTX = { sessionId: 's1' };

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockIsWindows.mockReturnValue(false);
	mockExecFileSync.mockReturnValue('');
	killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
	killSpy.mockRestore();
});

describe('killProcessTreeNow', () => {
	it('uses SIGKILL - never a signal the target can ignore', () => {
		killProcessTreeNow(PID, CTX);

		const signals = killSpy.mock.calls.map((c) => c[1]);
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((s) => s === 'SIGKILL')).toBe(true);
		expect(signals).not.toContain('SIGTERM');
		expect(signals).not.toContain('SIGHUP');
		expect(signals).not.toContain('SIGINT');
	});

	it('kills BOTH the process group and the pid itself', () => {
		// Not either/or. `kill(-pid)` succeeding only proves *something* in that
		// group was signalled; an interactive shell with job control keeps itself
		// in that group while the real job runs in a new one.
		killProcessTreeNow(PID, CTX);

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(PID, 'SIGKILL');
	});

	it('kills descendants, and does so BEFORE their parent', () => {
		// 4242 -> 5000 -> 6000, plus an unrelated 7777.
		mockExecFileSync.mockReturnValue(`${PID} 1\n5000 ${PID}\n6000 5000\n7777 1\n`);

		killProcessTreeNow(PID, CTX);

		const order = killSpy.mock.calls.map((c) => c[0]);
		expect(order).toContain(5000);
		expect(order).toContain(6000);
		// Deepest first, parent last - nothing gets to fork a replacement.
		expect(order.indexOf(6000)).toBeLessThan(order.indexOf(5000));
		expect(order.indexOf(5000)).toBeLessThan(order.indexOf(PID));
		// An unrelated process must never be touched.
		expect(order).not.toContain(7777);
	});

	it('reads the process table BEFORE issuing any kill', () => {
		// The whole reason the read is synchronous: once the parent dies its
		// children are re-parented and can no longer be found by ppid.
		const events: string[] = [];
		mockExecFileSync.mockImplementation(() => {
			events.push('read');
			return `${PID} 1\n5000 ${PID}\n`;
		});
		killSpy.mockImplementation(() => {
			events.push('kill');
			return true;
		});

		killProcessTreeNow(PID, CTX);

		expect(events[0]).toBe('read');
		expect(events).toContain('kill');
	});

	it('still kills the tree when the process table is unreadable', () => {
		mockExecFileSync.mockReturnValue('');

		killProcessTreeNow(PID, CTX);

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(PID, 'SIGKILL');
	});

	it('swallows an already-dead process', () => {
		killSpy.mockImplementation(() => {
			throw Object.assign(new Error('gone'), { code: 'ESRCH' });
		});

		expect(() => killProcessTreeNow(PID, CTX)).not.toThrow();
	});

	it('ignores a missing or invalid pid', () => {
		killProcessTreeNow(0, CTX);
		killProcessTreeNow(-1, CTX);

		expect(killSpy).not.toHaveBeenCalled();
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	it('uses taskkill /t /f on Windows, which has no process groups', () => {
		mockIsWindows.mockReturnValue(true);

		killProcessTreeNow(PID, CTX);

		expect(killSpy).not.toHaveBeenCalled();
		expect(mockExecFileSync).toHaveBeenCalledWith('taskkill', ['/pid', String(PID), '/t', '/f']);
	});

	it('is synchronous - the caller can settle the UI on the next line', () => {
		mockExecFileSync.mockReturnValue(`${PID} 1\n5000 ${PID}\n`);

		killProcessTreeNow(PID, CTX);

		// Every kill has already happened by the time the call returns; nothing
		// is deferred to a timer or a promise.
		expect(killSpy).toHaveBeenCalledWith(5000, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(PID, 'SIGKILL');
	});
});

describe('sweepStragglers', () => {
	it('kills a leftover child without blocking the caller', async () => {
		mockExecFile.mockResolvedValue({
			stdout: `9001 ${PID}\n9002 1\n`,
			stderr: '',
			exitCode: 0,
		});

		sweepStragglers(PID); // returns void, never awaited by production code
		await new Promise((r) => setTimeout(r, 0));

		expect(killSpy).toHaveBeenCalledWith(9001, 'SIGKILL');
		expect(killSpy).not.toHaveBeenCalledWith(9002, 'SIGKILL');
	});
});

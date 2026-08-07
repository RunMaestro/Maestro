/**
 * Tests for commandKill - how a one-off command is actually terminated.
 *
 * Two things here are load-bearing and were the bug:
 *  - the SIGNAL: node-pty's default is SIGHUP, which an interactive login shell
 *    (what these commands run under, so aliases resolve) survives on macOS, so
 *    Stop silently did nothing.
 *  - the TARGET: signalling only the shell leaves the actual command running,
 *    and a surviving grandchild holds the pty slave open so no exit is ever
 *    reported - the card sits on "Running..." forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecFile, mockIsWindows } = vi.hoisted(() => ({
	mockExecFile: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
	mockIsWindows: vi.fn(() => false),
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: mockExecFile,
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mockIsWindows,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
	signalProcessTree,
	terminateProcessTree,
	COMMAND_KILL_ESCALATION_MS,
} from '../../../../main/process-manager/utils/commandKill';

const PID = 4242;

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mockIsWindows.mockReturnValue(false);
	killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
	killSpy.mockRestore();
	vi.useRealTimers();
});

describe('signalProcessTree', () => {
	it('signals the whole process group, not just the pid', () => {
		// Negative pid = process group. This is what reaches the command itself
		// and anything it spawned, rather than only the wrapping shell.
		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
	});

	it('falls back to the bare pid when the group signal fails', () => {
		killSpy.mockImplementationOnce(() => {
			throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
		});

		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).toHaveBeenNthCalledWith(1, -PID, 'SIGTERM');
		expect(killSpy).toHaveBeenNthCalledWith(2, PID, 'SIGTERM');
	});

	it('swallows a fully-dead process', () => {
		killSpy.mockImplementation(() => {
			throw Object.assign(new Error('gone'), { code: 'ESRCH' });
		});

		expect(() => signalProcessTree(PID, 'SIGKILL')).not.toThrow();
	});

	it('ignores a missing or invalid pid', () => {
		signalProcessTree(0, 'SIGTERM');
		signalProcessTree(-1, 'SIGTERM');

		expect(killSpy).not.toHaveBeenCalled();
	});

	it('uses taskkill /t /f on Windows, which has no process groups', () => {
		mockIsWindows.mockReturnValue(true);

		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).not.toHaveBeenCalled();
		expect(mockExecFile).toHaveBeenCalledWith('taskkill', ['/pid', String(PID), '/t', '/f']);
	});
});

describe('terminateProcessTree', () => {
	it('sends SIGTERM immediately - NOT SIGHUP, which shells survive', () => {
		terminateProcessTree(PID, { sessionId: 's1' });

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
		expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGHUP');
		expect(killSpy).not.toHaveBeenCalledWith(PID, 'SIGHUP');
	});

	it('escalates to SIGKILL when the process ignores SIGTERM', () => {
		terminateProcessTree(PID, { sessionId: 's1' });
		expect(killSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(COMMAND_KILL_ESCALATION_MS);

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
	});

	it('does not escalate once the caller reports the process exited', () => {
		// Critical: a late SIGKILL against a recycled pid would kill an unrelated
		// process, so the exit handler must be able to call this off.
		const cancel = terminateProcessTree(PID, { sessionId: 's1' });
		cancel();

		vi.advanceTimersByTime(COMMAND_KILL_ESCALATION_MS * 4);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL');
	});

	it('escalates promptly - Stop should not feel like it hung', () => {
		expect(COMMAND_KILL_ESCALATION_MS).toBeLessThanOrEqual(2000);
	});
});

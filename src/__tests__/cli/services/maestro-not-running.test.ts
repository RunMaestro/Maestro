/**
 * The "desktop app is absent" outcome: the typed error, its exit code, and the
 * one reporter every app-dependent verb routes it through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import {
	MaestroNotRunningError,
	MAESTRO_NOT_RUNNING_CODE,
	MAESTRO_NOT_RUNNING_MESSAGE,
} from '../../../cli/services/maestro-not-running';
import { CommandTimeoutError, UnsupportedCommandError } from '../../../cli/services/maestro-client';
import { ExitCode, exitCodeForError } from '../../../cli/exit-codes';
import { exitIfMaestroNotRunning, failFromError } from '../../../cli/services/session-command';

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

describe('MaestroNotRunningError', () => {
	it('carries one message and code whatever the cause', () => {
		for (const reason of [
			'no-discovery-file',
			'stale-discovery-file',
			'connect-timeout',
			'connect-failed',
		] as const) {
			const error = new MaestroNotRunningError(reason, 'detail');
			expect(error.message).toBe(MAESTRO_NOT_RUNNING_MESSAGE);
			expect(error.code).toBe(MAESTRO_NOT_RUNNING_CODE);
			expect(error.reason).toBe(reason);
		}
	});
});

describe('exitCodeForError', () => {
	it('maps an absent app to NotRunning (3)', () => {
		expect(exitCodeForError(new MaestroNotRunningError('connect-timeout'))).toBe(
			ExitCode.NotRunning
		);
	});

	it('does not read an absent app into an ordinary error that merely says so', () => {
		expect(exitCodeForError(new Error(MAESTRO_NOT_RUNNING_MESSAGE))).toBe(ExitCode.GeneralError);
	});

	it('keeps the existing Unsupported and Timeout mappings', () => {
		expect(exitCodeForError(new UnsupportedCommandError('x'))).toBe(ExitCode.Unsupported);
		expect(exitCodeForError(new CommandTimeoutError('x'))).toBe(ExitCode.Timeout);
	});
});

describe('not-running reporter', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new ExitSignal(code as number | undefined);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const absent = () => new MaestroNotRunningError('no-discovery-file');

	describe('exitIfMaestroNotRunning', () => {
		it('prints the message on stderr and exits 3 for human output', () => {
			expect(() => exitIfMaestroNotRunning(absent())).toThrow(ExitSignal);
			expect(exitSpy).toHaveBeenCalledWith(3);
			expect(String(errorSpy.mock.calls[0][0])).toContain(MAESTRO_NOT_RUNNING_MESSAGE);
			expect(logSpy).not.toHaveBeenCalled();
		});

		it('prints the JSON envelope with the code on stdout', () => {
			expect(() => exitIfMaestroNotRunning(absent(), { json: true })).toThrow(ExitSignal);
			expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
				success: false,
				error: MAESTRO_NOT_RUNNING_MESSAGE,
				code: 'MAESTRO_NOT_RUNNING',
			});
			expect(exitSpy).toHaveBeenCalledWith(3);
		});

		it("keeps a verb's own envelope fields and stream", () => {
			expect(() =>
				exitIfMaestroNotRunning(absent(), {
					json: true,
					jsonExtra: { type: 'error' },
					stderrJson: true,
				})
			).toThrow(ExitSignal);
			expect(logSpy).not.toHaveBeenCalled();
			expect(JSON.parse(errorSpy.mock.calls[0][0])).toEqual({
				type: 'error',
				success: false,
				error: MAESTRO_NOT_RUNNING_MESSAGE,
				code: 'MAESTRO_NOT_RUNNING',
			});
		});

		it('returns without printing for any other error, so the caller handles it as before', () => {
			exitIfMaestroNotRunning(new Error('Connection closed (code=1006)'), { json: true });
			exitIfMaestroNotRunning(new UnsupportedCommandError('x'));
			exitIfMaestroNotRunning('a string');
			expect(exitSpy).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});
	});

	describe('failFromError', () => {
		it('reports an absent app as the one outcome', () => {
			expect(() => failFromError(absent(), true)).toThrow(ExitSignal);
			expect(JSON.parse(logSpy.mock.calls[0][0]).code).toBe('MAESTRO_NOT_RUNNING');
			expect(exitSpy).toHaveBeenCalledWith(3);
		});

		it('reports any other error with its own message and typed exit code', () => {
			expect(() => failFromError(new CommandTimeoutError('pong'), true)).toThrow(ExitSignal);
			const payload = JSON.parse(logSpy.mock.calls[0][0]);
			expect(payload.success).toBe(false);
			expect(payload.code).toBeUndefined();
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.Timeout);
		});

		it('exits 1 for an ordinary error', () => {
			expect(() => failFromError(new Error('boom'))).toThrow(ExitSignal);
			expect(String(errorSpy.mock.calls[0][0])).toBe('Error: boom');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});

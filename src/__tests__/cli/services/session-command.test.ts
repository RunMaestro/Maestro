/**
 * @file session-command.test.ts
 * @description The shared failure reporters every bridge verb ends in:
 * `failCommand` prints the error in the verb's output mode and exits with the
 * code it is given, and `failFromError` picks that code from the failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { ExitCode } from '../../../cli/exit-codes';
import {
	CommandTimeoutError,
	MaestroNotRunningError,
	UnsupportedCommandError,
} from '../../../cli/services/maestro-bridge-errors';
import { failCommand, failFromError } from '../../../cli/services/session-command';

describe('failCommand and failFromError', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints the error on stderr for a person and exits with the general failure', () => {
		expect(() => failCommand('Nope', false)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(errorSpy.mock.calls[0][0]).toContain('Nope');
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('prints one JSON object on stdout under --json', () => {
		expect(() => failCommand('Nope', true, ExitCode.InvalidUsage)).toThrow(
			`exit:${ExitCode.InvalidUsage}`
		);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ success: false, error: 'Nope' });
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('exits with the code the failure names', () => {
		expect(() => failFromError(new MaestroNotRunningError('closed'), true)).toThrow(
			`exit:${ExitCode.NotRunning}`
		);
		expect(() => failFromError(new UnsupportedCommandError('x'), true)).toThrow(
			`exit:${ExitCode.Unsupported}`
		);
		expect(() => failFromError(new CommandTimeoutError('x_result'), true)).toThrow(
			`exit:${ExitCode.Timeout}`
		);
		expect(() => failFromError(new Error('plain'), true)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(() => failFromError('a string', true)).toThrow(`exit:${ExitCode.GeneralError}`);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: false,
			error: 'a string',
		});
	});
});

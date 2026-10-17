/**
 * @file exit-codes.test.ts
 * @description The exit code a failure reports: a script branches on it, so a
 * closed app, an old build and a hung renderer must each name themselves.
 */

import { describe, it, expect } from 'vitest';
import { ExitCode, exitCodeForError } from '../../cli/exit-codes';
import {
	CommandTimeoutError,
	MaestroNotRunningError,
	UnsupportedCommandError,
} from '../../cli/services/maestro-bridge-errors';
import { SIGINT_EXIT_CODE } from '../../cli/utils/interrupt';

describe('exitCodeForError', () => {
	it('names a closed app, an old build and a hung renderer', () => {
		expect(exitCodeForError(new MaestroNotRunningError('not running'))).toBe(ExitCode.NotRunning);
		expect(exitCodeForError(new UnsupportedCommandError('some_command'))).toBe(
			ExitCode.Unsupported
		);
		expect(exitCodeForError(new CommandTimeoutError('some_result'))).toBe(ExitCode.Timeout);
	});

	it('leaves everything else the general failure', () => {
		expect(exitCodeForError(new Error('boom'))).toBe(ExitCode.GeneralError);
		expect(exitCodeForError('boom')).toBe(ExitCode.GeneralError);
	});
});

describe('ExitCode.Interrupted', () => {
	it('is the shell convention for SIGINT, and the interrupt handler exits with it', () => {
		expect(ExitCode.Interrupted).toBe(130);
		expect(SIGINT_EXIT_CODE).toBe(ExitCode.Interrupted);
	});
});

import { describe, expect, it } from 'vitest';

import { execFileNoThrow, needsWindowsShell } from '../../main/utils/execFile';

describe('execFile utility integration', () => {
	it('classifies Windows shell requirements without invoking a shell', () => {
		expect(needsWindowsShell('script.cmd')).toBe(true);
		expect(needsWindowsShell('SCRIPT.BAT')).toBe(true);
		expect(needsWindowsShell('git')).toBe(false);
		expect(needsWindowsShell('C:\\Program Files\\nodejs\\node')).toBe(false);
		expect(needsWindowsShell('tool.exe')).toBe(false);
		expect(needsWindowsShell('helper.COM')).toBe(false);
		expect(needsWindowsShell('custom-tool')).toBe(true);
		expect(needsWindowsShell('/usr/local/bin/custom-tool.py')).toBe(false);
	});

	it('writes stdin through spawn and preserves stderr from non-zero exits', async () => {
		const result = await execFileNoThrow(
			process.execPath,
			[
				'-e',
				[
					"process.stdin.setEncoding('utf8')",
					"let input = ''",
					"process.stdin.on('data', chunk => { input += chunk })",
					"process.stdin.on('end', () => {",
					'  process.stdout.write(input.toUpperCase())',
					"  process.stderr.write('intentional stderr')",
					'  process.exit(3)',
					'})',
				].join(';'),
			],
			undefined,
			{ input: 'queued input' }
		);

		expect(result).toEqual({
			stdout: 'QUEUED INPUT',
			stderr: 'intentional stderr',
			exitCode: 3,
		});
	});

	it('executes without stdin and supports the legacy environment options signature', async () => {
		const result = await execFileNoThrow(
			process.execPath,
			['-e', "process.stdout.write(process.env.MAESTRO_EXEC_FILE_TEST || '')"],
			undefined,
			{ MAESTRO_EXEC_FILE_TEST: 'env-ok' }
		);

		expect(result).toEqual({
			stdout: 'env-ok',
			stderr: '',
			exitCode: 0,
		});
	});

	it('returns stdout, stderr, and exit code from non-stdin command failures', async () => {
		const result = await execFileNoThrow(process.execPath, [
			'-e',
			"process.stdout.write('partial'); process.stderr.write('problem'); process.exit(4)",
		]);

		expect(result).toEqual({
			stdout: 'partial',
			stderr: 'problem',
			exitCode: 4,
		});
	});

	it('returns ETIMEDOUT when non-stdin commands exceed the timeout', async () => {
		const result = await execFileNoThrow(
			process.execPath,
			['-e', 'setTimeout(() => {}, 1000)'],
			undefined,
			{ timeout: 10 }
		);

		expect(result.exitCode).toBe('ETIMEDOUT');
		expect(result.stderr).toContain('ETIMEDOUT: process timed out after 10ms');
	});

	it('returns ETIMEDOUT when stdin-mode processes exceed the timeout', async () => {
		const result = await execFileNoThrow(
			process.execPath,
			['-e', 'setTimeout(() => {}, 1000)'],
			undefined,
			{ input: 'ignored', timeout: 10 }
		);

		expect(result.exitCode).toBe('ETIMEDOUT');
		expect(result.stderr).toContain('ETIMEDOUT: process timed out after 10ms');
	});

	it('returns spawn errors and clears the timeout timer', async () => {
		const result = await execFileNoThrow('/definitely/missing/maestro-command', [], undefined, {
			input: 'ignored',
			timeout: 1000,
		});

		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('ENOENT');
		expect(result.exitCode).toBe(1);
	});
});

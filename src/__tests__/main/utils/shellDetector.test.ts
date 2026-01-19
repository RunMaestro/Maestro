import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock execFile before importing shellDetector
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

import { detectShells, getShellCommand } from '../../../main/utils/shellDetector';
import { execFileNoThrow } from '../../../main/utils/execFile';

const mockedExecFileNoThrow = vi.mocked(execFileNoThrow);

describe('shellDetector', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('detectShells', () => {
		it('should detect all available shells', async () => {
			// Mock all shells as available
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/zsh\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells).toHaveLength(5);
			expect(shells.every((s) => s.available)).toBe(true);
		});

		it('should return the correct shell IDs', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/shell\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();
			const ids = shells.map((s) => s.id);

			expect(ids).toEqual(['zsh', 'bash', 'sh', 'fish', 'tcsh']);
		});

		it('should return the correct shell names', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/shell\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();
			const names = shells.map((s) => s.name);

			expect(names).toEqual(['Zsh', 'Bash', 'Bourne Shell (sh)', 'Fish', 'Tcsh']);
		});

		it('should handle shells that are not available', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});

			const shells = await detectShells();

			expect(shells.every((s) => !s.available)).toBe(true);
			expect(shells.every((s) => s.path === undefined)).toBe(true);
		});

		it('should extract the correct path from stdout', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/opt/homebrew/bin/zsh\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells[0].path).toBe('/opt/homebrew/bin/zsh');
		});

		it('should take the first result when multiple paths are returned', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/opt/homebrew/bin/bash\n/usr/bin/bash\n/bin/bash\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells[1].path).toBe('/opt/homebrew/bin/bash');
		});

		it('should handle mixed availability', async () => {
			mockedExecFileNoThrow
				.mockResolvedValueOnce({
					stdout: '/bin/zsh\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '/bin/bash\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'not found',
					exitCode: 1,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'not found',
					exitCode: 1,
				})
				.mockResolvedValueOnce({
					stdout: '/bin/tcsh\n',
					stderr: '',
					exitCode: 0,
				});

			const shells = await detectShells();

			expect(shells[0].available).toBe(true);
			expect(shells[0].path).toBe('/bin/zsh');
			expect(shells[1].available).toBe(true);
			expect(shells[1].path).toBe('/bin/bash');
			expect(shells[2].available).toBe(false);
			expect(shells[2].path).toBeUndefined();
			expect(shells[3].available).toBe(false);
			expect(shells[3].path).toBeUndefined();
			expect(shells[4].available).toBe(true);
			expect(shells[4].path).toBe('/bin/tcsh');
		});

		it('should use which command on non-Windows platforms', async () => {
			// Store original platform
			const originalPlatform = process.platform;
			// Mock as darwin
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/zsh\n',
				stderr: '',
				exitCode: 0,
			});

			await detectShells();

			expect(mockedExecFileNoThrow).toHaveBeenCalledWith('which', ['zsh']);

			// Restore original platform
			Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
		});

		it('should use where command on Windows', async () => {
			// Store original platform
			const originalPlatform = process.platform;
			// Mock as win32
			Object.defineProperty(process, 'platform', { value: 'win32', writable: true });

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: 'C:\\Windows\\System32\\powershell.exe\n',
				stderr: '',
				exitCode: 0,
			});

			await detectShells();

			// On Windows, the first shell is powershell.exe
			expect(mockedExecFileNoThrow).toHaveBeenCalledWith('where', ['powershell.exe']);

			// Restore original platform
			Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
		});

		it('should handle empty stdout with zero exit code', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			// Empty stdout means shell is not available
			expect(shells.every((s) => !s.available)).toBe(true);
		});

		it('should handle whitespace-only stdout', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '   \n  \n  ',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			// Whitespace-only stdout means shell is not available
			expect(shells.every((s) => !s.available)).toBe(true);
		});

		it('should call execFileNoThrow for each shell', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/shell\n',
				stderr: '',
				exitCode: 0,
			});

			await detectShells();

			expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(5);
		});

		it('should handle exceptions from execFileNoThrow', async () => {
			mockedExecFileNoThrow.mockRejectedValue(new Error('Command failed'));

			const shells = await detectShells();

			// Exception means shell is not available
			expect(shells.every((s) => !s.available)).toBe(true);
			expect(shells.every((s) => s.path === undefined)).toBe(true);
		});

		it('should handle partial exceptions', async () => {
			mockedExecFileNoThrow
				.mockResolvedValueOnce({
					stdout: '/bin/zsh\n',
					stderr: '',
					exitCode: 0,
				})
				.mockRejectedValueOnce(new Error('Command failed'))
				.mockResolvedValueOnce({
					stdout: '/bin/sh\n',
					stderr: '',
					exitCode: 0,
				})
				.mockRejectedValueOnce(new Error('Command failed'))
				.mockResolvedValueOnce({
					stdout: '/bin/tcsh\n',
					stderr: '',
					exitCode: 0,
				});

			const shells = await detectShells();

			expect(shells[0].available).toBe(true);
			expect(shells[1].available).toBe(false);
			expect(shells[2].available).toBe(true);
			expect(shells[3].available).toBe(false);
			expect(shells[4].available).toBe(true);
		});
	});

	describe('getShellCommand', () => {
		describe('on Unix-like platforms', () => {
			const originalPlatform = process.platform;

			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
			});

			afterEach(() => {
				Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
			});

			it('should return the shell ID directly for zsh', () => {
				expect(getShellCommand('zsh')).toBe('zsh');
			});

			it('should return the shell ID directly for bash', () => {
				expect(getShellCommand('bash')).toBe('bash');
			});

			it('should return the shell ID directly for sh', () => {
				expect(getShellCommand('sh')).toBe('sh');
			});

			it('should return the shell ID directly for fish', () => {
				expect(getShellCommand('fish')).toBe('fish');
			});

			it('should return the shell ID directly for tcsh', () => {
				expect(getShellCommand('tcsh')).toBe('tcsh');
			});

			it('should return any shell ID directly for unknown shells', () => {
				expect(getShellCommand('custom-shell')).toBe('custom-shell');
			});
		});

		describe('on Windows', () => {
			const originalPlatform = process.platform;

			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
			});

			afterEach(() => {
				Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
			});

			it('should return bash.exe for sh on Windows', () => {
				expect(getShellCommand('sh')).toBe('bash.exe');
			});

			it('should return bash.exe for bash on Windows', () => {
				expect(getShellCommand('bash')).toBe('bash.exe');
			});

			it('should return powershell.exe for zsh on Windows', () => {
				expect(getShellCommand('zsh')).toBe('powershell.exe');
			});

			it('should return powershell.exe for fish on Windows', () => {
				expect(getShellCommand('fish')).toBe('powershell.exe');
			});

			it('should return powershell.exe for tcsh on Windows', () => {
				expect(getShellCommand('tcsh')).toBe('powershell.exe');
			});

			it('should return powershell.exe for unknown shells on Windows', () => {
				expect(getShellCommand('custom-shell')).toBe('powershell.exe');
			});
		});

		describe('on Linux', () => {
			const originalPlatform = process.platform;

			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
			});

			afterEach(() => {
				Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
			});

			it('should return the shell ID directly on Linux', () => {
				expect(getShellCommand('zsh')).toBe('zsh');
				expect(getShellCommand('bash')).toBe('bash');
				expect(getShellCommand('sh')).toBe('sh');
			});
		});
	});

	describe('ShellInfo type', () => {
		it('should return ShellInfo objects with all required properties', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/zsh\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			for (const shell of shells) {
				expect(shell).toHaveProperty('id');
				expect(shell).toHaveProperty('name');
				expect(shell).toHaveProperty('available');
				expect(typeof shell.id).toBe('string');
				expect(typeof shell.name).toBe('string');
				expect(typeof shell.available).toBe('boolean');
			}
		});

		it('should include path property only when available', async () => {
			mockedExecFileNoThrow
				.mockResolvedValueOnce({
					stdout: '/bin/zsh\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 1,
				})
				.mockResolvedValueOnce({
					stdout: '/bin/sh\n',
					stderr: '',
					exitCode: 0,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 1,
				})
				.mockResolvedValueOnce({
					stdout: '',
					stderr: '',
					exitCode: 1,
				});

			const shells = await detectShells();

			expect(shells[0].path).toBe('/bin/zsh');
			expect(shells[1].path).toBeUndefined();
			expect(shells[2].path).toBe('/bin/sh');
			expect(shells[3].path).toBeUndefined();
			expect(shells[4].path).toBeUndefined();
		});
	});

	describe('edge cases', () => {
		it('should handle paths with spaces', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/Users/My User/bin/zsh\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells[0].path).toBe('/Users/My User/bin/zsh');
		});

		it('should handle paths with special characters', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: "/Users/user's-shell/bin/zsh\n",
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells[0].path).toBe("/Users/user's-shell/bin/zsh");
		});

		it('should handle Windows-style paths', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', writable: true });

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: 'C:\\Program Files\\Git\\bin\\bash.exe\r\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			// Windows paths can have \r\n line endings, trim handles this
			expect(shells[0].path).toBe('C:\\Program Files\\Git\\bin\\bash.exe');

			Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
		});

		it('should handle very long paths', async () => {
			const longPath = '/a'.repeat(1000) + '/zsh';
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: longPath + '\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			expect(shells[0].path).toBe(longPath);
		});

		it('should handle stderr with content but zero exit code', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/zsh\n',
				stderr: 'warning: something happened',
				exitCode: 0,
			});

			const shells = await detectShells();

			// Should still be available if stdout has path and exit code is 0
			expect(shells[0].available).toBe(true);
			expect(shells[0].path).toBe('/bin/zsh');
		});

		it('should handle newline variations', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/bin/zsh\r\n',
				stderr: '',
				exitCode: 0,
			});

			const shells = await detectShells();

			// Trim should handle \r\n
			expect(shells[0].path).toBe('/bin/zsh');
		});
	});
});

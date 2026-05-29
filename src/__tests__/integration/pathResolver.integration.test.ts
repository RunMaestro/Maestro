import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAccessSync, mockIsWindows } = vi.hoisted(() => ({
	mockAccessSync: vi.fn(),
	mockIsWindows: vi.fn(),
}));

vi.mock('fs', () => ({
	default: {
		accessSync: mockAccessSync,
		constants: { X_OK: 1 },
	},
	accessSync: mockAccessSync,
	constants: { X_OK: 1 },
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: mockIsWindows,
}));

import {
	buildInteractiveShellArgs,
	buildWrappedCommand,
	clearShellPathCache,
	resolveShellPath,
} from '../../main/process-manager/utils/pathResolver';

describe('pathResolver', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearShellPathCache();
		mockIsWindows.mockReturnValue(false);
	});

	describe('resolveShellPath', () => {
		it('returns Unix shell paths unchanged when already fully qualified', () => {
			expect(resolveShellPath('/custom/bin/zsh')).toBe('/custom/bin/zsh');
			expect(fs.accessSync).not.toHaveBeenCalled();
		});

		it('finds executable Unix shells in common shell paths', () => {
			vi.mocked(fs.accessSync).mockImplementation((candidate) => {
				if (candidate !== '/usr/local/bin/zsh') {
					throw new Error('not found');
				}
			});

			expect(resolveShellPath('zsh')).toBe('/usr/local/bin/zsh');
			expect(fs.accessSync).toHaveBeenNthCalledWith(1, '/bin/zsh', fs.constants.X_OK);
			expect(fs.accessSync).toHaveBeenNthCalledWith(2, '/usr/bin/zsh', fs.constants.X_OK);
			expect(fs.accessSync).toHaveBeenNthCalledWith(3, '/usr/local/bin/zsh', fs.constants.X_OK);
		});

		it('caches resolved Unix shell paths', () => {
			vi.mocked(fs.accessSync).mockImplementation((candidate) => {
				if (candidate !== '/bin/bash') {
					throw new Error('not found');
				}
			});

			expect(resolveShellPath('bash')).toBe('/bin/bash');
			expect(resolveShellPath('bash')).toBe('/bin/bash');
			expect(fs.accessSync).toHaveBeenCalledTimes(1);
		});

		it('falls back to the original Unix shell name when no executable path is found', () => {
			vi.mocked(fs.accessSync).mockImplementation(() => {
				throw new Error('not found');
			});

			expect(resolveShellPath('nu')).toBe('nu');
			expect(fs.accessSync).toHaveBeenCalledTimes(4);
		});

		it('normalizes common bare Windows shells to executable names', () => {
			mockIsWindows.mockReturnValue(true);

			expect(resolveShellPath('powershell')).toBe('powershell.exe');
			expect(resolveShellPath('pwsh')).toBe('pwsh.exe');
			expect(resolveShellPath('cmd')).toBe('cmd.exe');
		});

		it('preserves Windows shell paths and non-special shell names', () => {
			mockIsWindows.mockReturnValue(true);

			expect(resolveShellPath('C:\\Tools\\pwsh.exe')).toBe('C:\\Tools\\pwsh.exe');
			expect(resolveShellPath('bash')).toBe('bash');
			expect(fs.accessSync).not.toHaveBeenCalled();
		});
	});

	describe('buildWrappedCommand', () => {
		it('returns commands unchanged on Windows and fish', () => {
			mockIsWindows.mockReturnValue(true);
			expect(buildWrappedCommand('echo hi', 'zsh')).toBe('echo hi');

			mockIsWindows.mockReturnValue(false);
			expect(buildWrappedCommand('echo hi', 'fish')).toBe('echo hi');
		});

		it('sources zsh startup files before evaluating the escaped command', () => {
			expect(buildWrappedCommand("printf 'hi'", 'zsh')).toBe(
				"source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; eval 'printf '\\''hi'\\'''"
			);
		});

		it('sources bash startup files before evaluating the escaped command', () => {
			expect(buildWrappedCommand('echo $PATH', 'bash')).toBe(
				"source ~/.bash_profile 2>/dev/null; source ~/.bashrc 2>/dev/null; eval 'echo $PATH'"
			);
		});

		it('leaves unsupported shell names unwrapped', () => {
			expect(buildWrappedCommand('echo hi', 'nu')).toBe('echo hi');
		});
	});

	describe('buildInteractiveShellArgs', () => {
		it('passes commands directly on Windows', () => {
			mockIsWindows.mockReturnValue(true);

			expect(buildInteractiveShellArgs('dir', 'powershell')).toEqual(['dir']);
		});

		it('uses login + interactive flags for zsh commands', () => {
			expect(buildInteractiveShellArgs('ls', 'zsh')).toEqual(['-l', '-i', '-c', 'ls']);
		});

		it('passes the command as a dedicated shell argument without manual quoting', () => {
			expect(buildInteractiveShellArgs("printf 'hi'", 'zsh')).toEqual([
				'-l',
				'-i',
				'-c',
				"printf 'hi'",
			]);
		});

		it('uses login + interactive flags for bash commands', () => {
			expect(buildInteractiveShellArgs('ls', 'bash')).toEqual(['-l', '-i', '-c', 'ls']);
		});

		it('uses interactive command mode for fish', () => {
			expect(buildInteractiveShellArgs('ls', 'fish')).toEqual(['-i', '-c', 'ls']);
		});

		it('uses basic command mode for unsupported Unix shells', () => {
			expect(buildInteractiveShellArgs('ls', 'nu')).toEqual(['-c', 'ls']);
		});
	});
});

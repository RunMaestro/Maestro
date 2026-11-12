import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildInteractiveShellArgs,
	resolveShellPath,
} from '../../../../main/process-manager/utils/pathResolver';

describe('pathResolver', () => {
	describe('buildInteractiveShellArgs', () => {
		// These assertions model the Unix shell branch. `platformDetection`
		// reads `process.platform` first, so force it to a Unix value; otherwise
		// on Windows the product's `isWindows()` early-return yields `[command]`.
		const originalPlatform = process.platform;
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		});
		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
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
	});

	describe('resolveShellPath on Windows', () => {
		const originalPlatform = process.platform;
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		});
		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		// node-pty on Windows does not apply PATHEXT, so every bare shell id the
		// Settings shell picker offers needs its .exe.
		it.each([
			['powershell', 'powershell.exe'],
			['pwsh', 'pwsh.exe'],
			['cmd', 'cmd.exe'],
			['wsl', 'wsl.exe'],
			['bash', 'bash.exe'],
		])('resolves %s to %s', (shell, expected) => {
			expect(resolveShellPath(shell)).toBe(expected);
		});

		it('leaves a full Windows path alone', () => {
			expect(resolveShellPath('C:\\Windows\\System32\\wsl.exe')).toBe(
				'C:\\Windows\\System32\\wsl.exe'
			);
		});

		// A forward-slash path is still a path: reducing it to a bare name would
		// start whichever bash.exe is on PATH (possibly WSL's) instead of the
		// one the user configured.
		it('leaves a forward-slash Windows path alone', () => {
			expect(resolveShellPath('C:/Program Files/Git/bin/bash.exe')).toBe(
				'C:/Program Files/Git/bin/bash.exe'
			);
		});
	});
});

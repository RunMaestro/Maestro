/**
 * Tests for needsWindowsShell function in src/main/utils/execFile.ts
 *
 * This function determines whether a command needs shell execution on Windows.
 * Separated into its own test file to avoid module mocking conflicts.
 */

import { describe, it, expect } from 'vitest';
import { needsWindowsShell } from '../../../main/utils/execFile';

describe('needsWindowsShell', () => {
	describe('batch files', () => {
		it('should return true for .cmd files', () => {
			expect(needsWindowsShell('setup.cmd')).toBe(true);
			expect(needsWindowsShell('C:\\path\\to\\setup.CMD')).toBe(true);
		});

		it('should return true for .bat files', () => {
			expect(needsWindowsShell('install.bat')).toBe(true);
			expect(needsWindowsShell('C:\\path\\to\\INSTALL.BAT')).toBe(true);
		});
	});

	describe('executables', () => {
		it('should return false for .exe files', () => {
			expect(needsWindowsShell('program.exe')).toBe(false);
			expect(needsWindowsShell('C:\\path\\to\\program.EXE')).toBe(false);
		});

		it('should return false for .com files', () => {
			expect(needsWindowsShell('command.com')).toBe(false);
			expect(needsWindowsShell('C:\\path\\to\\COMMAND.COM')).toBe(false);
		});
	});

	describe('known commands with .exe variants', () => {
		it('should return false for git', () => {
			expect(needsWindowsShell('git')).toBe(false);
			expect(needsWindowsShell('GIT')).toBe(false);
		});

		it('should return false for git with full path', () => {
			expect(needsWindowsShell('C:\\Program Files\\Git\\bin\\git')).toBe(false);
			expect(needsWindowsShell('/usr/bin/git')).toBe(false);
		});

		it('should return false for node', () => {
			expect(needsWindowsShell('node')).toBe(false);
			expect(needsWindowsShell('C:\\nodejs\\node')).toBe(false);
		});

		it('should return false for npm/npx/yarn/pnpm', () => {
			expect(needsWindowsShell('npm')).toBe(false);
			expect(needsWindowsShell('npx')).toBe(false);
			expect(needsWindowsShell('yarn')).toBe(false);
			expect(needsWindowsShell('pnpm')).toBe(false);
		});

		it('should return false for python/python3', () => {
			expect(needsWindowsShell('python')).toBe(false);
			expect(needsWindowsShell('python3')).toBe(false);
		});

		it('should return false for pip/pip3', () => {
			expect(needsWindowsShell('pip')).toBe(false);
			expect(needsWindowsShell('pip3')).toBe(false);
		});
	});

	describe('unknown commands without extension', () => {
		it('should return true for unknown commands (need PATHEXT resolution)', () => {
			expect(needsWindowsShell('mycustomtool')).toBe(true);
			expect(needsWindowsShell('somecommand')).toBe(true);
		});
	});

	describe('commands with other extensions', () => {
		it('should return false for commands with unknown extensions', () => {
			// These have an extension, so no PATHEXT resolution needed
			expect(needsWindowsShell('script.ps1')).toBe(false);
			expect(needsWindowsShell('tool.msi')).toBe(false);
		});
	});
});

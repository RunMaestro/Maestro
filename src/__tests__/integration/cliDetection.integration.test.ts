/**
 * Tests for src/main/utils/cliDetection.ts
 *
 * Tests cover cloudflared detection functionality including:
 * - isCloudflaredInstalled
 * - getCloudflaredPath
 * - clearCloudflaredCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import fs from 'fs';

const fsMocks = vi.hoisted(() => ({
	existsSync: vi.fn(() => false),
}));

// Mock execFileNoThrow before importing the module
vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock os module for homedir
vi.mock('os', () => ({
	default: { homedir: () => '/home/testuser' },
	homedir: () => '/home/testuser',
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: {
			...actual,
			existsSync: fsMocks.existsSync,
		},
		existsSync: fsMocks.existsSync,
	};
});

import {
	isCloudflaredInstalled,
	getCloudflaredPath,
	clearCloudflaredCache,
	isGhInstalled,
	getGhPath,
	resolveGhPath,
	clearGhCache,
	getCachedGhStatus,
	setCachedGhStatus,
	detectSshPath,
	resolveSshPath,
	getSshPath,
	clearSshCache,
} from '../../main/utils/cliDetection';
import { execFileNoThrow } from '../../main/utils/execFile';

const mockedExecFileNoThrow = vi.mocked(execFileNoThrow);

describe('cliDetection.ts', () => {
	const originalPlatform = process.platform;
	const originalSystemRoot = process.env.SystemRoot;

	function setPlatform(platform: string): void {
		Object.defineProperty(process, 'platform', {
			value: platform,
			configurable: true,
		});
	}

	function restoreSystemRoot(): void {
		if (originalSystemRoot === undefined) {
			delete process.env.SystemRoot;
		} else {
			process.env.SystemRoot = originalSystemRoot;
		}
	}

	beforeEach(() => {
		vi.clearAllMocks();
		fsMocks.existsSync.mockReset().mockReturnValue(false);
		// Always clear cache before each test to ensure fresh state
		clearCloudflaredCache();
		clearGhCache();
		clearSshCache();
		setPlatform(originalPlatform);
		restoreSystemRoot();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Restore platform
		setPlatform(originalPlatform);
		restoreSystemRoot();
	});

	describe('isCloudflaredInstalled', () => {
		describe('on Unix-like systems', () => {
			beforeEach(() => {
				setPlatform('darwin');
			});

			it('should return true when cloudflared is found', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '/usr/local/bin/cloudflared\n',
					stderr: '',
					exitCode: 0,
				});

				const result = await isCloudflaredInstalled();

				expect(result).toBe(true);
				expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
					'which',
					['cloudflared'],
					undefined,
					expect.any(Object)
				);
			});

			it('should return false when cloudflared is not found', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '',
					stderr: 'cloudflared not found',
					exitCode: 1,
				});

				const result = await isCloudflaredInstalled();

				expect(result).toBe(false);
			});

			it('should return false when stdout is empty even with exit code 0', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '',
					stderr: '',
					exitCode: 0,
				});

				const result = await isCloudflaredInstalled();

				expect(result).toBe(false);
			});

			it('should return false when stdout is whitespace only', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '   \n\t  ',
					stderr: '',
					exitCode: 0,
				});

				// Clear cache and retry
				clearCloudflaredCache();
				const result = await isCloudflaredInstalled();

				expect(result).toBe(false);
			});

			it('should use expanded PATH environment', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '/opt/homebrew/bin/cloudflared\n',
					stderr: '',
					exitCode: 0,
				});

				await isCloudflaredInstalled();

				// Verify the env parameter contains expanded PATH
				expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
					'which',
					['cloudflared'],
					undefined,
					expect.objectContaining({
						PATH: expect.stringContaining('/opt/homebrew/bin'),
					})
				);
			});

			it('should include common binary locations in PATH', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '/usr/local/bin/cloudflared\n',
					stderr: '',
					exitCode: 0,
				});

				await isCloudflaredInstalled();

				const callEnv = mockedExecFileNoThrow.mock.calls[0][3] as NodeJS.ProcessEnv;
				const path = callEnv.PATH || '';

				expect(path).toContain('/opt/homebrew/bin');
				expect(path).toContain('/usr/local/bin');
				expect(path).toContain('/home/testuser/.local/bin');
				expect(path).toContain('/home/testuser/bin');
				expect(path).toContain('/usr/bin');
				expect(path).toContain('/bin');
			});
		});

		describe('on Windows', () => {
			beforeEach(() => {
				setPlatform('win32');
			});

			it('should use where command instead of which', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: 'C:\\Program Files\\cloudflared\\cloudflared.exe\n',
					stderr: '',
					exitCode: 0,
				});

				const result = await isCloudflaredInstalled();

				expect(result).toBe(true);
				expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
					'where',
					['cloudflared'],
					undefined,
					expect.any(Object)
				);
			});
		});

		describe('caching behavior', () => {
			it('should cache the result after first call', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '/usr/local/bin/cloudflared\n',
					stderr: '',
					exitCode: 0,
				});

				// First call
				await isCloudflaredInstalled();
				expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);

				// Second call should use cache
				const result = await isCloudflaredInstalled();
				expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);
				expect(result).toBe(true);
			});

			it('should cache false results too', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '',
					stderr: 'not found',
					exitCode: 1,
				});

				// First call
				await isCloudflaredInstalled();
				expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);

				// Second call should use cache
				const result = await isCloudflaredInstalled();
				expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);
				expect(result).toBe(false);
			});
		});

		describe('path extraction', () => {
			it('should extract first path when multiple paths returned', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '/opt/homebrew/bin/cloudflared\n/usr/local/bin/cloudflared\n',
					stderr: '',
					exitCode: 0,
				});

				await isCloudflaredInstalled();

				expect(getCloudflaredPath()).toBe('/opt/homebrew/bin/cloudflared');
			});

			it('should trim whitespace from path', async () => {
				mockedExecFileNoThrow.mockResolvedValue({
					stdout: '  /usr/local/bin/cloudflared  \n',
					stderr: '',
					exitCode: 0,
				});

				await isCloudflaredInstalled();

				expect(getCloudflaredPath()).toBe('/usr/local/bin/cloudflared');
			});
		});
	});

	describe('getCloudflaredPath', () => {
		// Note: clearCloudflaredCache() clears both the installed cache AND the path cache.

		it('should return the path after successful detection', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			await isCloudflaredInstalled();

			expect(getCloudflaredPath()).toBe('/usr/bin/cloudflared');
		});

		it('should clear path when clearCloudflaredCache is called', async () => {
			// First, ensure we have a successful detection
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '/first/path/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});
			clearCloudflaredCache();
			await isCloudflaredInstalled();
			expect(getCloudflaredPath()).toBe('/first/path/cloudflared');

			// Clear the cache - this should clear both installed and path caches
			clearCloudflaredCache();

			// Path should be null after cache clear
			expect(getCloudflaredPath()).toBeNull();

			// Now a failed detection
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});
			await isCloudflaredInstalled();

			// Path should still be null since detection failed
			expect(getCloudflaredPath()).toBeNull();
		});

		it('should update path when detection succeeds again with new path', async () => {
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '/new/path/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			expect(getCloudflaredPath()).toBe('/new/path/cloudflared');
		});
	});

	describe('clearCloudflaredCache', () => {
		it('should clear the cached result', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/local/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			// First call populates cache
			await isCloudflaredInstalled();
			expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);

			// Clear cache
			clearCloudflaredCache();

			// Next call should hit execFileNoThrow again
			await isCloudflaredInstalled();
			expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(2);
		});

		it('should allow re-detection with different result after cache clear', async () => {
			// First detection: found
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '/usr/local/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			const firstResult = await isCloudflaredInstalled();
			expect(firstResult).toBe(true);

			// Clear cache
			clearCloudflaredCache();

			// Second detection: not found
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});

			const secondResult = await isCloudflaredInstalled();
			expect(secondResult).toBe(false);
		});
	});

	describe('getExpandedEnv internal function', () => {
		it('should not duplicate paths that already exist in PATH', async () => {
			// Set up process.env.PATH to include some of the additional paths
			const originalPath = process.env.PATH;
			const testPath =
				process.platform === 'win32'
					? path.join(os.homedir(), '.local', 'bin')
					: '/opt/homebrew/bin';
			const delimiter = process.platform === 'win32' ? ';' : ':';
			process.env.PATH = `${testPath}${delimiter}/usr/bin${delimiter}/custom/path`;

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			// Clear cache to trigger new detection
			clearCloudflaredCache();
			await isCloudflaredInstalled();

			const callEnv = mockedExecFileNoThrow.mock.calls[0][3] as NodeJS.ProcessEnv;
			const pathParts = (callEnv.PATH || '').split(delimiter);

			// Count occurrences of the test path - should be 1
			const testPathCount = pathParts.filter((p) => p === testPath).length;
			expect(testPathCount).toBe(1);

			// Restore original PATH
			process.env.PATH = originalPath;
		});

		it('should prepend additional paths to front of PATH', async () => {
			const originalPath = process.env.PATH;
			process.env.PATH = '/custom/path';

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			const callEnv = mockedExecFileNoThrow.mock.calls[0][3] as NodeJS.ProcessEnv;
			const path = callEnv.PATH || '';

			// Additional paths should come before custom path
			const homebrewIndex = path.indexOf('/opt/homebrew/bin');
			const customIndex = path.indexOf('/custom/path');
			expect(homebrewIndex).toBeLessThan(customIndex);

			process.env.PATH = originalPath;
		});

		it('should handle empty PATH environment', async () => {
			const originalPath = process.env.PATH;
			delete process.env.PATH;

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			const callEnv = mockedExecFileNoThrow.mock.calls[0][3] as NodeJS.ProcessEnv;
			const path = callEnv.PATH || '';

			// Should still have the additional paths
			if (process.platform === 'win32') {
				expect(path.toLowerCase()).toContain('c:\\program files\\dotnet');
				expect(path.toLowerCase()).toContain('c:\\windows\\system32\\openssh');
			} else {
				expect(path).toContain('/opt/homebrew/bin');
				expect(path).toContain('/usr/local/bin');
			}

			process.env.PATH = originalPath;
		});
	});

	describe('edge cases', () => {
		it('should handle path with spaces', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/path/with spaces/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			await isCloudflaredInstalled();

			expect(getCloudflaredPath()).toBe('/path/with spaces/cloudflared');
		});

		it('should handle Windows-style path', async () => {
			setPlatform('win32');

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: 'C:\\Program Files\\Cloudflared\\cloudflared.exe\r\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			const result = await isCloudflaredInstalled();

			expect(result).toBe(true);
			expect(getCloudflaredPath()).toBe('C:\\Program Files\\Cloudflared\\cloudflared.exe');
		});

		it('should handle CRLF line endings from Windows where command', async () => {
			setPlatform('win32');

			// Windows 'where' command returns paths with CRLF line endings
			mockedExecFileNoThrow.mockResolvedValue({
				stdout:
					'C:\\Windows\\System32\\OpenSSH\\ssh.exe\r\nC:\\Program Files\\Git\\usr\\bin\\ssh.exe\r\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			// Should extract first path without trailing \r
			const resultPath = getCloudflaredPath();
			expect(resultPath).not.toContain('\r');
			expect(resultPath).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
		});

		it('should handle mixed LF and CRLF line endings', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/first/path/bin\r\n/second/path/bin\n/third/path/bin\r\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			const resultPath = getCloudflaredPath();
			expect(resultPath).not.toContain('\r');
			expect(resultPath).toBe('/first/path/bin');
		});

		it('should handle path with only CRLF (no additional lines)', async () => {
			setPlatform('win32');

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: 'C:\\Single\\Path\\binary.exe\r\n',
				stderr: '',
				exitCode: 0,
			});

			clearCloudflaredCache();
			await isCloudflaredInstalled();

			expect(getCloudflaredPath()).toBe('C:\\Single\\Path\\binary.exe');
		});

		it('should handle path with special characters', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/home/user@domain/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			await isCloudflaredInstalled();

			expect(getCloudflaredPath()).toBe('/home/user@domain/bin/cloudflared');
		});
	});

	describe('GitHub CLI detection', () => {
		it('should detect gh and cache the resolved path', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/opt/homebrew/bin/gh\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await isGhInstalled();

			expect(result).toBe(true);
			expect(getGhPath()).toBe('/opt/homebrew/bin/gh');
			expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
				process.platform === 'win32' ? 'where' : 'which',
				['gh'],
				undefined,
				expect.any(Object)
			);

			await isGhInstalled();
			expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);
		});

		it('should return false and keep gh path null when gh is missing', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});

			const result = await isGhInstalled();

			expect(result).toBe(false);
			expect(getGhPath()).toBeNull();
			expect(getCachedGhStatus()).toEqual({ installed: false, authenticated: false });
		});

		it('should handle empty gh stdout even with successful exit', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '  \n',
				stderr: '',
				exitCode: 0,
			});

			const result = await isGhInstalled();

			expect(result).toBe(false);
			expect(getGhPath()).toBeNull();
		});

		it('should use the first gh path from Windows where output', async () => {
			setPlatform('win32');
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: 'C:\\Tools\\gh.exe\r\nC:\\Other\\gh.exe\r\n',
				stderr: '',
				exitCode: 0,
			});

			await isGhInstalled();

			expect(getGhPath()).toBe('C:\\Tools\\gh.exe');
			expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
				'where',
				['gh'],
				undefined,
				expect.any(Object)
			);
		});

		it('should resolve custom gh path without detection', async () => {
			await expect(resolveGhPath('/custom/bin/gh')).resolves.toBe('/custom/bin/gh');

			expect(mockedExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should resolve detected gh path or fall back to gh', async () => {
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '/usr/local/bin/gh\n',
				stderr: '',
				exitCode: 0,
			});
			await expect(resolveGhPath()).resolves.toBe('/usr/local/bin/gh');

			clearGhCache();
			mockedExecFileNoThrow.mockResolvedValueOnce({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});
			await expect(resolveGhPath()).resolves.toBe('gh');
		});

		it('should cache gh authenticated status until the TTL expires', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1000);
			setCachedGhStatus(true, true);

			vi.mocked(Date.now).mockReturnValue(1000 + 59_000);
			expect(getCachedGhStatus()).toEqual({ installed: true, authenticated: true });

			vi.mocked(Date.now).mockReturnValue(1000 + 61_000);
			expect(getCachedGhStatus()).toBeNull();
		});

		it('should return null gh status before install detection has run', () => {
			expect(getCachedGhStatus()).toBeNull();
		});

		it('should return null gh status when installed but authentication has not been checked', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/gh\n',
				stderr: '',
				exitCode: 0,
			});

			await isGhInstalled();

			expect(getCachedGhStatus()).toBeNull();
		});

		it('should clear gh install, path, and auth caches', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/gh\n',
				stderr: '',
				exitCode: 0,
			});
			await isGhInstalled();
			setCachedGhStatus(true, true);

			clearGhCache();

			expect(getGhPath()).toBeNull();
			expect(getCachedGhStatus()).toBeNull();
		});
	});

	describe('SSH path detection', () => {
		it('should detect ssh through platform which command and cache the path', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/ssh\n',
				stderr: '',
				exitCode: 0,
			});

			await expect(detectSshPath()).resolves.toBe('/usr/bin/ssh');
			expect(getSshPath()).toBe('/usr/bin/ssh');
			expect(mockedExecFileNoThrow).toHaveBeenCalledWith(
				process.platform === 'win32' ? 'where' : 'which',
				['ssh'],
				undefined,
				expect.any(Object)
			);

			await detectSshPath();
			expect(mockedExecFileNoThrow).toHaveBeenCalledTimes(1);
		});

		it('should return null when ssh detection fails on non-Windows platforms', async () => {
			setPlatform('darwin');
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});

			await expect(detectSshPath()).resolves.toBeNull();
			expect(getSshPath()).toBeNull();
		});

		it('should use Windows built-in OpenSSH fallback when where fails', async () => {
			setPlatform('win32');
			process.env.SystemRoot = 'C:\\Windows';
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});
			fsMocks.existsSync.mockReturnValue(true);

			await expect(detectSshPath()).resolves.toBe(
				path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
			);
			expect(fs.existsSync).toHaveBeenCalledWith(
				path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
			);
		});

		it('should use default Windows root for built-in OpenSSH fallback', async () => {
			setPlatform('win32');
			delete process.env.SystemRoot;
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});
			fsMocks.existsSync.mockReturnValue(true);

			await expect(detectSshPath()).resolves.toBe(
				path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
			);
		});

		it('should leave ssh path null when Windows fallback check fails', async () => {
			setPlatform('win32');
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});
			fsMocks.existsSync.mockImplementation(() => {
				throw new Error('permission denied');
			});

			await expect(detectSshPath()).resolves.toBeNull();
			expect(getSshPath()).toBeNull();
		});

		it('should resolve ssh path with fallback command name when detection fails', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '',
				stderr: 'not found',
				exitCode: 1,
			});

			await expect(resolveSshPath()).resolves.toBe('ssh');
		});

		it('should clear ssh cache and allow re-detection', async () => {
			mockedExecFileNoThrow
				.mockResolvedValueOnce({ stdout: '/first/ssh\n', stderr: '', exitCode: 0 })
				.mockResolvedValueOnce({ stdout: '/second/ssh\n', stderr: '', exitCode: 0 });

			await expect(resolveSshPath()).resolves.toBe('/first/ssh');
			clearSshCache();
			await expect(resolveSshPath()).resolves.toBe('/second/ssh');
		});
	});
});

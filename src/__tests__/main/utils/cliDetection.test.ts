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

// Mock execFileNoThrow before importing the module
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock os module for homedir
vi.mock('os', () => ({
	default: { homedir: () => '/home/testuser' },
	homedir: () => '/home/testuser',
}));

import {
	isCloudflaredInstalled,
	getCloudflaredPath,
	clearCloudflaredCache,
	getCachedGhStatus,
	setCachedGhStatus,
	clearGhCache,
	resolveGhPath,
	isGhInstalled,
} from '../../../main/utils/cliDetection';
import { execFileNoThrow } from '../../../main/utils/execFile';

const mockedExecFileNoThrow = vi.mocked(execFileNoThrow);

describe('cliDetection.ts', () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.clearAllMocks();
		// Always clear cache before each test to ensure fresh state
		clearCloudflaredCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Restore platform
		Object.defineProperty(process, 'platform', { value: originalPlatform });
	});

	describe('isCloudflaredInstalled', () => {
		describe('on Unix-like systems', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
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
				Object.defineProperty(process, 'platform', { value: 'win32' });
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
			Object.defineProperty(process, 'platform', { value: 'win32' });

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
			Object.defineProperty(process, 'platform', { value: 'win32' });

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
			Object.defineProperty(process, 'platform', { value: 'win32' });

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
	describe('gh status cache', () => {
		beforeEach(() => {
			clearGhCache();
			vi.useRealTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			clearGhCache();
		});

		const DEFAULT_GH = '/opt/homebrew/bin/gh';
		const CUSTOM_GH = '/custom/bin/gh';

		it('returns null before anything has been cached', () => {
			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
		});

		it('serves a positive verdict from cache inside the TTL', () => {
			setCachedGhStatus(DEFAULT_GH, true, true);

			expect(getCachedGhStatus(DEFAULT_GH)).toEqual({ installed: true, authenticated: true });
		});

		it('serves a negative verdict from cache inside the TTL', () => {
			setCachedGhStatus(DEFAULT_GH, false, false);

			expect(getCachedGhStatus(DEFAULT_GH)).toEqual({ installed: false, authenticated: false });
		});

		// Regression: the verdict used to be path-agnostic, so a probe of the
		// PATH-resolved gh answered for a configured custom path and vice versa.
		it('treats a verdict reached against a different command as a miss', () => {
			setCachedGhStatus(DEFAULT_GH, false, false);

			expect(getCachedGhStatus(CUSTOM_GH)).toBeNull();
		});

		it('does not let a failed custom-path probe answer for the default gh', () => {
			setCachedGhStatus(CUSTOM_GH, false, false);

			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
			expect(getCachedGhStatus(CUSTOM_GH)).toEqual({ installed: false, authenticated: false });
		});

		// The status verdict and the `which` detection cache are separate: caching
		// a custom-path failure must not mark the PATH-resolved gh as missing.
		it('does not let a failed custom-path probe poison PATH detection', async () => {
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: `${DEFAULT_GH}\n`,
				stderr: '',
				exitCode: 0,
			});

			setCachedGhStatus(CUSTOM_GH, false, false);

			await expect(isGhInstalled()).resolves.toBe(true);
			await expect(resolveGhPath()).resolves.toBe(DEFAULT_GH);
		});

		it('replaces a verdict for one command with a verdict for another', () => {
			setCachedGhStatus(DEFAULT_GH, true, true);
			setCachedGhStatus(CUSTOM_GH, true, false);

			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
			expect(getCachedGhStatus(CUSTOM_GH)).toEqual({ installed: true, authenticated: false });
		});

		// Regression: a negative verdict used to skip the TTL check entirely, so one
		// failed probe at startup made gh unavailable for the whole app run.
		it('expires a NEGATIVE verdict once the TTL elapses', () => {
			vi.useFakeTimers();
			setCachedGhStatus(DEFAULT_GH, false, false);
			expect(getCachedGhStatus(DEFAULT_GH)).toEqual({ installed: false, authenticated: false });

			vi.advanceTimersByTime(60001);

			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
		});

		// Expiring the verdict is not enough on its own: isGhInstalled() returns
		// early on any non-null detection cache, so a stale `false` left behind
		// would make the next lookup answer from the result that just expired
		// instead of probing again.
		it('re-probes after a NEGATIVE verdict expires, rather than reusing it', async () => {
			vi.useFakeTimers();

			// Startup: the shim cannot reach its parent tool, so `which` fails.
			mockedExecFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
			await expect(isGhInstalled()).resolves.toBe(false);
			setCachedGhStatus('gh', false, false);

			vi.advanceTimersByTime(60001);
			expect(getCachedGhStatus('gh')).toBeNull();

			// The shim is resolvable now that its parent tool is reachable.
			mockedExecFileNoThrow.mockClear();
			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/home/testuser/.asdf/shims/gh\n',
				stderr: '',
				exitCode: 0,
			});

			await expect(isGhInstalled()).resolves.toBe(true);
			expect(mockedExecFileNoThrow).toHaveBeenCalled();
			await expect(resolveGhPath()).resolves.toBe('/home/testuser/.asdf/shims/gh');
		});

		it('expires a positive verdict once the TTL elapses', () => {
			vi.useFakeTimers();
			setCachedGhStatus(DEFAULT_GH, true, true);

			vi.advanceTimersByTime(60001);

			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
		});

		it('clearGhCache drops a cached verdict immediately', () => {
			setCachedGhStatus(DEFAULT_GH, true, true);

			clearGhCache();

			expect(getCachedGhStatus(DEFAULT_GH)).toBeNull();
		});

		it('resolveGhPath returns a custom path without probing the filesystem', async () => {
			await expect(resolveGhPath('/custom/bin/gh')).resolves.toBe('/custom/bin/gh');
			expect(mockedExecFileNoThrow).not.toHaveBeenCalled();
		});
	});
});

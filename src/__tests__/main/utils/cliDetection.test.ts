/**
 * Tests for src/main/utils/cliDetection.ts
 *
 * Tests cover cloudflared detection functionality including:
 * - isCloudflaredInstalled
 * - getCloudflaredPath
 * - clearCloudflaredCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
			process.env.PATH = '/opt/homebrew/bin:/usr/bin:/custom/path';

			mockedExecFileNoThrow.mockResolvedValue({
				stdout: '/usr/bin/cloudflared\n',
				stderr: '',
				exitCode: 0,
			});

			// Clear cache to trigger new detection
			clearCloudflaredCache();
			await isCloudflaredInstalled();

			const callEnv = mockedExecFileNoThrow.mock.calls[0][3] as NodeJS.ProcessEnv;
			const pathParts = (callEnv.PATH || '').split(':');

			// Count occurrences of /opt/homebrew/bin - should be 1
			const homebrewCount = pathParts.filter((p) => p === '/opt/homebrew/bin').length;
			expect(homebrewCount).toBe(1);

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
			expect(path).toContain('/opt/homebrew/bin');
			expect(path).toContain('/usr/local/bin');

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
});

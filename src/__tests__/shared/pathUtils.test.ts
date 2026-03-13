/**
 * Tests for shared path and version utility functions
 *
 * @file src/shared/pathUtils.ts
 *
 * These utilities consolidate duplicated logic found across:
 * - agent-detector.ts (expandTilde)
 * - ssh-command-builder.ts (expandPath)
 * - ssh-config-parser.ts (expandPath)
 * - ssh-remote-manager.ts (expandPath)
 * - process-manager.ts (inline tilde expansion)
 * - update-checker.ts (version comparison)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
	expandTilde,
	parseVersion,
	compareVersions,
	buildExpandedPath,
	buildExpandedEnv,
} from '../../shared/pathUtils';

// Mock os.homedir for consistent test behavior
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof os>('os');
	return {
		...actual,
		homedir: vi.fn(() => '/Users/testuser'),
		tmpdir: () => '/tmp',
	};
});

describe('expandTilde', () => {
	describe('basic tilde expansion', () => {
		it('should expand ~/path to home directory + path', () => {
			expect(expandTilde('~/Documents')).toBe('/Users/testuser/Documents');
		});

		it('should expand ~ alone to home directory', () => {
			expect(expandTilde('~')).toBe('/Users/testuser');
		});

		it('should expand ~/path/to/file correctly', () => {
			expect(expandTilde('~/.ssh/id_rsa')).toBe('/Users/testuser/.ssh/id_rsa');
		});

		it('should preserve paths without tilde', () => {
			expect(expandTilde('/absolute/path')).toBe('/absolute/path');
			expect(expandTilde('relative/path')).toBe('relative/path');
			expect(expandTilde('./local/path')).toBe('./local/path');
		});

		it('should not expand tilde in middle of path', () => {
			expect(expandTilde('/path/with~tilde')).toBe('/path/with~tilde');
		});
	});

	describe('edge cases', () => {
		it('should handle empty string', () => {
			expect(expandTilde('')).toBe('');
		});

		it('should handle paths with spaces', () => {
			expect(expandTilde('~/My Documents/file.txt')).toBe('/Users/testuser/My Documents/file.txt');
		});

		it('should handle deeply nested paths', () => {
			expect(expandTilde('~/.local/share/fnm/node-versions/v20.0.0/installation/bin')).toBe(
				'/Users/testuser/.local/share/fnm/node-versions/v20.0.0/installation/bin'
			);
		});
	});

	describe('cross-platform consistency', () => {
		it('should handle Windows-style home (when provided)', () => {
			vi.mocked(os.homedir).mockReturnValue('C:\\Users\\testuser');
			const result = expandTilde('~/.config');
			expect(result).toContain('testuser');
			expect(result).toContain('.config');
		});
	});
});

describe('parseVersion', () => {
	it('should parse version with v prefix', () => {
		expect(parseVersion('v22.10.0')).toEqual([22, 10, 0]);
	});

	it('should parse version without v prefix', () => {
		expect(parseVersion('0.14.0')).toEqual([0, 14, 0]);
	});

	it('should handle single digit versions', () => {
		expect(parseVersion('v8.0.0')).toEqual([8, 0, 0]);
	});

	it('should handle versions with more than 3 parts', () => {
		expect(parseVersion('1.2.3.4')).toEqual([1, 2, 3, 4]);
	});

	it('should handle non-numeric parts as 0', () => {
		expect(parseVersion('1.beta.3')).toEqual([1, 0, 3]);
	});

	it('should strip pre-release suffixes before parsing', () => {
		expect(parseVersion('0.15.0-rc.1')).toEqual([0, 15, 0]);
		expect(parseVersion('v1.2.0-beta.3')).toEqual([1, 2, 0]);
		expect(parseVersion('0.15.0-alpha')).toEqual([0, 15, 0]);
	});
});

describe('compareVersions', () => {
	describe('basic version comparison', () => {
		it('should return 1 when a > b', () => {
			expect(compareVersions('v22.0.0', 'v20.0.0')).toBe(1);
		});

		it('should return -1 when a < b', () => {
			expect(compareVersions('v20.0.0', 'v22.0.0')).toBe(-1);
		});

		it('should return 0 for equal versions', () => {
			expect(compareVersions('v20.10.0', 'v20.10.0')).toBe(0);
		});
	});

	describe('minor version comparison', () => {
		it('should compare by minor version when major is equal', () => {
			expect(compareVersions('v20.11.0', 'v20.10.0')).toBe(1);
			expect(compareVersions('v20.10.0', 'v20.11.0')).toBe(-1);
		});

		it('should handle v18.20 vs v18.2 correctly (20 > 2)', () => {
			expect(compareVersions('v18.20.0', 'v18.2.0')).toBe(1);
		});
	});

	describe('patch version comparison', () => {
		it('should compare by patch when major and minor are equal', () => {
			expect(compareVersions('v20.10.5', 'v20.10.3')).toBe(1);
			expect(compareVersions('v20.10.3', 'v20.10.5')).toBe(-1);
		});
	});

	describe('array sorting', () => {
		it('should sort ascending when used directly', () => {
			const versions = ['v22.21.0', 'v18.17.0', 'v20.10.0'];
			const sorted = [...versions].sort(compareVersions);
			expect(sorted).toEqual(['v18.17.0', 'v20.10.0', 'v22.21.0']);
		});

		it('should sort descending when args are flipped', () => {
			const versions = ['v18.17.0', 'v22.21.0', 'v20.10.0', 'v18.2.0', 'v21.0.0'];
			const sorted = [...versions].sort((a, b) => compareVersions(b, a));
			expect(sorted).toEqual(['v22.21.0', 'v21.0.0', 'v20.10.0', 'v18.17.0', 'v18.2.0']);
		});

		it('should handle single-digit versions', () => {
			const versions = ['v8.0.0', 'v16.0.0', 'v4.0.0', 'v12.0.0'];
			const sorted = [...versions].sort((a, b) => compareVersions(b, a));
			expect(sorted).toEqual(['v16.0.0', 'v12.0.0', 'v8.0.0', 'v4.0.0']);
		});
	});

	describe('edge cases', () => {
		it('should handle versions without v prefix', () => {
			expect(compareVersions('22.0.0', '20.0.0')).toBe(1);
		});

		it('should handle mixed v prefix', () => {
			expect(compareVersions('v22.0.0', '20.0.0')).toBe(1);
		});

		it('should handle versions with different part counts', () => {
			expect(compareVersions('1.0', '1.0.0')).toBe(0);
			expect(compareVersions('1.0.1', '1.0')).toBe(1);
		});
	});

	describe('pre-release version comparison', () => {
		it('should treat pre-release as less than the same stable version', () => {
			expect(compareVersions('0.15.0-rc.1', '0.15.0')).toBe(-1);
			expect(compareVersions('0.15.0', '0.15.0-rc.1')).toBe(1);
		});

		it('should treat pre-release as less than stable for various suffixes', () => {
			expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
			expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
			expect(compareVersions('1.0.0-dev', '1.0.0')).toBe(-1);
			expect(compareVersions('1.0.0-canary', '1.0.0')).toBe(-1);
		});

		it('should compare pre-releases with different base versions normally', () => {
			expect(compareVersions('0.16.0-rc.1', '0.15.0')).toBe(1);
			expect(compareVersions('0.14.0-rc.1', '0.15.0')).toBe(-1);
		});

		it('should compare two pre-releases lexically when base is the same', () => {
			expect(compareVersions('0.15.0-rc.1', '0.15.0-rc.2')).toBe(-1);
			expect(compareVersions('0.15.0-rc.2', '0.15.0-rc.1')).toBe(1);
			expect(compareVersions('0.15.0-rc.1', '0.15.0-rc.1')).toBe(0);
		});

		it('should order alpha < beta < rc lexically', () => {
			expect(compareVersions('0.15.0-alpha', '0.15.0-beta')).toBe(-1);
			expect(compareVersions('0.15.0-beta', '0.15.0-rc')).toBe(-1);
			expect(compareVersions('0.15.0-alpha', '0.15.0-rc')).toBe(-1);
		});

		it('should sort pre-release versions correctly in descending order', () => {
			const versions = ['0.15.0-rc.1', '0.15.0', '0.14.0', '0.15.0-beta.1', '0.16.0-rc.1'];
			const sorted = [...versions].sort((a, b) => compareVersions(b, a));
			expect(sorted).toEqual(['0.16.0-rc.1', '0.15.0', '0.15.0-rc.1', '0.15.0-beta.1', '0.14.0']);
		});
	});
});

describe('buildExpandedPath', () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		process.env.PATH = originalPath;
	});

	describe('Unix-like systems (macOS/Linux)', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
		});

		it('should include Homebrew paths on macOS', () => {
			process.env.PATH = '/usr/bin';
			const result = buildExpandedPath();

			expect(result).toContain('/opt/homebrew/bin');
			expect(result).toContain('/opt/homebrew/sbin');
			expect(result).toContain('/usr/local/bin');
		});

		it('should include user local paths', () => {
			process.env.PATH = '/usr/bin';
			const result = buildExpandedPath();

			// Check for patterns rather than exact paths (path.join may use OS-native separators)
			expect(result).toMatch(/\.local\/bin|\.local\\bin/);
			expect(result).toMatch(/\.npm-global\/bin|\.npm-global\\bin/);
			// User bin path - check with either separator
			expect(result).toMatch(/testuser[\/\\]bin/);
		});

		it('should include Claude and OpenCode paths', () => {
			process.env.PATH = '/usr/bin';
			const result = buildExpandedPath();

			expect(result).toMatch(/\.claude\/local|\.claude\\local/);
			expect(result).toMatch(/\.opencode\/bin|\.opencode\\bin/);
		});

		it('should not duplicate paths already in PATH', () => {
			process.env.PATH = '/opt/homebrew/bin:/usr/bin';
			const result = buildExpandedPath();

			const pathParts = result.split(':');
			const homebrewCount = pathParts.filter((p) => p === '/opt/homebrew/bin').length;
			expect(homebrewCount).toBe(1);
		});

		it('should prepend standard paths to front of PATH', () => {
			process.env.PATH = '/custom/path';
			const result = buildExpandedPath();

			const homebrewIndex = result.indexOf('/opt/homebrew/bin');
			const customIndex = result.indexOf('/custom/path');
			expect(homebrewIndex).toBeLessThan(customIndex);
		});

		it('should prepend detected Node version manager bin paths', () => {
			process.env.PATH = '/usr/bin';
			const originalNvmDir = process.env.NVM_DIR;
			const tempNvmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-nvm-'));
			process.env.NVM_DIR = tempNvmDir;
			fs.mkdirSync(path.join(tempNvmDir, 'current', 'bin'), { recursive: true });
			fs.mkdirSync(path.join(tempNvmDir, 'versions', 'node', 'v22.10.0', 'bin'), {
				recursive: true,
			});

			try {
				const result = buildExpandedPath();
				const pathParts = result.split(':');
				const currentBin = path.join(tempNvmDir, 'current', 'bin');
				const versionedBin = path.join(tempNvmDir, 'versions', 'node', 'v22.10.0', 'bin');

				expect(pathParts[0]).toBe(currentBin);
				expect(pathParts).toContain(versionedBin);
				expect(pathParts.indexOf(currentBin)).toBeLessThan(pathParts.indexOf(versionedBin));
			} finally {
				if (originalNvmDir === undefined) {
					delete process.env.NVM_DIR;
				} else {
					process.env.NVM_DIR = originalNvmDir;
				}
				fs.rmSync(tempNvmDir, { recursive: true, force: true });
			}
		});

		it('should accept custom paths that are prepended first', () => {
			process.env.PATH = '/usr/bin';
			const result = buildExpandedPath(['/my/custom/bin', '/another/path']);

			// Custom paths should be added but standard paths are also prepended
			expect(result).toContain('/my/custom/bin');
			expect(result).toContain('/another/path');
			expect(result).toContain('/opt/homebrew/bin');
		});

		it('should handle empty PATH environment', () => {
			delete process.env.PATH;
			const result = buildExpandedPath();

			expect(result).toContain('/opt/homebrew/bin');
			expect(result).toContain('/usr/local/bin');
			expect(result.length).toBeGreaterThan(0);
		});
	});

	describe('Windows', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'win32' });
		});

		it('should include Windows-specific paths', () => {
			process.env.PATH = 'C:\\Windows\\System32';
			const result = buildExpandedPath();

			// Check for npm paths (case-insensitive)
			expect(result).toMatch(/npm/i);
			// Check for Git paths (case-insensitive)
			expect(result).toMatch(/Git/i);
		});

		it('should include .NET SDK paths', () => {
			process.env.PATH = 'C:\\Windows\\System32';
			const result = buildExpandedPath();

			expect(result).toMatch(/dotnet/i);
		});

		it('should include Scoop and Chocolatey paths', () => {
			process.env.PATH = 'C:\\Windows\\System32';
			const result = buildExpandedPath();

			expect(result).toMatch(/scoop/i);
			expect(result).toMatch(/chocolatey/i);
		});
	});
});

describe('buildExpandedEnv', () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;

	beforeEach(() => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		process.env.PATH = originalPath;
	});

	it('should return a copy of process.env with expanded PATH', () => {
		process.env.PATH = '/usr/bin';
		const env = buildExpandedEnv();

		expect(env.PATH).toContain('/opt/homebrew/bin');
		expect(env.PATH).toContain('/usr/bin');
	});

	it('should include all original environment variables', () => {
		const originalHome = process.env.HOME;
		const env = buildExpandedEnv();

		expect(env.HOME).toBe(originalHome);
	});

	it('should apply custom environment variables', () => {
		const env = buildExpandedEnv({
			MY_CUSTOM_VAR: 'custom_value',
			ANOTHER_VAR: 'another_value',
		});

		expect(env.MY_CUSTOM_VAR).toBe('custom_value');
		expect(env.ANOTHER_VAR).toBe('another_value');
	});

	it('should expand tilde in custom env var values', () => {
		const env = buildExpandedEnv({
			MY_PATH: '~/some/path',
		});

		// path.join uses platform-specific separators, so check for both
		expect(env.MY_PATH).toMatch(/testuser[\/\\]some[\/\\]path/);
	});

	it('should not expand tilde if not at start of value', () => {
		const env = buildExpandedEnv({
			MY_VAR: 'prefix~/suffix',
		});

		expect(env.MY_VAR).toBe('prefix~/suffix');
	});

	it('should handle empty custom env vars', () => {
		const env = buildExpandedEnv({});

		expect(env.PATH).toContain('/opt/homebrew/bin');
	});

	it('should handle undefined custom env vars', () => {
		const env = buildExpandedEnv(undefined);

		expect(env.PATH).toContain('/opt/homebrew/bin');
	});

	it('should not mutate process.env', () => {
		const originalPathValue = process.env.PATH;
		buildExpandedEnv({ NEW_VAR: 'new_value' });

		expect(process.env.PATH).toBe(originalPathValue);
		expect(process.env.NEW_VAR).toBeUndefined();
	});
});

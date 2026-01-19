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

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import { expandTilde, parseVersion, compareVersions } from '../../shared/pathUtils';

// Mock os.homedir for consistent test behavior
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof os>('os');
	return {
		...actual,
		homedir: vi.fn(() => '/Users/testuser'),
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';

// Mock electron-store with a class
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			options: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.options = options;
			}
			get(_key: string, defaultValue?: unknown) {
				return defaultValue;
			}
			set() {}
		},
	};
});

// Mock fs
vi.mock('fs', () => ({
	default: {
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(),
	},
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
}));

import { getCustomSyncPath, getEarlySettings, findSshRemoteById } from '../../../main/stores/utils';
import type { BootstrapSettings } from '../../../main/stores/types';
import type Store from 'electron-store';

describe('stores/utils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getCustomSyncPath', () => {
		it('should return undefined when no custom path is configured', () => {
			const mockStore = {
				get: vi.fn().mockReturnValue(undefined),
			} as unknown as Store<BootstrapSettings>;

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(mockStore.get).toHaveBeenCalledWith('customSyncPath');
		});

		it('should return the custom path when it exists', () => {
			const customPath = '/Users/test/iCloud/Maestro';
			const mockStore = {
				get: vi.fn().mockReturnValue(customPath),
			} as unknown as Store<BootstrapSettings>;

			vi.mocked(fsSync.existsSync).mockReturnValue(true);

			const result = getCustomSyncPath(mockStore);

			expect(result).toBe(customPath);
			expect(fsSync.existsSync).toHaveBeenCalledWith(customPath);
		});

		it('should create directory when custom path does not exist', () => {
			const customPath = '/Users/test/iCloud/Maestro';
			const mockStore = {
				get: vi.fn().mockReturnValue(customPath),
			} as unknown as Store<BootstrapSettings>;

			vi.mocked(fsSync.existsSync).mockReturnValue(false);
			vi.mocked(fsSync.mkdirSync).mockReturnValue(undefined);

			const result = getCustomSyncPath(mockStore);

			expect(result).toBe(customPath);
			expect(fsSync.mkdirSync).toHaveBeenCalledWith(customPath, { recursive: true });
		});

		it('should return undefined when directory creation fails', () => {
			const customPath = '/Users/test/invalid/path';
			const mockStore = {
				get: vi.fn().mockReturnValue(customPath),
			} as unknown as Store<BootstrapSettings>;

			vi.mocked(fsSync.existsSync).mockReturnValue(false);
			vi.mocked(fsSync.mkdirSync).mockImplementation(() => {
				throw new Error('Permission denied');
			});

			// Spy on console.error to verify it's called
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(
				`Failed to create custom sync path: ${customPath}, using default`
			);
		});

		it('should reject relative paths', () => {
			const relativePath = 'relative/path/to/data';
			const mockStore = {
				get: vi.fn().mockReturnValue(relativePath),
			} as unknown as Store<BootstrapSettings>;

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(`Custom sync path must be absolute: ${relativePath}`);
		});

		it('should reject paths with traversal sequences', () => {
			const traversalPath = '/Users/test/../../../etc/passwd';
			const mockStore = {
				get: vi.fn().mockReturnValue(traversalPath),
			} as unknown as Store<BootstrapSettings>;

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(
				`Custom sync path contains traversal sequences: ${traversalPath}`
			);
		});

		it('should allow paths with ".." in directory names (not traversal)', () => {
			const validPath = '/Users/test/my..project/data';
			const mockStore = {
				get: vi.fn().mockReturnValue(validPath),
			} as unknown as Store<BootstrapSettings>;

			vi.mocked(fsSync.existsSync).mockReturnValue(true);

			const result = getCustomSyncPath(mockStore);

			// Should be allowed - ".." is part of directory name, not a traversal
			expect(result).toBe(validPath);
		});

		it('should reject paths in sensitive system directories', () => {
			const sensitivePath = '/etc/maestro';
			const mockStore = {
				get: vi.fn().mockReturnValue(sensitivePath),
			} as unknown as Store<BootstrapSettings>;

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(
				`Custom sync path cannot be in sensitive system directory: ${sensitivePath}`
			);
		});

		it('should reject paths that are too short', () => {
			const shortPath = '/a';
			const mockStore = {
				get: vi.fn().mockReturnValue(shortPath),
			} as unknown as Store<BootstrapSettings>;

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(`Custom sync path is too short: ${shortPath}`);
		});

		it('should reject paths containing null bytes', () => {
			const nullBytePath = '/Users/test/data\0/maestro';
			const mockStore = {
				get: vi.fn().mockReturnValue(nullBytePath),
			} as unknown as Store<BootstrapSettings>;

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = getCustomSyncPath(mockStore);

			expect(result).toBeUndefined();
			expect(consoleSpy).toHaveBeenCalledWith(
				`Custom sync path contains null bytes: ${nullBytePath}`
			);
		});
	});

	describe('getEarlySettings', () => {
		const originalPlatform = process.platform;

		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform });
		});

		it('should return default values when settings are not set (non-WSL)', () => {
			// Mock non-Linux platform
			Object.defineProperty(process, 'platform', { value: 'darwin' });

			const result = getEarlySettings('/test/path');

			expect(result).toEqual({
				crashReportingEnabled: true,
				disableGpuAcceleration: false,
			});
		});

		it('should auto-disable GPU acceleration in WSL environment', () => {
			// Mock Linux platform
			Object.defineProperty(process, 'platform', { value: 'linux' });

			// Mock /proc/version to indicate WSL
			vi.mocked(fsSync.existsSync).mockImplementation((path) => {
				if (path === '/proc/version') return true;
				return false;
			});
			vi.mocked(fsSync.readFileSync).mockReturnValue(
				'Linux version 5.15.0-1025-microsoft-standard-WSL2'
			);

			const result = getEarlySettings('/test/path');

			expect(result).toEqual({
				crashReportingEnabled: true,
				disableGpuAcceleration: true,
			});
		});

		it('should not auto-disable GPU acceleration on native Linux', () => {
			// Mock Linux platform
			Object.defineProperty(process, 'platform', { value: 'linux' });

			// Mock /proc/version to indicate native Linux
			vi.mocked(fsSync.existsSync).mockImplementation((path) => {
				if (path === '/proc/version') return true;
				return false;
			});
			vi.mocked(fsSync.readFileSync).mockReturnValue('Linux version 6.5.0-generic');

			const result = getEarlySettings('/test/path');

			expect(result).toEqual({
				crashReportingEnabled: true,
				disableGpuAcceleration: false,
			});
		});
	});

	describe('findSshRemoteById', () => {
		const mockSshRemotes = [
			{ id: 'remote-1', name: 'Server 1', host: 'server1.example.com', username: 'user1' },
			{ id: 'remote-2', name: 'Server 2', host: 'server2.example.com', username: 'user2' },
			{ id: 'remote-3', name: 'Server 3', host: 'server3.example.com', username: 'user3' },
		];

		it('should find remote by id', () => {
			const result = findSshRemoteById(mockSshRemotes as any, 'remote-2');

			expect(result).toEqual(mockSshRemotes[1]);
		});

		it('should return undefined for non-existent id', () => {
			const result = findSshRemoteById(mockSshRemotes as any, 'non-existent');

			expect(result).toBeUndefined();
		});

		it('should return undefined for empty array', () => {
			const result = findSshRemoteById([], 'remote-1');

			expect(result).toBeUndefined();
		});

		it('should find first matching remote when duplicates exist', () => {
			const remotesWithDuplicates = [
				{ id: 'remote-1', name: 'First', host: 'first.example.com', username: 'user1' },
				{ id: 'remote-1', name: 'Second', host: 'second.example.com', username: 'user2' },
			];

			const result = findSshRemoteById(remotesWithDuplicates as any, 'remote-1');

			expect(result?.name).toBe('First');
		});
	});
});

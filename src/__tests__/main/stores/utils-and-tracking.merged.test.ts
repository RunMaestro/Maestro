// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/stores/utils.test.ts
// Source: src/__tests__/main/stores/write-tracker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';
import { getCustomSyncPath, getEarlySettings } from '../../../main/stores/utils';
import type { BootstrapSettings } from '../../../main/stores/types';
import type Store from 'electron-store';
import {
	markInternalWrite,
	hadRecentInternalWrite,
	resetInternalWriteTracking,
	trackStoreWrites,
	INTERNAL_WRITE_SHADOW_MS,
} from '../../../main/stores/write-tracker';
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
// Source: src/__tests__/main/stores/utils.test.ts
describe('', () => {
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
				expect(consoleSpy).toHaveBeenCalledWith(
					`Custom sync path must be absolute: ${relativePath}`
				);
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
				const sensitivePath =
					process.platform === 'win32' ? 'C:\\Windows\\maestro' : '/etc/maestro';
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
					useNativeTitleBar: false,
					autoHideMenuBar: false,
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
					useNativeTitleBar: false,
					autoHideMenuBar: false,
				});
			});
			it('should default useNativeTitleBar to true on Windows', () => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const result = getEarlySettings('/test/path');
				expect(result).toEqual({
					crashReportingEnabled: true,
					disableGpuAcceleration: false,
					useNativeTitleBar: true,
					autoHideMenuBar: false,
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
					useNativeTitleBar: false,
					autoHideMenuBar: false,
				});
			});
		});
	});
});
// Source: src/__tests__/main/stores/write-tracker.test.ts
describe('', () => {
	describe('main/stores/write-tracker', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			resetInternalWriteTracking();
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it('reports no recent write for an untouched file', () => {
			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
		});
		it('reports a recent write inside the shadow window', () => {
			markInternalWrite('maestro-settings.json');
			vi.advanceTimersByTime(INTERNAL_WRITE_SHADOW_MS - 1);
			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
		});
		it('expires once the shadow window has elapsed', () => {
			markInternalWrite('maestro-settings.json');
			vi.advanceTimersByTime(INTERNAL_WRITE_SHADOW_MS + 1);
			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
		});
		it('keeps files independent', () => {
			markInternalWrite('maestro-settings.json');
			expect(hadRecentInternalWrite('maestro-agent-configs.json')).toBe(false);
		});
		describe('trackStoreWrites', () => {
			function makeStore() {
				return {
					data: {} as Record<string, unknown>,
					set(key: string, value: unknown) {
						this.data[key] = value;
						return 'set-result';
					},
					delete(key: string) {
						delete this.data[key];
					},
					clear() {
						this.data = {};
					},
					reset() {
						this.data = {};
					},
					get(key: string) {
						return this.data[key];
					},
				};
			}
			it('stamps a write and preserves the return value and behaviour', () => {
				const store = trackStoreWrites(makeStore(), 'maestro-settings.json');
				const result = store.set('conductorProfile', 'hello');
				expect(result).toBe('set-result');
				expect(store.get('conductorProfile')).toBe('hello');
				expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
			});
			it('stamps delete, clear, and reset too', () => {
				for (const method of ['delete', 'clear', 'reset'] as const) {
					resetInternalWriteTracking();
					const store = trackStoreWrites(makeStore(), 'maestro-settings.json');
					store[method]('conductorProfile');
					expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
				}
			});
			it('does not stamp reads', () => {
				const store = trackStoreWrites(makeStore(), 'maestro-settings.json');
				store.get('conductorProfile');
				expect(hadRecentInternalWrite('maestro-settings.json')).toBe(false);
			});
			it('stamps even when the underlying write throws', () => {
				const store = trackStoreWrites(
					{
						set() {
							throw new Error('ENOSPC');
						},
					},
					'maestro-settings.json'
				);
				expect(() => store.set()).toThrow('ENOSPC');
				expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
			});
		});
	});
});

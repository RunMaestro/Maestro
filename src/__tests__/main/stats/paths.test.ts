/**
 * Tests for cross-platform path resolution and normalization.
 *
 * Note: better-sqlite3 is a native module compiled for Electron's Node version.
 * Direct testing with the native module in vitest is not possible without
 * electron-rebuild for the vitest runtime. These tests use mocked database
 * operations to verify the logic without requiring the actual native module.
 *
 * For full integration testing of the SQLite database, use the Electron test
 * environment (e2e tests) where the native module is properly loaded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Track Database constructor calls to verify file path
let lastDbPath: string | null = null;

// Store mock references so they can be accessed in tests
const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ count: 0, total_duration: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	// Transaction mock that immediately executes the function
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

// Mock better-sqlite3 as a class
vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(dbPath: string) {
				lastDbPath = dbPath;
			}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});

// Mock electron's app module with trackable userData path
const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-stats-db');
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));

// Track fs calls
const mockFsExistsSync = vi.fn(() => true);
const mockFsMkdirSync = vi.fn();
const mockFsCopyFileSync = vi.fn();
const mockFsUnlinkSync = vi.fn();
const mockFsRenameSync = vi.fn();
const mockFsStatSync = vi.fn(() => ({ size: 1024 }));
const mockFsReadFileSync = vi.fn(() => '0'); // Default: old timestamp (triggers vacuum check)
const mockFsWriteFileSync = vi.fn();
const mockFsReaddirSync = vi.fn(() => [] as string[]);

// Mock fs
vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockFsMkdirSync(...args),
	copyFileSync: (...args: unknown[]) => mockFsCopyFileSync(...args),
	unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
	renameSync: (...args: unknown[]) => mockFsRenameSync(...args),
	statSync: (...args: unknown[]) => mockFsStatSync(...args),
	readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
	readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
	promises: {
		access: async (pathArg: unknown) => {
			if (!mockFsExistsSync(pathArg)) {
				const error = new Error('ENOENT');
				(error as NodeJS.ErrnoException).code = 'ENOENT';
				throw error;
			}
		},
		mkdir: async (...args: unknown[]) => mockFsMkdirSync(...args),
		stat: async (...args: unknown[]) => mockFsStatSync(...args),
		readdir: async (...args: unknown[]) => mockFsReaddirSync(...args),
		unlink: async (...args: unknown[]) => mockFsUnlinkSync(...args),
	},
	constants: { F_OK: 0 },
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import types only - we'll test the type definitions
import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
	StatsAggregation,
} from '../../../shared/stats-types';

describe('Cross-platform database path resolution (macOS, Windows, Linux)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('macOS path resolution', () => {
		it('should use macOS-style userData path: ~/Library/Application Support/Maestro/', async () => {
			// Simulate macOS userData path
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(macOsUserData, 'stats.db'));
		});

		it('should handle macOS path with spaces in Application Support', async () => {
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath).toContain('Application Support');
			expect(dbPath).toContain('stats.db');
		});

		it('should handle macOS username with special characters', async () => {
			const macOsUserData = '/Users/test.user-name/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(macOsUserData, 'stats.db'));
		});

		it('should resolve to absolute path on macOS', async () => {
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(path.isAbsolute(db.getDbPath())).toBe(true);
		});
	});

	describe('Windows path resolution', () => {
		it('should use Windows-style userData path: %APPDATA%\\Maestro\\', async () => {
			// Simulate Windows userData path
			const windowsUserData = 'C:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// path.join will use the platform's native separator
			expect(lastDbPath).toBe(path.join(windowsUserData, 'stats.db'));
		});

		it('should handle Windows path with drive letter', async () => {
			const windowsUserData = 'D:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath).toContain('stats.db');
			// The path should start with a drive letter pattern when on Windows
			// or be a proper path when joined
		});

		it('should handle Windows username with spaces', async () => {
			const windowsUserData = 'C:\\Users\\Test User\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(windowsUserData, 'stats.db'));
		});

		it('should handle Windows UNC paths (network drives)', async () => {
			const windowsUncPath = '\\\\NetworkDrive\\SharedFolder\\AppData\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUncPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(windowsUncPath, 'stats.db'));
		});

		it('should handle portable Windows installation path', async () => {
			// Portable apps might use a different structure
			const portablePath = 'E:\\PortableApps\\Maestro\\Data';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(portablePath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(portablePath, 'stats.db'));
		});
	});

	describe('Linux path resolution', () => {
		it('should use Linux-style userData path: ~/.config/Maestro/', async () => {
			// Simulate Linux userData path
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(linuxUserData, 'stats.db'));
		});

		it('should handle Linux XDG_CONFIG_HOME override', async () => {
			// Custom XDG_CONFIG_HOME might result in different path
			const customConfigHome = '/custom/config/path/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(customConfigHome);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(customConfigHome, 'stats.db'));
		});

		it('should handle Linux username with underscore', async () => {
			const linuxUserData = '/home/test_user/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(linuxUserData, 'stats.db'));
		});

		it('should resolve to absolute path on Linux', async () => {
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(path.isAbsolute(db.getDbPath())).toBe(true);
		});

		it('should handle Linux Snap/Flatpak sandboxed paths', async () => {
			// Snap packages have a different path structure
			const snapPath = '/home/testuser/snap/maestro/current/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(snapPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(snapPath, 'stats.db'));
		});
	});

	describe('path.join cross-platform behavior', () => {
		it('should use path.join to combine userData and stats.db', async () => {
			const testUserData = '/test/user/data';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// path.join should be used (not string concatenation)
			expect(db.getDbPath()).toBe(path.join(testUserData, 'stats.db'));
		});

		it('should handle trailing slash in userData path', async () => {
			const userDataWithSlash = '/test/user/data/';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(userDataWithSlash);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// path.join normalizes trailing slashes
			const dbPath = db.getDbPath();
			expect(dbPath.endsWith('stats.db')).toBe(true);
			// Should not have double slashes
			expect(dbPath).not.toContain('//');
		});

		it('should result in stats.db as the basename on all platforms', async () => {
			const testUserData = '/any/path/structure';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(path.basename(db.getDbPath())).toBe('stats.db');
		});

		it('should result in userData directory as the parent', async () => {
			const testUserData = '/any/path/structure';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(testUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(path.dirname(db.getDbPath())).toBe(testUserData);
		});
	});

	describe('directory creation cross-platform', () => {
		it('should create directory on macOS if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const macOsUserData = '/Users/testuser/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(macOsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(macOsUserData, { recursive: true });
		});

		it('should create directory on Windows if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const windowsUserData = 'C:\\Users\\TestUser\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(windowsUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(windowsUserData, { recursive: true });
		});

		it('should create directory on Linux if it does not exist', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const linuxUserData = '/home/testuser/.config/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(linuxUserData);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(linuxUserData, { recursive: true });
		});

		it('should use recursive option for deeply nested paths', async () => {
			mockFsExistsSync.mockReturnValue(false);
			const deepPath = '/very/deep/nested/path/structure/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(deepPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(mockFsMkdirSync).toHaveBeenCalledWith(deepPath, { recursive: true });
		});
	});

	describe('edge cases for path resolution', () => {
		it('should handle unicode characters in path', async () => {
			const unicodePath = '/Users/用户名/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(unicodePath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(unicodePath, 'stats.db'));
		});

		it('should handle emoji in path (macOS supports this)', async () => {
			const emojiPath = '/Users/test/Documents/🎵Music/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(emojiPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(emojiPath, 'stats.db'));
		});

		it('should handle very long paths (approaching Windows MAX_PATH)', async () => {
			// Windows MAX_PATH is 260 characters by default
			const longPath = '/very' + '/long'.repeat(50) + '/path/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(longPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(dbPath.endsWith('stats.db')).toBe(true);
		});

		it('should handle path with single quotes', async () => {
			const quotedPath = "/Users/O'Brien/Library/Application Support/Maestro";
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(quotedPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(quotedPath, 'stats.db'));
		});

		it('should handle path with double quotes (Windows allows this)', async () => {
			// Note: Double quotes aren't typically valid in Windows paths but path.join handles them
			const quotedPath = 'C:\\Users\\Test"User\\AppData\\Roaming\\Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(quotedPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			const dbPath = db.getDbPath();
			expect(path.basename(dbPath)).toBe('stats.db');
		});

		it('should handle path with ampersand', async () => {
			const ampersandPath = '/Users/Smith & Jones/Library/Application Support/Maestro';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(ampersandPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			expect(lastDbPath).toBe(path.join(ampersandPath, 'stats.db'));
		});
	});

	describe('consistency across platform simulations', () => {
		it('should always produce a path ending with stats.db regardless of platform', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../../main/stats');
				const db = new StatsDB();

				expect(path.basename(db.getDbPath())).toBe('stats.db');
			}
		});

		it('should always initialize successfully regardless of platform path format', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				vi.clearAllMocks();
				mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
				mockDb.prepare.mockReturnValue(mockStatement);
				mockFsExistsSync.mockReturnValue(true);

				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../../main/stats');
				const db = new StatsDB();
				await db.initialize();

				expect(db.isReady()).toBe(true);
			}
		});

		it('should pass correct directory to mkdirSync on all platforms', async () => {
			const platforms = [
				'/Users/mac/Library/Application Support/Maestro',
				'C:\\Users\\Windows\\AppData\\Roaming\\Maestro',
				'/home/linux/.config/Maestro',
			];

			for (const platformPath of platforms) {
				vi.resetModules();
				vi.clearAllMocks();
				mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
				mockDb.prepare.mockReturnValue(mockStatement);
				mockFsExistsSync.mockReturnValue(false);
				mockFsMkdirSync.mockClear();

				const { app } = await import('electron');
				vi.mocked(app.getPath).mockReturnValue(platformPath);

				const { StatsDB } = await import('../../../main/stats');
				const db = new StatsDB();
				await db.initialize();

				expect(mockFsMkdirSync).toHaveBeenCalledWith(platformPath, { recursive: true });
			}
		});
	});

	describe('electron app.getPath integration', () => {
		it('should call app.getPath with "userData" argument', async () => {
			const { app } = await import('electron');

			const { StatsDB } = await import('../../../main/stats');
			new StatsDB();

			expect(app.getPath).toHaveBeenCalledWith('userData');
		});

		it('should respect the value returned by app.getPath', async () => {
			const customPath = '/custom/electron/user/data/path';
			const { app } = await import('electron');
			vi.mocked(app.getPath).mockReturnValue(customPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			expect(db.getDbPath()).toBe(path.join(customPath, 'stats.db'));
		});

		it('should use userData path at construction time (not lazily)', async () => {
			const { app } = await import('electron');
			const initialPath = '/initial/path';
			vi.mocked(app.getPath).mockReturnValue(initialPath);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Change the mock after construction
			vi.mocked(app.getPath).mockReturnValue('/different/path');

			// Should still use the initial path
			expect(db.getDbPath()).toBe(path.join(initialPath, 'stats.db'));
		});
	});
});

/**
 * Concurrent writes and database locking tests
 *
 * Tests that verify concurrent write operations don't cause database locking issues.
 * better-sqlite3 uses synchronous operations and WAL mode for optimal concurrent access.
 *
 * Key behaviors tested:
 * - Rapid sequential writes complete without errors
 * - Concurrent write operations all succeed (via Promise.all)
 * - Interleaved read/write operations work correctly
 * - High-volume concurrent writes complete without data loss
 * - WAL mode is properly enabled for concurrent access
 */

describe('File path normalization in database (forward slashes consistently)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
		mockFsMkdirSync.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('normalizePath utility function', () => {
		it('should convert Windows backslashes to forward slashes', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\TestUser\\Projects\\MyApp')).toBe(
				'C:/Users/TestUser/Projects/MyApp'
			);
		});

		it('should preserve Unix-style forward slashes unchanged', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('/Users/testuser/Projects/MyApp')).toBe(
				'/Users/testuser/Projects/MyApp'
			);
		});

		it('should handle mixed slashes (normalize to forward slashes)', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users/TestUser\\Projects/MyApp')).toBe(
				'C:/Users/TestUser/Projects/MyApp'
			);
		});

		it('should handle UNC paths (Windows network shares)', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('\\\\NetworkServer\\Share\\Folder\\File.md')).toBe(
				'//NetworkServer/Share/Folder/File.md'
			);
		});

		it('should return null for null input', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath(null)).toBeNull();
		});

		it('should return null for undefined input', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath(undefined)).toBeNull();
		});

		it('should handle empty string', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('')).toBe('');
		});

		it('should handle path with spaces', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\Test User\\My Documents\\Project')).toBe(
				'C:/Users/Test User/My Documents/Project'
			);
		});

		it('should handle path with special characters', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\test.user-name\\Projects\\[MyApp]')).toBe(
				'C:/Users/test.user-name/Projects/[MyApp]'
			);
		});

		it('should handle consecutive backslashes', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\\\Users\\\\TestUser')).toBe('C://Users//TestUser');
		});

		it('should handle path ending with backslash', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\TestUser\\')).toBe('C:/Users/TestUser/');
		});

		it('should handle Japanese/CJK characters in path', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\ユーザー\\プロジェクト')).toBe(
				'C:/Users/ユーザー/プロジェクト'
			);
		});
	});

	describe('insertQueryEvent path normalization', () => {
		it('should normalize Windows projectPath to forward slashes', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp',
				tabId: 'tab-1',
			});

			// Verify that the statement was called with normalized path
			// insertQueryEvent now has 9 parameters: id, sessionId, agentType, source, startTime, duration, projectPath, tabId, isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String), // id
				'session-1',
				'claude-code',
				'user',
				expect.any(Number), // startTime
				5000,
				'C:/Users/TestUser/Projects/MyApp', // normalized path
				'tab-1',
				null // isRemote (undefined → null)
			);
		});

		it('should preserve Unix projectPath unchanged', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				projectPath: '/Users/testuser/Projects/MyApp',
				tabId: 'tab-1',
			});

			// insertQueryEvent now has 9 parameters including isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'user',
				expect.any(Number),
				5000,
				'/Users/testuser/Projects/MyApp', // unchanged
				'tab-1',
				null // isRemote (undefined → null)
			);
		});

		it('should store null for undefined projectPath', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertQueryEvent({
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user',
				startTime: Date.now(),
				duration: 5000,
				// projectPath is undefined
			});

			// insertQueryEvent now has 9 parameters including isRemote
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'user',
				expect.any(Number),
				5000,
				null, // undefined becomes null
				null, // tabId undefined → null
				null // isRemote undefined → null
			);
		});
	});

	describe('getQueryEvents filter path normalization', () => {
		it('should normalize Windows filter projectPath for matching', async () => {
			// Setup: database returns events with normalized paths
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: 'C:/Users/TestUser/Projects/MyApp', // normalized in DB
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Query with Windows-style path (backslashes)
			const events = db.getQueryEvents('day', {
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp', // Windows style
			});

			// Verify the prepared statement was called with normalized path
			expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('project_path = ?'));

			// The filter should be normalized to forward slashes for matching
			const prepareCallArgs = mockStatement.all.mock.calls[0];
			expect(prepareCallArgs).toContain('C:/Users/TestUser/Projects/MyApp');
		});

		it('should preserve Unix filter projectPath unchanged', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getQueryEvents('week', {
				projectPath: '/Users/testuser/Projects/MyApp',
			});

			const prepareCallArgs = mockStatement.all.mock.calls[0];
			expect(prepareCallArgs).toContain('/Users/testuser/Projects/MyApp');
		});
	});

	describe('insertAutoRunSession path normalization', () => {
		it('should normalize Windows documentPath and projectPath', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: 'C:\\Users\\TestUser\\Docs\\task.md',
				startTime: Date.now(),
				duration: 60000,
				tasksTotal: 5,
				tasksCompleted: 3,
				projectPath: 'C:\\Users\\TestUser\\Projects\\MyApp',
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				'C:/Users/TestUser/Docs/task.md', // normalized documentPath
				expect.any(Number),
				60000,
				5,
				3,
				'C:/Users/TestUser/Projects/MyApp' // normalized projectPath
			);
		});

		it('should handle null paths correctly', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				startTime: Date.now(),
				duration: 60000,
				// documentPath and projectPath are undefined
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.any(String),
				'session-1',
				'claude-code',
				null, // undefined documentPath becomes null
				expect.any(Number),
				60000,
				null,
				null,
				null // undefined projectPath becomes null
			);
		});
	});

	describe('updateAutoRunSession path normalization', () => {
		it('should normalize Windows documentPath on update', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.updateAutoRunSession('auto-run-1', {
				duration: 120000,
				documentPath: 'D:\\Projects\\NewDocs\\updated.md',
			});

			// The SQL should include document_path update with normalized path
			expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('document_path = ?'));
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should handle undefined documentPath in update (no change)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.updateAutoRunSession('auto-run-1', {
				duration: 120000,
				tasksCompleted: 5,
				// documentPath not included
			});

			// The SQL should NOT include document_path
			const prepareCalls = mockDb.prepare.mock.calls;
			const updateCall = prepareCalls.find((call) => call[0]?.includes?.('UPDATE'));
			if (updateCall) {
				expect(updateCall[0]).not.toContain('document_path');
			}
		});
	});

	describe('cross-platform path consistency', () => {
		it('should produce identical normalized paths from Windows and Unix inputs for same logical path', async () => {
			const { normalizePath } = await import('../../../main/stats');

			const windowsPath = 'C:\\Users\\Test\\project';
			const unixPath = 'C:/Users/Test/project';

			expect(normalizePath(windowsPath)).toBe(normalizePath(unixPath));
		});

		it('should allow filtering by either path style and match stored normalized path', async () => {
			// Setup: database returns events with normalized paths
			const storedPath = 'C:/Users/TestUser/Projects/MyApp';
			mockStatement.all.mockReturnValue([
				{
					id: 'event-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					source: 'user',
					start_time: Date.now(),
					duration: 5000,
					project_path: storedPath,
					tab_id: 'tab-1',
				},
			]);

			const { StatsDB, normalizePath } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Both Windows and Unix style filters should normalize to the same value
			const windowsFilter = 'C:\\Users\\TestUser\\Projects\\MyApp';
			const unixFilter = 'C:/Users/TestUser/Projects/MyApp';

			expect(normalizePath(windowsFilter)).toBe(storedPath);
			expect(normalizePath(unixFilter)).toBe(storedPath);
		});

		it('should handle Linux paths correctly', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('/home/user/.config/maestro')).toBe('/home/user/.config/maestro');
		});

		it('should handle macOS Application Support paths correctly', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('/Users/test/Library/Application Support/Maestro')).toBe(
				'/Users/test/Library/Application Support/Maestro'
			);
		});
	});

	describe('edge cases and special characters', () => {
		it('should handle paths with unicode characters', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\用户\\项目')).toBe('C:/Users/用户/项目');
		});

		it('should handle paths with emoji (if supported by filesystem)', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\Test\\📁Projects\\MyApp')).toBe(
				'C:/Users/Test/📁Projects/MyApp'
			);
		});

		it('should handle very long paths', async () => {
			const { normalizePath } = await import('../../../main/stats');
			const longPath =
				'C:\\Users\\TestUser\\' + 'VeryLongDirectoryName\\'.repeat(20) + 'FinalFile.md';
			const normalizedPath = normalizePath(longPath);
			expect(normalizedPath).not.toContain('\\');
			expect(normalizedPath).toContain('/');
		});

		it('should handle root paths', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\')).toBe('C:/');
			expect(normalizePath('/')).toBe('/');
		});

		it('should handle drive letter only', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('D:')).toBe('D:');
		});

		it('should handle paths with dots', async () => {
			const { normalizePath } = await import('../../../main/stats');
			expect(normalizePath('C:\\Users\\..\\TestUser\\.hidden\\file.txt')).toBe(
				'C:/Users/../TestUser/.hidden/file.txt'
			);
		});
	});
});

/**
 * Database VACUUM functionality tests
 *
 * Tests for the automatic database vacuum feature that runs on startup
 * when the database exceeds 100MB to maintain performance.
 */

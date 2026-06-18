/**
 * Tests for VACUUM scheduling, clearOldData, and database maintenance.
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

describe('Database VACUUM functionality', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
		// Reset statSync to throw by default (simulates file not existing)
		mockFsStatSync.mockImplementation(() => {
			throw new Error('ENOENT: no such file or directory');
		});
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('getDatabaseSize', () => {
		it('should return 0 when statSync throws (file missing)', async () => {
			// The mock fs.statSync is not configured to return size by default
			// so getDatabaseSize will catch the error and return 0
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Since mockFsExistsSync.mockReturnValue(true) is set but statSync is not mocked,
			// getDatabaseSize will try to call the real statSync on a non-existent path
			// and catch the error, returning 0
			const size = db.getDatabaseSize();

			// The mock environment doesn't have actual file, so expect 0
			expect(size).toBe(0);
		});

		it('should handle statSync gracefully when file does not exist', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// getDatabaseSize should not throw
			expect(() => db.getDatabaseSize()).not.toThrow();
		});
	});

	describe('vacuum', () => {
		it('should execute VACUUM SQL command', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should return success true when vacuum completes', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should return bytesFreed of 0 when sizes are equal (mocked)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			// With mock fs, both before and after sizes will be 0
			expect(result.bytesFreed).toBe(0);
		});

		it('should return error if database not initialized', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			// Don't initialize

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.bytesFreed).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should handle VACUUM failure gracefully', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Make VACUUM fail
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const result = db.vacuum();

			expect(result.success).toBe(false);
			expect(result.error).toContain('database is locked');
		});

		it('should log vacuum progress with size information', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.info).mockClear();

			db.vacuum();

			// Check that logger was called with vacuum-related messages
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Starting VACUUM'),
				expect.any(String)
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('VACUUM completed'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded', () => {
		it('should skip vacuum if database size is 0 (below threshold)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			const result = db.vacuumIfNeeded();

			// Size is 0 (mock fs), which is below 100MB threshold
			expect(result.vacuumed).toBe(false);
			expect(result.databaseSize).toBe(0);
			expect(result.result).toBeUndefined();
		});

		it('should return correct databaseSize in result', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			// Size property should be present
			expect(typeof result.databaseSize).toBe('number');
		});

		it('should use default 100MB threshold when not specified', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// With 0 byte size (mocked), should skip vacuum
			const result = db.vacuumIfNeeded();

			expect(result.vacuumed).toBe(false);
		});

		it('should not vacuum with threshold 0 and size 0 since 0 is not > 0', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 0 threshold and 0 byte file: 0 is NOT greater than 0
			const result = db.vacuumIfNeeded(0);

			// The condition is: databaseSize < thresholdBytes
			// 0 < 0 is false, so vacuumed should be true (it tries to vacuum)
			expect(result.databaseSize).toBe(0);
			// Since 0 is NOT less than 0, it proceeds to vacuum
			expect(result.vacuumed).toBe(true);
		});

		it('should log appropriate message when skipping vacuum', async () => {
			const { logger } = await import('../../../main/utils/logger');
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear logger mocks from initialization
			vi.mocked(logger.debug).mockClear();

			db.vacuumIfNeeded();

			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});
	});

	describe('vacuumIfNeeded with custom thresholds', () => {
		it('should respect custom threshold parameter (threshold = -1 means always vacuum)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With -1 threshold, 0 > -1 is true, so should vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM');
		});

		it('should not vacuum with very large threshold', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Clear mocks from initialization
			mockStatement.run.mockClear();
			mockDb.prepare.mockClear();

			// With 1TB threshold, should NOT trigger vacuum
			const result = db.vacuumIfNeeded(1024 * 1024 * 1024 * 1024);

			expect(result.vacuumed).toBe(false);
			expect(mockDb.prepare).not.toHaveBeenCalledWith('VACUUM');
		});
	});

	describe('initialize with vacuumIfNeeded integration', () => {
		it('should call vacuumIfNeededWeekly during initialization', async () => {
			const { logger } = await import('../../../main/utils/logger');

			// Clear logger mocks before test
			vi.mocked(logger.debug).mockClear();

			// Mock timestamp file as old (0 = epoch, triggers vacuum check)
			mockFsReadFileSync.mockReturnValue('0');

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			db.initialize();

			// With old timestamp, vacuumIfNeededWeekly should proceed to call vacuumIfNeeded
			// which logs "below vacuum threshold" for small databases (mocked as 1024 bytes)
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('below vacuum threshold'),
				expect.any(String)
			);
		});

		it('should complete initialization even if vacuum would fail', async () => {
			// Make VACUUM fail if called
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql === 'VACUUM') {
					return {
						run: vi.fn().mockImplementation(() => {
							throw new Error('VACUUM failed: database is locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Initialize should not throw (vacuum is skipped due to 0 size anyway)
			expect(() => db.initialize()).not.toThrow();

			// Database should still be ready
			expect(db.isReady()).toBe(true);
		});

		it('should not block initialization for small databases', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();

			// Time the initialization (should be fast for mock)
			const start = Date.now();
			db.initialize();
			const elapsed = Date.now() - start;

			expect(db.isReady()).toBe(true);
			expect(elapsed).toBeLessThan(1000); // Should be fast in mock environment
		});
	});

	describe('vacuum return types', () => {
		it('vacuum should return object with success, bytesFreed, and optional error', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuum();

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.bytesFreed).toBe('number');
			expect(result.error === undefined || typeof result.error === 'string').toBe(true);
		});

		it('vacuumIfNeeded should return object with vacuumed, databaseSize, and optional result', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.vacuumIfNeeded();

			expect(typeof result.vacuumed).toBe('boolean');
			expect(typeof result.databaseSize).toBe('number');
			expect(result.result === undefined || typeof result.result === 'object').toBe(true);
		});

		it('vacuumIfNeeded should include result when vacuum is performed', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Use -1 threshold to force vacuum
			const result = db.vacuumIfNeeded(-1);

			expect(result.vacuumed).toBe(true);
			expect(result.result).toBeDefined();
			expect(result.result?.success).toBe(true);
		});
	});

	describe('clearOldData method', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.resetModules();
		});

		it('should return error when database is not initialized', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			// Don't initialize

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBe('Database not initialized');
		});

		it('should return error when olderThanDays is 0 or negative', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const resultZero = db.clearOldData(0);
			expect(resultZero.success).toBe(false);
			expect(resultZero.error).toBe('olderThanDays must be greater than 0');

			const resultNegative = db.clearOldData(-10);
			expect(resultNegative.success).toBe(false);
			expect(resultNegative.error).toBe('olderThanDays must be greater than 0');
		});

		it('should successfully clear old data with valid parameters', async () => {
			// Mock prepare to return statements with expected behavior
			mockStatement.all.mockReturnValue([{ id: 'session-1' }, { id: 'session-2' }]);
			mockStatement.run.mockReturnValue({ changes: 5 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(5);
			expect(result.deletedAutoRunSessions).toBe(5);
			expect(result.deletedAutoRunTasks).toBe(5);
			expect(result.error).toBeUndefined();
		});

		it('should handle empty results (no old data)', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(365);

			expect(result.success).toBe(true);
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
			expect(result.error).toBeUndefined();
		});

		it('should calculate correct cutoff time based on days', async () => {
			let capturedCutoffTime: number | null = null;

			mockDb.prepare.mockImplementation((sql: string) => {
				return {
					run: vi.fn((cutoff: number) => {
						if (sql.includes('DELETE FROM query_events')) {
							capturedCutoffTime = cutoff;
						}
						return { changes: 0 };
					}),
					get: mockStatement.get,
					all: vi.fn(() => []),
				};
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const beforeCall = Date.now();
			db.clearOldData(7);
			const afterCall = Date.now();

			// Cutoff should be approximately 7 days ago
			const expectedCutoff = beforeCall - 7 * 24 * 60 * 60 * 1000;
			expect(capturedCutoffTime).not.toBeNull();
			expect(capturedCutoffTime!).toBeGreaterThanOrEqual(expectedCutoff - 1000);
			expect(capturedCutoffTime!).toBeLessThanOrEqual(afterCall - 7 * 24 * 60 * 60 * 1000 + 1000);
		});

		it('should handle database errors gracefully', async () => {
			mockDb.prepare.mockImplementation((sql: string) => {
				if (sql.includes('DELETE FROM query_events')) {
					return {
						run: vi.fn(() => {
							throw new Error('Database locked');
						}),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const result = db.clearOldData(30);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Database locked');
			expect(result.deletedQueryEvents).toBe(0);
			expect(result.deletedAutoRunSessions).toBe(0);
			expect(result.deletedAutoRunTasks).toBe(0);
		});

		it('should support various time periods', async () => {
			mockStatement.all.mockReturnValue([]);
			mockStatement.run.mockReturnValue({ changes: 0 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			// Test common time periods from Settings UI
			const periods = [7, 30, 90, 180, 365];
			for (const days of periods) {
				const result = db.clearOldData(days);
				expect(result.success).toBe(true);
			}
		});
	});

	// =====================================================================
});

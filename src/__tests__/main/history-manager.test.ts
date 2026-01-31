/**
 * Tests for the HistoryManager class
 *
 * HistoryManager handles per-session history storage with automatic migration
 * from a legacy single-file format. Each session gets its own JSON file in a
 * dedicated history/ subdirectory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock electron
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock fs module
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	readdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	watch: vi.fn(),
}));

import * as fs from 'fs';
import { app } from 'electron';
import { logger } from '../../main/utils/logger';
import { HistoryManager, getHistoryManager } from '../../main/history-manager';
import {
	HISTORY_VERSION,
	MAX_ENTRIES_PER_SESSION,
	sanitizeSessionId,
} from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';

// Type the mocked fs functions
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);
const mockWatch = vi.mocked(fs.watch);

/**
 * Helper to create a mock HistoryEntry
 */
function createMockEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: `entry-${Math.random().toString(36).slice(2, 8)}`,
		type: 'USER',
		timestamp: Date.now(),
		summary: 'Test summary',
		projectPath: '/test/project',
		sessionId: 'session-1',
		...overrides,
	};
}

/**
 * Helper to create a serialized history file data string
 */
function createHistoryFileData(
	sessionId: string,
	entries: HistoryEntry[],
	projectPath = '/test/project'
): string {
	return JSON.stringify({
		version: HISTORY_VERSION,
		sessionId,
		projectPath,
		entries,
	});
}

describe('HistoryManager', () => {
	let manager: HistoryManager;

	beforeEach(() => {
		vi.resetAllMocks();
		// Default: nothing exists
		mockExistsSync.mockReturnValue(false);
		manager = new HistoryManager();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ----------------------------------------------------------------
	// Constructor
	// ----------------------------------------------------------------
	describe('constructor', () => {
		it('should set up paths based on app.getPath("userData")', () => {
			expect(app.getPath).toHaveBeenCalledWith('userData');
			expect(manager.getHistoryDir()).toBe(path.join('/mock/userData', 'history'));
			expect(manager.getLegacyFilePath()).toBe(
				path.join('/mock/userData', 'maestro-history.json')
			);
		});
	});

	// ----------------------------------------------------------------
	// initialize()
	// ----------------------------------------------------------------
	describe('initialize()', () => {
		it('should create history directory if it does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			await manager.initialize();

			expect(mockMkdirSync).toHaveBeenCalledWith(
				path.join('/mock/userData', 'history'),
				{ recursive: true }
			);
		});

		it('should not recreate history directory if it already exists', async () => {
			// history dir exists, marker exists (no migration)
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return true;
				return false;
			});

			await manager.initialize();
			expect(mockMkdirSync).not.toHaveBeenCalled();
		});

		it('should run migration if needed', async () => {
			// history dir does not exist, marker does not exist, legacy file exists with entries
			const legacyEntries = [createMockEntry({ sessionId: 'sess-1' })];
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ entries: legacyEntries })
			);

			await manager.initialize();

			// Should have written a session file and a migration marker
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		it('should not run migration if marker already exists', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return true;
				return false;
			});

			await manager.initialize();

			// No session file writes expected
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// needsMigration() (tested indirectly through initialize)
	// ----------------------------------------------------------------
	describe('needsMigration (via initialize)', () => {
		it('should not need migration when marker exists', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return true;
				return false;
			});

			await manager.initialize();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should need migration when legacy file has entries', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ entries: [createMockEntry({ sessionId: 's1' })] })
			);

			await manager.initialize();
			expect(mockWriteFileSync).toHaveBeenCalled();
		});

		it('should not need migration when legacy file is empty', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries: [] }));

			await manager.initialize();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should not need migration when legacy file does not exist', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return false;
				return false;
			});

			await manager.initialize();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should not need migration when legacy file is malformed', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue('not-json{{{');

			await manager.initialize();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// hasMigrated()
	// ----------------------------------------------------------------
	describe('hasMigrated()', () => {
		it('should return true when migration marker exists', () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return p.toString().endsWith('history-migrated.json');
			});
			expect(manager.hasMigrated()).toBe(true);
		});

		it('should return false when migration marker does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.hasMigrated()).toBe(false);
		});
	});

	// ----------------------------------------------------------------
	// migrateFromLegacy() (tested via initialize)
	// ----------------------------------------------------------------
	describe('migrateFromLegacy (via initialize)', () => {
		it('should group entries by sessionId and write per-session files', async () => {
			const entry1 = createMockEntry({ sessionId: 'sess-a', id: 'e1', projectPath: '/projA' });
			const entry2 = createMockEntry({ sessionId: 'sess-a', id: 'e2', projectPath: '/projA' });
			const entry3 = createMockEntry({ sessionId: 'sess-b', id: 'e3', projectPath: '/projB' });

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ entries: [entry1, entry2, entry3] })
			);

			await manager.initialize();

			// Should write two session files + migration marker = 3 writes
			// (mkdirSync for history dir also called)
			const writeCalls = mockWriteFileSync.mock.calls;
			expect(writeCalls.length).toBe(3); // sess-a.json, sess-b.json, migration marker

			// Check session file for sess-a
			const sessACall = writeCalls.find((c) =>
				c[0].toString().includes(`sess-a.json`)
			);
			expect(sessACall).toBeDefined();
			const sessAData = JSON.parse(sessACall![1] as string);
			expect(sessAData.entries).toHaveLength(2);
			expect(sessAData.sessionId).toBe('sess-a');

			// Check session file for sess-b
			const sessBCall = writeCalls.find((c) =>
				c[0].toString().includes(`sess-b.json`)
			);
			expect(sessBCall).toBeDefined();
			const sessBData = JSON.parse(sessBCall![1] as string);
			expect(sessBData.entries).toHaveLength(1);
			expect(sessBData.sessionId).toBe('sess-b');
		});

		it('should create migration marker with correct metadata', async () => {
			const entries = [
				createMockEntry({ sessionId: 'sess-1' }),
				createMockEntry({ sessionId: 'sess-2' }),
			];

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries }));

			await manager.initialize();

			const markerCall = mockWriteFileSync.mock.calls.find((c) =>
				c[0].toString().endsWith('history-migrated.json')
			);
			expect(markerCall).toBeDefined();
			const marker = JSON.parse(markerCall![1] as string);
			expect(marker.version).toBe(HISTORY_VERSION);
			expect(marker.legacyEntryCount).toBe(2);
			expect(marker.sessionsMigrated).toBe(2);
			expect(typeof marker.migratedAt).toBe('number');
		});

		it('should skip orphaned entries (no sessionId)', async () => {
			const goodEntry = createMockEntry({ sessionId: 'sess-1', id: 'good' });
			const orphanedEntry = createMockEntry({ id: 'orphan' });
			delete (orphanedEntry as Partial<HistoryEntry>).sessionId;

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(
				JSON.stringify({ entries: [goodEntry, orphanedEntry] })
			);

			await manager.initialize();

			// Should write 1 session file + migration marker
			expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

			// Marker should reflect total entry count (including orphaned)
			const markerCall = mockWriteFileSync.mock.calls.find((c) =>
				c[0].toString().endsWith('history-migrated.json')
			);
			const marker = JSON.parse(markerCall![1] as string);
			expect(marker.legacyEntryCount).toBe(2);
			expect(marker.sessionsMigrated).toBe(1);

			// Should log that orphaned entries were skipped
			expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
				expect.stringContaining('Skipped 1 orphaned entries'),
				expect.any(String)
			);
		});

		it('should trim entries to MAX_ENTRIES_PER_SESSION per session during migration', async () => {
			// Create more entries than the limit for a single session
			const entries: HistoryEntry[] = [];
			for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 50; i++) {
				entries.push(createMockEntry({ sessionId: 'sess-big', id: `e-${i}` }));
			}

			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries }));

			await manager.initialize();

			const sessionCall = mockWriteFileSync.mock.calls.find((c) =>
				c[0].toString().includes('sess-big.json')
			);
			const sessionData = JSON.parse(sessionCall![1] as string);
			expect(sessionData.entries.length).toBe(MAX_ENTRIES_PER_SESSION);
		});

		it('should throw and log error if migration fails', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return false;
				if (s.endsWith('history-migrated.json')) return false;
				if (s.endsWith('maestro-history.json')) return true;
				return false;
			});
			// First call (needsMigration) succeeds; second call (migrateFromLegacy) throws
			mockReadFileSync
				.mockReturnValueOnce(JSON.stringify({ entries: [createMockEntry({ sessionId: 's1' })] }))
				.mockImplementationOnce(() => {
					throw new Error('Disk read error');
				});

			await expect(manager.initialize()).rejects.toThrow('Disk read error');
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringContaining('History migration failed'),
				expect.any(String)
			);
		});
	});

	// ----------------------------------------------------------------
	// getEntries(sessionId)
	// ----------------------------------------------------------------
	describe('getEntries()', () => {
		it('should return entries from session file', () => {
			const entries = [createMockEntry({ id: 'e1' }), createMockEntry({ id: 'e2' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			const result = manager.getEntries('session-1');
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('e1');
		});

		it('should return empty array if session file does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			const result = manager.getEntries('nonexistent');
			expect(result).toEqual([]);
		});

		it('should return empty array on read error', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Read error');
			});

			const result = manager.getEntries('session-1');
			expect(result).toEqual([]);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		});

		it('should return empty array when file contains malformed JSON', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('not valid json');

			const result = manager.getEntries('session-1');
			expect(result).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// addEntry(sessionId, projectPath, entry)
	// ----------------------------------------------------------------
	describe('addEntry()', () => {
		it('should create a new file when session does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			const entry = createMockEntry({ id: 'new-entry' });

			manager.addEntry('session-1', '/test/project', entry);

			expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries).toHaveLength(1);
			expect(written.entries[0].id).toBe('new-entry');
			expect(written.sessionId).toBe('session-1');
			expect(written.projectPath).toBe('/test/project');
			expect(written.version).toBe(HISTORY_VERSION);
		});

		it('should prepend entry to beginning of existing file', () => {
			const existingEntry = createMockEntry({ id: 'old' });
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('session-1', [existingEntry])
			);

			const newEntry = createMockEntry({ id: 'new' });
			manager.addEntry('session-1', '/test/project', newEntry);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries).toHaveLength(2);
			expect(written.entries[0].id).toBe('new');
			expect(written.entries[1].id).toBe('old');
		});

		it('should trim to MAX_ENTRIES_PER_SESSION', () => {
			const existingEntries: HistoryEntry[] = [];
			for (let i = 0; i < MAX_ENTRIES_PER_SESSION; i++) {
				existingEntries.push(createMockEntry({ id: `e-${i}` }));
			}

			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('session-1', existingEntries)
			);

			const newEntry = createMockEntry({ id: 'overflow' });
			manager.addEntry('session-1', '/test/project', newEntry);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries).toHaveLength(MAX_ENTRIES_PER_SESSION);
			expect(written.entries[0].id).toBe('overflow');
		});

		it('should update projectPath on existing file', () => {
			const existingEntry = createMockEntry({ id: 'e1' });
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('session-1', [existingEntry], '/old/path')
			);

			const newEntry = createMockEntry({ id: 'e2' });
			manager.addEntry('session-1', '/new/path', newEntry);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.projectPath).toBe('/new/path');
		});

		it('should create fresh data when existing file is corrupted', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('corrupted-json{{{');

			const entry = createMockEntry({ id: 'new-entry' });
			manager.addEntry('session-1', '/test/project', entry);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries).toHaveLength(1);
			expect(written.entries[0].id).toBe('new-entry');
		});

		it('should log error on write failure', () => {
			mockExistsSync.mockReturnValue(false);
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('Write error');
			});

			const entry = createMockEntry({ id: 'e1' });
			// Should not throw
			manager.addEntry('session-1', '/test/project', entry);

			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringContaining('Failed to write history'),
				expect.any(String)
			);
		});
	});

	// ----------------------------------------------------------------
	// deleteEntry(sessionId, entryId)
	// ----------------------------------------------------------------
	describe('deleteEntry()', () => {
		it('should remove an entry by id and return true', () => {
			const entries = [
				createMockEntry({ id: 'e1' }),
				createMockEntry({ id: 'e2' }),
			];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			const result = manager.deleteEntry('session-1', 'e1');
			expect(result).toBe(true);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries).toHaveLength(1);
			expect(written.entries[0].id).toBe('e2');
		});

		it('should return false if session file does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.deleteEntry('nonexistent', 'e1')).toBe(false);
		});

		it('should return false if entry is not found', () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			expect(manager.deleteEntry('session-1', 'nonexistent')).toBe(false);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should return false on read error (parse failure)', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('bad json');

			expect(manager.deleteEntry('session-1', 'e1')).toBe(false);
		});

		it('should return false on write error', () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('Write error');
			});

			expect(manager.deleteEntry('session-1', 'e1')).toBe(false);
			expect(vi.mocked(logger.error)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// updateEntry(sessionId, entryId, updates)
	// ----------------------------------------------------------------
	describe('updateEntry()', () => {
		it('should update an entry by id and return true', () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'original' }),
			];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			const result = manager.updateEntry('session-1', 'e1', { summary: 'updated' });
			expect(result).toBe(true);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries[0].summary).toBe('updated');
			expect(written.entries[0].id).toBe('e1');
		});

		it('should return false if session file does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.updateEntry('nonexistent', 'e1', { summary: 'x' })).toBe(false);
		});

		it('should return false if entry is not found', () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			expect(manager.updateEntry('session-1', 'nonexistent', { summary: 'x' })).toBe(false);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should return false on parse error', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('bad json');

			expect(manager.updateEntry('session-1', 'e1', { summary: 'x' })).toBe(false);
		});

		it('should return false on write error', () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('Write error');
			});

			expect(manager.updateEntry('session-1', 'e1', { summary: 'x' })).toBe(false);
			expect(vi.mocked(logger.error)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearSession(sessionId)
	// ----------------------------------------------------------------
	describe('clearSession()', () => {
		it('should delete the session file if it exists', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);

			manager.clearSession('session-1');

			expect(mockUnlinkSync).toHaveBeenCalledWith(filePath);
		});

		it('should do nothing if session file does not exist', () => {
			mockExistsSync.mockReturnValue(false);

			manager.clearSession('nonexistent');

			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it('should log error on delete failure', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockUnlinkSync.mockImplementation(() => {
				throw new Error('Delete error');
			});

			manager.clearSession('session-1');

			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				expect.stringContaining('Failed to clear history'),
				expect.any(String)
			);
		});
	});

	// ----------------------------------------------------------------
	// listSessionsWithHistory()
	// ----------------------------------------------------------------
	describe('listSessionsWithHistory()', () => {
		it('should return session IDs from .json files in history dir', () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) =>
				p.toString().endsWith('history')
			);
			mockReaddirSync.mockReturnValue([
				'session_1.json' as unknown as fs.Dirent,
				'session_2.json' as unknown as fs.Dirent,
				'readme.txt' as unknown as fs.Dirent,
			]);

			const result = manager.listSessionsWithHistory();
			expect(result).toEqual(['session_1', 'session_2']);
		});

		it('should return empty array if history directory does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.listSessionsWithHistory()).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getHistoryFilePath(sessionId)
	// ----------------------------------------------------------------
	describe('getHistoryFilePath()', () => {
		it('should return file path if session file exists', () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);

			expect(manager.getHistoryFilePath('session-1')).toBe(filePath);
		});

		it('should return null if session file does not exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.getHistoryFilePath('nonexistent')).toBeNull();
		});
	});

	// ----------------------------------------------------------------
	// getAllEntries(limit?)
	// ----------------------------------------------------------------
	describe('getAllEntries()', () => {
		it('should aggregate entries across all sessions sorted by timestamp', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
				'sess_b.json' as unknown as fs.Dirent,
			]);

			const entryA = createMockEntry({ id: 'a1', timestamp: 100 });
			const entryB = createMockEntry({ id: 'b1', timestamp: 200 });

			mockReadFileSync.mockImplementation((p: string | fs.PathLike) => {
				const s = p.toString();
				if (s.includes('sess_a.json')) {
					return createHistoryFileData('sess_a', [entryA]);
				}
				if (s.includes('sess_b.json')) {
					return createHistoryFileData('sess_b', [entryB]);
				}
				return '{}';
			});

			const result = manager.getAllEntries();
			expect(result).toHaveLength(2);
			// Sorted descending: 200, 100
			expect(result[0].id).toBe('b1');
			expect(result[1].id).toBe('a1');
		});

		it('should respect limit parameter', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({ id: 'e1', timestamp: 300 }),
				createMockEntry({ id: 'e2', timestamp: 200 }),
				createMockEntry({ id: 'e3', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(createHistoryFileData('sess_a', entries));

			const result = manager.getAllEntries(2);
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('e1');
			expect(result[1].id).toBe('e2');
		});

		it('should return empty array when no sessions exist', () => {
			mockExistsSync.mockReturnValue(false);
			expect(manager.getAllEntries()).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getAllEntriesPaginated(options?)
	// ----------------------------------------------------------------
	describe('getAllEntriesPaginated()', () => {
		it('should return paginated results with metadata', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({ id: 'e1', timestamp: 300 }),
				createMockEntry({ id: 'e2', timestamp: 200 }),
				createMockEntry({ id: 'e3', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(createHistoryFileData('sess_a', entries));

			const result = manager.getAllEntriesPaginated({ limit: 2, offset: 0 });
			expect(result.entries).toHaveLength(2);
			expect(result.total).toBe(3);
			expect(result.limit).toBe(2);
			expect(result.offset).toBe(0);
			expect(result.hasMore).toBe(true);
		});

		it('should handle offset beyond total entries', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('sess_a', [createMockEntry()])
			);

			const result = manager.getAllEntriesPaginated({ limit: 10, offset: 100 });
			expect(result.entries).toHaveLength(0);
			expect(result.total).toBe(1);
			expect(result.hasMore).toBe(false);
		});
	});

	// ----------------------------------------------------------------
	// getEntriesByProjectPath(projectPath)
	// ----------------------------------------------------------------
	describe('getEntriesByProjectPath()', () => {
		it('should return entries matching project path', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
				'sess_b.json' as unknown as fs.Dirent,
			]);

			const entryA = createMockEntry({
				id: 'a1',
				projectPath: '/project/alpha',
				timestamp: 100,
			});
			const entryB = createMockEntry({
				id: 'b1',
				projectPath: '/project/beta',
				timestamp: 200,
			});

			mockReadFileSync.mockImplementation((p: string | fs.PathLike) => {
				const s = p.toString();
				if (s.includes('sess_a.json')) {
					return createHistoryFileData('sess_a', [entryA], '/project/alpha');
				}
				if (s.includes('sess_b.json')) {
					return createHistoryFileData('sess_b', [entryB], '/project/beta');
				}
				return '{}';
			});

			const result = manager.getEntriesByProjectPath('/project/alpha');
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('a1');
		});

		it('should return empty array when no matching sessions exist', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entry = createMockEntry({ projectPath: '/other/path' });
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('sess_a', [entry], '/other/path')
			);

			const result = manager.getEntriesByProjectPath('/no/match');
			expect(result).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getEntriesByProjectPathPaginated(projectPath, options?)
	// ----------------------------------------------------------------
	describe('getEntriesByProjectPathPaginated()', () => {
		it('should return paginated results filtered by project path', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({ id: 'e1', projectPath: '/proj', timestamp: 300 }),
				createMockEntry({ id: 'e2', projectPath: '/proj', timestamp: 200 }),
				createMockEntry({ id: 'e3', projectPath: '/proj', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('sess_a', entries, '/proj')
			);

			const result = manager.getEntriesByProjectPathPaginated('/proj', {
				limit: 2,
				offset: 0,
			});
			expect(result.entries).toHaveLength(2);
			expect(result.total).toBe(3);
			expect(result.hasMore).toBe(true);
		});
	});

	// ----------------------------------------------------------------
	// getEntriesPaginated(sessionId, options?)
	// ----------------------------------------------------------------
	describe('getEntriesPaginated()', () => {
		it('should return paginated results for a single session', () => {
			const entries = [
				createMockEntry({ id: 'e1' }),
				createMockEntry({ id: 'e2' }),
				createMockEntry({ id: 'e3' }),
			];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', entries));

			const result = manager.getEntriesPaginated('session-1', { limit: 2, offset: 1 });
			expect(result.entries).toHaveLength(2);
			expect(result.total).toBe(3);
			expect(result.offset).toBe(1);
			expect(result.hasMore).toBe(false);
		});

		it('should return empty paginated result for nonexistent session', () => {
			mockExistsSync.mockReturnValue(false);

			const result = manager.getEntriesPaginated('nonexistent');
			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
		});
	});

	// ----------------------------------------------------------------
	// updateSessionNameByClaudeSessionId(agentSessionId, sessionName)
	// ----------------------------------------------------------------
	describe('updateSessionNameByClaudeSessionId()', () => {
		it('should update sessionName for matching entries and return count', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({
					id: 'e1',
					agentSessionId: 'agent-123',
					sessionName: 'old-name',
				}),
				createMockEntry({
					id: 'e2',
					agentSessionId: 'agent-123',
					sessionName: 'old-name',
				}),
				createMockEntry({
					id: 'e3',
					agentSessionId: 'agent-other',
					sessionName: 'other',
				}),
			];
			mockReadFileSync.mockReturnValue(createHistoryFileData('sess_a', entries));

			const count = manager.updateSessionNameByClaudeSessionId('agent-123', 'new-name');
			expect(count).toBe(2);

			const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
			expect(written.entries[0].sessionName).toBe('new-name');
			expect(written.entries[1].sessionName).toBe('new-name');
			expect(written.entries[2].sessionName).toBe('other');
		});

		it('should return 0 when no entries match', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({ id: 'e1', agentSessionId: 'agent-999' }),
			];
			mockReadFileSync.mockReturnValue(createHistoryFileData('sess_a', entries));

			const count = manager.updateSessionNameByClaudeSessionId('no-match', 'new-name');
			expect(count).toBe(0);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should not update entries that already have the correct sessionName', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entries = [
				createMockEntry({
					id: 'e1',
					agentSessionId: 'agent-123',
					sessionName: 'already-correct',
				}),
			];
			mockReadFileSync.mockReturnValue(createHistoryFileData('sess_a', entries));

			const count = manager.updateSessionNameByClaudeSessionId(
				'agent-123',
				'already-correct'
			);
			expect(count).toBe(0);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should handle read errors gracefully', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Read error');
			});

			const count = manager.updateSessionNameByClaudeSessionId('agent-123', 'new-name');
			expect(count).toBe(0);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearByProjectPath(projectPath)
	// ----------------------------------------------------------------
	describe('clearByProjectPath()', () => {
		it('should clear sessions matching the project path', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
				'sess_b.json' as unknown as fs.Dirent,
			]);

			const entryA = createMockEntry({ projectPath: '/target/project' });
			const entryB = createMockEntry({ projectPath: '/other/project' });

			mockReadFileSync.mockImplementation((p: string | fs.PathLike) => {
				const s = p.toString();
				if (s.includes('sess_a.json')) {
					return createHistoryFileData('sess_a', [entryA], '/target/project');
				}
				if (s.includes('sess_b.json')) {
					return createHistoryFileData('sess_b', [entryB], '/other/project');
				}
				return '{}';
			});

			manager.clearByProjectPath('/target/project');

			// Should only unlink sess_a
			expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
			expect(mockUnlinkSync.mock.calls[0][0].toString()).toContain('sess_a.json');
		});

		it('should do nothing when no sessions match', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
			]);

			const entry = createMockEntry({ projectPath: '/other' });
			mockReadFileSync.mockReturnValue(
				createHistoryFileData('sess_a', [entry], '/other')
			);

			manager.clearByProjectPath('/no/match');
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearAll()
	// ----------------------------------------------------------------
	describe('clearAll()', () => {
		it('should clear all session files', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.json' as unknown as fs.Dirent,
				'sess_b.json' as unknown as fs.Dirent,
				'sess_c.json' as unknown as fs.Dirent,
			]);

			manager.clearAll();

			expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
		});

		it('should handle empty history directory', () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);

			manager.clearAll();

			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// startWatching / stopWatching
	// ----------------------------------------------------------------
	describe('startWatching() / stopWatching()', () => {
		it('should start watching history directory for changes', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			expect(mockWatch).toHaveBeenCalledWith(
				path.join('/mock/userData', 'history'),
				expect.any(Function)
			);
		});

		it('should create directory if it does not exist before watching', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(false);

			manager.startWatching(vi.fn());

			expect(mockMkdirSync).toHaveBeenCalledWith(
				path.join('/mock/userData', 'history'),
				{ recursive: true }
			);
		});

		it('should invoke callback when a .json file changes', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			let watchCallback: (event: string, filename: string | null) => void = () => {};
			mockWatch.mockImplementation((_dir: string, cb: unknown) => {
				watchCallback = cb as (event: string, filename: string | null) => void;
				return mockWatcher;
			});
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			// Simulate a file change event
			watchCallback('change', 'session_1.json');

			expect(callback).toHaveBeenCalledWith('session_1');
		});

		it('should not invoke callback for non-json files', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			let watchCallback: (event: string, filename: string | null) => void = () => {};
			mockWatch.mockImplementation((_dir: string, cb: unknown) => {
				watchCallback = cb as (event: string, filename: string | null) => void;
				return mockWatcher;
			});
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			watchCallback('change', 'readme.txt');
			expect(callback).not.toHaveBeenCalled();
		});

		it('should not invoke callback when filename is null', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			let watchCallback: (event: string, filename: string | null) => void = () => {};
			mockWatch.mockImplementation((_dir: string, cb: unknown) => {
				watchCallback = cb as (event: string, filename: string | null) => void;
				return mockWatcher;
			});
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			watchCallback('change', null);
			expect(callback).not.toHaveBeenCalled();
		});

		it('should not start watching again if already watching', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.startWatching(vi.fn());

			expect(mockWatch).toHaveBeenCalledTimes(1);
		});

		it('should stop watching and close watcher', () => {
			const mockWatcher = { close: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.stopWatching();

			expect(mockWatcher.close).toHaveBeenCalled();
		});

		it('should allow re-watching after stop', () => {
			const mockWatcher1 = { close: vi.fn() } as unknown as fs.FSWatcher;
			const mockWatcher2 = { close: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch
				.mockReturnValueOnce(mockWatcher1)
				.mockReturnValueOnce(mockWatcher2);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.stopWatching();
			manager.startWatching(vi.fn());

			expect(mockWatch).toHaveBeenCalledTimes(2);
		});

		it('should be safe to call stopWatching when not watching', () => {
			// Should not throw
			expect(() => manager.stopWatching()).not.toThrow();
		});
	});

	// ----------------------------------------------------------------
	// getHistoryManager() singleton
	// ----------------------------------------------------------------
	describe('getHistoryManager()', () => {
		it('should return a HistoryManager instance', () => {
			const instance = getHistoryManager();
			expect(instance).toBeInstanceOf(HistoryManager);
		});

		it('should return the same instance on subsequent calls', () => {
			const instance1 = getHistoryManager();
			const instance2 = getHistoryManager();
			expect(instance1).toBe(instance2);
		});
	});

	// ----------------------------------------------------------------
	// sanitizeSessionId integration (uses real shared function)
	// ----------------------------------------------------------------
	describe('session ID sanitization', () => {
		it('should sanitize session IDs with special characters for file paths', () => {
			mockExistsSync.mockReturnValue(false);

			const entry = createMockEntry({ id: 'e1' });
			manager.addEntry('session/with:special.chars!', '/test', entry);

			const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
			// Should not contain /, :, ., or ! in the filename portion
			const filename = path.basename(writtenPath);
			expect(filename).toBe(
				`${sanitizeSessionId('session/with:special.chars!')}.json`
			);
			expect(filename).not.toContain('/');
			expect(filename).not.toContain(':');
			expect(filename).not.toContain('!');
		});
	});
});

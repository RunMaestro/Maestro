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

// Mock Sentry so we can assert which failures are (and are not) reported.
vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock fs module. PR-C 1.6 - history-manager now uses fs/promises, but the
// existing assertions are written against the sync mocks. We bridge the
// async API to the sync mocks below so the test surface stays compact:
// existing setup (mockExistsSync.mockImplementation(...), etc.) keeps
// driving behavior, and assertions on mockReadFileSync / mockWriteFileSync /
// mockMkdirSync / mockUnlinkSync / mockReaddirSync continue to fire.
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	appendFileSync: vi.fn(),
	readdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	watch: vi.fn(),
	constants: { F_OK: 0 },
}));

// Bridge fs/promises to the sync mocks above so test setup like
// `mockReadFileSync.mockReturnValue(...)` still drives the async code path
// in history-manager.
//
// history-manager now writes session files via `atomicWriteJson` (write to
// `${file}.tmp`, then `rename` over the target). We model that atomicity here
// so the existing assertions, which expect `writeFileSync` to be called with
// the FINAL path and content, keep firing unchanged: `.tmp` writes are
// buffered, and `rename` commits the buffered payload as a single
// `writeFileSync(finalPath, data)`. Direct, non-`.tmp` writes (the migration
// marker) flush immediately. `rename` on a real (non-buffered) path is the
// corrupt-file backup move, which no assertion inspects, so it is a no-op.
vi.mock('fs/promises', async () => {
	const fs = await import('fs');
	const pendingTmpWrites = new Map<string, string>();
	return {
		access: vi.fn(async (p: string) => {
			if (!(fs as { existsSync: (p: string) => boolean }).existsSync(p)) {
				const err = new Error('ENOENT') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			}
		}),
		mkdir: vi.fn(async (p: string, opts?: { recursive?: boolean }) =>
			(fs as { mkdirSync: (p: string, o?: unknown) => void }).mkdirSync(p, opts)
		),
		readFile: vi.fn(async (p: string, enc?: string) => {
			const contents = (
				fs as { readFileSync: (p: string, e?: string) => string | undefined }
			).readFileSync(p, enc);
			// An unstaged path means "no such file"; the real API rejects rather
			// than resolving undefined, and history-manager relies on that.
			if (contents === undefined) {
				const err = new Error('ENOENT') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			}
			return contents;
		}),
		writeFile: vi.fn(async (p: string, data: string, enc?: string) => {
			if (p.endsWith('.tmp')) {
				pendingTmpWrites.set(p, data);
				return;
			}
			(fs as { writeFileSync: (p: string, d: string, e?: string) => void }).writeFileSync(
				p,
				data,
				enc
			);
		}),
		rename: vi.fn(async (from: string, to: string) => {
			if (pendingTmpWrites.has(from)) {
				const data = pendingTmpWrites.get(from)!;
				pendingTmpWrites.delete(from);
				(fs as { writeFileSync: (p: string, d: string, e?: string) => void }).writeFileSync(
					to,
					data,
					'utf-8'
				);
			}
		}),
		readdir: vi.fn(async (p: string) =>
			(fs as { readdirSync: (p: string) => string[] }).readdirSync(p)
		),
		unlink: vi.fn(async (p: string) => (fs as { unlinkSync: (p: string) => void }).unlinkSync(p)),
		// The JSONL add path appends one line instead of rewriting the file.
		appendFile: vi.fn(async (p: string, data: string, enc?: string) =>
			(fs as { appendFileSync: (p: string, d: string, e?: string) => void }).appendFileSync(
				p,
				data,
				enc
			)
		),
	};
});

import * as fs from 'fs';
import { app } from 'electron';
import { logger } from '../../main/utils/logger';
import { HistoryManager, getHistoryManager } from '../../main/history-manager';
import {
	HISTORY_VERSION,
	HISTORY_JSONL_EXT,
	MAX_ENTRIES_PER_SESSION,
	sanitizeSessionId,
} from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';
import { captureException } from '../../main/utils/sentry';

// Type the mocked fs functions
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockAppendFileSync = vi.mocked(fs.appendFileSync);
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
 * Serialize entries as a JSONL history file body. Argument order is FILE order
 * (oldest first), matching what `readEntriesInFileOrder` expects on disk.
 */
function createJsonlFileData(entries: HistoryEntry[]): string {
	return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

/**
 * Parse a JSONL payload captured from a write/append mock back into entries.
 */
function parseJsonlWrite(payload: unknown): HistoryEntry[] {
	return String(payload)
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as HistoryEntry);
}

/**
 * Helper to create a serialized LEGACY history file data string (newest-first
 * single object). Still used by the migration tests.
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
		// Default: empty directory (was implicitly handled by existsSync=false
		// in the sync code, but the async path now calls fsp.readdir directly
		// and the bridge mock would otherwise return undefined here).
		mockReaddirSync.mockReturnValue([]);
		manager = new HistoryManager();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ----------------------------------------------------------------
	// Constructor
	// ----------------------------------------------------------------
	describe('constructor', () => {
		it('should set up paths based on app.getPath("userData")', async () => {
			expect(app.getPath).toHaveBeenCalledWith('userData');
			expect(manager.getHistoryDir()).toBe(path.join('/mock/userData', 'history'));
			expect(manager.getLegacyFilePath()).toBe(path.join('/mock/userData', 'maestro-history.json'));
		});
	});

	// ----------------------------------------------------------------
	// initialize()
	// ----------------------------------------------------------------
	describe('initialize()', () => {
		it('should create history directory if it does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			await manager.initialize();

			expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/mock/userData', 'history'), {
				recursive: true,
			});
		});

		it('uses recursive mkdir (idempotent - safe even when dir exists)', async () => {
			// PR-C 1.6: the existsSync-then-mkdirSync guard was redundant -
			// fsp.mkdir({ recursive: true }) is itself idempotent and trivially
			// fast. The new code calls it unconditionally and lets the OS
			// no-op when the dir already exists.
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				const s = p.toString();
				if (s.endsWith('history')) return true;
				if (s.endsWith('history-migrated.json')) return true;
				return false;
			});

			await manager.initialize();
			expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/mock/userData', 'history'), {
				recursive: true,
			});
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
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries: legacyEntries }));

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
		it('should return true when migration marker exists', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => {
				return p.toString().endsWith('history-migrated.json');
			});
			expect(await manager.hasMigrated()).toBe(true);
		});

		it('should return false when migration marker does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.hasMigrated()).toBe(false);
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
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries: [entry1, entry2, entry3] }));

			await manager.initialize();

			// Should write two session files + migration marker = 3 writes
			// (mkdirSync for history dir also called)
			const writeCalls = mockWriteFileSync.mock.calls;
			expect(writeCalls.length).toBe(3); // sess-a.json, sess-b.json, migration marker

			// Check session file for sess-a
			const sessACall = writeCalls.find((c) => c[0].toString().includes(`sess-a.json`));
			expect(sessACall).toBeDefined();
			const sessAEntries = parseJsonlWrite(sessACall![1]);
			expect(sessAEntries).toHaveLength(2);
			expect(sessAEntries.every((e) => e.sessionId === 'sess-a')).toBe(true);

			// Check session file for sess-b
			const sessBCall = writeCalls.find((c) => c[0].toString().includes(`sess-b.json`));
			expect(sessBCall).toBeDefined();
			const sessBEntries = parseJsonlWrite(sessBCall![1]);
			expect(sessBEntries).toHaveLength(1);
			expect(sessBEntries[0].sessionId).toBe('sess-b');
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
			mockReadFileSync.mockReturnValue(JSON.stringify({ entries: [goodEntry, orphanedEntry] }));

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
				c[0].toString().includes('sess-big.jsonl')
			);
			expect(parseJsonlWrite(sessionCall![1]).length).toBe(MAX_ENTRIES_PER_SESSION);
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
		it('should return entries from session file', async () => {
			const entries = [createMockEntry({ id: 'e1' }), createMockEntry({ id: 'e2' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.getEntries('session-1');
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('e1');
		});

		it('should parse session files with a leading UTF-8 BOM', async () => {
			const entries = [createMockEntry({ id: 'bom-entry' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(`\uFEFF${createJsonlFileData([...entries].reverse())}`);

			const result = await manager.getEntries('session-1');
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('bom-entry');
		});

		it('keeps every good line when a torn line is present', async () => {
			// The durability property JSONL buys: an append interrupted by a crash
			// leaves a partial final line. Under the old single-object format that
			// one bad byte made JSON.parse throw and the caller discarded EVERY
			// entry in the file. Here it costs exactly the torn record.
			const good = [createMockEntry({ id: 'a' }), createMockEntry({ id: 'b' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(
				`${createJsonlFileData(good)}{"id":"torn","summary":"half a li`
			);

			const result = await manager.getEntries('session-1');

			// Newest first, torn record dropped, nothing else lost.
			expect(result.map((e) => e.id)).toEqual(['b', 'a']);
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.stringContaining('malformed history line'),
				expect.any(String)
			);
			// A single torn line is an expected on-disk condition, not a bug.
			expect(vi.mocked(captureException)).not.toHaveBeenCalled();
		});

		it('should return empty array if session file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			const result = await manager.getEntries('nonexistent');
			expect(result).toEqual([]);
		});

		it('should return empty array on read error', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Read error');
			});

			const result = await manager.getEntries('session-1');
			expect(result).toEqual([]);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
			// A non-JSON read failure is unexpected and should still be reported.
			expect(vi.mocked(captureException)).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'history:read', sessionId: 'session-1' })
			);
		});

		it('should return empty array when file contains malformed JSON', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('not valid json');

			const result = await manager.getEntries('session-1');
			expect(result).toEqual([]);
		});

		it('does not report corrupt/truncated history JSON to Sentry (MAESTRO-QA)', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			// A file of nothing BUT unreadable bytes (e.g. the old format left
			// behind, or a file truncated to garbage) yields no entries, and is
			// still not reported to Sentry - it is an on-disk condition, not a bug.
			mockReadFileSync.mockReturnValue('{"version":1,"entries":[{"id":"e1","prompt":"hel');

			const result = await manager.getEntries('session-1');
			expect(result).toEqual([]);
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				expect.stringContaining('malformed history line'),
				expect.any(String)
			);
		});
	});

	// ----------------------------------------------------------------
	// addEntry(sessionId, projectPath, entry)
	// ----------------------------------------------------------------
	describe('addEntry()', () => {
		const sessionFile = path.join(
			'/mock/userData',
			'history',
			`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
		);

		it('appends a line for a session that has no file yet', async () => {
			mockExistsSync.mockReturnValue(false);
			const entry = createMockEntry({ id: 'new-entry' });

			await manager.addEntry('session-1', '/test/project', entry);

			expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
			const [appendedPath, payload] = mockAppendFileSync.mock.calls[0];
			expect(appendedPath).toBe(sessionFile);
			const written = parseJsonlWrite(payload);
			expect(written).toHaveLength(1);
			expect(written[0].id).toBe('new-entry');
		});

		it('appends WITHOUT rewriting the existing file', async () => {
			// The whole point of JSONL: adding an entry must not re-serialize the
			// file. Rewriting on every add is what produced ~56 MB of writes per
			// entry at a 50k cap. If this test starts failing because
			// writeFileSync fired, the write amplification is back.
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData([createMockEntry({ id: 'old' })]));

			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'a' }));
			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'b' }));

			expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
			expect(parseJsonlWrite(mockAppendFileSync.mock.calls[0][1])[0].id).toBe('a');
			expect(parseJsonlWrite(mockAppendFileSync.mock.calls[1][1])[0].id).toBe('b');
		});

		it('appends one physical line even when the entry contains newlines', async () => {
			// One entry == one line is what lets the reader drop a torn line and
			// keep everything else.
			mockExistsSync.mockReturnValue(false);
			await manager.addEntry(
				'session-1',
				'/test/project',
				createMockEntry({ id: 'multi', summary: 'line one\nline two\nline three' })
			);

			const payload = String(mockAppendFileSync.mock.calls[0][1]);
			expect(payload.endsWith('\n')).toBe(true);
			expect(payload.trimEnd().split('\n')).toHaveLength(1);
			expect(parseJsonlWrite(payload)[0].summary).toBe('line one\nline two\nline three');
		});

		it('migrates a legacy .json session before its first append', async () => {
			// Appending a line onto the legacy single-object file would corrupt it.
			const legacyFile = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}.json`
			);
			const legacyEntries = [createMockEntry({ id: 'newest' }), createMockEntry({ id: 'oldest' })];
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === legacyFile);
			mockReadFileSync.mockReturnValue(createHistoryFileData('session-1', legacyEntries));

			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'fresh' }));

			// Legacy file is rewritten as JSONL in file order (oldest first)...
			const converted = parseJsonlWrite(mockWriteFileSync.mock.calls[0][1]);
			expect(converted.map((e) => e.id)).toEqual(['oldest', 'newest']);
			// ...and only then is the new entry appended.
			expect(parseJsonlWrite(mockAppendFileSync.mock.calls[0][1])[0].id).toBe('fresh');
		});

		it('rotates down to the cap once the file exceeds it', async () => {
			const overflowing: HistoryEntry[] = [];
			for (let i = 0; i < 60; i++) overflowing.push(createMockEntry({ id: `e-${i}` }));
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData(overflowing));

			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'fresh' }), 50);

			const rotated = parseJsonlWrite(mockWriteFileSync.mock.calls[0][1]);
			expect(rotated).toHaveLength(50);
			// Rotation keeps the NEWEST entries, i.e. the tail of the file.
			expect(rotated[rotated.length - 1].id).toBe('e-59');
			expect(rotated[0].id).toBe('e-10');
		});

		it('does not rotate a file that is already within the cap', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(
				createJsonlFileData([createMockEntry({ id: 'a' }), createMockEntry({ id: 'b' })])
			);

			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'c' }), 50);

			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('honours the maxLogBuffer resolver instead of the built-in fallback', async () => {
			// Regression: the Cue write paths pass no explicit cap. Before the
			// resolver existed they trimmed to 5,000 and destroyed entries on an
			// agent whose maxLogBuffer was raised to 25,000.
			const existing: HistoryEntry[] = [];
			for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 10; i++) {
				existing.push(createMockEntry({ id: `e-${i}` }));
			}
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData(existing));

			manager.setMaxEntriesResolver(() => 25000);
			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'kept' }));

			// Under the resolver's cap, so nothing is trimmed away.
			expect(mockWriteFileSync).not.toHaveBeenCalled();
			expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
		});

		it('lets an explicit maxEntries argument win over the resolver', async () => {
			const existing: HistoryEntry[] = [];
			for (let i = 0; i < 50; i++) existing.push(createMockEntry({ id: `e-${i}` }));
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData(existing));

			manager.setMaxEntriesResolver(() => 25000);
			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'fresh' }), 10);

			expect(parseJsonlWrite(mockWriteFileSync.mock.calls[0][1])).toHaveLength(10);
		});

		it('falls back to the default cap when the resolver throws', async () => {
			const existing: HistoryEntry[] = [];
			for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 10; i++) {
				existing.push(createMockEntry({ id: `e-${i}` }));
			}
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData(existing));

			manager.setMaxEntriesResolver(() => {
				throw new Error('settings store unavailable');
			});
			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'fresh' }));

			expect(parseJsonlWrite(mockWriteFileSync.mock.calls[0][1])).toHaveLength(
				MAX_ENTRIES_PER_SESSION
			);
		});

		it('stamps projectPath onto an entry that lacks one', async () => {
			// The file-level projectPath of the old format is gone, so every line
			// must carry its own or getEntriesByProjectPath cannot filter.
			mockExistsSync.mockReturnValue(false);
			const entry = createMockEntry({ id: 'no-path' });
			delete (entry as Partial<HistoryEntry>).projectPath;

			await manager.addEntry('session-1', '/stamped/path', entry as HistoryEntry);

			expect(parseJsonlWrite(mockAppendFileSync.mock.calls[0][1])[0].projectPath).toBe(
				'/stamped/path'
			);
		});

		it('should log error on write failure', async () => {
			mockExistsSync.mockReturnValue(false);
			mockAppendFileSync.mockImplementation(() => {
				throw new Error('Disk full');
			});

			await manager.addEntry('session-1', '/test/project', createMockEntry());

			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to write history'),
				expect.any(String)
			);
			expect(vi.mocked(captureException)).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'history:write' })
			);
		});

		it('shrink guard refuses a rotation that would drop below the cap', async () => {
			// Rotation is the only remaining whole-file rewrite, so it inherits the
			// tripwire: it may land ON the cap and never below it.
			const existing: HistoryEntry[] = [];
			for (let i = 0; i < 60; i++) existing.push(createMockEntry({ id: `e-${i}` }));
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === sessionFile);
			mockReadFileSync.mockReturnValue(createJsonlFileData(existing));

			await manager.addEntry('session-1', '/test/project', createMockEntry({ id: 'fresh' }), 50);

			// A legitimate trim to exactly the cap is allowed, not blocked.
			expect(parseJsonlWrite(mockWriteFileSync.mock.calls[0][1])).toHaveLength(50);
			expect(vi.mocked(captureException)).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ operation: 'history:shrinkGuard' })
			);
		});
	});
	describe('deleteEntry()', () => {
		it('should remove an entry by id and return true', async () => {
			const entries = [createMockEntry({ id: 'e1' }), createMockEntry({ id: 'e2' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.deleteEntry('session-1', 'e1');
			expect(result).toBe(true);

			const written = parseJsonlWrite(mockWriteFileSync.mock.calls[0][1]);
			expect(written).toHaveLength(1);
			expect(written[0].id).toBe('e2');
		});

		it('should return false if session file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.deleteEntry('nonexistent', 'e1')).toBe(false);
		});

		it('should return false if entry is not found', async () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			expect(await manager.deleteEntry('session-1', 'nonexistent')).toBe(false);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should return false on read error (parse failure)', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('bad json');

			expect(await manager.deleteEntry('session-1', 'e1')).toBe(false);
		});

		it('should return false on write error', async () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('Write error');
			});

			expect(await manager.deleteEntry('session-1', 'e1')).toBe(false);
			expect(vi.mocked(logger.error)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// updateEntry(sessionId, entryId, updates)
	// ----------------------------------------------------------------
	describe('updateEntry()', () => {
		it('should update an entry by id and return true', async () => {
			const entries = [createMockEntry({ id: 'e1', summary: 'original' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.updateEntry('session-1', 'e1', { summary: 'updated' });
			expect(result).toBe(true);

			const written = parseJsonlWrite(mockWriteFileSync.mock.calls[0][1]);
			const updated = written.find((e) => e.id === 'e1');
			expect(updated?.summary).toBe('updated');
		});

		it('should return false if session file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.updateEntry('nonexistent', 'e1', { summary: 'x' })).toBe(false);
		});

		it('should return false if entry is not found', async () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			expect(await manager.updateEntry('session-1', 'nonexistent', { summary: 'x' })).toBe(false);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should return false on parse error', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue('bad json');

			expect(await manager.updateEntry('session-1', 'e1', { summary: 'x' })).toBe(false);
		});

		it('should return false on write error', async () => {
			const entries = [createMockEntry({ id: 'e1' })];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));
			mockWriteFileSync.mockImplementation(() => {
				throw new Error('Write error');
			});

			expect(await manager.updateEntry('session-1', 'e1', { summary: 'x' })).toBe(false);
			expect(vi.mocked(logger.error)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearSession(sessionId)
	// ----------------------------------------------------------------
	describe('clearSession()', () => {
		it('should delete the session file if it exists', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);

			await manager.clearSession('session-1');

			expect(mockUnlinkSync).toHaveBeenCalledWith(filePath);
		});

		it('does not throw when session file does not exist (ENOENT swallowed)', async () => {
			// PR-C 1.6: clearSession previously gated on existsSync. The async
			// path uses fsp.unlink directly and catches ENOENT, so unlink is
			// called but throws ENOENT internally. Net behavior (silent no-op
			// on missing file) is preserved.
			mockExistsSync.mockReturnValue(false);
			mockUnlinkSync.mockImplementation(() => {
				const err = new Error('ENOENT') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			});

			await expect(manager.clearSession('nonexistent')).resolves.toBeUndefined();
		});

		it('should log error on delete failure', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockUnlinkSync.mockImplementation(() => {
				throw new Error('Delete error');
			});

			await manager.clearSession('session-1');

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
		it('should return session IDs from .json files in history dir', async () => {
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString().endsWith('history'));
			mockReaddirSync.mockReturnValue([
				'session_1.jsonl' as unknown as fs.Dirent,
				'session_2.jsonl' as unknown as fs.Dirent,
				'readme.txt' as unknown as fs.Dirent,
			]);

			const result = await manager.listSessionsWithHistory();
			expect(result).toEqual(['session_1', 'session_2']);
		});

		it('should return empty array if history directory does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.listSessionsWithHistory()).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getHistoryFilePath(sessionId)
	// ----------------------------------------------------------------
	describe('getHistoryFilePath()', () => {
		it('should return file path if session file exists', async () => {
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);
			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);

			expect(await manager.getHistoryFilePath('session-1')).toBe(filePath);
		});

		it('should return null if session file does not exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.getHistoryFilePath('nonexistent')).toBeNull();
		});
	});

	// ----------------------------------------------------------------
	// getAllEntries(limit?)
	// ----------------------------------------------------------------
	describe('getAllEntries()', () => {
		it('should aggregate entries across all sessions sorted by timestamp', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.jsonl' as unknown as fs.Dirent,
				'sess_b.jsonl' as unknown as fs.Dirent,
			]);

			const entryA = createMockEntry({ id: 'a1', timestamp: 100 });
			const entryB = createMockEntry({ id: 'b1', timestamp: 200 });

			mockReadFileSync.mockImplementation((p: string | fs.PathLike) => {
				const s = p.toString();
				if (s.includes('sess_a.jsonl')) {
					return createJsonlFileData([...[entryA]].reverse());
				}
				if (s.includes('sess_b.jsonl')) {
					return createJsonlFileData([...[entryB]].reverse());
				}
				return '{}';
			});

			const result = await manager.getAllEntries();
			expect(result).toHaveLength(2);
			// Sorted descending: 200, 100
			expect(result[0].id).toBe('b1');
			expect(result[1].id).toBe('a1');
		});

		it('should respect limit parameter', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entries = [
				createMockEntry({ id: 'e1', timestamp: 300 }),
				createMockEntry({ id: 'e2', timestamp: 200 }),
				createMockEntry({ id: 'e3', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.getAllEntries(2);
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('e1');
			expect(result[1].id).toBe('e2');
		});

		it('should return empty array when no sessions exist', async () => {
			mockExistsSync.mockReturnValue(false);
			expect(await manager.getAllEntries()).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getAllEntriesPaginated(options?)
	// ----------------------------------------------------------------
	describe('getAllEntriesPaginated()', () => {
		it('should return paginated results with metadata', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entries = [
				createMockEntry({ id: 'e1', timestamp: 300 }),
				createMockEntry({ id: 'e2', timestamp: 200 }),
				createMockEntry({ id: 'e3', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.getAllEntriesPaginated({ limit: 2, offset: 0 });
			expect(result.entries).toHaveLength(2);
			expect(result.total).toBe(3);
			expect(result.limit).toBe(2);
			expect(result.offset).toBe(0);
			expect(result.hasMore).toBe(true);
		});

		it('should handle offset beyond total entries', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);
			mockReadFileSync.mockReturnValue(createJsonlFileData([createMockEntry()]));

			const result = await manager.getAllEntriesPaginated({ limit: 10, offset: 100 });
			expect(result.entries).toHaveLength(0);
			expect(result.total).toBe(1);
			expect(result.hasMore).toBe(false);
		});
	});

	// ----------------------------------------------------------------
	// getEntriesByProjectPath(projectPath)
	// ----------------------------------------------------------------
	describe('getEntriesByProjectPath()', () => {
		it('should return entries matching project path', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.jsonl' as unknown as fs.Dirent,
				'sess_b.jsonl' as unknown as fs.Dirent,
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
				if (s.includes('sess_a.jsonl')) {
					return createJsonlFileData([...[entryA]].reverse());
				}
				if (s.includes('sess_b.jsonl')) {
					return createJsonlFileData([...[entryB]].reverse());
				}
				return '{}';
			});

			const result = await manager.getEntriesByProjectPath('/project/alpha');
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('a1');
		});

		it('should return empty array when no matching sessions exist', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entry = createMockEntry({ projectPath: '/other/path' });
			mockReadFileSync.mockReturnValue(createJsonlFileData([...[entry]].reverse()));

			const result = await manager.getEntriesByProjectPath('/no/match');
			expect(result).toEqual([]);
		});
	});

	// ----------------------------------------------------------------
	// getEntriesByProjectPathPaginated(projectPath, options?)
	// ----------------------------------------------------------------
	describe('getEntriesByProjectPathPaginated()', () => {
		it('should return paginated results filtered by project path', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entries = [
				createMockEntry({ id: 'e1', projectPath: '/proj', timestamp: 300 }),
				createMockEntry({ id: 'e2', projectPath: '/proj', timestamp: 200 }),
				createMockEntry({ id: 'e3', projectPath: '/proj', timestamp: 100 }),
			];
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.getEntriesByProjectPathPaginated('/proj', {
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
		it('should return paginated results for a single session', async () => {
			const entries = [
				createMockEntry({ id: 'e1' }),
				createMockEntry({ id: 'e2' }),
				createMockEntry({ id: 'e3' }),
			];
			const filePath = path.join(
				'/mock/userData',
				'history',
				`${sanitizeSessionId('session-1')}${HISTORY_JSONL_EXT}`
			);

			mockExistsSync.mockImplementation((p: fs.PathLike) => p.toString() === filePath);
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const result = await manager.getEntriesPaginated('session-1', { limit: 2, offset: 1 });
			expect(result.entries).toHaveLength(2);
			expect(result.total).toBe(3);
			expect(result.offset).toBe(1);
			expect(result.hasMore).toBe(false);
		});

		it('should return empty paginated result for nonexistent session', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await manager.getEntriesPaginated('nonexistent');
			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
		});
	});

	// ----------------------------------------------------------------
	// updateSessionNameByClaudeSessionId(agentSessionId, sessionName)
	// ----------------------------------------------------------------
	describe('updateSessionNameByClaudeSessionId()', () => {
		it('should update sessionName for matching entries and return count', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

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
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const count = await manager.updateSessionNameByClaudeSessionId('agent-123', 'new-name');
			expect(count).toBe(2);

			const written = parseJsonlWrite(mockWriteFileSync.mock.calls[0][1]);
			const renamed = written.filter((e) => e.sessionName === 'new-name');
			expect(renamed).toHaveLength(2);
			expect(written.filter((e) => e.sessionName === 'other')).toHaveLength(1);
		});

		it('should return 0 when no entries match', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entries = [createMockEntry({ id: 'e1', agentSessionId: 'agent-999' })];
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const count = await manager.updateSessionNameByClaudeSessionId('no-match', 'new-name');
			expect(count).toBe(0);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should not update entries that already have the correct sessionName', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entries = [
				createMockEntry({
					id: 'e1',
					agentSessionId: 'agent-123',
					sessionName: 'already-correct',
				}),
			];
			mockReadFileSync.mockReturnValue(createJsonlFileData([...entries].reverse()));

			const count = await manager.updateSessionNameByClaudeSessionId(
				'agent-123',
				'already-correct'
			);
			expect(count).toBe(0);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		});

		it('should handle read errors gracefully', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);
			mockReadFileSync.mockImplementation(() => {
				throw new Error('Read error');
			});

			const count = await manager.updateSessionNameByClaudeSessionId('agent-123', 'new-name');
			expect(count).toBe(0);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearByProjectPath(projectPath)
	// ----------------------------------------------------------------
	describe('clearByProjectPath()', () => {
		it('should clear sessions matching the project path', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.jsonl' as unknown as fs.Dirent,
				'sess_b.jsonl' as unknown as fs.Dirent,
			]);

			const entryA = createMockEntry({ projectPath: '/target/project' });
			const entryB = createMockEntry({ projectPath: '/other/project' });

			mockReadFileSync.mockImplementation((p: string | fs.PathLike) => {
				const s = p.toString();
				if (s.includes('sess_a.jsonl')) {
					return createJsonlFileData([...[entryA]].reverse());
				}
				if (s.includes('sess_b.jsonl')) {
					return createJsonlFileData([...[entryB]].reverse());
				}
				return '{}';
			});

			await manager.clearByProjectPath('/target/project');

			// Should only touch sess_a (both its JSONL file and any legacy leftover).
			const unlinked = mockUnlinkSync.mock.calls.map((c) => c[0].toString());
			expect(unlinked.some((f) => f.includes('sess_a.jsonl'))).toBe(true);
			expect(unlinked.every((f) => f.includes('sess_a'))).toBe(true);
		});

		it('should do nothing when no sessions match', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(['sess_a.jsonl' as unknown as fs.Dirent]);

			const entry = createMockEntry({ projectPath: '/other' });
			mockReadFileSync.mockReturnValue(createJsonlFileData([...[entry]].reverse()));

			await manager.clearByProjectPath('/no/match');
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// clearAll()
	// ----------------------------------------------------------------
	describe('clearAll()', () => {
		it('should clear all session files', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([
				'sess_a.jsonl' as unknown as fs.Dirent,
				'sess_b.jsonl' as unknown as fs.Dirent,
				'sess_c.jsonl' as unknown as fs.Dirent,
			]);

			await manager.clearAll();

			// Each session clears its JSONL file plus any legacy leftover.
			const unlinked = mockUnlinkSync.mock.calls.map((c) => c[0].toString());
			for (const sess of ['sess_a', 'sess_b', 'sess_c']) {
				expect(unlinked.some((f) => f.includes(`${sess}.jsonl`))).toBe(true);
			}
		});

		it('should handle empty history directory', async () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue([]);

			await manager.clearAll();

			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------
	// startWatching / stopWatching
	// ----------------------------------------------------------------
	describe('startWatching() / stopWatching()', () => {
		it('should start watching history directory for changes', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			expect(mockWatch).toHaveBeenCalledWith(
				path.join('/mock/userData', 'history'),
				expect.any(Function)
			);
		});

		it('should create directory if it does not exist before watching', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(false);

			manager.startWatching(vi.fn());

			expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/mock/userData', 'history'), {
				recursive: true,
			});
		});

		it('should invoke callback when a .json file changes', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			let watchCallback: (event: string, filename: string | null) => void = () => {};
			mockWatch.mockImplementation((_dir: string, cb: unknown) => {
				watchCallback = cb as (event: string, filename: string | null) => void;
				return mockWatcher;
			});
			mockExistsSync.mockReturnValue(true);

			const callback = vi.fn();
			manager.startWatching(callback);

			// Simulate a file change event
			watchCallback('change', 'session_1.jsonl');

			expect(callback).toHaveBeenCalledWith('session_1');
		});

		it('should not invoke callback for non-json files', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
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

		it('should not invoke callback when filename is null', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
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

		// MAESTRO-SC: fs.watch throws EMFILE (fd ceiling) / ENOSPC (Linux inotify
		// max_user_watches) on constrained machines. Watching only powers live
		// refresh on external edits and the manager already degrades cleanly, so
		// these are environment limits, not Maestro faults.
		it.each(['EMFILE', 'ENOSPC', 'ENFILE', 'ENOENT', 'EPERM', 'UNKNOWN'])(
			'does not report %s from fs.watch to Sentry (MAESTRO-SC)',
			(code) => {
				mockExistsSync.mockReturnValue(true);
				mockWatch.mockImplementation(() => {
					throw Object.assign(new Error(`${code}: watch failed`), { code });
				});

				expect(() => manager.startWatching(vi.fn())).not.toThrow();

				expect(vi.mocked(captureException)).not.toHaveBeenCalled();
				expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
					expect.stringContaining('Failed to start history watcher'),
					expect.any(String)
				);
			}
		);

		it('still reports an unexpected fs.watch failure to Sentry', () => {
			mockExistsSync.mockReturnValue(true);
			mockWatch.mockImplementation(() => {
				throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
			});

			manager.startWatching(vi.fn());

			expect(vi.mocked(captureException)).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'history:watch:start' })
			);
		});

		it.each(['EMFILE', 'ENOSPC'])(
			'does not report a %s watcher error event to Sentry (MAESTRO-SC)',
			(code) => {
				let errorHandler: (err: unknown) => void = () => {};
				const mockWatcher = {
					close: vi.fn(),
					on: vi.fn((event: string, cb: (err: unknown) => void) => {
						if (event === 'error') errorHandler = cb;
					}),
				} as unknown as fs.FSWatcher;
				mockWatch.mockReturnValue(mockWatcher);
				mockExistsSync.mockReturnValue(true);

				manager.startWatching(vi.fn());
				errorHandler(Object.assign(new Error(`${code}: watch failed`), { code }));

				expect(vi.mocked(captureException)).not.toHaveBeenCalled();
			}
		);

		// The directory creation sits on the same OS ceilings fs.watch does, so it
		// has to be under the same guard. Outside the try it propagates to the
		// caller in main/index.ts and reports as a history init failure instead.
		it.each(['EMFILE', 'ENOSPC', 'ENFILE', 'ENOENT', 'EPERM', 'UNKNOWN'])(
			'does not report %s from the directory creation to Sentry (MAESTRO-SC)',
			(code) => {
				mockExistsSync.mockReturnValue(false);
				mockMkdirSync.mockImplementation(() => {
					throw Object.assign(new Error(`${code}: mkdir failed`), { code });
				});

				expect(() => manager.startWatching(vi.fn())).not.toThrow();

				expect(vi.mocked(captureException)).not.toHaveBeenCalled();
			}
		);

		it('still reports an unexpected directory-creation failure to Sentry', () => {
			mockExistsSync.mockReturnValue(false);
			mockMkdirSync.mockImplementation(() => {
				throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
			});

			expect(() => manager.startWatching(vi.fn())).not.toThrow();

			expect(vi.mocked(captureException)).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'history:watch:start' })
			);
		});

		// Node documents an FSWatcher as unusable once it emits 'error'. Holding on
		// to it makes the `if (this.watcher) return` guard reject every later
		// startWatching, so live refresh stays dead for the rest of the session.
		it('replaces a watcher that died with an error event', () => {
			let errorHandler: (err: unknown) => void = () => {};
			const dead = {
				close: vi.fn(),
				on: vi.fn((event: string, cb: (err: unknown) => void) => {
					if (event === 'error') errorHandler = cb;
				}),
			} as unknown as fs.FSWatcher;
			const replacement = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValueOnce(dead).mockReturnValueOnce(replacement);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			errorHandler(Object.assign(new Error('EMFILE: watch failed'), { code: 'EMFILE' }));
			manager.startWatching(vi.fn());

			expect(mockWatch).toHaveBeenCalledTimes(2);
			// Node says the watcher is not to be used from its own error handler.
			expect(dead.close).not.toHaveBeenCalled();
		});

		it('should not start watching again if already watching', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.startWatching(vi.fn());

			expect(mockWatch).toHaveBeenCalledTimes(1);
		});

		it('should stop watching and close watcher', async () => {
			const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.stopWatching();

			expect(mockWatcher.close).toHaveBeenCalled();
		});

		it('should allow re-watching after stop', async () => {
			const mockWatcher1 = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			const mockWatcher2 = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValueOnce(mockWatcher1).mockReturnValueOnce(mockWatcher2);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());
			manager.stopWatching();
			manager.startWatching(vi.fn());

			expect(mockWatch).toHaveBeenCalledTimes(2);
		});

		it('should be safe to call stopWatching when not watching', async () => {
			// Should not throw
			expect(() => manager.stopWatching()).not.toThrow();
		});

		it('should register an error handler on the watcher to prevent unhandled rejections', () => {
			const onSpy = vi.fn();
			const mockWatcher = { close: vi.fn(), on: onSpy } as unknown as fs.FSWatcher;
			mockWatch.mockReturnValue(mockWatcher);
			mockExistsSync.mockReturnValue(true);

			manager.startWatching(vi.fn());

			expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function));
		});

		it('should log and not throw if fs.watch itself throws', () => {
			mockWatch.mockImplementation(() => {
				throw new Error('EBUSY: resource busy');
			});
			mockExistsSync.mockReturnValue(true);

			expect(() => manager.startWatching(vi.fn())).not.toThrow();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to start history watcher'),
				expect.any(String)
			);
		});
	});

	// ----------------------------------------------------------------
	// getHistoryManager() singleton
	// ----------------------------------------------------------------
	describe('getHistoryManager()', () => {
		it('should return a HistoryManager instance', async () => {
			const instance = getHistoryManager();
			expect(instance).toBeInstanceOf(HistoryManager);
		});

		it('should return the same instance on subsequent calls', async () => {
			const instance1 = getHistoryManager();
			const instance2 = getHistoryManager();
			expect(instance1).toBe(instance2);
		});
	});

	// ----------------------------------------------------------------
	// sanitizeSessionId integration (uses real shared function)
	// ----------------------------------------------------------------
	describe('session ID sanitization', () => {
		it('should sanitize session IDs with special characters for file paths', async () => {
			mockExistsSync.mockReturnValue(false);

			const entry = createMockEntry({ id: 'e1' });
			await manager.addEntry('session/with:special.chars!', '/test', entry);

			const writtenPath = mockAppendFileSync.mock.calls[0][0] as string;
			// Should not contain /, :, ., or ! in the filename portion
			const filename = path.basename(writtenPath);
			expect(filename).toBe(
				`${sanitizeSessionId('session/with:special.chars!')}${HISTORY_JSONL_EXT}`
			);
			expect(filename).not.toContain('/');
			expect(filename).not.toContain(':');
			expect(filename).not.toContain('!');
		});
	});
});

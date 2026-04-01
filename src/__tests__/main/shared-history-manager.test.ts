/**
 * Tests for the SharedHistoryManager
 *
 * Tests JSONL read/write operations for cross-host history synchronization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron app
vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => '/mock/userData') },
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

// Mock sentry
vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock remote-fs
vi.mock('../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	writeFileRemote: vi.fn(() => ({ success: true })),
	readDirRemote: vi.fn(),
	mkdirRemote: vi.fn(() => ({ success: true })),
}));

// Mock fs module at the top level so ESM imports are properly intercepted
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		readdirSync: vi.fn(),
	};
});

import {
	writeEntryLocal,
	readRemoteEntriesLocal,
	getLocalHostname,
} from '../../main/shared-history-manager';
import type { HistoryEntry } from '../../shared/types';

const LOCAL_HOSTNAME = os.hostname();

const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: 'entry-1',
	type: 'USER',
	timestamp: Date.now(),
	summary: 'Test entry',
	projectPath: '/test/project',
	sessionId: 'session-1',
	...overrides,
});

describe('SharedHistoryManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('getLocalHostname()', () => {
		it('should return the OS hostname', () => {
			expect(getLocalHostname()).toBe(LOCAL_HOSTNAME);
		});
	});

	describe('writeEntryLocal()', () => {
		it('should create directory and append entry as JSONL', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
			vi.mocked(fs.appendFileSync).mockReturnValue(undefined);
			vi.mocked(fs.readFileSync).mockReturnValue('');

			const entry = createMockEntry();
			writeEntryLocal('/test/project', entry);

			// Should create directory
			expect(fs.mkdirSync).toHaveBeenCalledWith(path.join('/test/project', '.maestro/history'), {
				recursive: true,
			});

			// Should append JSONL line
			expect(fs.appendFileSync).toHaveBeenCalled();
			const writtenContent = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
			const parsed = JSON.parse(writtenContent.trim());
			expect(parsed.id).toBe('entry-1');
			expect(parsed.hostname).toBe(LOCAL_HOSTNAME);
		});
	});

	describe('readRemoteEntriesLocal()', () => {
		it('should return empty array when directory does not exist', () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const entries = readRemoteEntriesLocal('/test/project');
			expect(entries).toEqual([]);
		});

		it('should skip own hostname file and read others', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue([
				`history-${LOCAL_HOSTNAME}.jsonl` as any,
				'history-other-host.jsonl' as any,
			]);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({
					id: 'remote-1',
					type: 'AUTO',
					timestamp: 1000,
					summary: 'remote',
					projectPath: '/test',
				}) + '\n'
			);

			const entries = readRemoteEntriesLocal('/test/project');

			// Should only read other-host file, not own hostname file
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe('remote-1');
			expect(entries[0].hostname).toBe('other-host');
		});

		it('should skip malformed JSONL lines gracefully', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['history-other-host.jsonl' as any]);
			vi.mocked(fs.readFileSync).mockReturnValue(
				'not valid json\n' +
					JSON.stringify({
						id: 'good-1',
						type: 'USER',
						timestamp: 2000,
						summary: 'ok',
						projectPath: '/test',
					}) +
					'\n'
			);

			const entries = readRemoteEntriesLocal('/test/project');

			// Should parse the valid line and skip the bad one
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe('good-1');
		});

		it('should respect maxEntries limit per file', () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readdirSync).mockReturnValue(['history-other-host.jsonl' as any]);

			// Create 10 entries
			const lines =
				Array.from({ length: 10 }, (_, i) =>
					JSON.stringify({
						id: `entry-${i}`,
						type: 'USER',
						timestamp: i * 1000,
						summary: `Entry ${i}`,
						projectPath: '/test',
					})
				).join('\n') + '\n';
			vi.mocked(fs.readFileSync).mockReturnValue(lines);

			// Limit to 5
			const entries = readRemoteEntriesLocal('/test/project', 5);

			expect(entries).toHaveLength(5);
			// Should keep the most recent (end of file)
			expect(entries[0].id).toBe('entry-5');
			expect(entries[4].id).toBe('entry-9');
		});
	});
});

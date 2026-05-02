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
	listDirWithStatsRemote: vi.fn(),
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
	readRemoteEntriesSsh,
	getLocalHostname,
	__resetSharedHistoryCacheForTest,
} from '../../main/shared-history-manager';
import * as remoteFs from '../../main/utils/remote-fs';
import type { HistoryEntry, SshRemoteConfig } from '../../shared/types';

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

	describe('readRemoteEntriesSsh()', () => {
		const sshConfig: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Test Host',
			host: 'example.com',
			port: 22,
			username: 'testuser',
			privateKeyPath: '/home/me/.ssh/id_ed25519',
			enabled: true,
		};

		beforeEach(() => {
			__resetSharedHistoryCacheForTest();
		});

		it('skips re-reading files when size + mtime are unchanged', async () => {
			const remoteCwd = '/home/testuser/project';
			const fileEntry = {
				name: 'history-other-host.jsonl',
				size: 100,
				mtime: 1700000000000,
			};

			vi.mocked(remoteFs.listDirWithStatsRemote).mockResolvedValue({
				success: true,
				data: [fileEntry],
			});
			vi.mocked(remoteFs.readFileRemote).mockResolvedValue({
				success: true,
				data:
					JSON.stringify({
						id: 'remote-1',
						type: 'USER',
						timestamp: 1700000000000,
						summary: 'remote entry',
						projectPath: '/home/testuser/project',
					}) + '\n',
			});

			const first = await readRemoteEntriesSsh(remoteCwd, sshConfig);
			expect(first).toHaveLength(1);
			expect(first[0].id).toBe('remote-1');
			expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(1);

			// Second call: same stats. Should hit cache and skip readFileRemote.
			const second = await readRemoteEntriesSsh(remoteCwd, sshConfig);
			expect(second).toHaveLength(1);
			expect(second[0].id).toBe('remote-1');
			expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(1);
			expect(remoteFs.listDirWithStatsRemote).toHaveBeenCalledTimes(2);
		});

		it('re-reads when mtime changes', async () => {
			const remoteCwd = '/home/testuser/project';
			vi.mocked(remoteFs.listDirWithStatsRemote)
				.mockResolvedValueOnce({
					success: true,
					data: [{ name: 'history-other-host.jsonl', size: 100, mtime: 1700000000000 }],
				})
				.mockResolvedValueOnce({
					success: true,
					data: [{ name: 'history-other-host.jsonl', size: 200, mtime: 1700000005000 }],
				});

			vi.mocked(remoteFs.readFileRemote)
				.mockResolvedValueOnce({
					success: true,
					data:
						JSON.stringify({
							id: 'old',
							type: 'USER',
							timestamp: 1,
							summary: 'old',
							projectPath: '/p',
						}) + '\n',
				})
				.mockResolvedValueOnce({
					success: true,
					data:
						JSON.stringify({
							id: 'old',
							type: 'USER',
							timestamp: 1,
							summary: 'old',
							projectPath: '/p',
						}) +
						'\n' +
						JSON.stringify({
							id: 'new',
							type: 'USER',
							timestamp: 2,
							summary: 'new',
							projectPath: '/p',
						}) +
						'\n',
				});

			await readRemoteEntriesSsh(remoteCwd, sshConfig);
			const second = await readRemoteEntriesSsh(remoteCwd, sshConfig);

			expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(2);
			expect(second.map((e) => e.id)).toEqual(['old', 'new']);
		});

		it('skips own hostname file', async () => {
			vi.mocked(remoteFs.listDirWithStatsRemote).mockResolvedValue({
				success: true,
				data: [
					{
						name: `history-${LOCAL_HOSTNAME.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`,
						size: 50,
						mtime: 1,
					},
					{ name: 'history-other.jsonl', size: 50, mtime: 1 },
				],
			});
			vi.mocked(remoteFs.readFileRemote).mockResolvedValue({
				success: true,
				data:
					JSON.stringify({
						id: 'remote-only',
						type: 'USER',
						timestamp: 1,
						summary: 'r',
						projectPath: '/p',
					}) + '\n',
			});

			const entries = await readRemoteEntriesSsh('/cwd', sshConfig);
			expect(entries).toHaveLength(1);
			expect(entries[0].hostname).toBe('other');
			expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(1);
		});

		it('returns empty when listDirWithStatsRemote fails', async () => {
			vi.mocked(remoteFs.listDirWithStatsRemote).mockResolvedValue({
				success: false,
				error: 'Directory not found',
			});

			const entries = await readRemoteEntriesSsh('/cwd', sshConfig);
			expect(entries).toEqual([]);
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		});
	});
});

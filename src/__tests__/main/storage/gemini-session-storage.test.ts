/**
 * Tests for GeminiSessionStorage
 *
 * Verifies:
 * - deleteMessagePair: index-based and content-based message deletion
 * - readSessionMessages: UUID uses original array index
 * - getAllNamedSessions: named session aggregation from origins store
 * - listSessions: origin metadata enrichment (names, stars)
 * - Edge cases: missing file, missing message, no paired response, backup/restore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiSessionStorage } from '../../../main/storage/gemini-session-storage';
import fs from 'fs/promises';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		stat: vi.fn(),
		unlink: vi.fn(),
		copyFile: vi.fn(),
	},
}));

// Mock os.homedir
vi.mock('os', () => ({
	default: {
		homedir: () => '/mock-home',
	},
}));

/**
 * Helper to build a Gemini session JSON string
 */
function buildSessionJson(
	messages: Array<{ type: string; content: string; toolCalls?: unknown[] }>,
	sessionId = 'test-session-id'
) {
	return JSON.stringify(
		{
			sessionId,
			messages,
			startTime: '2026-01-01T00:00:00.000Z',
			lastUpdated: '2026-01-01T01:00:00.000Z',
		},
		null,
		2
	);
}

describe('GeminiSessionStorage', () => {
	let storage: GeminiSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		storage = new GeminiSessionStorage();
	});

	/**
	 * Helper: set up mocks so findSessionFile succeeds for a given session
	 */
	function mockFindSessionFile(sessionContent: string) {
		// getHistoryDir: access succeeds for basename path, readFile for .project_root
		(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
			if (filePath.endsWith('.project_root')) {
				return Promise.resolve('/test/project');
			}
			return Promise.resolve(sessionContent);
		});
		(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
			'session-123-test-session-id.json',
		]);
		(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
			size: 1000,
			mtimeMs: Date.now(),
			isDirectory: () => true,
		});
		(fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		(fs.copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	}

	describe('readSessionMessages', () => {
		it('should set uuid to stringified original array index', async () => {
			const sessionContent = buildSessionJson([
				{ type: 'user', content: 'Hello' },
				{ type: 'info', content: 'Processing...' },
				{ type: 'gemini', content: 'Hi there!' },
				{ type: 'user', content: 'Second question' },
				{ type: 'gemini', content: 'Second answer' },
			]);

			mockFindSessionFile(sessionContent);

			const result = await storage.readSessionMessages('/test/project', 'test-session-id', {
				limit: 100,
			});

			// Should only include conversation messages (user + gemini), skip info
			expect(result.messages.length).toBe(4);

			// UUIDs should be the original array indices (not filtered indices)
			expect(result.messages[0].uuid).toBe('0'); // user at index 0
			expect(result.messages[1].uuid).toBe('2'); // gemini at index 2 (index 1 is info, skipped)
			expect(result.messages[2].uuid).toBe('3'); // user at index 3
			expect(result.messages[3].uuid).toBe('4'); // gemini at index 4
		});

		it('should skip info/error/warning messages but preserve their indices', async () => {
			const sessionContent = buildSessionJson([
				{ type: 'user', content: 'Hello' },
				{ type: 'warning', content: 'Be careful' },
				{ type: 'error', content: 'Oops' },
				{ type: 'gemini', content: 'Response' },
			]);

			mockFindSessionFile(sessionContent);

			const result = await storage.readSessionMessages('/test/project', 'test-session-id', {
				limit: 100,
			});

			expect(result.messages.length).toBe(2);
			expect(result.messages[0].uuid).toBe('0'); // user at original index 0
			expect(result.messages[1].uuid).toBe('3'); // gemini at original index 3
		});
	});

	describe('deleteMessagePair', () => {
		it('should delete user message and paired gemini response by index', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Hi there!' },
				{ type: 'user', content: 'Second question' },
				{ type: 'gemini', content: 'Second answer' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(2);

			// Verify the written content
			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			expect(writeCall).toBeDefined();
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Second question');
			expect(writtenSession.messages[1].content).toBe('Second answer');
		});

		it('should remove intermediate info/error/warning messages between user and gemini', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'info', content: 'Processing...' },
				{ type: 'warning', content: 'Slow response' },
				{ type: 'gemini', content: 'Response' },
				{ type: 'user', content: 'Next' },
				{ type: 'gemini', content: 'Next response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(4); // user + info + warning + gemini

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Next');
		});

		it('should delete only user message when no paired gemini response exists', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Hi there!' },
				{ type: 'user', content: 'Last question with no response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '2');

			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(1);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Hello');
			expect(writtenSession.messages[1].content).toBe('Hi there!');
		});

		it('should fall back to content match when index does not match a user message', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Hi there!' },
				{ type: 'user', content: 'Target message' },
				{ type: 'gemini', content: 'Target response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			// Pass an invalid index but valid fallback content
			const result = await storage.deleteMessagePair(
				'/test/project',
				'test-session-id',
				'99',
				'Target message'
			);

			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(2);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Hello');
		});

		it('should return error when session file is not found', async () => {
			// Set up mocks to simulate no session file found
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const result = await storage.deleteMessagePair('/test/project', 'nonexistent', '0');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Session file not found');
		});

		it('should return error when message is not found', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Hi there!' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '99');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Message not found');
		});

		it('should not match index pointing to a non-user message', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Hi there!' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			// Index 1 is a gemini message, not user
			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '1');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Message not found');
		});

		it('should return error for SSH remote sessions', async () => {
			const result = await storage.deleteMessagePair(
				'/test/project',
				'test-session-id',
				'0',
				undefined,
				{ enabled: true, host: 'example.com' } as never
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Delete not supported for remote sessions');
		});

		it('should create backup before writing and clean up on success', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			// Verify backup was created (first writeFile call should be the .bak)
			const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
			const backupCall = writeCalls.find((call: unknown[]) => (call[0] as string).endsWith('.bak'));
			expect(backupCall).toBeDefined();
			expect(backupCall![1]).toBe(sessionContent);

			// Verify backup cleanup was attempted
			expect(fs.unlink).toHaveBeenCalled();
		});

		it('should restore from backup on write failure', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			// Make the second writeFile (the actual session write) fail
			let writeCount = 0;
			(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
				writeCount++;
				if (writeCount === 2) {
					return Promise.reject(new Error('Disk full'));
				}
				return Promise.resolve(undefined);
			});

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to write session file');

			// Verify copyFile was called to restore backup
			expect(fs.copyFile).toHaveBeenCalled();
		});

		it('should handle deletion of messages with toolCalls embedded', async () => {
			const messages = [
				{ type: 'user', content: 'Run a command' },
				{
					type: 'gemini',
					content: 'Running...',
					toolCalls: [{ id: 'tc-1', name: 'execute', status: 'success' }],
				},
				{ type: 'user', content: 'Next' },
				{ type: 'gemini', content: 'Done' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(2);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			// toolCalls are embedded in the gemini message, so removing the message removes them
			expect(writtenSession.messages[0].content).toBe('Next');
		});

		it('should include intermediates when no gemini response exists (no orphans)', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'info', content: 'Processing...' },
				{ type: 'warning', content: 'Slow response' },
				{ type: 'user', content: 'Gave up waiting' },
				{ type: 'gemini', content: 'Response to second' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			// Should remove user + info + warning = 3 (not just the user message)
			expect(result.linesRemoved).toBe(3);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Gave up waiting');
			expect(writtenSession.messages[1].content).toBe('Response to second');
		});

		it('should include trailing intermediates after gemini response (no orphans)', async () => {
			const messages = [
				{ type: 'user', content: 'Run something' },
				{ type: 'gemini', content: 'Done' },
				{ type: 'info', content: 'Tool completed' },
				{ type: 'warning', content: 'Cleanup note' },
				{ type: 'user', content: 'Next question' },
				{ type: 'gemini', content: 'Next answer' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			// Should remove user + gemini + info + warning = 4
			expect(result.linesRemoved).toBe(4);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Next question');
			expect(writtenSession.messages[1].content).toBe('Next answer');
		});

		it('should include both leading and trailing intermediates around gemini response', async () => {
			const messages = [
				{ type: 'user', content: 'Do task' },
				{ type: 'info', content: 'Starting tool...' },
				{ type: 'gemini', content: 'Task done' },
				{ type: 'info', content: 'Tool finished' },
				{ type: 'user', content: 'Thanks' },
				{ type: 'gemini', content: 'Welcome' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(true);
			// Should remove user + info + gemini + info = 4
			expect(result.linesRemoved).toBe(4);

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			expect(writtenSession.messages.length).toBe(2);
			expect(writtenSession.messages[0].content).toBe('Thanks');
			expect(writtenSession.messages[1].content).toBe('Welcome');
		});

		it('should update lastUpdated timestamp after deletion', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => !(call[0] as string).endsWith('.bak')
			);
			const writtenSession = JSON.parse(writeCall![1] as string);
			// lastUpdated should be updated to a recent timestamp
			expect(writtenSession.lastUpdated).toBeDefined();
			expect(new Date(writtenSession.lastUpdated).getTime()).toBeGreaterThan(
				new Date('2026-01-01T01:00:00.000Z').getTime()
			);
		});
	});

	describe('getAllNamedSessions', () => {
		function createMockOriginsStore(data: Record<string, unknown> = {}) {
			return {
				get: vi.fn().mockReturnValue(data),
				set: vi.fn(),
			} as never;
		}

		it('should return empty array when no origins store is provided', async () => {
			const storageNoStore = new GeminiSessionStorage();
			const result = await storageNoStore.getAllNamedSessions();
			expect(result).toEqual([]);
		});

		it('should return empty array when no gemini-cli origins exist', async () => {
			const store = createMockOriginsStore({ origins: {} });
			const storageWithStore = new GeminiSessionStorage(store);
			const result = await storageWithStore.getAllNamedSessions();
			expect(result).toEqual([]);
		});

		it('should return named sessions from origins store', async () => {
			const store = createMockOriginsStore({
				'gemini-cli': {
					'/test/project': {
						'session-1': { sessionName: 'My Session', starred: true },
						'session-2': { sessionName: 'Other Session' },
						'session-3': { origin: 'auto' }, // no sessionName — should be skipped
					},
				},
			});
			// Mock findSessionFile to return null (no file on disk)
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const storageWithStore = new GeminiSessionStorage(store);
			const result = await storageWithStore.getAllNamedSessions();

			expect(result).toHaveLength(2);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						agentSessionId: 'session-1',
						projectPath: '/test/project',
						sessionName: 'My Session',
						starred: true,
					}),
					expect.objectContaining({
						agentSessionId: 'session-2',
						projectPath: '/test/project',
						sessionName: 'Other Session',
					}),
				])
			);
		});

		it('should NOT include sessions from other agents (e.g., codex)', async () => {
			const store = createMockOriginsStore({
				'gemini-cli': {
					'/test/project': {
						'gemini-session-1': { sessionName: 'Gemini Session' },
					},
				},
				codex: {
					'/test/project': {
						'codex-session-1': { sessionName: 'Codex Session' },
					},
				},
				'claude-code': {
					'/other/project': {
						'claude-session-1': { sessionName: 'Claude Session' },
					},
				},
			});
			// Mock findSessionFile to fail (no files on disk)
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const storageWithStore = new GeminiSessionStorage(store);
			const result = await storageWithStore.getAllNamedSessions();

			expect(result).toHaveLength(1);
			expect(result[0].agentSessionId).toBe('gemini-session-1');
			expect(result[0].sessionName).toBe('Gemini Session');
			// Ensure no codex or claude sessions leak through
			expect(result.find((s) => s.agentSessionId === 'codex-session-1')).toBeUndefined();
			expect(result.find((s) => s.agentSessionId === 'claude-session-1')).toBeUndefined();
		});

		it('should pass through starred status correctly (true, false, undefined)', async () => {
			const store = createMockOriginsStore({
				'gemini-cli': {
					'/test/project': {
						'session-starred': { sessionName: 'Starred', starred: true },
						'session-unstarred': { sessionName: 'Unstarred', starred: false },
						'session-no-star': { sessionName: 'No Star Field' },
					},
				},
			});
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const storageWithStore = new GeminiSessionStorage(store);
			const result = await storageWithStore.getAllNamedSessions();

			expect(result).toHaveLength(3);

			const starred = result.find((s) => s.agentSessionId === 'session-starred');
			const unstarred = result.find((s) => s.agentSessionId === 'session-unstarred');
			const noStar = result.find((s) => s.agentSessionId === 'session-no-star');

			expect(starred?.starred).toBe(true);
			expect(unstarred?.starred).toBe(false);
			expect(noStar?.starred).toBeUndefined();
		});

		it('should include lastActivityAt when session file exists', async () => {
			const mtimeMs = new Date('2026-02-15T10:00:00Z').getTime();
			const store = createMockOriginsStore({
				'gemini-cli': {
					'/test/project': {
						'test-session-id': { sessionName: 'Named Session' },
					},
				},
			});

			// Mock findSessionFile to succeed
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve('{}');
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-123-test-session-id.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 500,
				mtimeMs,
				mtime: new Date(mtimeMs),
				isDirectory: () => true,
			});

			const storageWithStore = new GeminiSessionStorage(store);
			const result = await storageWithStore.getAllNamedSessions();

			expect(result).toHaveLength(1);
			expect(result[0].lastActivityAt).toBe(mtimeMs);
		});
	});

	describe('listSessions with origin metadata enrichment', () => {
		function createMockOriginsStore(data: Record<string, unknown> = {}) {
			return {
				get: vi.fn().mockReturnValue(data),
				set: vi.fn(),
			} as never;
		}

		it('should enrich sessions with sessionName and starred from origins store', async () => {
			const sessionContent = buildSessionJson(
				[
					{ type: 'user', content: 'Hello' },
					{ type: 'gemini', content: 'Hi!' },
				],
				'test-session-id'
			);

			const store = createMockOriginsStore({
				'gemini-cli': {
					'/test/project': {
						'test-session-id': { sessionName: 'Custom Name', starred: true, origin: 'user' },
					},
				},
			});

			const storageWithStore = new GeminiSessionStorage(store);

			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(sessionContent);
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-123-test-session-id.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			const sessions = await storageWithStore.listSessions('/test/project');

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionName).toBe('Custom Name');
			expect(sessions[0].starred).toBe(true);
			expect(sessions[0].origin).toBe('user');
		});

		it('should work without origins store (no enrichment)', async () => {
			const sessionContent = buildSessionJson(
				[
					{ type: 'user', content: 'Hello' },
					{ type: 'gemini', content: 'Hi!' },
				],
				'test-session-id'
			);

			const storageNoStore = new GeminiSessionStorage();

			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(sessionContent);
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-123-test-session-id.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			const sessions = await storageNoStore.listSessions('/test/project');

			expect(sessions).toHaveLength(1);
			// sessionName should be from the parsed file (summary or first message), not from origins
			expect(sessions[0].starred).toBeUndefined();
			expect(sessions[0].origin).toBeUndefined();
		});
	});
});

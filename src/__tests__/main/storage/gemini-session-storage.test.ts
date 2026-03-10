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
		rename: vi.fn(),
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
		(fs.rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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

			// Verify atomic write: content written to .tmp, then renamed
			const tmpCall = writeCalls.find((call: unknown[]) => (call[0] as string).endsWith('.tmp'));
			expect(tmpCall).toBeDefined();
			expect(fs.rename).toHaveBeenCalledWith(
				expect.stringContaining('.tmp'),
				expect.stringContaining('session-123-test-session-id.json')
			);

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

		it('should serialize concurrent deletes on the same session file', async () => {
			const messages = [
				{ type: 'user', content: 'First' },
				{ type: 'gemini', content: 'Response 1' },
				{ type: 'user', content: 'Second' },
				{ type: 'gemini', content: 'Response 2' },
			];

			// Track the file content state so the second delete sees the first's changes
			let currentContent = buildSessionJson(messages);
			const operationOrder: string[] = [];
			let firstWriteResolve: (() => void) | null = null;

			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-123-test-session-id.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(currentContent);
			});
			(fs.unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

			let tmpWriteCount = 0;
			(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async (_filePath: string) => {
				if ((_filePath as string).endsWith('.tmp')) {
					tmpWriteCount++;
					const n = tmpWriteCount;
					operationOrder.push(`write-start-${n}`);
					if (n === 1) {
						// First atomic write blocks to prove serialization
						await new Promise<void>((r) => {
							firstWriteResolve = r;
						});
					}
					operationOrder.push(`write-end-${n}`);
				}
			});
			(fs.rename as ReturnType<typeof vi.fn>).mockImplementation(async (tmpPath: string) => {
				// Simulate atomic rename: update currentContent from the .tmp write
				const tmpWriteCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
					(call: unknown[]) => call[0] === tmpPath
				);
				if (tmpWriteCall) {
					currentContent = tmpWriteCall[1] as string;
				}
			});

			// Launch two concurrent deletes
			const p1 = storage.deleteMessagePair('/test/project', 'test-session-id', '0');
			// Give p1 time to start and block on its write
			await new Promise((r) => setTimeout(r, 50));
			const p2 = storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			// Release the first write
			await new Promise((r) => setTimeout(r, 10));
			firstWriteResolve!();

			const [result1, result2] = await Promise.all([p1, p2]);

			// First delete succeeds: removes "First" + "Response 1"
			expect(result1.success).toBe(true);
			expect(result1.linesRemoved).toBe(2);

			// Second delete runs after first completes and sees updated file.
			// Index 0 is now "Second" (after first delete removed "First"+"Response 1")
			expect(result2.success).toBe(true);
			expect(result2.linesRemoved).toBe(2);

			// Verify serialization: second write started after first write ended
			const writeEnd1 = operationOrder.indexOf('write-end-1');
			const writeStart2 = operationOrder.indexOf('write-start-2');
			expect(writeEnd1).toBeGreaterThanOrEqual(0);
			expect(writeStart2).toBeGreaterThanOrEqual(0);
			expect(writeEnd1).toBeLessThan(writeStart2);
		});

		it('should use atomic write-then-rename for session file updates', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			// Verify write went to .tmp file
			const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
			const tmpWrite = writeCalls.find((call: unknown[]) => (call[0] as string).endsWith('.tmp'));
			expect(tmpWrite).toBeDefined();

			// Verify rename was called from .tmp to .json
			const renameCalls = (fs.rename as ReturnType<typeof vi.fn>).mock.calls;
			expect(renameCalls).toHaveLength(1);
			expect(renameCalls[0][0]).toMatch(/\.tmp$/);
			expect(renameCalls[0][1]).toMatch(/\.json$/);

			// Verify NO direct write to the session .json file (only .bak and .tmp)
			const directWrites = writeCalls.filter(
				(call: unknown[]) =>
					(call[0] as string).endsWith('.json') && !(call[0] as string).endsWith('.bak')
			);
			expect(directWrites).toHaveLength(0);
		});

		it('should clean up orphaned temp file on write failure', async () => {
			const messages = [
				{ type: 'user', content: 'Hello' },
				{ type: 'gemini', content: 'Response' },
			];
			const sessionContent = buildSessionJson(messages);
			mockFindSessionFile(sessionContent);

			// Make rename fail (simulates atomic write failure)
			(fs.rename as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rename failed'));

			const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to write session file');

			// Verify backup restore was attempted
			expect(fs.copyFile).toHaveBeenCalled();

			// Verify orphaned .tmp cleanup was attempted
			const unlinkCalls = (fs.unlink as ReturnType<typeof vi.fn>).mock.calls;
			const tmpUnlink = unlinkCalls.find((call: unknown[]) => (call[0] as string).endsWith('.tmp'));
			expect(tmpUnlink).toBeDefined();
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

	describe('searchSessions', () => {
		function mockMultipleSessionFiles(sessionsMap: Record<string, string>) {
			const filenames = Object.keys(sessionsMap);
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				for (const [filename, content] of Object.entries(sessionsMap)) {
					if (filePath.endsWith(filename)) {
						return Promise.resolve(content);
					}
				}
				return Promise.reject(new Error('ENOENT'));
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(filenames);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});
		}

		it('should return empty array for empty query', async () => {
			const results = await storage.searchSessions('/test/project', '  ', 'all');
			expect(results).toEqual([]);
		});

		it('should return empty array when no history dir exists', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const results = await storage.searchSessions('/test/project', 'hello', 'all');
			expect(results).toEqual([]);
		});

		it('should find sessions by user message content', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'Hello world' },
						{ type: 'gemini', content: 'Hi there!' },
					],
					'sess-a'
				),
				'session-200-sess-b.json': buildSessionJson(
					[
						{ type: 'user', content: 'Goodbye' },
						{ type: 'gemini', content: 'Bye!' },
					],
					'sess-b'
				),
			});

			const results = await storage.searchSessions('/test/project', 'Hello', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('sess-a');
			expect(results[0].matchType).toBe('user');
			expect(results[0].matchCount).toBe(1);
		});

		it('should find sessions by assistant message content', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'Question' },
						{ type: 'gemini', content: 'The answer is 42' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'answer', 'assistant');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('assistant');
		});

		it('should find sessions by title (summary)', async () => {
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [
					{ type: 'user', content: 'Do something' },
					{ type: 'gemini', content: 'Done' },
				],
				summary: 'Debugging the auth module',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			const results = await storage.searchSessions('/test/project', 'auth module', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('title');
		});

		it('should search all modes and prioritize title > user > assistant', async () => {
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [
					{ type: 'user', content: 'keyword in user' },
					{ type: 'gemini', content: 'keyword in assistant' },
				],
				summary: 'keyword in title',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			const results = await storage.searchSessions('/test/project', 'keyword', 'all');
			expect(results).toHaveLength(1);
			// Title match takes priority in 'all' mode
			expect(results[0].matchType).toBe('title');
		});

		it('should return no results when query does not match', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'Hello' },
						{ type: 'gemini', content: 'Hi!' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'nonexistent', 'all');
			expect(results).toEqual([]);
		});

		it('should skip empty session files', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(
					buildSessionJson(
						[
							{ type: 'user', content: 'findme' },
							{ type: 'gemini', content: 'ok' },
						],
						'sess-a'
					)
				);
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-100-sess-a.json',
				'session-200-sess-empty.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.includes('sess-empty')) {
					return Promise.resolve({ size: 0, mtimeMs: Date.now(), isDirectory: () => true });
				}
				return Promise.resolve({ size: 1000, mtimeMs: Date.now(), isDirectory: () => true });
			});

			const results = await storage.searchSessions('/test/project', 'findme', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('sess-a');
		});

		it('should not call listSessions or findSessionFile (no double-read)', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'test' },
						{ type: 'gemini', content: 'ok' },
					],
					'sess-a'
				),
			});

			await storage.searchSessions('/test/project', 'test', 'all');

			// readdir should be called exactly once (for findSessionFiles),
			// NOT twice (which would happen if listSessions was called + findSessionFile for each)
			const readdirCalls = (fs.readdir as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call: unknown[]) => !(call[0] as string).endsWith('.gemini/history')
			);
			// Only the session dir readdir, not base history dir scan
			expect(readdirCalls.length).toBeLessThanOrEqual(1);
		});

		it('should be case-insensitive when matching', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'Hello WORLD' },
						{ type: 'gemini', content: 'response' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'hello world', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('sess-a');
		});

		it('should return matchPreview with first matching message content (truncated to 200 chars)', async () => {
			const longContent = 'A'.repeat(300);
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: longContent },
						{ type: 'gemini', content: 'response' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'AAAA', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].matchPreview).toBe('A'.repeat(200));
			expect(results[0].matchPreview.length).toBe(200);
		});

		it('should count multiple user matches in the same session', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'keyword first' },
						{ type: 'gemini', content: 'reply' },
						{ type: 'user', content: 'keyword second' },
						{ type: 'gemini', content: 'reply again' },
						{ type: 'user', content: 'keyword third' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'keyword', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].matchCount).toBe(3);
			// Preview should be from the first matching message
			expect(results[0].matchPreview).toContain('keyword first');
		});

		it('should count multiple assistant matches in the same session', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'question' },
						{ type: 'gemini', content: 'answer with token' },
						{ type: 'user', content: 'follow up' },
						{ type: 'gemini', content: 'another token answer' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'token', 'assistant');
			expect(results).toHaveLength(1);
			expect(results[0].matchCount).toBe(2);
		});

		it('should fall through to user match in all mode when title does not match', async () => {
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [
					{ type: 'user', content: 'findme in user message' },
					{ type: 'gemini', content: 'no match here' },
				],
				summary: 'Unrelated title',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			const results = await storage.searchSessions('/test/project', 'findme', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('user');
			expect(results[0].matchPreview).toContain('findme in user message');
		});

		it('should fall through to assistant match in all mode when neither title nor user match', async () => {
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [
					{ type: 'user', content: 'unrelated question' },
					{ type: 'gemini', content: 'the secret answer is here' },
				],
				summary: 'Unrelated title',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			const results = await storage.searchSessions('/test/project', 'secret answer', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('assistant');
			expect(results[0].matchPreview).toContain('the secret answer is here');
		});

		it('should gracefully handle corrupted JSON files during search', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				if (filePath.includes('sess-good')) {
					return Promise.resolve(
						buildSessionJson(
							[
								{ type: 'user', content: 'findme' },
								{ type: 'gemini', content: 'ok' },
							],
							'sess-good'
						)
					);
				}
				// Corrupted JSON for the other file
				return Promise.resolve('{ not valid json !!!');
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-100-sess-good.json',
				'session-200-sess-bad.json',
			]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			const results = await storage.searchSessions('/test/project', 'findme', 'all');
			// Should still return the good result, not throw
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('sess-good');
		});

		it('should use title preview as fallback when message preview is empty', async () => {
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [{ type: 'user', content: 'searchterm' }],
				summary: 'Summary with searchterm',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			// Title mode — matchPreview should come from summary
			const results = await storage.searchSessions('/test/project', 'searchterm', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchPreview).toContain('Summary with searchterm');
		});

		it('should search across multiple sessions and return all matches', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'user', content: 'common keyword here' },
						{ type: 'gemini', content: 'response' },
					],
					'sess-a'
				),
				'session-200-sess-b.json': buildSessionJson(
					[
						{ type: 'user', content: 'also has common keyword' },
						{ type: 'gemini', content: 'reply' },
					],
					'sess-b'
				),
				'session-300-sess-c.json': buildSessionJson(
					[
						{ type: 'user', content: 'no match at all' },
						{ type: 'gemini', content: 'nothing' },
					],
					'sess-c'
				),
			});

			const results = await storage.searchSessions('/test/project', 'common keyword', 'user');
			expect(results).toHaveLength(2);
			const ids = results.map((r) => r.sessionId).sort();
			expect(ids).toEqual(['sess-a', 'sess-b']);
		});

		it('should skip info/error/warning messages during search', async () => {
			mockMultipleSessionFiles({
				'session-100-sess-a.json': buildSessionJson(
					[
						{ type: 'info', content: 'keyword in info' },
						{ type: 'error', content: 'keyword in error' },
						{ type: 'warning', content: 'keyword in warning' },
						{ type: 'user', content: 'no match here' },
						{ type: 'gemini', content: 'no match either' },
					],
					'sess-a'
				),
			});

			const results = await storage.searchSessions('/test/project', 'keyword', 'all');
			expect(results).toEqual([]);
		});

		it('should use query as last-resort matchPreview when no other preview available', async () => {
			// Edge case: title matches but messages array is empty
			const content = JSON.stringify({
				sessionId: 'sess-a',
				messages: [],
				summary: 'findme',
				startTime: '2026-01-01T00:00:00.000Z',
				lastUpdated: '2026-01-01T01:00:00.000Z',
			});

			mockMultipleSessionFiles({
				'session-100-sess-a.json': content,
			});

			const results = await storage.searchSessions('/test/project', 'findme', 'title');
			expect(results).toHaveLength(1);
			// matchPreview should have the title as preview
			expect(results[0].matchPreview).toBe('findme');
		});
	});

	describe('listSessionsPaginated', () => {
		function mockPaginatedFiles(count: number) {
			const filenames = Array.from(
				{ length: count },
				(_, i) => `session-${String(i).padStart(3, '0')}-sess-${i}.json`
			);

			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(filenames);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				// Extract session ID from the file path
				const match = filePath.match(/sess-(\d+)\.json$/);
				const idx = match ? parseInt(match[1], 10) : 0;
				return Promise.resolve(
					buildSessionJson(
						[
							{ type: 'user', content: `Message ${idx}` },
							{ type: 'gemini', content: `Response ${idx}` },
						],
						`sess-${idx}`
					)
				);
			});
			// Each file gets a different mtime for sorting (higher index = newer)
			(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				const match = (filePath as string).match(/sess-(\d+)\.json$/);
				const idx = match ? parseInt(match[1], 10) : 0;
				return Promise.resolve({
					size: 1000,
					mtimeMs: 1000000 + idx * 1000,
					mtime: new Date(1000000 + idx * 1000),
					isDirectory: () => true,
				});
			});
		}

		it('should return first page of sessions', async () => {
			mockPaginatedFiles(5);

			const result = await storage.listSessionsPaginated('/test/project', { limit: 3 });

			expect(result.sessions).toHaveLength(3);
			expect(result.totalCount).toBe(5);
			expect(result.hasMore).toBe(true);
			expect(result.nextCursor).toBeDefined();
		});

		it('should return all sessions when limit exceeds count', async () => {
			mockPaginatedFiles(3);

			const result = await storage.listSessionsPaginated('/test/project', { limit: 10 });

			expect(result.sessions).toHaveLength(3);
			expect(result.totalCount).toBe(3);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		});

		it('should paginate from cursor position', async () => {
			mockPaginatedFiles(5);

			// First page
			const page1 = await storage.listSessionsPaginated('/test/project', { limit: 2 });
			expect(page1.sessions).toHaveLength(2);
			expect(page1.hasMore).toBe(true);

			// Second page using cursor
			const page2 = await storage.listSessionsPaginated('/test/project', {
				limit: 2,
				cursor: page1.nextCursor!,
			});
			expect(page2.sessions).toHaveLength(2);
			expect(page2.hasMore).toBe(true);

			// Third page
			const page3 = await storage.listSessionsPaginated('/test/project', {
				limit: 2,
				cursor: page2.nextCursor!,
			});
			expect(page3.sessions).toHaveLength(1);
			expect(page3.hasMore).toBe(false);

			// No duplicates across pages
			const allIds = [
				...page1.sessions.map((s) => s.sessionId),
				...page2.sessions.map((s) => s.sessionId),
				...page3.sessions.map((s) => s.sessionId),
			];
			expect(new Set(allIds).size).toBe(5);
		});

		it('should return empty result when no history dir exists', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
			(fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

			const result = await storage.listSessionsPaginated('/test/project');

			expect(result.sessions).toEqual([]);
			expect(result.totalCount).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('should sort by mtime descending (newest first)', async () => {
			mockPaginatedFiles(3);

			const result = await storage.listSessionsPaginated('/test/project', { limit: 10 });

			// Higher index = newer mtime, so should come first
			expect(result.sessions[0].sessionId).toBe('sess-2');
			expect(result.sessions[1].sessionId).toBe('sess-1');
			expect(result.sessions[2].sessionId).toBe('sess-0');
		});

		it('should only parse files in page range (not all files)', async () => {
			mockPaginatedFiles(10);

			await storage.listSessionsPaginated('/test/project', { limit: 3 });

			// readFile should be called for .project_root + only 3 session files (not all 10)
			const readFileCalls = (fs.readFile as ReturnType<typeof vi.fn>).mock.calls;
			const sessionReadCalls = readFileCalls.filter(
				(call: unknown[]) =>
					(call[0] as string).includes('sess-') && (call[0] as string).endsWith('.json')
			);
			expect(sessionReadCalls.length).toBe(3);
		});

		it('should skip empty files', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-100-sess-a.json',
				'session-200-sess-empty.json',
			]);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(
					buildSessionJson(
						[
							{ type: 'user', content: 'Hello' },
							{ type: 'gemini', content: 'Hi' },
						],
						'sess-a'
					)
				);
			});
			(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if ((filePath as string).includes('sess-empty')) {
					return Promise.resolve({ size: 0, mtimeMs: Date.now(), isDirectory: () => true });
				}
				return Promise.resolve({ size: 1000, mtimeMs: Date.now(), isDirectory: () => true });
			});

			const result = await storage.listSessionsPaginated('/test/project');
			expect(result.sessions).toHaveLength(1);
			expect(result.totalCount).toBe(1);
		});

		it('should reset to first page when cursor is not found', async () => {
			mockPaginatedFiles(5);

			const result = await storage.listSessionsPaginated('/test/project', {
				limit: 3,
				cursor: 'nonexistent-cursor-id',
			});

			// When cursor not found, startIndex falls back to 0
			expect(result.sessions).toHaveLength(3);
			expect(result.totalCount).toBe(5);
			expect(result.hasMore).toBe(true);
			// Should return from the beginning (newest first)
			expect(result.sessions[0].sessionId).toBe('sess-4');
		});

		it('should return empty page when cursor is the last session', async () => {
			mockPaginatedFiles(3);

			// Get sessions to find the last one (oldest, since sorted newest-first)
			const all = await storage.listSessionsPaginated('/test/project', { limit: 10 });
			const lastSessionId = all.sessions[all.sessions.length - 1].sessionId;

			const result = await storage.listSessionsPaginated('/test/project', {
				limit: 10,
				cursor: lastSessionId,
			});

			expect(result.sessions).toHaveLength(0);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
			expect(result.totalCount).toBe(3);
		});

		it('should use default limit of 100 when no options provided', async () => {
			mockPaginatedFiles(5);

			const result = await storage.listSessionsPaginated('/test/project');

			expect(result.sessions).toHaveLength(5);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		});

		it('should return empty result when directory has no session files', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.reject(new Error('ENOENT'));
			});
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 0,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			const result = await storage.listSessionsPaginated('/test/project', { limit: 10 });

			expect(result.sessions).toEqual([]);
			expect(result.totalCount).toBe(0);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		});

		it('should handle stat failures gracefully by excluding failed files', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
				'session-100-sess-good.json',
				'session-200-sess-statfail.json',
			]);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(
					buildSessionJson(
						[
							{ type: 'user', content: 'Hello' },
							{ type: 'gemini', content: 'Hi' },
						],
						'sess-good'
					)
				);
			});
			(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if ((filePath as string).includes('sess-statfail')) {
					return Promise.reject(new Error('EACCES'));
				}
				return Promise.resolve({
					size: 1000,
					mtimeMs: Date.now(),
					isDirectory: () => true,
				});
			});

			const result = await storage.listSessionsPaginated('/test/project');

			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0].sessionId).toBe('sess-good');
			expect(result.totalCount).toBe(1);
		});

		it('should maintain correct totalCount across paginated requests', async () => {
			mockPaginatedFiles(7);

			const page1 = await storage.listSessionsPaginated('/test/project', { limit: 3 });
			const page2 = await storage.listSessionsPaginated('/test/project', {
				limit: 3,
				cursor: page1.nextCursor!,
			});
			const page3 = await storage.listSessionsPaginated('/test/project', {
				limit: 3,
				cursor: page2.nextCursor!,
			});

			// totalCount should be consistent across all pages
			expect(page1.totalCount).toBe(7);
			expect(page2.totalCount).toBe(7);
			expect(page3.totalCount).toBe(7);

			// Verify page sizes
			expect(page1.sessions).toHaveLength(3);
			expect(page1.hasMore).toBe(true);
			expect(page2.sessions).toHaveLength(3);
			expect(page2.hasMore).toBe(true);
			expect(page3.sessions).toHaveLength(1);
			expect(page3.hasMore).toBe(false);
		});
	});

	describe('getHistoryDir caching', () => {
		it('should cache getHistoryDir results and return cached value on second call', async () => {
			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(buildSessionJson([], 'test'));
			});
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 0,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			// First call — triggers filesystem access
			await storage.listSessions('/test/project');
			const accessCallCount1 = (fs.access as ReturnType<typeof vi.fn>).mock.calls.length;

			// Second call — should use cache (no new fs.access calls for getHistoryDir)
			await storage.listSessions('/test/project');
			const accessCallCount2 = (fs.access as ReturnType<typeof vi.fn>).mock.calls.length;

			// Second call should NOT add new access calls for directory resolution
			expect(accessCallCount2).toBe(accessCallCount1);
		});
	});

	describe('file size guards (MAX_SESSION_FILE_SIZE)', () => {
		const OVERSIZED = 51 * 1024 * 1024; // 51 MB — exceeds 50 MB limit

		describe('parseSessionFile (via listSessions)', () => {
			it('should return minimal metadata for oversized files instead of parsing', async () => {
				(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
				(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['session-100-sess-big.json']);
				(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if (filePath.endsWith('.project_root')) {
						return Promise.resolve('/test/project');
					}
					// Should NOT be called for session file — size guard should prevent it
					return Promise.resolve(
						buildSessionJson([{ type: 'user', content: 'Should not read' }], 'sess-big')
					);
				});
				(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
					size: OVERSIZED,
					mtimeMs: 1700000000000,
					isDirectory: () => true,
				});

				const sessions = await storage.listSessions('/test/project');

				expect(sessions).toHaveLength(1);
				expect(sessions[0].sessionId).toBe('sess-big');
				expect(sessions[0].sessionName).toContain('oversized');
				expect(sessions[0].firstMessage).toContain('too large');
				expect(sessions[0].messageCount).toBe(0);
				expect(sessions[0].sizeBytes).toBe(OVERSIZED);
			});

			it('should still parse normal-sized files alongside oversized ones', async () => {
				(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
				(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
					'session-100-sess-big.json',
					'session-200-sess-ok.json',
				]);
				(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if (filePath.endsWith('.project_root')) {
						return Promise.resolve('/test/project');
					}
					return Promise.resolve(
						buildSessionJson(
							[
								{ type: 'user', content: 'Hello' },
								{ type: 'gemini', content: 'Hi' },
							],
							'sess-ok'
						)
					);
				});
				(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if ((filePath as string).includes('sess-big')) {
						return Promise.resolve({
							size: OVERSIZED,
							mtimeMs: 1700000000000,
							isDirectory: () => true,
						});
					}
					return Promise.resolve({
						size: 1000,
						mtimeMs: 1700000001000,
						isDirectory: () => true,
					});
				});

				const sessions = await storage.listSessions('/test/project');

				expect(sessions).toHaveLength(2);
				const bigSession = sessions.find((s) => s.sessionId === 'sess-big');
				const okSession = sessions.find((s) => s.sessionId === 'sess-ok');
				expect(bigSession?.sessionName).toContain('oversized');
				expect(okSession?.messageCount).toBe(2);
			});
		});

		describe('readSessionMessages', () => {
			it('should return empty result with error for oversized files', async () => {
				(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
				(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if (filePath.endsWith('.project_root')) {
						return Promise.resolve('/test/project');
					}
					return Promise.resolve(
						buildSessionJson([{ type: 'user', content: 'Should not read' }], 'test-session-id')
					);
				});
				(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
					'session-123-test-session-id.json',
				]);
				(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
					size: OVERSIZED,
					mtimeMs: Date.now(),
					isDirectory: () => true,
				});

				const result = await storage.readSessionMessages('/test/project', 'test-session-id', {
					limit: 100,
				});

				expect(result.messages).toEqual([]);
				expect(result.total).toBe(0);
				expect(result.hasMore).toBe(false);
				expect(result.error).toContain('maximum size');
			});
		});

		describe('searchSessions', () => {
			it('should skip oversized files with warning', async () => {
				(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
				(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
					'session-100-sess-big.json',
					'session-200-sess-ok.json',
				]);
				(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if (filePath.endsWith('.project_root')) {
						return Promise.resolve('/test/project');
					}
					return Promise.resolve(
						buildSessionJson(
							[
								{ type: 'user', content: 'findme keyword' },
								{ type: 'gemini', content: 'Found it' },
							],
							'sess-ok'
						)
					);
				});
				(fs.stat as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if ((filePath as string).includes('sess-big')) {
						return Promise.resolve({
							size: OVERSIZED,
							mtimeMs: Date.now(),
							isDirectory: () => true,
						});
					}
					return Promise.resolve({
						size: 1000,
						mtimeMs: Date.now(),
						isDirectory: () => true,
					});
				});

				const results = await storage.searchSessions('/test/project', 'findme', 'all');

				// Only the normal-sized file should be searched
				expect(results).toHaveLength(1);
				expect(results[0].sessionId).toBe('sess-ok');
			});
		});

		describe('deleteMessagePair', () => {
			it('should reject deletion of oversized files', async () => {
				(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
				(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
					if (filePath.endsWith('.project_root')) {
						return Promise.resolve('/test/project');
					}
					return Promise.resolve(
						buildSessionJson(
							[
								{ type: 'user', content: 'Hello' },
								{ type: 'gemini', content: 'Hi' },
							],
							'test-session-id'
						)
					);
				});
				(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue([
					'session-123-test-session-id.json',
				]);
				(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
					size: OVERSIZED,
					mtimeMs: Date.now(),
					isDirectory: () => true,
				});

				const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

				expect(result.success).toBe(false);
				expect(result.error).toContain('maximum size');
			});

			it('should allow deletion of normal-sized files', async () => {
				const sessionContent = buildSessionJson([
					{ type: 'user', content: 'Hello' },
					{ type: 'gemini', content: 'Hi' },
				]);
				mockFindSessionFile(sessionContent);

				const result = await storage.deleteMessagePair('/test/project', 'test-session-id', '0');

				expect(result.success).toBe(true);
			});
		});
	});

	describe('bounded concurrency in listSessions', () => {
		it('should process multiple session files concurrently', async () => {
			const filenames = Array.from({ length: 5 }, (_, i) => `session-${i}-sess-${i}.json`);

			(fs.access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
			(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(filenames);
			(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
				if (filePath.endsWith('.project_root')) {
					return Promise.resolve('/test/project');
				}
				return Promise.resolve(
					buildSessionJson(
						[
							{ type: 'user', content: 'Hello' },
							{ type: 'gemini', content: 'Hi!' },
						],
						'test'
					)
				);
			});
			(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				size: 1000,
				mtimeMs: Date.now(),
				isDirectory: () => true,
			});

			const sessions = await storage.listSessions('/test/project');

			// All 5 files should be processed
			expect(sessions).toHaveLength(5);
		});
	});
});

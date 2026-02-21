/**
 * Tests for GeminiSessionStorage
 *
 * Verifies:
 * - deleteMessagePair: index-based and content-based message deletion
 * - readSessionMessages: UUID uses original array index
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
function buildSessionJson(messages: Array<{ type: string; content: string; toolCalls?: unknown[] }>, sessionId = 'test-session-id') {
	return JSON.stringify({
		sessionId,
		messages,
		startTime: '2026-01-01T00:00:00.000Z',
		lastUpdated: '2026-01-01T01:00:00.000Z',
	}, null, 2);
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
		(fs.readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['session-123-test-session-id.json']);
		(fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 1000, mtimeMs: Date.now(), isDirectory: () => true });
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

			const result = await storage.readSessionMessages('/test/project', 'test-session-id', { limit: 100 });

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

			const result = await storage.readSessionMessages('/test/project', 'test-session-id', { limit: 100 });

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
});

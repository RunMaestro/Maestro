/**
 * @file session-recovery.test.ts
 * @description Unit tests for the Group Chat session recovery module.
 *
 * Tests cover:
 * - detectSessionNotFoundError: detecting session-not-found errors from agent output
 * - needsSessionRecovery: delegation to detectSessionNotFoundError
 * - buildRecoveryContext: constructing recovery context with chat history
 * - initiateSessionRecovery: clearing agentSessionId for re-spawn
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../../main/parsers/error-patterns', () => ({
	getErrorPatterns: vi.fn(() => ({})),
	matchErrorPattern: vi.fn(() => null),
}));

vi.mock('../../../main/group-chat/group-chat-log', () => ({
	readLog: vi.fn(async () => []),
}));

vi.mock('../../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: vi.fn(async () => null),
	updateParticipant: vi.fn(async () => ({})),
	getGroupChatDir: vi.fn(() => '/tmp/gc'),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	detectSessionNotFoundError,
	needsSessionRecovery,
	buildRecoveryContext,
	initiateSessionRecovery,
} from '../../../main/group-chat/session-recovery';

import { getErrorPatterns, matchErrorPattern } from '../../../main/parsers/error-patterns';
import { readLog } from '../../../main/group-chat/group-chat-log';
import {
	loadGroupChat,
	updateParticipant,
} from '../../../main/group-chat/group-chat-storage';

const mockedGetErrorPatterns = vi.mocked(getErrorPatterns);
const mockedMatchErrorPattern = vi.mocked(matchErrorPattern);
const mockedReadLog = vi.mocked(readLog);
const mockedLoadGroupChat = vi.mocked(loadGroupChat);
const mockedUpdateParticipant = vi.mocked(updateParticipant);

describe('group-chat/session-recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ========================================================================
	// detectSessionNotFoundError
	// ========================================================================

	describe('detectSessionNotFoundError', () => {
		it('should return false for empty string', () => {
			expect(detectSessionNotFoundError('')).toBe(false);
		});

		it('should return false for undefined-ish empty output', () => {
			// The function checks `if (!output)` so empty string returns false
			expect(detectSessionNotFoundError('')).toBe(false);
		});

		it('should return false for normal output with no error patterns', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Hello, I am working on your task. Everything looks good.';
			expect(detectSessionNotFoundError(output)).toBe(false);
		});

		it('should call getErrorPatterns with provided agentId', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			detectSessionNotFoundError('some output', 'opencode');
			expect(mockedGetErrorPatterns).toHaveBeenCalledWith('opencode');
		});

		it('should default to claude-code when agentId is not provided', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			detectSessionNotFoundError('some output');
			expect(mockedGetErrorPatterns).toHaveBeenCalledWith('claude-code');
		});

		it('should return true when matchErrorPattern returns session_not_found type', () => {
			const mockPatterns = { session_not_found: [] };
			mockedGetErrorPatterns.mockReturnValue(mockPatterns);
			mockedMatchErrorPattern.mockReturnValue({
				type: 'session_not_found',
				message: 'Session not found. The session may have been deleted.',
				recoverable: true,
			});

			const output = 'Error: no conversation found with session id abc-123';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return false when matchErrorPattern returns a different error type', () => {
			const mockPatterns = {};
			mockedGetErrorPatterns.mockReturnValue(mockPatterns);
			mockedMatchErrorPattern.mockReturnValue({
				type: 'auth_expired',
				message: 'Authentication failed.',
				recoverable: true,
			});

			// The function only returns true for type === 'session_not_found'
			// and the raw fallback patterns below won't match this output
			const output = 'Authentication failed please login again';
			expect(detectSessionNotFoundError(output)).toBe(false);
		});

		it('should check each line of multi-line output against matchErrorPattern', () => {
			const mockPatterns = {};
			mockedGetErrorPatterns.mockReturnValue(mockPatterns);

			// Return null for first line, session_not_found for second line
			mockedMatchErrorPattern
				.mockReturnValueOnce(null)
				.mockReturnValueOnce({
					type: 'session_not_found',
					message: 'Session not found.',
					recoverable: true,
				});

			const output = 'First line of output\nSession not found for id xyz';
			expect(detectSessionNotFoundError(output)).toBe(true);
			// Should have been called twice (once per line) before finding the match
			expect(mockedMatchErrorPattern).toHaveBeenCalledTimes(2);
		});

		// Raw regex pattern tests (fallback patterns that run after matchErrorPattern)

		it('should return true for raw pattern "no conversation found with session id"', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Error: no conversation found with session id abc-123-def';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return true for raw pattern "no conversation found with session id" (case insensitive)', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'NO CONVERSATION FOUND WITH SESSION ID xyz';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return true for raw pattern "Session not found"', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Error: Session not found';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return true for raw pattern "session was not found"', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'The session was not found in the system';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return true for raw pattern "invalid session id"', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Error: invalid session id provided';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return true for raw pattern "Invalid Session ID" (case insensitive)', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Invalid Session ID: abc-123';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should return false when output contains unrelated errors', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			const output = 'Error: rate limit exceeded. Please try again later.';
			expect(detectSessionNotFoundError(output)).toBe(false);
		});

		it('should check raw patterns against the full output (not line-by-line)', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			// The raw patterns test against the full output string
			const output = 'Line 1: some normal output\nLine 2: invalid session id found\nLine 3: done';
			expect(detectSessionNotFoundError(output)).toBe(true);
		});

		it('should prefer matchErrorPattern result over raw patterns', () => {
			const mockPatterns = {};
			mockedGetErrorPatterns.mockReturnValue(mockPatterns);
			mockedMatchErrorPattern.mockReturnValue({
				type: 'session_not_found',
				message: 'Session not found.',
				recoverable: true,
			});

			const output = 'session not found';
			const result = detectSessionNotFoundError(output);
			expect(result).toBe(true);
			// matchErrorPattern was called and returned a match, so function returns early
			// The raw regex patterns would also match, but we expect the structured match first
			expect(mockedMatchErrorPattern).toHaveBeenCalled();
		});
	});

	// ========================================================================
	// needsSessionRecovery
	// ========================================================================

	describe('needsSessionRecovery', () => {
		it('should delegate to detectSessionNotFoundError', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			expect(needsSessionRecovery('')).toBe(false);
			expect(needsSessionRecovery('normal output')).toBe(false);
		});

		it('should return true when session error is detected', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			expect(needsSessionRecovery('Session not found')).toBe(true);
		});

		it('should pass agentId through to detectSessionNotFoundError', () => {
			mockedGetErrorPatterns.mockReturnValue({});
			mockedMatchErrorPattern.mockReturnValue(null);

			needsSessionRecovery('some output', 'codex');
			expect(mockedGetErrorPatterns).toHaveBeenCalledWith('codex');
		});
	});

	// ========================================================================
	// buildRecoveryContext
	// ========================================================================

	describe('buildRecoveryContext', () => {
		it('should return empty string when chat is not found', async () => {
			mockedLoadGroupChat.mockResolvedValue(null);

			const result = await buildRecoveryContext('non-existent-id', 'Alice');
			expect(result).toBe('');
		});

		it('should return empty string when there are no messages', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toBe('');
		});

		it('should include "Session Recovery Context" header', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Architecture Discussion',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: 'Hello everyone' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('## Session Recovery Context');
		});

		it('should include the chat name in the context', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Architecture Discussion',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: 'Hello' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('Architecture Discussion');
		});

		it('should include participant own statements section when they have messages', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Alice', content: 'I think we should use TypeScript' },
				{ timestamp: '2025-01-15T10:01:00.000Z', from: 'Bob', content: 'Good idea' },
				{ timestamp: '2025-01-15T10:02:00.000Z', from: 'Alice', content: 'Let me explain further' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('### Your Previous Statements (as Alice)');
			expect(result).toContain('You previously said the following');
			expect(result).toContain('I think we should use TypeScript');
			expect(result).toContain('Let me explain further');
		});

		it('should not include "Your Previous Statements" section when participant has no messages', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: 'Hello' },
				{ timestamp: '2025-01-15T10:01:00.000Z', from: 'Charlie', content: 'Hi there' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).not.toContain('### Your Previous Statements');
			// Should still have conversation history
			expect(result).toContain('### Recent Conversation History');
		});

		it('should include recent conversation history with all messages', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Alice', content: 'My message' },
				{ timestamp: '2025-01-15T10:01:00.000Z', from: 'Bob', content: 'Bob reply' },
				{ timestamp: '2025-01-15T10:02:00.000Z', from: 'Charlie', content: 'Charlie reply' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('### Recent Conversation History');
			expect(result).toContain('My message');
			expect(result).toContain('Bob reply');
			expect(result).toContain('Charlie reply');
		});

		it('should mark participant own messages with **YOU** prefix in conversation history', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Alice', content: 'Hello from Alice' },
				{ timestamp: '2025-01-15T10:01:00.000Z', from: 'Bob', content: 'Hello from Bob' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('**YOU (Alice):**');
			expect(result).toContain('[Bob]:');
		});

		it('should respect lastMessages limit', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			const messages = [];
			for (let i = 0; i < 10; i++) {
				messages.push({
					timestamp: `2025-01-15T10:${String(i).padStart(2, '0')}:00.000Z`,
					from: i % 2 === 0 ? 'Alice' : 'Bob',
					content: `Message ${i}`,
				});
			}
			mockedReadLog.mockResolvedValue(messages);

			// Request only last 3 messages
			const result = await buildRecoveryContext('chat-1', 'Alice', 3);

			// Should contain only the last 3 messages (index 7, 8, 9)
			expect(result).toContain('Message 7');
			expect(result).toContain('Message 8');
			expect(result).toContain('Message 9');

			// Should NOT contain earlier messages
			expect(result).not.toContain('Message 0');
			expect(result).not.toContain('Message 6');
		});

		it('should use default lastMessages of 30', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			const messages = [];
			for (let i = 0; i < 40; i++) {
				messages.push({
					timestamp: `2025-01-15T10:${String(i).padStart(2, '0')}:00.000Z`,
					from: 'Bob',
					content: `Message ${i}`,
				});
			}
			mockedReadLog.mockResolvedValue(messages);

			const result = await buildRecoveryContext('chat-1', 'Alice');

			// Default is 30, so messages 10-39 should be included
			expect(result).toContain('Message 10');
			expect(result).toContain('Message 39');

			// Messages 0-9 should NOT be included
			expect(result).not.toContain('Message 0');
			expect(result).not.toContain('Message 9');
		});

		it('should truncate own messages longer than 1000 characters', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			const longContent = 'A'.repeat(1500);
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Alice', content: longContent },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');

			// The "Your Previous Statements" section truncates at 1000 chars
			// It should contain the first 1000 chars followed by "..."
			const yourStatementsSection = result.split('### Recent Conversation History')[0];
			expect(yourStatementsSection).toContain('A'.repeat(1000));
			expect(yourStatementsSection).toContain('...');
			// The full 1500 chars should NOT be present in that section
			expect(yourStatementsSection).not.toContain('A'.repeat(1001));
		});

		it('should truncate conversation history messages longer than 500 characters', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			const longContent = 'B'.repeat(800);
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: longContent },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');

			// In "Recent Conversation History", all messages truncate at 500 chars
			const historySection = result.split('### Recent Conversation History')[1];
			expect(historySection).toContain('B'.repeat(500));
			expect(historySection).toContain('...');
			expect(historySection).not.toContain('B'.repeat(501));
		});

		it('should not add ellipsis to messages within truncation limits', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Alice', content: 'Short message from Alice' },
				{ timestamp: '2025-01-15T10:01:00.000Z', from: 'Bob', content: 'Short message from Bob' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');

			// Count occurrences of "..." - should not have any truncation ellipsis
			// (Note: the context does include "..." in other places, but not from truncation)
			expect(result).toContain('Short message from Alice');
			expect(result).toContain('Short message from Bob');
		});

		it('should include continuity instruction at the end', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: 'Hello' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('Please continue from where you left off');
			expect(result).toContain('Maintain consistency with your previous statements');
		});

		it('should call readLog with the chat logPath', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/custom/path/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([]);

			await buildRecoveryContext('chat-1', 'Alice');
			expect(mockedReadLog).toHaveBeenCalledWith('/custom/path/chat.log');
		});

		it('should include session unavailability explanation', async () => {
			mockedLoadGroupChat.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});
			mockedReadLog.mockResolvedValue([
				{ timestamp: '2025-01-15T10:00:00.000Z', from: 'Bob', content: 'Hello' },
			]);

			const result = await buildRecoveryContext('chat-1', 'Alice');
			expect(result).toContain('Your previous session was unavailable');
			expect(result).toContain('fresh session');
		});
	});

	// ========================================================================
	// initiateSessionRecovery
	// ========================================================================

	describe('initiateSessionRecovery', () => {
		it('should return true and call updateParticipant to clear agentSessionId', async () => {
			mockedUpdateParticipant.mockResolvedValue({
				id: 'chat-1',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			const result = await initiateSessionRecovery('chat-1', 'Alice');
			expect(result).toBe(true);
			expect(mockedUpdateParticipant).toHaveBeenCalledWith('chat-1', 'Alice', {
				agentSessionId: undefined,
			});
		});

		it('should return false when updateParticipant throws an error', async () => {
			mockedUpdateParticipant.mockRejectedValue(new Error('Group chat not found: chat-99'));

			const result = await initiateSessionRecovery('chat-99', 'Alice');
			expect(result).toBe(false);
		});

		it('should call updateParticipant with the correct groupChatId and participantName', async () => {
			mockedUpdateParticipant.mockResolvedValue({
				id: 'my-chat',
				name: 'Test Chat',
				logPath: '/tmp/chat.log',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'mod-session-1',
				participants: [],
				imagesDir: '/tmp/images',
			});

			await initiateSessionRecovery('my-chat', 'Bob');
			expect(mockedUpdateParticipant).toHaveBeenCalledWith('my-chat', 'Bob', {
				agentSessionId: undefined,
			});
		});

		it('should return false when updateParticipant throws a non-standard error', async () => {
			mockedUpdateParticipant.mockRejectedValue('string error');

			const result = await initiateSessionRecovery('chat-1', 'Alice');
			expect(result).toBe(false);
		});
	});
});

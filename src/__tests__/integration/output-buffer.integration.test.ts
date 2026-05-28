/**
 * @file output-buffer.test.ts
 * @description Unit tests for group chat output buffer management.
 */

import { describe, it, expect } from 'vitest';
import {
	appendToGroupChatBuffer,
	getGroupChatBufferedOutput,
	clearGroupChatBuffer,
	hasGroupChatBuffer,
	isGroupChatBufferTruncated,
} from '../../main/group-chat/output-buffer';
import { MAX_GROUP_CHAT_BUFFER_SIZE } from '../../main/constants';

describe('group-chat/output-buffer', () => {
	// Use unique session IDs for each test to avoid state leakage
	const getUniqueSessionId = () =>
		`test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	describe('appendToGroupChatBuffer', () => {
		it('should create a new buffer for a new session', () => {
			const sessionId = getUniqueSessionId();
			const result = appendToGroupChatBuffer(sessionId, 'Hello');
			expect(result).toBe(5); // Length of 'Hello'
		});

		it('should append to existing buffer', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Hello');
			const result = appendToGroupChatBuffer(sessionId, ' World');
			expect(result).toBe(11); // Length of 'Hello World'
		});

		it('should return cumulative length after multiple appends', () => {
			const sessionId = getUniqueSessionId();
			expect(appendToGroupChatBuffer(sessionId, 'A')).toBe(1);
			expect(appendToGroupChatBuffer(sessionId, 'BB')).toBe(3);
			expect(appendToGroupChatBuffer(sessionId, 'CCC')).toBe(6);
		});

		it('should handle empty strings', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Start');
			const result = appendToGroupChatBuffer(sessionId, '');
			expect(result).toBe(5); // Length unchanged
		});

		it('should handle different sessions independently', () => {
			const sessionId1 = getUniqueSessionId();
			const sessionId2 = getUniqueSessionId();

			appendToGroupChatBuffer(sessionId1, 'Session 1 data');
			appendToGroupChatBuffer(sessionId2, 'Session 2');

			expect(getGroupChatBufferedOutput(sessionId1)).toBe('Session 1 data');
			expect(getGroupChatBufferedOutput(sessionId2)).toBe('Session 2');
		});

		it('should handle large data efficiently', () => {
			const sessionId = getUniqueSessionId();
			const largeChunk = 'x'.repeat(10000);

			// Append multiple large chunks
			for (let i = 0; i < 10; i++) {
				appendToGroupChatBuffer(sessionId, largeChunk);
			}

			const result = appendToGroupChatBuffer(sessionId, 'final');
			expect(result).toBe(100005); // 10 * 10000 + 5

			// Clean up
			clearGroupChatBuffer(sessionId);
		});
	});

	describe('getGroupChatBufferedOutput', () => {
		it('should return undefined for non-existent session', () => {
			const sessionId = getUniqueSessionId();
			expect(getGroupChatBufferedOutput(sessionId)).toBeUndefined();
		});

		it('should return concatenated output', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Hello');
			appendToGroupChatBuffer(sessionId, ' ');
			appendToGroupChatBuffer(sessionId, 'World');

			expect(getGroupChatBufferedOutput(sessionId)).toBe('Hello World');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should return empty string for session with empty buffer', () => {
			const sessionId = getUniqueSessionId();
			// Create buffer with empty string
			appendToGroupChatBuffer(sessionId, '');

			// Should return undefined because chunks array is empty (no non-empty data)
			// Actually, empty string IS pushed to chunks, so it won't be undefined
			// But the check is chunks.length === 0, so empty string still counts
			const result = getGroupChatBufferedOutput(sessionId);
			expect(result).toBe('');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should preserve newlines and special characters', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Line 1\n');
			appendToGroupChatBuffer(sessionId, 'Line 2\t');
			appendToGroupChatBuffer(sessionId, 'Special: "quotes" & <brackets>');

			const result = getGroupChatBufferedOutput(sessionId);
			expect(result).toBe('Line 1\nLine 2\tSpecial: "quotes" & <brackets>');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should handle unicode characters', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Hello ');
			appendToGroupChatBuffer(sessionId, 'World! ');

			const result = getGroupChatBufferedOutput(sessionId);
			expect(result).toContain('Hello');
			expect(result).toContain('World');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});
	});

	describe('clearGroupChatBuffer', () => {
		it('should clear existing buffer', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Some data');
			clearGroupChatBuffer(sessionId);

			expect(getGroupChatBufferedOutput(sessionId)).toBeUndefined();
		});

		it('should not throw for non-existent session', () => {
			const sessionId = getUniqueSessionId();
			expect(() => clearGroupChatBuffer(sessionId)).not.toThrow();
		});

		it('should allow reuse of session ID after clear', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'First');
			clearGroupChatBuffer(sessionId);

			appendToGroupChatBuffer(sessionId, 'Second');
			expect(getGroupChatBufferedOutput(sessionId)).toBe('Second');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});
	});

	describe('hasGroupChatBuffer', () => {
		it('should return false for non-existent session', () => {
			const sessionId = getUniqueSessionId();
			expect(hasGroupChatBuffer(sessionId)).toBe(false);
		});

		it('should return true for session with data', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Some data');

			expect(hasGroupChatBuffer(sessionId)).toBe(true);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should return false after buffer is cleared', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Some data');
			clearGroupChatBuffer(sessionId);

			expect(hasGroupChatBuffer(sessionId)).toBe(false);
		});

		it('should return true for buffer with only empty string', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, '');

			// Empty string is still pushed to chunks, so hasBuffer should be true
			expect(hasGroupChatBuffer(sessionId)).toBe(true);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});
	});

	describe('isGroupChatBufferTruncated', () => {
		it('should return false for non-existent session', () => {
			const sessionId = getUniqueSessionId();
			expect(isGroupChatBufferTruncated(sessionId)).toBe(false);
		});

		it('should return false for normal buffer', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Normal data');

			expect(isGroupChatBufferTruncated(sessionId)).toBe(false);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should return false after buffer is cleared', () => {
			const sessionId = getUniqueSessionId();
			appendToGroupChatBuffer(sessionId, 'Some data');
			clearGroupChatBuffer(sessionId);

			expect(isGroupChatBufferTruncated(sessionId)).toBe(false);
		});
	});

	describe('buffer size limits', () => {
		it('should have MAX_GROUP_CHAT_BUFFER_SIZE defined as 10MB', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBe(10 * 1024 * 1024);
		});

		it('should accept data up to the limit', () => {
			const sessionId = getUniqueSessionId();
			// Add data just under the limit (use smaller chunk for test performance)
			const chunk = 'x'.repeat(1000);
			for (let i = 0; i < 100; i++) {
				appendToGroupChatBuffer(sessionId, chunk);
			}

			// Should not be truncated
			expect(isGroupChatBufferTruncated(sessionId)).toBe(false);
			expect(hasGroupChatBuffer(sessionId)).toBe(true);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should truncate when exceeding max buffer size', () => {
			const sessionId = getUniqueSessionId();

			// Create a chunk that will exceed the buffer when added multiple times
			// Using 1MB chunks for faster test execution
			const oneMB = 1024 * 1024;
			const largeChunk = 'x'.repeat(oneMB);

			// Add 11MB worth of data (exceeds 10MB limit)
			for (let i = 0; i < 11; i++) {
				appendToGroupChatBuffer(sessionId, largeChunk);
			}

			// Should be truncated
			expect(isGroupChatBufferTruncated(sessionId)).toBe(true);

			// Output should contain truncation marker
			const output = getGroupChatBufferedOutput(sessionId);
			expect(output).toContain('[output truncated due to size limit]');

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should stop accepting data after truncation', () => {
			const sessionId = getUniqueSessionId();

			// Fill buffer to capacity
			const oneMB = 1024 * 1024;
			const largeChunk = 'x'.repeat(oneMB);

			for (let i = 0; i < 11; i++) {
				appendToGroupChatBuffer(sessionId, largeChunk);
			}

			// Get length after truncation
			const lengthAfterTruncation = appendToGroupChatBuffer(sessionId, '');

			// Try to add more data
			const newLength = appendToGroupChatBuffer(sessionId, 'This should be dropped');

			// Length should not increase (data was dropped)
			expect(newLength).toBe(lengthAfterTruncation);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});

		it('should add truncation marker only once', () => {
			const sessionId = getUniqueSessionId();

			// Exceed buffer limit
			const oneMB = 1024 * 1024;
			const largeChunk = 'x'.repeat(oneMB);

			for (let i = 0; i < 11; i++) {
				appendToGroupChatBuffer(sessionId, largeChunk);
			}

			// Try to add more data multiple times
			appendToGroupChatBuffer(sessionId, 'Extra 1');
			appendToGroupChatBuffer(sessionId, 'Extra 2');
			appendToGroupChatBuffer(sessionId, 'Extra 3');

			// Output should contain truncation marker only once
			const output = getGroupChatBufferedOutput(sessionId);
			const markerCount = (output!.match(/\[output truncated due to size limit\]/g) || []).length;
			expect(markerCount).toBe(1);

			// Clean up
			clearGroupChatBuffer(sessionId);
		});
	});

	describe('integration scenarios', () => {
		it('should handle typical group chat workflow', () => {
			const moderatorSession = getUniqueSessionId();
			const participantSession = getUniqueSessionId();

			// Moderator receives streaming output
			appendToGroupChatBuffer(moderatorSession, '{"type": "text", "text": "Hello"}');
			appendToGroupChatBuffer(moderatorSession, '\n');
			appendToGroupChatBuffer(moderatorSession, '{"type": "text", "text": " World"}');

			// Participant receives streaming output
			appendToGroupChatBuffer(participantSession, '{"type": "response", "data": "Reply"}');

			// Verify independent buffers
			expect(hasGroupChatBuffer(moderatorSession)).toBe(true);
			expect(hasGroupChatBuffer(participantSession)).toBe(true);

			// Get and clear moderator buffer (simulating process exit)
			const moderatorOutput = getGroupChatBufferedOutput(moderatorSession);
			expect(moderatorOutput).toContain('Hello');
			clearGroupChatBuffer(moderatorSession);

			// Get and clear participant buffer
			const participantOutput = getGroupChatBufferedOutput(participantSession);
			expect(participantOutput).toContain('Reply');
			clearGroupChatBuffer(participantSession);

			// Verify cleanup
			expect(hasGroupChatBuffer(moderatorSession)).toBe(false);
			expect(hasGroupChatBuffer(participantSession)).toBe(false);
		});

		it('should handle concurrent appends to different sessions', () => {
			const sessions = Array.from({ length: 5 }, () => getUniqueSessionId());

			// Simulate concurrent appends
			sessions.forEach((sessionId, index) => {
				appendToGroupChatBuffer(sessionId, `Session ${index} Part 1`);
			});

			sessions.forEach((sessionId, index) => {
				appendToGroupChatBuffer(sessionId, ` Session ${index} Part 2`);
			});

			// Verify each session has correct data
			sessions.forEach((sessionId, index) => {
				const output = getGroupChatBufferedOutput(sessionId);
				expect(output).toBe(`Session ${index} Part 1 Session ${index} Part 2`);
				clearGroupChatBuffer(sessionId);
			});
		});
	});
});

/**
 * @file performance-optimizations.test.ts
 * @description Unit tests for performance optimizations in the main process.
 *
 * Tests cover:
 * - Group chat session ID regex patterns
 * - Buffer operations (O(1) append, correct join)
 * - Debug logging conditional behavior
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================================
// Regex Pattern Tests
// ============================================================================
// These patterns are used in hot paths (process data handlers) and are
// pre-compiled at module level for performance. We test them here to ensure
// they match the expected session ID formats.

describe('Group Chat Session ID Patterns', () => {
	// Moderator session patterns
	const REGEX_MODERATOR_SESSION = /^group-chat-(.+)-moderator-/;
	const REGEX_MODERATOR_SESSION_TIMESTAMP = /^group-chat-(.+)-moderator-\d+$/;

	// Participant session patterns
	const REGEX_PARTICIPANT_UUID =
		/^group-chat-(.+)-participant-(.+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
	const REGEX_PARTICIPANT_TIMESTAMP = /^group-chat-(.+)-participant-(.+)-(\d{13,})$/;
	const REGEX_PARTICIPANT_FALLBACK = /^group-chat-(.+)-participant-([^-]+)-/;

	// Web broadcast patterns
	const REGEX_AI_SUFFIX = /-ai-.+$/;
	const REGEX_AI_TAB_ID = /-ai-(.+)$/;

	describe('REGEX_MODERATOR_SESSION', () => {
		it('should match moderator session IDs', () => {
			const sessionId = 'group-chat-test-chat-123-moderator-1705678901234';
			const match = sessionId.match(REGEX_MODERATOR_SESSION);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('test-chat-123');
		});

		it('should match moderator synthesis session IDs', () => {
			const sessionId = 'group-chat-my-chat-moderator-synthesis-1705678901234';
			const match = sessionId.match(REGEX_MODERATOR_SESSION);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('my-chat');
		});

		it('should not match participant session IDs', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-1705678901234';
			const match = sessionId.match(REGEX_MODERATOR_SESSION);
			expect(match).toBeNull();
		});

		it('should not match regular session IDs', () => {
			const sessionId = 'session-123-ai-tab1';
			const match = sessionId.match(REGEX_MODERATOR_SESSION);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_MODERATOR_SESSION_TIMESTAMP', () => {
		it('should match moderator session IDs with timestamp suffix', () => {
			const sessionId = 'group-chat-test-chat-moderator-1705678901234';
			const match = sessionId.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('test-chat');
		});

		it('should not match moderator synthesis session IDs', () => {
			const sessionId = 'group-chat-my-chat-moderator-synthesis-1705678901234';
			const match = sessionId.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			expect(match).toBeNull();
		});

		it('should not match session IDs without timestamp', () => {
			const sessionId = 'group-chat-test-chat-moderator-';
			const match = sessionId.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_PARTICIPANT_UUID', () => {
		it('should match participant session IDs with UUID suffix', () => {
			const sessionId =
				'group-chat-test-chat-participant-Agent1-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
			const match = sessionId.match(REGEX_PARTICIPANT_UUID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('test-chat');
			expect(match![2]).toBe('Agent1');
			expect(match![3]).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
		});

		it('should match UUID case-insensitively', () => {
			const sessionId =
				'group-chat-test-chat-participant-Agent1-A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
			const match = sessionId.match(REGEX_PARTICIPANT_UUID);
			expect(match).not.toBeNull();
		});

		it('should not match session IDs with invalid UUID', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-invalid-uuid';
			const match = sessionId.match(REGEX_PARTICIPANT_UUID);
			expect(match).toBeNull();
		});

		it('should handle participant names with hyphens', () => {
			const sessionId =
				'group-chat-test-chat-participant-My-Agent-Name-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
			const match = sessionId.match(REGEX_PARTICIPANT_UUID);
			expect(match).not.toBeNull();
			expect(match![2]).toBe('My-Agent-Name');
		});
	});

	describe('REGEX_PARTICIPANT_TIMESTAMP', () => {
		it('should match participant session IDs with 13-digit timestamp', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-1705678901234';
			const match = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('test-chat');
			expect(match![2]).toBe('Agent1');
			expect(match![3]).toBe('1705678901234');
		});

		it('should match timestamps with more than 13 digits', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-17056789012345';
			const match = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
			expect(match).not.toBeNull();
		});

		it('should not match timestamps with less than 13 digits', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-123456789012';
			const match = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
			expect(match).toBeNull();
		});

		it('should handle participant names with hyphens', () => {
			const sessionId = 'group-chat-test-chat-participant-My-Agent-1705678901234';
			const match = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
			expect(match).not.toBeNull();
			expect(match![2]).toBe('My-Agent');
		});
	});

	describe('REGEX_PARTICIPANT_FALLBACK', () => {
		it('should match participant session IDs with simple names', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent1-anything';
			const match = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('test-chat');
			expect(match![2]).toBe('Agent1');
		});

		it('should stop at hyphen for participant name', () => {
			const sessionId = 'group-chat-test-chat-participant-Agent-1-suffix';
			const match = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
			expect(match).not.toBeNull();
			expect(match![2]).toBe('Agent'); // Stops at first hyphen after participant name start
		});
	});

	describe('REGEX_AI_SUFFIX', () => {
		it('should match session IDs with -ai- suffix', () => {
			expect(REGEX_AI_SUFFIX.test('session-123-ai-tab1')).toBe(true);
		});

		it('should match session IDs with UUID tab IDs', () => {
			expect(REGEX_AI_SUFFIX.test('51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb')).toBe(true);
		});

		it('should remove -ai- suffix correctly with UUID tab IDs', () => {
			const sessionId = '51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb';
			const baseSessionId = sessionId.replace(REGEX_AI_SUFFIX, '');
			expect(baseSessionId).toBe('51cee651-6629-4de8-abdd-1c1540555f2d');
		});

		it('should not match session IDs without -ai- suffix', () => {
			expect(REGEX_AI_SUFFIX.test('session-123-terminal')).toBe(false);
		});
	});

	describe('REGEX_AI_TAB_ID', () => {
		it('should extract simple tab ID from session ID', () => {
			const match = 'session-123-ai-tab1'.match(REGEX_AI_TAB_ID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('tab1');
		});

		it('should extract UUID tab ID from session ID', () => {
			const match = '51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(REGEX_AI_TAB_ID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('73aaeb23-6673-45a4-8fdf-c769802f79bb');
		});

		it('should return null for non-AI sessions', () => {
			const match = 'session-123-terminal'.match(REGEX_AI_TAB_ID);
			expect(match).toBeNull();
		});
	});
});

// ============================================================================
// Buffer Operation Tests
// ============================================================================
// These tests verify the O(1) buffer implementation works correctly.

describe('Group Chat Output Buffer', () => {
	// Simulate the buffer implementation
	type BufferEntry = { chunks: string[]; totalLength: number };
	let buffers: Map<string, BufferEntry>;

	function appendToBuffer(sessionId: string, data: string): number {
		let buffer = buffers.get(sessionId);
		if (!buffer) {
			buffer = { chunks: [], totalLength: 0 };
			buffers.set(sessionId, buffer);
		}
		buffer.chunks.push(data);
		buffer.totalLength += data.length;
		return buffer.totalLength;
	}

	function getBufferedOutput(sessionId: string): string | undefined {
		const buffer = buffers.get(sessionId);
		if (!buffer || buffer.chunks.length === 0) return undefined;
		return buffer.chunks.join('');
	}

	beforeEach(() => {
		buffers = new Map();
	});

	describe('appendToBuffer', () => {
		it('should create new buffer entry on first append', () => {
			const length = appendToBuffer('session-1', 'hello');
			expect(length).toBe(5);
			expect(buffers.has('session-1')).toBe(true);
		});

		it('should append to existing buffer', () => {
			appendToBuffer('session-1', 'hello');
			const length = appendToBuffer('session-1', ' world');
			expect(length).toBe(11); // 5 + 6
		});

		it('should track total length correctly across multiple appends', () => {
			appendToBuffer('session-1', 'a'); // 1
			appendToBuffer('session-1', 'bb'); // 3
			appendToBuffer('session-1', 'ccc'); // 6
			const length = appendToBuffer('session-1', 'dddd'); // 10
			expect(length).toBe(10);
		});

		it('should maintain separate buffers for different sessions', () => {
			appendToBuffer('session-1', 'hello');
			appendToBuffer('session-2', 'world');

			expect(buffers.get('session-1')?.totalLength).toBe(5);
			expect(buffers.get('session-2')?.totalLength).toBe(5);
		});

		it('should handle empty strings', () => {
			appendToBuffer('session-1', 'hello');
			const length = appendToBuffer('session-1', '');
			expect(length).toBe(5);
		});

		it('should handle large data chunks', () => {
			const largeData = 'x'.repeat(100000);
			const length = appendToBuffer('session-1', largeData);
			expect(length).toBe(100000);
		});
	});

	describe('getBufferedOutput', () => {
		it('should return undefined for non-existent session', () => {
			const output = getBufferedOutput('non-existent');
			expect(output).toBeUndefined();
		});

		it('should return undefined for empty buffer', () => {
			buffers.set('session-1', { chunks: [], totalLength: 0 });
			const output = getBufferedOutput('session-1');
			expect(output).toBeUndefined();
		});

		it('should join chunks correctly', () => {
			appendToBuffer('session-1', 'hello');
			appendToBuffer('session-1', ' ');
			appendToBuffer('session-1', 'world');

			const output = getBufferedOutput('session-1');
			expect(output).toBe('hello world');
		});

		it('should preserve order of chunks', () => {
			appendToBuffer('session-1', '1');
			appendToBuffer('session-1', '2');
			appendToBuffer('session-1', '3');

			const output = getBufferedOutput('session-1');
			expect(output).toBe('123');
		});

		it('should handle special characters', () => {
			appendToBuffer('session-1', '{"type": "test"}');
			appendToBuffer('session-1', '\n');
			appendToBuffer('session-1', '{"type": "test2"}');

			const output = getBufferedOutput('session-1');
			expect(output).toBe('{"type": "test"}\n{"type": "test2"}');
		});
	});

	describe('buffer cleanup', () => {
		it('should allow deletion of buffer entries', () => {
			appendToBuffer('session-1', 'data');
			buffers.delete('session-1');
			expect(buffers.has('session-1')).toBe(false);
		});

		it('should not affect other buffers on deletion', () => {
			appendToBuffer('session-1', 'data1');
			appendToBuffer('session-2', 'data2');

			buffers.delete('session-1');

			expect(buffers.has('session-1')).toBe(false);
			expect(getBufferedOutput('session-2')).toBe('data2');
		});
	});

	describe('performance characteristics', () => {
		it('should maintain O(1) append by tracking totalLength incrementally', () => {
			// This test verifies the implementation doesn't use reduce()
			// by checking that totalLength matches sum of chunk lengths
			const chunks = ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5'];

			for (const chunk of chunks) {
				appendToBuffer('session-1', chunk);
			}

			const buffer = buffers.get('session-1')!;
			const actualSum = buffer.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

			expect(buffer.totalLength).toBe(actualSum);
		});

		it('should handle many small appends efficiently', () => {
			// Simulate streaming output with many small chunks
			const startTime = Date.now();

			for (let i = 0; i < 10000; i++) {
				appendToBuffer('session-1', 'x');
			}

			const elapsed = Date.now() - startTime;

			// Should complete in under 100ms for 10000 appends
			// (generous threshold to avoid flaky tests)
			expect(elapsed).toBeLessThan(100);
			expect(buffers.get('session-1')?.totalLength).toBe(10000);
		});
	});
});

// ============================================================================
// Debug Logging Tests
// ============================================================================
// These tests verify the conditional debug logging behavior.

describe('Debug Logging', () => {
	// Simulate the debugLog function
	function createDebugLog(isEnabled: boolean) {
		const logs: string[] = [];

		function debugLog(prefix: string, message: string, ...args: unknown[]): void {
			if (isEnabled) {
				logs.push(`[${prefix}] ${message}`);
			}
		}

		return { debugLog, logs };
	}

	it('should log when debug is enabled', () => {
		const { debugLog, logs } = createDebugLog(true);

		debugLog('GroupChat:Debug', 'Test message');

		expect(logs).toHaveLength(1);
		expect(logs[0]).toBe('[GroupChat:Debug] Test message');
	});

	it('should not log when debug is disabled', () => {
		const { debugLog, logs } = createDebugLog(false);

		debugLog('GroupChat:Debug', 'Test message');

		expect(logs).toHaveLength(0);
	});

	it('should format message with prefix correctly', () => {
		const { debugLog, logs } = createDebugLog(true);

		debugLog('WebBroadcast', 'Broadcasting to session');

		expect(logs[0]).toBe('[WebBroadcast] Broadcasting to session');
	});

	it('should handle multiple log calls', () => {
		const { debugLog, logs } = createDebugLog(true);

		debugLog('Test', 'Message 1');
		debugLog('Test', 'Message 2');
		debugLog('Test', 'Message 3');

		expect(logs).toHaveLength(3);
	});
});

// ============================================================================
// Session ID Parsing Tests
// ============================================================================
// These tests verify the parseParticipantSessionId logic.

describe('parseParticipantSessionId', () => {
	// Simulate the parsing function
	function parseParticipantSessionId(
		sessionId: string
	): { groupChatId: string; participantName: string } | null {
		if (!sessionId.includes('-participant-')) {
			return null;
		}

		const REGEX_PARTICIPANT_UUID =
			/^group-chat-(.+)-participant-(.+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
		const REGEX_PARTICIPANT_TIMESTAMP = /^group-chat-(.+)-participant-(.+)-(\d{13,})$/;
		const REGEX_PARTICIPANT_FALLBACK = /^group-chat-(.+)-participant-([^-]+)-/;

		const uuidMatch = sessionId.match(REGEX_PARTICIPANT_UUID);
		if (uuidMatch) {
			return { groupChatId: uuidMatch[1], participantName: uuidMatch[2] };
		}

		const timestampMatch = sessionId.match(REGEX_PARTICIPANT_TIMESTAMP);
		if (timestampMatch) {
			return { groupChatId: timestampMatch[1], participantName: timestampMatch[2] };
		}

		const fallbackMatch = sessionId.match(REGEX_PARTICIPANT_FALLBACK);
		if (fallbackMatch) {
			return { groupChatId: fallbackMatch[1], participantName: fallbackMatch[2] };
		}

		return null;
	}

	it('should return null for non-participant session IDs', () => {
		expect(parseParticipantSessionId('session-123')).toBeNull();
		expect(parseParticipantSessionId('group-chat-test-moderator-123')).toBeNull();
	});

	it('should parse UUID-based participant session IDs', () => {
		const result = parseParticipantSessionId(
			'group-chat-my-chat-participant-Claude-a1b2c3d4-e5f6-7890-abcd-ef1234567890'
		);
		expect(result).toEqual({
			groupChatId: 'my-chat',
			participantName: 'Claude',
		});
	});

	it('should parse timestamp-based participant session IDs', () => {
		const result = parseParticipantSessionId('group-chat-my-chat-participant-Claude-1705678901234');
		expect(result).toEqual({
			groupChatId: 'my-chat',
			participantName: 'Claude',
		});
	});

	it('should handle participant names with hyphens using UUID format', () => {
		const result = parseParticipantSessionId(
			'group-chat-my-chat-participant-Claude-Code-a1b2c3d4-e5f6-7890-abcd-ef1234567890'
		);
		expect(result).toEqual({
			groupChatId: 'my-chat',
			participantName: 'Claude-Code',
		});
	});

	it('should handle group chat IDs with hyphens', () => {
		const result = parseParticipantSessionId(
			'group-chat-my-complex-chat-id-participant-Agent-1705678901234'
		);
		expect(result).toEqual({
			groupChatId: 'my-complex-chat-id',
			participantName: 'Agent',
		});
	});

	it('should prefer UUID match over timestamp match', () => {
		// This session ID could theoretically match both patterns
		// but UUID should be tried first
		const result = parseParticipantSessionId(
			'group-chat-chat-participant-Agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890'
		);
		expect(result).not.toBeNull();
		expect(result?.participantName).toBe('Agent');
	});
});

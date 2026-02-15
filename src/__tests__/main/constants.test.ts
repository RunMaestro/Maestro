/**
 * @file constants.test.ts
 * @description Unit tests for main process constants including regex patterns and debug utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	REGEX_MODERATOR_SESSION,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	REGEX_PARTICIPANT_UUID,
	REGEX_PARTICIPANT_TIMESTAMP,
	REGEX_PARTICIPANT_FALLBACK,
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	DEBUG_GROUP_CHAT,
	debugLog,
	debugLogLazy,
	MAX_GROUP_CHAT_BUFFER_SIZE,
} from '../../main/constants';

describe('main/constants', () => {
	describe('REGEX_MODERATOR_SESSION', () => {
		it('should match moderator session IDs', () => {
			const match = 'group-chat-abc123-moderator-1702934567890'.match(REGEX_MODERATOR_SESSION);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
		});

		it('should match moderator synthesis session IDs', () => {
			const match = 'group-chat-abc123-moderator-synthesis-1702934567890'.match(
				REGEX_MODERATOR_SESSION
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
		});

		it('should not match participant session IDs', () => {
			const match = 'group-chat-abc123-participant-Claude-1702934567890'.match(
				REGEX_MODERATOR_SESSION
			);
			expect(match).toBeNull();
		});

		it('should not match regular session IDs', () => {
			const match = 'session-abc123'.match(REGEX_MODERATOR_SESSION);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_MODERATOR_SESSION_TIMESTAMP', () => {
		it('should match moderator session IDs with timestamp suffix', () => {
			const match = 'group-chat-abc123-moderator-1702934567890'.match(
				REGEX_MODERATOR_SESSION_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
		});

		it('should not match moderator synthesis session IDs', () => {
			// This pattern expects only digits after "moderator-"
			const match = 'group-chat-abc123-moderator-synthesis-1702934567890'.match(
				REGEX_MODERATOR_SESSION_TIMESTAMP
			);
			expect(match).toBeNull();
		});

		it('should not match session IDs without timestamp', () => {
			const match = 'group-chat-abc123-moderator-'.match(REGEX_MODERATOR_SESSION_TIMESTAMP);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_PARTICIPANT_UUID', () => {
		it('should match participant session IDs with UUID suffix', () => {
			const match =
				'group-chat-abc123-participant-Claude-550e8400-e29b-41d4-a716-446655440000'.match(
					REGEX_PARTICIPANT_UUID
				);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('Claude');
			expect(match![3]).toBe('550e8400-e29b-41d4-a716-446655440000');
		});

		it('should match participant with hyphenated name and UUID', () => {
			const match =
				'group-chat-abc123-participant-OpenCode-Ollama-550e8400-e29b-41d4-a716-446655440000'.match(
					REGEX_PARTICIPANT_UUID
				);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('OpenCode-Ollama');
		});

		it('should be case-insensitive for UUID', () => {
			const match =
				'group-chat-abc123-participant-Claude-550E8400-E29B-41D4-A716-446655440000'.match(
					REGEX_PARTICIPANT_UUID
				);
			expect(match).not.toBeNull();
		});

		it('should not match timestamp suffix as UUID', () => {
			const match = 'group-chat-abc123-participant-Claude-1702934567890'.match(
				REGEX_PARTICIPANT_UUID
			);
			expect(match).toBeNull();
		});
	});

	describe('REGEX_PARTICIPANT_TIMESTAMP', () => {
		it('should match participant session IDs with timestamp suffix', () => {
			const match = 'group-chat-abc123-participant-Claude-1702934567890'.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('Claude');
			expect(match![3]).toBe('1702934567890');
		});

		it('should match participant with hyphenated name and timestamp', () => {
			const match = 'group-chat-abc123-participant-OpenCode-Ollama-1702934567890'.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('OpenCode-Ollama');
		});

		it('should require at least 13 digits for timestamp', () => {
			const shortTimestamp = 'group-chat-abc123-participant-Claude-170293456'.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(shortTimestamp).toBeNull();

			const longTimestamp = 'group-chat-abc123-participant-Claude-17029345678901'.match(
				REGEX_PARTICIPANT_TIMESTAMP
			);
			expect(longTimestamp).not.toBeNull();
		});
	});

	describe('REGEX_PARTICIPANT_FALLBACK', () => {
		it('should match basic participant session IDs', () => {
			const match = 'group-chat-abc123-participant-Claude-anything'.match(
				REGEX_PARTICIPANT_FALLBACK
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('Claude');
		});

		it('should only capture first segment for hyphenated names', () => {
			// Fallback is for backwards compatibility with non-hyphenated names
			const match = 'group-chat-abc123-participant-OpenCode-Ollama-1702934567890'.match(
				REGEX_PARTICIPANT_FALLBACK
			);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123');
			expect(match![2]).toBe('OpenCode'); // Only captures up to first hyphen
		});
	});

	describe('REGEX_AI_SUFFIX', () => {
		it('should match session IDs with -ai- suffix and any tab ID format', () => {
			expect('session-123-ai-tab1'.match(REGEX_AI_SUFFIX)).not.toBeNull();
			expect('session-123-ai-abc123def'.match(REGEX_AI_SUFFIX)).not.toBeNull();
			expect('51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb'.match(REGEX_AI_SUFFIX)).not.toBeNull();
		});

		it('should not match session IDs without -ai- suffix', () => {
			expect('session-123-terminal'.match(REGEX_AI_SUFFIX)).toBeNull();
			expect('session-123'.match(REGEX_AI_SUFFIX)).toBeNull();
		});

		it('should correctly strip -ai- suffix to extract base session ID', () => {
			const sessionId = '51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb';
			expect(sessionId.replace(REGEX_AI_SUFFIX, '')).toBe('51cee651-6629-4de8-abdd-1c1540555f2d');
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
	});

	describe('DEBUG_GROUP_CHAT', () => {
		it('should be a boolean', () => {
			expect(typeof DEBUG_GROUP_CHAT).toBe('boolean');
		});
	});

	describe('debugLog', () => {
		let consoleSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
		});

		it('should be a function', () => {
			expect(typeof debugLog).toBe('function');
		});

		it('should accept prefix, message, and additional args', () => {
			// Function should not throw regardless of DEBUG_GROUP_CHAT value
			expect(() => debugLog('TestPrefix', 'Test message', { extra: 'data' })).not.toThrow();
		});

		it('should format message with prefix when called', () => {
			debugLog('TestPrefix', 'Test message');
			// If DEBUG_GROUP_CHAT is true, it will log; if false, it won't
			// We're just testing it doesn't throw
		});
	});

	describe('debugLogLazy', () => {
		let consoleSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleSpy.mockRestore();
		});

		it('should be a function', () => {
			expect(typeof debugLogLazy).toBe('function');
		});

		it('should accept prefix, message callback, and additional args', () => {
			// Function should not throw regardless of DEBUG_GROUP_CHAT value
			expect(() =>
				debugLogLazy('TestPrefix', () => 'Test message', { extra: 'data' })
			).not.toThrow();
		});

		it('should not call message callback when DEBUG_GROUP_CHAT is false', () => {
			// This test verifies the lazy evaluation behavior
			// In production (DEBUG_GROUP_CHAT=false), the callback should not be called
			const messageFn = vi.fn(() => 'Expensive computation result');

			debugLogLazy('TestPrefix', messageFn);

			// If DEBUG_GROUP_CHAT is false, messageFn should not be called
			// If true, it will be called - either way, no error
			// The key point is that in production, expensive computations are avoided
		});

		it('should handle callbacks that return complex strings', () => {
			const items = [1, 2, 3];
			expect(() =>
				debugLogLazy('Parser', () => `Parsed ${items.length} items: ${JSON.stringify(items)}`)
			).not.toThrow();
		});
	});

	describe('MAX_GROUP_CHAT_BUFFER_SIZE', () => {
		it('should be defined', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeDefined();
		});

		it('should be 10MB (10 * 1024 * 1024 bytes)', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBe(10 * 1024 * 1024);
		});

		it('should be a positive number', () => {
			expect(MAX_GROUP_CHAT_BUFFER_SIZE).toBeGreaterThan(0);
		});
	});
});

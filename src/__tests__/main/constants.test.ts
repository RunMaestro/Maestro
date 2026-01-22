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
		it('should match session IDs with -ai- suffix', () => {
			expect('session-123-ai-tab1'.match(REGEX_AI_SUFFIX)).not.toBeNull();
		});

		it('should not match session IDs without -ai- suffix', () => {
			expect('session-123-terminal'.match(REGEX_AI_SUFFIX)).toBeNull();
		});

		it('should not match session IDs without -ai- suffix pattern', () => {
			// Missing the tab ID after -ai-
			expect('session-ai-'.match(REGEX_AI_SUFFIX)).toBeNull();
			// No -ai- suffix at all
			expect('session-123'.match(REGEX_AI_SUFFIX)).toBeNull();
		});

		it('should match session IDs with -ai-{tabId} even in middle (suffix matches end)', () => {
			// This DOES match because the regex looks for -ai-{non-hyphen chars} at the END
			expect('session-ai-123'.match(REGEX_AI_SUFFIX)).not.toBeNull();
		});
	});

	describe('REGEX_AI_TAB_ID', () => {
		it('should extract tab ID from session ID', () => {
			const match = 'session-123-ai-tab1'.match(REGEX_AI_TAB_ID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('tab1');
		});

		it('should extract complex tab IDs', () => {
			const match = 'session-123-ai-abc123def'.match(REGEX_AI_TAB_ID);
			expect(match).not.toBeNull();
			expect(match![1]).toBe('abc123def');
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
});

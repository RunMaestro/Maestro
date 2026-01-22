/**
 * @file session-parser.test.ts
 * @description Unit tests for group chat session ID parsing utilities.
 */

import { describe, it, expect } from 'vitest';
import { parseParticipantSessionId } from '../../../main/group-chat/session-parser';

describe('group-chat/session-parser', () => {
	describe('parseParticipantSessionId', () => {
		describe('non-participant session IDs', () => {
			it('should return null for regular session IDs', () => {
				expect(parseParticipantSessionId('session-abc123')).toBeNull();
			});

			it('should return null for moderator session IDs', () => {
				expect(parseParticipantSessionId('group-chat-abc123-moderator-1702934567890')).toBeNull();
			});

			it('should return null for empty string', () => {
				expect(parseParticipantSessionId('')).toBeNull();
			});

			it('should return null for session ID containing "participant" but not in correct format', () => {
				expect(parseParticipantSessionId('participant-abc123')).toBeNull();
			});
		});

		describe('participant session IDs with UUID suffix', () => {
			it('should parse participant session ID with UUID suffix', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-550e8400-e29b-41d4-a716-446655440000'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle hyphenated participant names with UUID suffix', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-OpenCode-Ollama-550e8400-e29b-41d4-a716-446655440000'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('OpenCode-Ollama');
			});

			it('should handle uppercase UUID', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-550E8400-E29B-41D4-A716-446655440000'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle complex group chat IDs with UUID suffix', () => {
				const result = parseParticipantSessionId(
					'group-chat-my-complex-chat-id-participant-Agent-550e8400-e29b-41d4-a716-446655440000'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('my-complex-chat-id');
				expect(result!.participantName).toBe('Agent');
			});
		});

		describe('participant session IDs with timestamp suffix', () => {
			it('should parse participant session ID with timestamp suffix', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-1702934567890'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle hyphenated participant names with timestamp suffix', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-OpenCode-Ollama-1702934567890'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('OpenCode-Ollama');
			});

			it('should handle long timestamps (14+ digits)', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-17029345678901234'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle complex group chat IDs with timestamp', () => {
				const result = parseParticipantSessionId(
					'group-chat-my-complex-chat-id-participant-Agent-1702934567890'
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('my-complex-chat-id');
				expect(result!.participantName).toBe('Agent');
			});
		});

		describe('fallback pattern for backwards compatibility', () => {
			it('should handle simple participant names without UUID or long timestamp', () => {
				// Fallback pattern for older format
				const result = parseParticipantSessionId('group-chat-abc123-participant-Claude-123');
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('abc123');
				expect(result!.participantName).toBe('Claude');
			});
		});

		describe('edge cases', () => {
			it('should handle participant name with numbers', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-Agent2-1702934567890'
				);
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('Agent2');
			});

			it('should handle single character participant name', () => {
				const result = parseParticipantSessionId('group-chat-abc123-participant-A-1702934567890');
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('A');
			});

			it('should handle single character group chat ID', () => {
				const result = parseParticipantSessionId('group-chat-x-participant-Claude-1702934567890');
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe('x');
			});

			it('should handle participant name with underscores', () => {
				const result = parseParticipantSessionId(
					'group-chat-abc123-participant-My_Agent-1702934567890'
				);
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('My_Agent');
			});
		});

		describe('priority of matching patterns', () => {
			it('should prefer UUID match over timestamp match', () => {
				// This tests that UUID pattern is tried first
				const uuidResult = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-550e8400-e29b-41d4-a716-446655440000'
				);
				expect(uuidResult).not.toBeNull();
				expect(uuidResult!.participantName).toBe('Claude');
			});

			it('should use timestamp match when UUID pattern does not match', () => {
				const timestampResult = parseParticipantSessionId(
					'group-chat-abc123-participant-Claude-1702934567890'
				);
				expect(timestampResult).not.toBeNull();
				expect(timestampResult!.participantName).toBe('Claude');
			});
		});
	});
});

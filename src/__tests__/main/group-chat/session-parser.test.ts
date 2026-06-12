/**
 * @file session-parser.test.ts
 * @description Unit tests for group chat session ID parsing utilities.
 *
 * groupChatId is ALWAYS a uuidv4() in production (see group-chat-storage.ts:
 * createGroupChat). The regex patterns in main/constants.ts anchor on the UUID
 * format to eliminate greedy-backtrack ambiguity when participant names contain
 * sentinel substrings like "-participant-" or "-recovery-". These tests use
 * real UUIDs and exercise the adversarial cases that previously mis-parsed.
 */

import { describe, it, expect } from 'vitest';
import { parseParticipantSessionId } from '../../../main/group-chat/session-parser';

// Real UUIDs for test fixtures. The regex in constants.ts accepts the
// canonical 8-4-4-4-12 hex shape regardless of UUID version, so a v1
// (GC_ID_2 is the RFC 4122 namespace UUID) and a v4 (GC_ID) both work
// equivalently and exercise the same code paths. Production groupChatIds
// are uuidv4() but the regex itself is version-agnostic.
const GC_ID = '550e8400-e29b-41d4-a716-446655440000';
const GC_ID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('group-chat/session-parser', () => {
	describe('parseParticipantSessionId', () => {
		describe('non-participant session IDs', () => {
			it('should return null for regular session IDs', () => {
				expect(parseParticipantSessionId('session-abc123')).toBeNull();
			});

			it('should return null for moderator session IDs', () => {
				expect(parseParticipantSessionId(`group-chat-${GC_ID}-moderator-1702934567890`)).toBeNull();
			});

			it('should return null for empty string', () => {
				expect(parseParticipantSessionId('')).toBeNull();
			});

			it('should return null for session ID containing "participant" but not in correct format', () => {
				expect(parseParticipantSessionId('participant-abc123')).toBeNull();
			});

			it('should return null for session ID not starting with group-chat-', () => {
				// Strict prefix guard: even a session with "-participant-" must not
				// parse if it doesn't start with the canonical group-chat- prefix.
				expect(
					parseParticipantSessionId(`something-${GC_ID}-participant-Claude-1702934567890`)
				).toBeNull();
			});

			it('should return null for non-UUID groupChatId', () => {
				// Legacy non-UUID groupChatIds are rejected — production ALWAYS
				// uses uuidv4() for group-chat IDs, so a non-UUID shape is
				// either a bug or an adversarial input.
				expect(
					parseParticipantSessionId('group-chat-abc123-participant-Claude-1702934567890')
				).toBeNull();
			});
		});

		describe('participant session IDs with UUID suffix', () => {
			it('should parse participant session ID with UUID suffix', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-${GC_ID_2}`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle hyphenated participant names with UUID suffix', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-OpenCode-Ollama-${GC_ID_2}`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('OpenCode-Ollama');
			});

			it('should handle uppercase UUID', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-${GC_ID_2.toUpperCase()}`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude');
			});

			it('does NOT strip -recovery in the UUID branch (recovery is timestamp-only in production)', () => {
				// Production never combines a UUID suffix with -recovery (see
				// group-chat-router.respawnParticipantWithRecovery, which uses
				// Date.now()). The UUID branch must therefore take the participant
				// name verbatim — stripping -recovery here would silently truncate
				// a legitimate name that happens to end with "-recovery".
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-recovery-${GC_ID_2}`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude-recovery');
			});
		});

		describe('participant session IDs with timestamp suffix', () => {
			it('should parse participant session ID with timestamp suffix', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude');
			});

			it('should handle hyphenated participant names with timestamp suffix', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-OpenCode-Ollama-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('OpenCode-Ollama');
			});

			it('should handle long timestamps (14+ digits)', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-17029345678901234`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude');
			});

			it('should strip -recovery suffix from timestamp-suffixed IDs', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-recovery-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Claude');
			});
		});

		describe('adversarial inputs (leak prevention)', () => {
			it('should resist a participant name literally containing "-participant-"', () => {
				// Pre-fix: the greedy (.+) capture backtracked to the LAST
				// "-participant-" and mis-parsed groupChatId and participantName,
				// causing buffered output to flush against the wrong owner.
				// With UUID-anchored groupChatId, the split is unambiguous.
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-evil-participant-name-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('evil-participant-name');
			});

			it('should resist a participant name that LOOKS like a UUID', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-${GC_ID_2}-${GC_ID_2}`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				// The inner UUID is absorbed into the name; the trailing one is
				// the canonical instance suffix.
				expect(result!.participantName).toBe(GC_ID_2);
			});

			it('should resist a participant name with 13-digit numbers', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Agent-1234567890123-Suffix-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.groupChatId).toBe(GC_ID);
				expect(result!.participantName).toBe('Agent-1234567890123-Suffix');
			});
		});

		describe('edge cases', () => {
			it('should handle participant name with numbers', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Agent2-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('Agent2');
			});

			it('should handle single character participant name', () => {
				const result = parseParticipantSessionId(`group-chat-${GC_ID}-participant-A-1702934567890`);
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('A');
			});

			it('should handle participant name with underscores', () => {
				const result = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-My_Agent-1702934567890`
				);
				expect(result).not.toBeNull();
				expect(result!.participantName).toBe('My_Agent');
			});
		});

		describe('priority of matching patterns', () => {
			it('should prefer UUID match over timestamp match', () => {
				const uuidResult = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-${GC_ID_2}`
				);
				expect(uuidResult).not.toBeNull();
				expect(uuidResult!.participantName).toBe('Claude');
			});

			it('should use timestamp match when UUID pattern does not match', () => {
				const timestampResult = parseParticipantSessionId(
					`group-chat-${GC_ID}-participant-Claude-1702934567890`
				);
				expect(timestampResult).not.toBeNull();
				expect(timestampResult!.participantName).toBe('Claude');
			});
		});
	});
});

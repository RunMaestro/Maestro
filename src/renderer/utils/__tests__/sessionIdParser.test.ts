/**
 * Tests for sessionIdParser utility.
 * Validates session ID parsing with pre-compiled regex patterns.
 */

import { describe, it, expect } from 'vitest';
import {
	parseSessionId,
	parseGroupChatSessionId,
	isSynopsisSession,
	isBatchSession,
	getBaseSessionId,
	getTabId,
	REGEX_AI_TAB,
	REGEX_SYNOPSIS,
	REGEX_BATCH,
	REGEX_GROUP_CHAT_MODERATOR,
	REGEX_GROUP_CHAT_PARTICIPANT,
} from '../sessionIdParser';

describe('sessionIdParser', () => {
	describe('parseSessionId', () => {
		it('should parse AI tab session IDs', () => {
			const result = parseSessionId('session-123-ai-tab1');
			expect(result).toEqual({
				actualSessionId: 'session-123',
				tabId: 'tab1',
				baseSessionId: 'session-123',
				type: 'ai-tab',
			});
		});

		it('should parse AI tab session with complex session ID', () => {
			const result = parseSessionId('my-app-session-uuid-ai-main-tab');
			expect(result).toEqual({
				actualSessionId: 'my-app-session-uuid',
				tabId: 'main-tab',
				baseSessionId: 'my-app-session-uuid',
				type: 'ai-tab',
			});
		});

		it('should parse legacy AI session IDs', () => {
			const result = parseSessionId('session-123-ai');
			expect(result).toEqual({
				actualSessionId: 'session-123',
				tabId: null,
				baseSessionId: 'session-123',
				type: 'legacy-ai',
			});
		});

		it('should parse synopsis session IDs', () => {
			const result = parseSessionId('session-123-synopsis-1704067200000');
			expect(result).toEqual({
				actualSessionId: 'session-123-synopsis-1704067200000',
				tabId: null,
				baseSessionId: 'session-123',
				type: 'synopsis',
			});
		});

		it('should parse batch session IDs', () => {
			const result = parseSessionId('session-123-batch-1704067200000');
			expect(result).toEqual({
				actualSessionId: 'session-123-batch-1704067200000',
				tabId: null,
				baseSessionId: 'session-123',
				type: 'batch',
			});
		});

		it('should parse regular session IDs', () => {
			const result = parseSessionId('session-123');
			expect(result).toEqual({
				actualSessionId: 'session-123',
				tabId: null,
				baseSessionId: 'session-123',
				type: 'regular',
			});
		});

		it('should handle UUID-style session IDs', () => {
			const uuid = '550e8400-e29b-41d4-a716-446655440000';
			const result = parseSessionId(`${uuid}-ai-default`);
			expect(result).toEqual({
				actualSessionId: uuid,
				tabId: 'default',
				baseSessionId: uuid,
				type: 'ai-tab',
			});
		});

		it('should strip forced parallel suffix from AI tab session IDs', () => {
			const result = parseSessionId('session-123-ai-tab1-fp-1712611230000');
			expect(result).toEqual({
				actualSessionId: 'session-123',
				tabId: 'tab1',
				baseSessionId: 'session-123',
				type: 'ai-tab',
			});
		});

		it('should strip forced parallel suffix with UUID session and tab IDs', () => {
			const sessionUuid = '550e8400-e29b-41d4-a716-446655440000';
			const tabUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
			const result = parseSessionId(`${sessionUuid}-ai-${tabUuid}-fp-1712611230000`);
			expect(result).toEqual({
				actualSessionId: sessionUuid,
				tabId: tabUuid,
				baseSessionId: sessionUuid,
				type: 'ai-tab',
			});
		});
	});

	describe('parseGroupChatSessionId', () => {
		it('should parse moderator session ID', () => {
			const uuid = '533fad24-3915-4fc6-9edb-ba2292a5b903';
			const result = parseGroupChatSessionId(`group-chat-${uuid}-moderator-1704067200000`);
			expect(result).toEqual({
				isGroupChat: true,
				groupChatId: uuid,
				isModerator: true,
				timestamp: '1704067200000',
			});
		});

		it('should parse participant session ID', () => {
			const uuid = '533fad24-3915-4fc6-9edb-ba2292a5b903';
			const result = parseGroupChatSessionId(`group-chat-${uuid}-Agent1-1704067200000`);
			expect(result).toEqual({
				isGroupChat: true,
				groupChatId: uuid,
				isModerator: false,
				participantName: 'Agent1',
				timestamp: '1704067200000',
			});
		});

		it('should return isGroupChat: false for non-group chat sessions', () => {
			const result = parseGroupChatSessionId('session-123-ai-tab1');
			expect(result).toEqual({ isGroupChat: false });
		});

		it('should return isGroupChat: false for regular sessions', () => {
			const result = parseGroupChatSessionId('session-123');
			expect(result).toEqual({ isGroupChat: false });
		});
	});

	describe('helper functions', () => {
		describe('isSynopsisSession', () => {
			it('should return true for synopsis sessions', () => {
				expect(isSynopsisSession('session-123-synopsis-1234567890')).toBe(true);
			});

			it('should return false for non-synopsis sessions', () => {
				expect(isSynopsisSession('session-123-ai-tab1')).toBe(false);
				expect(isSynopsisSession('session-123')).toBe(false);
				expect(isSynopsisSession('session-123-batch-1234567890')).toBe(false);
			});
		});

		describe('isBatchSession', () => {
			it('should return true for batch sessions', () => {
				expect(isBatchSession('session-123-batch-1234567890')).toBe(true);
			});

			it('should return false for non-batch sessions', () => {
				expect(isBatchSession('session-123-ai-tab1')).toBe(false);
				expect(isBatchSession('session-123')).toBe(false);
				expect(isBatchSession('session-123-synopsis-1234567890')).toBe(false);
			});

			it('should not match false positives with batch in UUID', () => {
				// Session ID with "batch" in the UUID should NOT match
				expect(isBatchSession('session-batch-uuid-ai-tab1')).toBe(false);
			});
		});

		describe('getBaseSessionId', () => {
			it('should extract base session ID from any format', () => {
				expect(getBaseSessionId('session-123-ai-tab1')).toBe('session-123');
				expect(getBaseSessionId('session-123-ai')).toBe('session-123');
				expect(getBaseSessionId('session-123-synopsis-1234567890')).toBe('session-123');
				expect(getBaseSessionId('session-123-batch-1234567890')).toBe('session-123');
				expect(getBaseSessionId('session-123')).toBe('session-123');
			});
		});

		describe('getTabId', () => {
			it('should extract tab ID from AI tab sessions', () => {
				expect(getTabId('session-123-ai-tab1')).toBe('tab1');
				expect(getTabId('session-123-ai-main-tab')).toBe('main-tab');
			});

			it('should return null for non-AI-tab sessions', () => {
				expect(getTabId('session-123-ai')).toBe(null);
				expect(getTabId('session-123')).toBe(null);
				expect(getTabId('session-123-synopsis-1234567890')).toBe(null);
			});

			it('should strip forced parallel suffix from tab ID', () => {
				expect(getTabId('session-123-ai-tab1-fp-1712611230000')).toBe('tab1');
			});
		});
	});

	describe('regex patterns', () => {
		it('REGEX_AI_TAB should match AI tab format', () => {
			expect('session-ai-tab'.match(REGEX_AI_TAB)).toBeTruthy();
			expect('session-123-ai-tab1'.match(REGEX_AI_TAB)).toBeTruthy();
			expect('session-ai'.match(REGEX_AI_TAB)).toBeFalsy();
		});

		it('REGEX_AI_TAB should strip forced parallel suffix and extract correct tab ID', () => {
			const match = 'session-123-ai-tab1-fp-1712611230000'.match(REGEX_AI_TAB);
			expect(match).toBeTruthy();
			expect(match![1]).toBe('session-123');
			expect(match![2]).toBe('tab1');
		});

		it('REGEX_AI_TAB should handle hyphenated tab IDs without forced parallel suffix', () => {
			const match = 'session-123-ai-main-tab'.match(REGEX_AI_TAB);
			expect(match).toBeTruthy();
			expect(match![1]).toBe('session-123');
			expect(match![2]).toBe('main-tab');
		});

		it('REGEX_SYNOPSIS should match synopsis format', () => {
			expect('session-synopsis-123'.match(REGEX_SYNOPSIS)).toBeTruthy();
			expect('session-123-synopsis-1234567890'.match(REGEX_SYNOPSIS)).toBeTruthy();
			expect('session-synopsis'.match(REGEX_SYNOPSIS)).toBeFalsy();
		});

		it('REGEX_BATCH should match batch format', () => {
			expect('session-batch-123'.match(REGEX_BATCH)).toBeTruthy();
			expect('session-123-batch-1234567890'.match(REGEX_BATCH)).toBeTruthy();
			expect('session-batch'.match(REGEX_BATCH)).toBeFalsy();
		});

		it('REGEX_GROUP_CHAT_MODERATOR should match moderator format', () => {
			const uuid = '533fad24-3915-4fc6-9edb-ba2292a5b903';
			expect(`group-chat-${uuid}-moderator-123`.match(REGEX_GROUP_CHAT_MODERATOR)).toBeTruthy();
			expect('group-chat-invalid-moderator-123'.match(REGEX_GROUP_CHAT_MODERATOR)).toBeFalsy();
		});

		it('REGEX_GROUP_CHAT_PARTICIPANT should match participant format', () => {
			const uuid = '533fad24-3915-4fc6-9edb-ba2292a5b903';
			expect(`group-chat-${uuid}-Agent1-123`.match(REGEX_GROUP_CHAT_PARTICIPANT)).toBeTruthy();
			expect('group-chat-invalid-Agent1-123'.match(REGEX_GROUP_CHAT_PARTICIPANT)).toBeFalsy();
		});
	});
});

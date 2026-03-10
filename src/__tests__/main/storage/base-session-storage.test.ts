/**
 * Tests for BaseSessionStorage — shared pagination, search, and utility methods.
 *
 * Uses a concrete TestSessionStorage subclass to test the abstract base class.
 */

import { describe, it, expect, vi } from 'vitest';
import { BaseSessionStorage, SearchableMessage } from '../../../main/storage/base-session-storage';
import type { ToolType, SshRemoteConfig } from '../../../shared/types';
import type {
	AgentSessionInfo,
	SessionReadOptions,
	SessionMessagesResult,
	SessionMessage,
} from '../../../main/agents';

// ============================================================
// Concrete subclass for testing
// ============================================================

class TestSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'claude-code';

	/** Inject sessions for listSessions */
	sessions: AgentSessionInfo[] = [];

	/** Inject searchable messages per session */
	searchableMessages: Map<string, SearchableMessage[]> = new Map();

	/** Session IDs that should throw when loading messages */
	failingSessions: Set<string> = new Set();

	async listSessions(
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		return this.sessions;
	}

	async readSessionMessages(
		_projectPath: string,
		_sessionId: string,
		_options?: SessionReadOptions,
		_sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		return { messages: [], total: 0, hasMore: false };
	}

	getSessionPath(
		_projectPath: string,
		_sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: true };
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		if (this.failingSessions.has(sessionId)) {
			throw new Error(`Failed to load messages for ${sessionId}`);
		}
		return this.searchableMessages.get(sessionId) || [];
	}
}

// ============================================================
// Helpers
// ============================================================

function makeSession(id: string, modifiedAt?: string): AgentSessionInfo {
	return {
		sessionId: id,
		projectPath: '/test',
		timestamp: '2025-01-01T00:00:00Z',
		modifiedAt: modifiedAt || '2025-01-01T00:00:00Z',
		firstMessage: `Session ${id}`,
		messageCount: 5,
		sizeBytes: 1024,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 60,
	};
}

function makeMessage(role: 'user' | 'assistant', content: string, index: number): SessionMessage {
	return {
		type: role,
		role,
		content,
		timestamp: '2025-01-01T00:00:00Z',
		uuid: `msg-${index}`,
	};
}

// ============================================================
// Tests
// ============================================================

describe('BaseSessionStorage', () => {
	// ---- paginateSessions (static) ----

	describe('paginateSessions', () => {
		const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s-${i}`));

		it('returns first page with default limit', () => {
			const result = BaseSessionStorage.paginateSessions(sessions);
			expect(result.sessions).toHaveLength(10);
			expect(result.hasMore).toBe(false);
			expect(result.totalCount).toBe(10);
			expect(result.nextCursor).toBeNull();
		});

		it('limits results to specified limit', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, { limit: 3 });
			expect(result.sessions).toHaveLength(3);
			expect(result.hasMore).toBe(true);
			expect(result.totalCount).toBe(10);
			expect(result.nextCursor).toBe('s-2');
		});

		it('uses cursor to start after specified session', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 's-4',
				limit: 3,
			});
			expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-5', 's-6', 's-7']);
			expect(result.hasMore).toBe(true);
		});

		it('returns empty page when cursor is last session', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 's-9',
				limit: 5,
			});
			expect(result.sessions).toHaveLength(0);
			expect(result.hasMore).toBe(false);
		});

		it('resets to start when cursor not found', () => {
			const result = BaseSessionStorage.paginateSessions(sessions, {
				cursor: 'nonexistent',
				limit: 2,
			});
			expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-0', 's-1']);
		});

		it('handles empty sessions array', () => {
			const result = BaseSessionStorage.paginateSessions([]);
			expect(result.sessions).toHaveLength(0);
			expect(result.hasMore).toBe(false);
			expect(result.totalCount).toBe(0);
			expect(result.nextCursor).toBeNull();
		});
	});

	// ---- applyMessagePagination (static) ----

	describe('applyMessagePagination', () => {
		const messages = Array.from({ length: 30 }, (_, i) =>
			makeMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i)
		);

		it('returns last 20 messages by default (most recent first)', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages);
			expect(result.messages).toHaveLength(20);
			expect(result.total).toBe(30);
			expect(result.hasMore).toBe(true);
			// Should contain messages 10-29
			expect(result.messages[0].content).toBe('Message 10');
			expect(result.messages[19].content).toBe('Message 29');
		});

		it('applies offset to load older messages', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages, {
				offset: 20,
				limit: 10,
			});
			expect(result.messages).toHaveLength(10);
			expect(result.messages[0].content).toBe('Message 0');
			expect(result.hasMore).toBe(false);
		});

		it('handles offset beyond total', () => {
			const result = BaseSessionStorage.applyMessagePagination(messages, {
				offset: 50,
				limit: 10,
			});
			// When offset >= total, returns empty items but preserves total
			expect(result.messages).toHaveLength(0);
			expect(result.total).toBe(30);
			expect(result.hasMore).toBe(false);
		});

		it('handles empty messages', () => {
			const result = BaseSessionStorage.applyMessagePagination([]);
			expect(result.messages).toHaveLength(0);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('clamps to available messages when limit exceeds total', () => {
			const small = messages.slice(0, 5);
			const result = BaseSessionStorage.applyMessagePagination(small, { limit: 100 });
			expect(result.messages).toHaveLength(5);
			expect(result.hasMore).toBe(false);
		});
	});

	// ---- extractMatchPreview (static) ----

	describe('extractMatchPreview', () => {
		it('extracts context around match', () => {
			const text = 'A'.repeat(100) + 'TARGET' + 'B'.repeat(100);
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10);
			// Should include ... prefix, 10 chars before, TARGET, 10 chars after, ... suffix
			expect(preview).toContain('TARGET');
			expect(preview.startsWith('...')).toBe(true);
			expect(preview.endsWith('...')).toBe(true);
		});

		it('omits leading ellipsis when match is at start', () => {
			const text = 'TARGET' + 'B'.repeat(100);
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10);
			expect(preview.startsWith('TARGET')).toBe(true);
			expect(preview.endsWith('...')).toBe(true);
		});

		it('omits trailing ellipsis when match is at end', () => {
			const text = 'A'.repeat(100) + 'TARGET';
			const lower = text.toLowerCase();
			const preview = BaseSessionStorage.extractMatchPreview(text, lower, 'target', 6, 10);
			expect(preview.startsWith('...')).toBe(true);
			expect(preview.endsWith('TARGET')).toBe(true);
		});

		it('returns empty string when no match', () => {
			const preview = BaseSessionStorage.extractMatchPreview(
				'hello world',
				'hello world',
				'missing',
				7
			);
			expect(preview).toBe('');
		});

		it('handles short text with no ellipsis needed', () => {
			const text = 'find me';
			const preview = BaseSessionStorage.extractMatchPreview(text, text, 'find', 4, 60);
			expect(preview).toBe('find me');
		});
	});

	// ---- resolveSearchMode (static) ----

	describe('resolveSearchMode', () => {
		it('returns title match for title mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('title', 'ses-1', true, 3, 2, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'title',
				matchPreview: 'preview',
				matchCount: 1,
			});
		});

		it('returns null when title mode has no title match', () => {
			const result = BaseSessionStorage.resolveSearchMode('title', 'ses-1', false, 0, 5, '');
			expect(result).toBeNull();
		});

		it('returns user match for user mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('user', 'ses-1', false, 3, 0, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'user',
				matchPreview: 'preview',
				matchCount: 3,
			});
		});

		it('returns assistant match for assistant mode', () => {
			const result = BaseSessionStorage.resolveSearchMode(
				'assistant',
				'ses-1',
				false,
				0,
				5,
				'preview'
			);
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'assistant',
				matchPreview: 'preview',
				matchCount: 5,
			});
		});

		it('returns combined match for all mode', () => {
			const result = BaseSessionStorage.resolveSearchMode('all', 'ses-1', true, 3, 2, 'preview');
			expect(result).toEqual({
				sessionId: 'ses-1',
				matchType: 'title',
				matchPreview: 'preview',
				matchCount: 5,
			});
		});

		it('returns null for all mode with no matches', () => {
			const result = BaseSessionStorage.resolveSearchMode('all', 'ses-1', false, 0, 0, '');
			expect(result).toBeNull();
		});

		it('prefers title > user > assistant for matchType in all mode', () => {
			// Only user matches
			const r1 = BaseSessionStorage.resolveSearchMode('all', 's', false, 2, 0, '');
			expect(r1?.matchType).toBe('user');

			// Only assistant matches
			const r2 = BaseSessionStorage.resolveSearchMode('all', 's', false, 0, 3, '');
			expect(r2?.matchType).toBe('assistant');
		});
	});

	// ---- listSessionsPaginated (instance) ----

	describe('listSessionsPaginated', () => {
		it('delegates to listSessions and paginates', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = Array.from({ length: 5 }, (_, i) => makeSession(`s-${i}`));

			const result = await storage.listSessionsPaginated('/test', { limit: 2 });
			expect(result.sessions).toHaveLength(2);
			expect(result.hasMore).toBe(true);
			expect(result.totalCount).toBe(5);
		});
	});

	// ---- searchSessions (instance) ----

	describe('searchSessions', () => {
		it('returns empty for empty query', async () => {
			const storage = new TestSessionStorage();
			const results = await storage.searchSessions('/test', '  ', 'all');
			expect(results).toEqual([]);
		});

		it('finds matches in user messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'Fix the authentication bug' },
				{ role: 'assistant', textContent: 'I will fix it' },
			]);

			const results = await storage.searchSessions('/test', 'authentication', 'user');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('user');
			expect(results[0].matchCount).toBe(1);
		});

		it('finds matches in assistant messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'help me' },
				{ role: 'assistant', textContent: 'Here is the solution to your problem' },
			]);

			const results = await storage.searchSessions('/test', 'solution', 'assistant');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('assistant');
		});

		it('searches all modes correctly', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'search term here' }]);
			storage.searchableMessages.set('s-2', [{ role: 'assistant', textContent: 'no match here' }]);

			const results = await storage.searchSessions('/test', 'search term', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-1');
		});

		it('is case-insensitive', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'FiX ThE BuG' }]);

			const results = await storage.searchSessions('/test', 'fix the bug', 'user');
			expect(results).toHaveLength(1);
		});

		it('includes match preview', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'Please fix the authentication bug in login' },
			]);

			const results = await storage.searchSessions('/test', 'authentication', 'all');
			expect(results[0].matchPreview).toContain('authentication');
		});

		it('skips sessions with no matching messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);
			storage.searchableMessages.set('s-2', [{ role: 'user', textContent: 'matching query here' }]);

			const results = await storage.searchSessions('/test', 'matching query', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-2');
		});

		it('counts multiple matches in a session', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'fix this bug' },
				{ role: 'assistant', textContent: 'fixed the bug' },
				{ role: 'user', textContent: 'another bug found' },
			]);

			const results = await storage.searchSessions('/test', 'bug', 'all');
			expect(results).toHaveLength(1);
			expect(results[0].matchCount).toBe(3); // 2 user + 1 assistant
		});

		it('matches title from session firstMessage metadata', async () => {
			const storage = new TestSessionStorage();
			// makeSession creates firstMessage: 'Session s-1'
			storage.sessions = [makeSession('s-1')];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);

			const results = await storage.searchSessions('/test', 'Session s-1', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('title');
			expect(results[0].matchPreview).toContain('Session s-1');
		});

		it('matches title from sessionName when present', async () => {
			const storage = new TestSessionStorage();
			const session = makeSession('s-1');
			session.sessionName = 'My Custom Session Name';
			storage.sessions = [session];
			storage.searchableMessages.set('s-1', [{ role: 'user', textContent: 'unrelated content' }]);

			const results = await storage.searchSessions('/test', 'Custom Session', 'title');
			expect(results).toHaveLength(1);
			expect(results[0].matchType).toBe('title');
		});

		it('does not match title from user message content', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')]; // firstMessage: 'Session s-1'
			storage.searchableMessages.set('s-1', [
				{ role: 'user', textContent: 'fix the authentication bug' },
			]);

			// 'authentication' is in user message but not in firstMessage/sessionName
			const results = await storage.searchSessions('/test', 'authentication', 'title');
			expect(results).toHaveLength(0);
		});

		it('continues searching when getSearchableMessages fails for a session', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1'), makeSession('s-2')];
			storage.failingSessions.add('s-1');
			storage.searchableMessages.set('s-2', [{ role: 'user', textContent: 'search term here' }]);

			const results = await storage.searchSessions('/test', 'search term', 'user');
			// s-1 fails but s-2 still returns results
			expect(results).toHaveLength(1);
			expect(results[0].sessionId).toBe('s-2');
		});

		it('returns empty when all sessions fail to load messages', async () => {
			const storage = new TestSessionStorage();
			storage.sessions = [makeSession('s-1')];
			storage.failingSessions.add('s-1');

			const results = await storage.searchSessions('/test', 'anything', 'all');
			expect(results).toHaveLength(0);
		});
	});
});

/**
 * Tests for CursorSessionStorage - No-Op Implementation
 *
 * Cursor's on-disk session storage format is not publicly documented,
 * so CursorSessionStorage returns empty results for all operations.
 * These tests verify the no-op behavior is correct.
 */

import { describe, it, expect } from 'vitest';
import { CursorSessionStorage } from '../../../main/storage/cursor-session-storage';

describe('CursorSessionStorage', () => {
	const storage = new CursorSessionStorage();

	it('should have agentId set to cursor', () => {
		expect(storage.agentId).toBe('cursor');
	});

	describe('listSessions', () => {
		it('should return an empty array', async () => {
			const result = await storage.listSessions('/some/project');
			expect(result).toEqual([]);
		});

		it('should return an empty array with SSH config', async () => {
			const sshConfig = { enabled: true, host: 'remote', user: 'test' };
			const result = await storage.listSessions('/some/project', sshConfig as any);
			expect(result).toEqual([]);
		});
	});

	describe('readSessionMessages', () => {
		it('should return empty messages result', async () => {
			const result = await storage.readSessionMessages('/some/project', 'session-123');
			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});

		it('should return empty messages result with options', async () => {
			const result = await storage.readSessionMessages('/some/project', 'session-123', {
				offset: 10,
				limit: 5,
			});
			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});
	});

	describe('getSessionPath', () => {
		it('should return null', () => {
			const result = storage.getSessionPath('/some/project', 'session-123');
			expect(result).toBeNull();
		});
	});

	describe('deleteMessagePair', () => {
		it('should return failure with descriptive error', async () => {
			const result = await storage.deleteMessagePair(
				'/some/project',
				'session-123',
				'msg-uuid-456'
			);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('not yet documented');
		});
	});

	describe('listSessionsPaginated (inherited)', () => {
		it('should return empty paginated result', async () => {
			const result = await storage.listSessionsPaginated('/some/project');
			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});
	});

	describe('searchSessions (inherited)', () => {
		it('should return empty search results', async () => {
			const result = await storage.searchSessions('/some/project', 'test query', 'all');
			expect(result).toEqual([]);
		});

		it('should return empty for empty query', async () => {
			const result = await storage.searchSessions('/some/project', '', 'all');
			expect(result).toEqual([]);
		});
	});
});

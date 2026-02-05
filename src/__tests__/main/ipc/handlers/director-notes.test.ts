/**
 * Tests for the Director's Notes IPC handlers
 *
 * These tests verify:
 * - Unified history aggregation across all sessions
 * - Token estimation for synopsis generation
 * - AI synopsis generation (placeholder)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerDirectorNotesHandlers } from '../../../../main/ipc/handlers/director-notes';
import * as historyManagerModule from '../../../../main/history-manager';
import type { HistoryManager } from '../../../../main/history-manager';
import type { HistoryEntry } from '../../../../shared/types';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the history-manager module
vi.mock('../../../../main/history-manager', () => ({
	getHistoryManager: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('director-notes IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockHistoryManager: Partial<HistoryManager>;

	// Helper to create mock history entries
	const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'entry-1',
		type: 'AUTO',
		sessionId: 'session-1',
		projectPath: '/test/project',
		timestamp: Date.now(),
		summary: 'Test entry',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();

		// Create mock history manager
		mockHistoryManager = {
			getEntries: vi.fn().mockReturnValue([]),
			listSessionsWithHistory: vi.fn().mockReturnValue([]),
		};

		vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue(
			mockHistoryManager as unknown as HistoryManager
		);

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerDirectorNotesHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all director-notes handlers', () => {
			const expectedChannels = [
				'director-notes:getUnifiedHistory',
				'director-notes:estimateTokens',
				'director-notes:generateSynopsis',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('director-notes:getUnifiedHistory', () => {
		it('should aggregate history from all sessions', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);

			vi.mocked(mockHistoryManager.getEntries)
				.mockReturnValueOnce([
					createMockEntry({ id: 'e1', timestamp: now - 1000, summary: 'Entry 1', sessionName: 'Agent A' }),
				])
				.mockReturnValueOnce([
					createMockEntry({ id: 'e2', timestamp: now - 2000, summary: 'Entry 2', sessionName: 'Agent B' }),
				]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('e1'); // newer first
			expect(result[1].id).toBe('e2');
			expect(result[0].sourceSessionId).toBe('session-1');
			expect(result[1].sourceSessionId).toBe('session-2');
		});

		it('should filter by lookbackDays', async () => {
			const now = Date.now();
			const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
			const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'recent', timestamp: twoDaysAgo }),
				createMockEntry({ id: 'old', timestamp: tenDaysAgo }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('recent');
		});

		it('should filter by type when filter is provided', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'auto-entry', type: 'AUTO', timestamp: now - 1000 }),
				createMockEntry({ id: 'user-entry', type: 'USER', timestamp: now - 2000 }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7, filter: 'AUTO' });

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('auto-entry');
		});

		it('should return both types when filter is null', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'auto-entry', type: 'AUTO', timestamp: now - 1000 }),
				createMockEntry({ id: 'user-entry', type: 'USER', timestamp: now - 2000 }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7, filter: null });

			expect(result).toHaveLength(2);
		});

		it('should return entries sorted by timestamp descending', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);

			// Session 1 has older entry, session 2 has newer entry
			vi.mocked(mockHistoryManager.getEntries)
				.mockReturnValueOnce([
					createMockEntry({ id: 'oldest', timestamp: now - 3000 }),
				])
				.mockReturnValueOnce([
					createMockEntry({ id: 'newest', timestamp: now - 1000 }),
					createMockEntry({ id: 'middle', timestamp: now - 2000 }),
				]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result).toHaveLength(3);
			expect(result[0].id).toBe('newest');
			expect(result[1].id).toBe('middle');
			expect(result[2].id).toBe('oldest');
		});

		it('should include agentName from sessionName', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now, sessionName: 'My Agent' }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result[0].agentName).toBe('My Agent');
		});

		it('should derive agentName from session ID when sessionName is absent', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['claude-abc123']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now, sessionName: undefined }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			// Falls back to sessionId.split('-')[0]
			expect(result[0].agentName).toBe('claude');
		});

		it('should return empty array when no sessions have history', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result).toEqual([]);
		});

		it('should return empty array when all entries are outside lookback window', async () => {
			const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'old', timestamp: thirtyDaysAgo }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result).toEqual([]);
		});
	});

	describe('director-notes:estimateTokens', () => {
		it('should estimate tokens based on content length', async () => {
			// 4 characters per token heuristic
			const entries = [
				createMockEntry({ summary: 'abcd', fullResponse: undefined }), // 4 chars = 1 token
			];

			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, entries);

			expect(result).toBe(1);
		});

		it('should include both summary and fullResponse in estimation', async () => {
			// summary: 8 chars + fullResponse: 12 chars = 20 chars / 4 = 5 tokens
			const entries = [
				createMockEntry({ summary: 'abcdefgh', fullResponse: 'abcdefghijkl' }),
			];

			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, entries);

			expect(result).toBe(5);
		});

		it('should handle entries with no summary or fullResponse', async () => {
			const entries = [
				createMockEntry({ summary: '', fullResponse: undefined }),
			];

			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, entries);

			expect(result).toBe(0);
		});

		it('should aggregate tokens across multiple entries', async () => {
			// Entry 1: 8 chars summary + 0 response = 8
			// Entry 2: 4 chars summary + 4 chars response = 8
			// Total: 16 chars / 4 = 4 tokens
			const entries = [
				createMockEntry({ summary: 'abcdefgh', fullResponse: undefined }),
				createMockEntry({ summary: 'abcd', fullResponse: 'efgh' }),
			];

			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, entries);

			expect(result).toBe(4);
		});

		it('should ceil the token estimate', async () => {
			// 5 chars / 4 = 1.25, ceiled to 2
			const entries = [
				createMockEntry({ summary: 'abcde', fullResponse: undefined }),
			];

			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, entries);

			expect(result).toBe(2);
		});

		it('should return 0 for empty entries array', async () => {
			const handler = handlers.get('director-notes:estimateTokens');
			const result = await handler!({} as any, []);

			expect(result).toBe(0);
		});
	});

	describe('director-notes:generateSynopsis', () => {
		it('should return a placeholder synopsis with success', async () => {
			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(true);
			expect(result.synopsis).toContain("Director's Notes");
			expect(result.synopsis).toContain('7 days');
		});

		it('should include lookbackDays in the synopsis content', async () => {
			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 14, provider: 'codex' });

			expect(result.synopsis).toContain('14 days');
		});

		it('should return synopsis with expected structure', async () => {
			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result).toHaveProperty('success');
			expect(result).toHaveProperty('synopsis');
			expect(typeof result.synopsis).toBe('string');
		});

		it('should not have an error field on success', async () => {
			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});
	});
});

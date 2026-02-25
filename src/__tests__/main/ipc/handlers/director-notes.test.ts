/**
 * Tests for the Director's Notes IPC handlers
 *
 * These tests verify:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation via groomContext (file-path based)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerDirectorNotesHandlers,
	sanitizeDisplayName,
} from '../../../../main/ipc/handlers/director-notes';
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

// Mock the stores module
const mockGetSessionsStore = vi.fn().mockReturnValue({
	get: vi.fn().mockReturnValue([]),
});
vi.mock('../../../../main/stores', () => ({
	getSessionsStore: (...args: any[]) => mockGetSessionsStore(...args),
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

// Mock the context-groomer module
vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

// Mock the prompts module
vi.mock('../../../../../prompts', () => ({
	directorNotesPrompt: 'Mock director notes prompt',
}));

describe('director-notes IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockHistoryManager: Partial<HistoryManager>;
	let mockProcessManager: any;
	let mockAgentDetector: any;

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

		// Create mock process manager and agent detector
		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 123 }),
			on: vi.fn(),
			off: vi.fn(),
			kill: vi.fn(),
		};
		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				available: true,
				command: 'claude',
				args: [],
			}),
		};

		// Create mock history manager
		mockHistoryManager = {
			getEntries: vi.fn().mockReturnValue([]),
			listSessionsWithHistory: vi.fn().mockReturnValue([]),
			getHistoryFilePath: vi.fn().mockReturnValue(null),
		};

		vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue(
			mockHistoryManager as unknown as HistoryManager
		);

		// Reset sessions store mock to return empty sessions by default
		mockGetSessionsStore.mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		});

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers with mock dependencies
		registerDirectorNotesHandlers({
			getProcessManager: () => mockProcessManager,
			getAgentDetector: () => mockAgentDetector,
		});
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all director-notes handlers', () => {
			const expectedChannels = [
				'director-notes:getUnifiedHistory',
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
					createMockEntry({
						id: 'e1',
						timestamp: now - 1000,
						summary: 'Entry 1',
						sessionName: 'Agent A',
					}),
				])
				.mockReturnValueOnce([
					createMockEntry({
						id: 'e2',
						timestamp: now - 2000,
						summary: 'Entry 2',
						sessionName: 'Agent B',
					}),
				]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].id).toBe('e1'); // newer first
			expect(result.entries[1].id).toBe('e2');
			expect(result.entries[0].sourceSessionId).toBe('session-1');
			expect(result.entries[1].sourceSessionId).toBe('session-2');
			expect(result.total).toBe(2);
			expect(result.hasMore).toBe(false);
		});

		it('should include stats in the response', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);

			vi.mocked(mockHistoryManager.getEntries)
				.mockReturnValueOnce([
					createMockEntry({
						id: 'e1',
						type: 'AUTO',
						timestamp: now - 1000,
						agentSessionId: 'as-1',
					}),
					createMockEntry({
						id: 'e2',
						type: 'USER',
						timestamp: now - 2000,
						agentSessionId: 'as-1',
					}),
				])
				.mockReturnValueOnce([
					createMockEntry({
						id: 'e3',
						type: 'AUTO',
						timestamp: now - 3000,
						agentSessionId: 'as-2',
					}),
					createMockEntry({
						id: 'e4',
						type: 'USER',
						timestamp: now - 4000,
						agentSessionId: 'as-3',
					}),
				]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result.stats).toBeDefined();
			expect(result.stats.agentCount).toBe(2); // 2 Maestro sessions
			expect(result.stats.sessionCount).toBe(3); // 3 unique provider sessions (as-1, as-2, as-3)
			expect(result.stats.autoCount).toBe(2);
			expect(result.stats.userCount).toBe(2);
			expect(result.stats.totalCount).toBe(4);
		});

		it('should compute stats from unfiltered data when type filter is applied', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', type: 'AUTO', timestamp: now - 1000, agentSessionId: 'as-1' }),
				createMockEntry({ id: 'e2', type: 'USER', timestamp: now - 2000, agentSessionId: 'as-1' }),
				createMockEntry({ id: 'e3', type: 'AUTO', timestamp: now - 3000, agentSessionId: 'as-2' }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7, filter: 'AUTO' });

			// Entries filtered to AUTO only
			expect(result.entries).toHaveLength(2);
			// Stats include ALL entries regardless of type filter
			expect(result.stats.autoCount).toBe(2);
			expect(result.stats.userCount).toBe(1);
			expect(result.stats.totalCount).toBe(3);
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

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].id).toBe('recent');
		});

		it('should return all entries when lookbackDays is 0 (all time)', async () => {
			const now = Date.now();
			const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
			const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'recent', timestamp: twoDaysAgo }),
				createMockEntry({ id: 'ancient', timestamp: yearAgo }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 0 });

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].id).toBe('recent');
			expect(result.entries[1].id).toBe('ancient');
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

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].id).toBe('auto-entry');
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

			expect(result.entries).toHaveLength(2);
		});

		it('should return entries sorted by timestamp descending', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);

			// Session 1 has older entry, session 2 has newer entry
			vi.mocked(mockHistoryManager.getEntries)
				.mockReturnValueOnce([createMockEntry({ id: 'oldest', timestamp: now - 3000 })])
				.mockReturnValueOnce([
					createMockEntry({ id: 'newest', timestamp: now - 1000 }),
					createMockEntry({ id: 'middle', timestamp: now - 2000 }),
				]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result.entries).toHaveLength(3);
			expect(result.entries[0].id).toBe('newest');
			expect(result.entries[1].id).toBe('middle');
			expect(result.entries[2].id).toBe('oldest');
		});

		it('should use Maestro session name when available in sessions store', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now, sessionName: 'Tab Name' }),
			]);

			// Mock the sessions store to return a session with a name
			mockGetSessionsStore.mockReturnValue({
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						name: '🚧 my-feature',
						toolType: 'claude-code',
						cwd: '/test',
						projectRoot: '/test',
					},
				]),
			});

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			// Should use Maestro session name, not tab name
			expect(result.entries[0].agentName).toBe('🚧 my-feature');
		});

		it('should set agentName to undefined when Maestro session not found in store', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now, sessionName: 'My Agent' }),
			]);

			// Sessions store returns no matching session
			mockGetSessionsStore.mockReturnValue({
				get: vi.fn().mockReturnValue([
					{
						id: 'other-session',
						name: 'Other',
						toolType: 'claude-code',
						cwd: '/test',
						projectRoot: '/test',
					},
				]),
			});

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			// agentName is only the Maestro session name; undefined when not found
			expect(result.entries[0].agentName).toBeUndefined();
			// sessionName is still preserved on the entry
			expect(result.entries[0].sessionName).toBe('My Agent');
		});

		it('should set agentName to undefined when session is not in store', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['claude-abc123']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now, sessionName: undefined }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			// No Maestro session name available
			expect(result.entries[0].agentName).toBeUndefined();
		});

		it('should return empty entries when no sessions have history', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('should return empty entries when all entries are outside lookback window', async () => {
			const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'old', timestamp: thirtyDaysAgo }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');
			const result = await handler!({} as any, { lookbackDays: 7 });

			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('should support pagination with limit and offset', async () => {
			const now = Date.now();
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'e1', timestamp: now - 1000 }),
				createMockEntry({ id: 'e2', timestamp: now - 2000 }),
				createMockEntry({ id: 'e3', timestamp: now - 3000 }),
				createMockEntry({ id: 'e4', timestamp: now - 4000 }),
				createMockEntry({ id: 'e5', timestamp: now - 5000 }),
			]);

			const handler = handlers.get('director-notes:getUnifiedHistory');

			// First page: limit 2, offset 0
			const page1 = await handler!({} as any, { lookbackDays: 7, limit: 2, offset: 0 });
			expect(page1.entries).toHaveLength(2);
			expect(page1.entries[0].id).toBe('e1');
			expect(page1.entries[1].id).toBe('e2');
			expect(page1.total).toBe(5);
			expect(page1.hasMore).toBe(true);

			// Second page: limit 2, offset 2
			const page2 = await handler!({} as any, { lookbackDays: 7, limit: 2, offset: 2 });
			expect(page2.entries).toHaveLength(2);
			expect(page2.entries[0].id).toBe('e3');
			expect(page2.entries[1].id).toBe('e4');
			expect(page2.total).toBe(5);
			expect(page2.hasMore).toBe(true);

			// Third page: limit 2, offset 4
			const page3 = await handler!({} as any, { lookbackDays: 7, limit: 2, offset: 4 });
			expect(page3.entries).toHaveLength(1);
			expect(page3.entries[0].id).toBe('e5');
			expect(page3.total).toBe(5);
			expect(page3.hasMore).toBe(false);
		});
	});

	describe('director-notes:generateSynopsis', () => {
		it('should return error when agent is not available', async () => {
			mockAgentDetector.getAgent.mockResolvedValue({ available: false });

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('not available');
		});

		it('should return empty-history message when no sessions have history files', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([]);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(true);
			expect(result.synopsis).toContain('No history files found');
			expect(result.synopsis).toContain('7 days');
			expect(result.generatedAt).toBeTypeOf('number');
			expect(result.generatedAt).toBeLessThanOrEqual(Date.now());
		});

		it('should return empty-history message when all file paths are null', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(null);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(true);
			expect(result.synopsis).toContain('No history files found');
		});

		it('should call groomContext with file-path manifest and return synopsis', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis\n\nWork was done.',
				durationMs: 5000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(true);
			expect(result.synopsis).toBe('# Synopsis\n\nWork was done.');
			expect(result.generatedAt).toBeTypeOf('number');
			expect(result.generatedAt).toBeLessThanOrEqual(Date.now());

			// Verify groomContext was called with file path in prompt (not inline JSON data)
			const groomCall = vi.mocked(groomContext).mock.calls[0][0];
			expect(groomCall.agentType).toBe('claude-code');
			expect(groomCall.readOnlyMode).toBe(true);
			expect(groomCall.prompt).toContain('/data/history/session-1.json');
			expect(groomCall.prompt).toContain('session-1');
			// Verify no inline entry data (the prompt describes the schema but doesn't embed actual entries)
			expect(groomCall.prompt).not.toContain('"Fixed a bug"');
		});

		it('should include all sessions with history files in the prompt manifest', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
				'session-3',
			]);
			vi.mocked(mockHistoryManager.getHistoryFilePath)
				.mockReturnValueOnce('/data/history/session-1.json')
				.mockReturnValueOnce('/data/history/session-2.json')
				.mockReturnValueOnce(null); // session-3 has no file

			const handler = handlers.get('director-notes:generateSynopsis');
			await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			const promptArg = vi.mocked(groomContext).mock.calls[0][0].prompt;
			expect(promptArg).toContain('/data/history/session-1.json');
			expect(promptArg).toContain('/data/history/session-2.json');
			expect(promptArg).not.toContain('session-3');
		});

		it('should pass custom agent config to groomContext when provided', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis\n\nCustom agent work.',
				durationMs: 5000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, {
				lookbackDays: 7,
				provider: 'claude-code',
				customPath: '/usr/local/bin/custom-claude',
				customArgs: '--model opus',
				customEnvVars: { ANTHROPIC_API_KEY: 'test-key' },
			});

			expect(result.success).toBe(true);
			expect(groomContext).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'claude-code',
					readOnlyMode: true,
					sessionCustomPath: '/usr/local/bin/custom-claude',
					sessionCustomArgs: '--model opus',
					sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'test-key' },
				}),
				mockProcessManager,
				mockAgentDetector
			);
		});

		it('should use Maestro session name in file-path manifest', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			// Mock sessions store with Maestro session name
			mockGetSessionsStore.mockReturnValue({
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						name: '🚧 feature-branch',
						toolType: 'claude-code',
						cwd: '/test',
						projectRoot: '/test',
					},
				]),
			});

			const handler = handlers.get('director-notes:generateSynopsis');
			await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			// The prompt should contain the Maestro session name alongside the file path
			const promptArg = vi.mocked(groomContext).mock.calls[0][0].prompt;
			expect(promptArg).toContain('🚧 feature-branch');
			expect(promptArg).toContain('/data/history/session-1.json');
		});

		it('should fall back to session ID when no Maestro session name is available', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['unknown-session']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/unknown-session.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			const promptArg = vi.mocked(groomContext).mock.calls[0][0].prompt;
			expect(promptArg).toContain('unknown-session');
		});

		it('should return error when groomContext fails', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockRejectedValue(new Error('Agent timed out'));

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('Agent timed out');
		});

		it('should return error when agent returns empty response', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '  ',
				durationMs: 3000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			const result = await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('empty response');
		});

		it('should sanitize session names in the prompt manifest', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			// Session name with markdown injection characters
			mockGetSessionsStore.mockReturnValue({
				get: vi.fn().mockReturnValue([
					{
						id: 'session-1',
						name: '**bold** [link](http://evil) # heading',
						toolType: 'claude-code',
						cwd: '/test',
						projectRoot: '/test',
					},
				]),
			});

			const handler = handlers.get('director-notes:generateSynopsis');
			await handler!({} as any, { lookbackDays: 7, provider: 'claude-code' });

			const promptArg = vi.mocked(groomContext).mock.calls[0][0].prompt;
			// Markdown characters should be stripped
			expect(promptArg).not.toContain('**bold**');
			expect(promptArg).not.toContain('[link]');
			expect(promptArg).toContain('bold linkhttp://evil heading');
		});

		it('should include lookback and cutoff metadata in prompt', async () => {
			const { groomContext } = await import('../../../../main/utils/context-groomer');
			vi.mocked(groomContext).mockResolvedValue({
				response: '# Synopsis',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/data/history/session-1.json'
			);

			const handler = handlers.get('director-notes:generateSynopsis');
			await handler!({} as any, { lookbackDays: 14, provider: 'claude-code' });

			const promptArg = vi.mocked(groomContext).mock.calls[0][0].prompt;
			expect(promptArg).toContain('Lookback period: 14 days');
			expect(promptArg).toContain('Timestamp cutoff:');
		});
	});
});

describe('sanitizeDisplayName', () => {
	it('should strip markdown formatting characters', () => {
		expect(sanitizeDisplayName('**bold** text')).toBe('bold text');
		expect(sanitizeDisplayName('# heading')).toBe('heading');
		expect(sanitizeDisplayName('`code`')).toBe('code');
		expect(sanitizeDisplayName('~~strikethrough~~')).toBe('strikethrough');
	});

	it('should strip link and image syntax', () => {
		expect(sanitizeDisplayName('[link](url)')).toBe('linkurl');
		expect(sanitizeDisplayName('![alt](img)')).toBe('altimg');
	});

	it('should collapse whitespace and trim', () => {
		expect(sanitizeDisplayName('  hello   world  ')).toBe('hello world');
		expect(sanitizeDisplayName('line\nnewline')).toBe('line newline');
	});

	it('should preserve emoji and regular text', () => {
		expect(sanitizeDisplayName('🚧 feature-branch')).toBe('🚧 feature-branch');
		expect(sanitizeDisplayName('my-session')).toBe('my-session');
	});

	it('should handle empty and whitespace-only strings', () => {
		expect(sanitizeDisplayName('')).toBe('');
		expect(sanitizeDisplayName('   ')).toBe('');
	});
});

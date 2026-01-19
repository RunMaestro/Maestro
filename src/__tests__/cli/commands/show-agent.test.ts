/**
 * @file show-agent.test.ts
 * @description Tests for the show-agent CLI command
 *
 * Tests all functionality of the show-agent command including:
 * - Displaying agent details with history and stats
 * - JSON output mode
 * - Group name resolution
 * - Usage statistics aggregation
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionInfo, Group, HistoryEntry } from '../../../shared/types';

// Mock the storage service
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	readHistory: vi.fn(),
	readGroups: vi.fn(),
}));

// Mock the formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatAgentDetail: vi.fn((detail) => `Agent: ${detail.name}\nPath: ${detail.cwd}`),
	formatError: vi.fn((msg) => `Error: ${msg}`),
}));

import { showAgent } from '../../../cli/commands/show-agent';
import { getSessionById, readHistory, readGroups } from '../../../cli/services/storage';
import { formatAgentDetail, formatError } from '../../../cli/output/formatter';

describe('show-agent command', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		groupId: undefined,
		autoRunFolderPath: undefined,
		...overrides,
	});

	const mockHistoryEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'hist-1',
		sessionId: 'agent-123',
		projectPath: '/path/to/project',
		timestamp: Date.now(),
		type: 'command',
		summary: 'Test command',
		success: true,
		elapsedTimeMs: 1000,
		usageStats: {
			inputTokens: 100,
			outputTokens: 200,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 25,
			totalCostUsd: 0.01,
		},
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation((code?: string | number | null | undefined) => {
				throw new Error(`process.exit(${code})`);
			});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	describe('basic display', () => {
		it('should display agent details in human-readable format', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(getSessionById).toHaveBeenCalledWith('agent-123');
			expect(formatAgentDetail).toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should include group name when agent belongs to a group', () => {
			const groups: Group[] = [{ id: 'group-1', name: 'Frontend', emoji: '🎨', collapsed: false }];
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: 'group-1' }));
			vi.mocked(readGroups).mockReturnValue(groups);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(formatAgentDetail).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: 'group-1',
					groupName: 'Frontend',
				})
			);
		});

		it('should handle agent without group', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: undefined }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', {});

			expect(formatAgentDetail).toHaveBeenCalledWith(
				expect.objectContaining({
					groupId: undefined,
					groupName: undefined,
				})
			);
		});
	});

	describe('usage statistics', () => {
		it('should aggregate usage stats from history', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({
					usageStats: {
						inputTokens: 100,
						outputTokens: 200,
						cacheReadInputTokens: 50,
						cacheCreationInputTokens: 25,
						totalCostUsd: 0.01,
					},
				}),
				mockHistoryEntry({
					usageStats: {
						inputTokens: 150,
						outputTokens: 300,
						cacheReadInputTokens: 75,
						cacheCreationInputTokens: 50,
						totalCostUsd: 0.02,
					},
				}),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalInputTokens).toBe(250);
			expect(parsed.stats.totalOutputTokens).toBe(500);
			expect(parsed.stats.totalCacheReadTokens).toBe(125);
			expect(parsed.stats.totalCacheCreationTokens).toBe(75);
			expect(parsed.stats.totalCost).toBe(0.03);
		});

		it('should count success and failure entries', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ success: true }),
				mockHistoryEntry({ success: true }),
				mockHistoryEntry({ success: false }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.successCount).toBe(2);
			expect(parsed.stats.failureCount).toBe(1);
		});

		it('should aggregate elapsed time', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ elapsedTimeMs: 1000 }),
				mockHistoryEntry({ elapsedTimeMs: 2000 }),
				mockHistoryEntry({ elapsedTimeMs: 3000 }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalElapsedMs).toBe(6000);
		});

		it('should handle entries without usageStats', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ usageStats: undefined }),
				mockHistoryEntry({
					usageStats: {
						inputTokens: 100,
						outputTokens: 200,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.01,
					},
				}),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalInputTokens).toBe(100);
			expect(parsed.stats.totalOutputTokens).toBe(200);
		});

		it('should handle entries without elapsedTimeMs', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ elapsedTimeMs: undefined }),
				mockHistoryEntry({ elapsedTimeMs: 1000 }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.totalElapsedMs).toBe(1000);
		});

		it('should handle entries with undefined success', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ success: undefined }),
				mockHistoryEntry({ success: true }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.successCount).toBe(1);
			expect(parsed.stats.failureCount).toBe(0);
		});
	});

	describe('recent history', () => {
		it('should include last 10 history entries sorted by timestamp', () => {
			const history: HistoryEntry[] = Array.from({ length: 15 }, (_, i) =>
				mockHistoryEntry({ id: `hist-${i}`, timestamp: 1000 + i * 100 })
			);

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory).toHaveLength(10);
			// Should be sorted by timestamp descending (most recent first)
			expect(parsed.recentHistory[0].id).toBe('hist-14');
			expect(parsed.recentHistory[9].id).toBe('hist-5');
		});

		it('should include cost from history entries', () => {
			const history: HistoryEntry[] = [
				mockHistoryEntry({ usageStats: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0.05 } }),
			];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory[0].cost).toBe(0.05);
		});

		it('should handle history entries without usageStats', () => {
			const history: HistoryEntry[] = [mockHistoryEntry({ usageStats: undefined })];

			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue(history);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.recentHistory[0].cost).toBeUndefined();
		});
	});

	describe('JSON output', () => {
		it('should output JSON when json option is true', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			expect(formatAgentDetail).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(1);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.id).toBe('agent-123');
			expect(parsed.name).toBe('Test Agent');
			expect(parsed.toolType).toBe('claude-code');
		});

		it('should include all agent properties in JSON output', () => {
			vi.mocked(getSessionById).mockReturnValue(
				mockSession({
					id: 'full-agent',
					name: 'Full Agent',
					toolType: 'gemini-cli',
					cwd: '/project',
					projectRoot: '/project/root',
					groupId: 'group-1',
					autoRunFolderPath: '/project/playbooks',
				})
			);
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'group-1', name: 'My Group', emoji: '🔧', collapsed: false },
			]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('full-agent', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.id).toBe('full-agent');
			expect(parsed.name).toBe('Full Agent');
			expect(parsed.toolType).toBe('gemini-cli');
			expect(parsed.cwd).toBe('/project');
			expect(parsed.projectRoot).toBe('/project/root');
			expect(parsed.groupId).toBe('group-1');
			expect(parsed.groupName).toBe('My Group');
			expect(parsed.autoRunFolderPath).toBe('/project/playbooks');
		});
	});

	describe('error handling', () => {
		it('should throw error when agent not found', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Agent not found: nonexistent');
		});

		it('should output error as JSON when json option is true', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', { json: true })).toThrow('process.exit(1)');

			const errorOutput = consoleErrorSpy.mock.calls[0][0];
			const parsed = JSON.parse(errorOutput);
			expect(parsed.error).toBe('Agent not found: nonexistent');
		});

		it('should handle storage errors', () => {
			vi.mocked(getSessionById).mockImplementation(() => {
				throw new Error('Storage read failed');
			});

			expect(() => showAgent('agent-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Storage read failed');
		});

		it('should handle non-Error objects thrown', () => {
			vi.mocked(getSessionById).mockImplementation(() => {
				throw 'String error';
			});

			expect(() => showAgent('agent-123', {})).toThrow('process.exit(1)');

			expect(formatError).toHaveBeenCalledWith('Unknown error');
		});

		it('should exit with code 1 on error', () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);

			expect(() => showAgent('nonexistent', {})).toThrow('process.exit(1)');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('edge cases', () => {
		it('should handle empty history', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.stats.historyEntries).toBe(0);
			expect(parsed.stats.successCount).toBe(0);
			expect(parsed.stats.failureCount).toBe(0);
			expect(parsed.stats.totalCost).toBe(0);
			expect(parsed.recentHistory).toEqual([]);
		});

		it('should handle partial ID lookup', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession());
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent', {});

			expect(getSessionById).toHaveBeenCalledWith('agent');
		});

		it('should handle group not found for groupId', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ groupId: 'missing-group' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('agent-123', { json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.groupId).toBe('missing-group');
			expect(parsed.groupName).toBeUndefined();
		});

		it('should pass correct sessionId to readHistory', () => {
			vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'specific-agent' }));
			vi.mocked(readGroups).mockReturnValue([]);
			vi.mocked(readHistory).mockReturnValue([]);

			showAgent('specific-agent', {});

			expect(readHistory).toHaveBeenCalledWith(undefined, 'specific-agent');
		});
	});
});

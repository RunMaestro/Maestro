/**
 * Tests for stats preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createStatsApi } from '../../../main/preload/stats';

describe('Stats Preload API', () => {
	let api: ReturnType<typeof createStatsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createStatsApi();
	});

	describe('recordQuery', () => {
		it('should invoke stats:record-query', async () => {
			mockInvoke.mockResolvedValue('query-123');
			const event = {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user' as const,
				startTime: Date.now(),
				duration: 5000,
				projectPath: '/project',
			};

			const result = await api.recordQuery(event);

			expect(mockInvoke).toHaveBeenCalledWith('stats:record-query', event);
			expect(result).toBe('query-123');
		});
	});

	describe('startAutoRun', () => {
		it('should invoke stats:start-autorun', async () => {
			mockInvoke.mockResolvedValue('autorun-123');
			const session = {
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: '/project/.maestro/tasks.md',
				startTime: Date.now(),
				tasksTotal: 10,
				projectPath: '/project',
			};

			const result = await api.startAutoRun(session);

			expect(mockInvoke).toHaveBeenCalledWith('stats:start-autorun', session);
			expect(result).toBe('autorun-123');
		});
	});

	describe('Auto Run and shortcut reads added for the Usage Dashboard', () => {
		it('endAutoRun forwards a corrected tasksTotal', async () => {
			mockInvoke.mockResolvedValue(true);
			await api.endAutoRun('autorun-1', 1000, 12, 12);
			expect(mockInvoke).toHaveBeenCalledWith('stats:end-autorun', 'autorun-1', 1000, 12, 12);
		});

		it('getAutoRunTurnsByHour invokes the grouped channel', async () => {
			mockInvoke.mockResolvedValue([]);
			await api.getAutoRunTurnsByHour('week');
			expect(mockInvoke).toHaveBeenCalledWith('stats:get-autorun-turns-by-hour', 'week');
		});

		it('recordShortcutUsage sends the shortcut id', async () => {
			mockInvoke.mockResolvedValue('2026-06-21');
			await api.recordShortcutUsage(123, 'toggleSidebar');
			expect(mockInvoke).toHaveBeenCalledWith('stats:record-shortcut-usage', 123, 'toggleSidebar');
		});

		it('getShortcutUsageByShortcut invokes the per-shortcut channel', async () => {
			mockInvoke.mockResolvedValue([]);
			await api.getShortcutUsageByShortcut('month');
			expect(mockInvoke).toHaveBeenCalledWith('stats:get-shortcut-usage-by-shortcut', 'month');
		});
	});

	describe('endAutoRun', () => {
		it('should invoke stats:end-autorun', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.endAutoRun('autorun-123', 60000, 8);

			expect(mockInvoke).toHaveBeenCalledWith(
				'stats:end-autorun',
				'autorun-123',
				60000,
				8,
				undefined
			);
			expect(result).toBe(true);
		});
	});

	describe('recordAutoTask', () => {
		it('should invoke stats:record-task', async () => {
			mockInvoke.mockResolvedValue('task-123');
			const task = {
				autoRunSessionId: 'autorun-123',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 3,
				taskContent: 'Fix the bug',
				startTime: Date.now(),
				duration: 10000,
				success: true,
			};

			const result = await api.recordAutoTask(task);

			expect(mockInvoke).toHaveBeenCalledWith('stats:record-task', task);
			expect(result).toBe('task-123');
		});
	});

	describe('getStats', () => {
		it('should invoke stats:get-stats without filters', async () => {
			mockInvoke.mockResolvedValue([]);

			const result = await api.getStats('day');

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-stats', 'day', undefined);
			expect(result).toEqual([]);
		});

		it('should invoke stats:get-stats with filters', async () => {
			mockInvoke.mockResolvedValue([]);
			const filters = {
				agentType: 'claude-code',
				source: 'user' as const,
				projectPath: '/project',
			};

			await api.getStats('week', filters);

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-stats', 'week', filters);
		});

		it('should handle all time ranges', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getStats('month');
			await api.getStats('year');
			await api.getStats('all');

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-stats', 'month', undefined);
			expect(mockInvoke).toHaveBeenCalledWith('stats:get-stats', 'year', undefined);
			expect(mockInvoke).toHaveBeenCalledWith('stats:get-stats', 'all', undefined);
		});
	});

	describe('getAutoRunSessions', () => {
		it('should invoke stats:get-autorun-sessions', async () => {
			const sessions = [
				{
					id: 'ar-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					startTime: Date.now(),
					duration: 60000,
					tasksTotal: 10,
					tasksCompleted: 8,
				},
			];
			mockInvoke.mockResolvedValue(sessions);

			const result = await api.getAutoRunSessions('day');

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-autorun-sessions', 'day');
			expect(result).toEqual(sessions);
		});
	});

	describe('getAggregation', () => {
		it('should invoke stats:get-aggregation', async () => {
			const aggregation = {
				totalQueries: 100,
				totalDuration: 500000,
				avgDuration: 5000,
				byAgent: {
					'claude-code': { count: 80, duration: 400000 },
					opencode: { count: 20, duration: 100000 },
				},
				bySource: { user: 70, auto: 30 },
				byDay: [
					{ date: '2024-01-01', count: 50, duration: 250000 },
					{ date: '2024-01-02', count: 50, duration: 250000 },
				],
			};
			mockInvoke.mockResolvedValue(aggregation);

			const result = await api.getAggregation('week');

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-aggregation', 'week');
			expect(result).toEqual(aggregation);
		});
	});

	describe('exportUsage', () => {
		it('should invoke stats:export with the range, format, and path', async () => {
			const exportResult = {
				path: '/path/to/export.json',
				format: 'json',
				rowCounts: { 'query-events': 2 },
				notes: [],
			};
			mockInvoke.mockResolvedValue(exportResult);

			const result = await api.exportUsage('month', 'json', '/path/to/export.json');

			expect(mockInvoke).toHaveBeenCalledWith(
				'stats:export',
				'month',
				'json',
				'/path/to/export.json'
			);
			expect(result).toEqual(exportResult);
		});
	});

	describe('onStatsUpdate', () => {
		it('should register event listener and return cleanup function', () => {
			const callback = vi.fn();

			const cleanup = api.onStatsUpdate(callback);

			expect(mockOn).toHaveBeenCalledWith('stats:updated', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback when event is received', () => {
			const callback = vi.fn();
			let registeredHandler: () => void;

			mockOn.mockImplementation((_channel: string, handler: () => void) => {
				registeredHandler = handler;
			});

			api.onStatsUpdate(callback);
			registeredHandler!();

			expect(callback).toHaveBeenCalled();
		});

		it('should remove listener when cleanup is called', () => {
			const callback = vi.fn();
			let registeredHandler: () => void;

			mockOn.mockImplementation((_channel: string, handler: () => void) => {
				registeredHandler = handler;
			});

			const cleanup = api.onStatsUpdate(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('stats:updated', registeredHandler!);
		});
	});

	describe('retired surface', () => {
		it('no longer exposes cleanup or the earliest-timestamp read', () => {
			expect(api).not.toHaveProperty('clearOldData');
			expect(api).not.toHaveProperty('getEarliestTimestamp');
		});
	});

	describe('initialization result', () => {
		it('reads and clears the stats database reset notice', async () => {
			mockInvoke.mockResolvedValueOnce({ success: true, wasReset: true, userMessage: 'reset' });
			await expect(api.getInitializationResult()).resolves.toEqual({
				success: true,
				wasReset: true,
				userMessage: 'reset',
			});
			expect(mockInvoke).toHaveBeenCalledWith('stats:get-initialization-result');

			mockInvoke.mockResolvedValueOnce(true);
			await expect(api.clearInitializationResult()).resolves.toBe(true);
			expect(mockInvoke).toHaveBeenCalledWith('stats:clear-initialization-result');
		});
	});

	describe('getDatabaseSize', () => {
		it('should invoke stats:get-database-size', async () => {
			mockInvoke.mockResolvedValue(1024000);

			const result = await api.getDatabaseSize();

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-database-size');
			expect(result).toBe(1024000);
		});
	});

	describe('recordSessionCreated', () => {
		it('should invoke stats:record-session-created', async () => {
			mockInvoke.mockResolvedValue('lifecycle-123');
			const event = {
				sessionId: 'session-1',
				agentType: 'claude-code',
				projectPath: '/project',
				createdAt: Date.now(),
				isRemote: false,
			};

			const result = await api.recordSessionCreated(event);

			expect(mockInvoke).toHaveBeenCalledWith('stats:record-session-created', event);
			expect(result).toBe('lifecycle-123');
		});

		it('should return null for duplicate sessions', async () => {
			mockInvoke.mockResolvedValue(null);
			const event = {
				sessionId: 'session-1',
				agentType: 'claude-code',
				createdAt: Date.now(),
			};

			const result = await api.recordSessionCreated(event);

			expect(result).toBeNull();
		});
	});

	describe('recordSessionClosed', () => {
		it('should invoke stats:record-session-closed', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.recordSessionClosed('session-1', Date.now());

			expect(mockInvoke).toHaveBeenCalledWith(
				'stats:record-session-closed',
				'session-1',
				expect.any(Number)
			);
			expect(result).toBe(true);
		});
	});

	describe('getSessionLifecycle', () => {
		it('should invoke stats:get-session-lifecycle', async () => {
			const lifecycle = [
				{
					id: 'lc-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					projectPath: '/project',
					createdAt: Date.now() - 60000,
					closedAt: Date.now(),
					duration: 60000,
					isRemote: false,
				},
			];
			mockInvoke.mockResolvedValue(lifecycle);

			const result = await api.getSessionLifecycle('day');

			expect(mockInvoke).toHaveBeenCalledWith('stats:get-session-lifecycle', 'day');
			expect(result).toEqual(lifecycle);
		});
	});
});

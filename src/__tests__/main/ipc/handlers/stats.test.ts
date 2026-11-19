/**
 * Tests for the Stats IPC handlers
 *
 * These tests verify that the stats:updated event is broadcast correctly
 * after each database write operation, ensuring real-time dashboard updates.
 * The event names the table that changed and reaches every open window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerStatsHandlers } from '../../../../main/ipc/handlers/stats';
import * as statsDbModule from '../../../../main/stats';
import type { StatsDB } from '../../../../main/stats';
import { runAsActingUser } from '../../../../main/web-server/auth/acting-user';
import { noteTurnActor, resetTurnActors } from '../../../../main/web-server/auth/turn-attribution';

// Every open window, as BrowserWindow.getAllWindows() reports them. Stats
// updates broadcast to all of them (any window can show the dashboard).
const openWindows = vi.hoisted(() => ({ all: [] as unknown[] }));

// Mock electron's ipcMain, BrowserWindow, and app
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: { getAllWindows: vi.fn(() => openWindows.all) },
	app: {
		// Stats handler now registers a before-quit hook to flush the
		// query-events buffer; tests don't exercise the hook so a noop is fine.
		on: vi.fn(),
		getPath: vi.fn().mockReturnValue('/mock/user/data'),
		getVersion: vi.fn().mockReturnValue('0.0.0-test'),
	},
}));

// The export handler delegates to exportUsageData (covered in
// usage-export.test.ts); the token accessor would otherwise read real agent
// session files from disk.
const mockExportUsageData = vi.fn();
vi.mock('../../../../main/stats/usage-export', () => ({
	exportUsageData: (...args: unknown[]) => mockExportUsageData(...args),
}));
// The delegation reads live in usage-dashboard-reads.ts (covered in
// usage-dashboard-reads.test.ts); the handlers only forward the range.
const mockGetDelegationTotals = vi.fn();
const mockGetDelegationByDay = vi.fn();
vi.mock('../../../../main/stats/usage-dashboard-reads', () => ({
	getDelegationTotals: (...args: unknown[]) => mockGetDelegationTotals(...args),
	getDelegationByDay: (...args: unknown[]) => mockGetDelegationByDay(...args),
}));
const mockGetTokenUsageAggregate = vi.fn();
vi.mock('../../../../main/stats/token-usage/token-usage-accessor', () => ({
	getTokenUsageAggregate: (...args: unknown[]) => mockGetTokenUsageAggregate(...args),
}));

// Mock the stats-db module
vi.mock('../../../../main/stats', () => ({
	getStatsDB: vi.fn(),
}));

// Mock the query-events buffer so tests can verify it's called without
// needing a real SQLite DB. PR-B 1.5: the IPC handler now enqueues into
// this buffer instead of calling db.insertQueryEvent directly.
const mockEnqueueQueryEvent = vi.fn(() => 'buffered-query-event-id');
const mockFlushQueryEventsSync = vi.fn();
// The flush listener the handler registers: query events are announced when
// the buffer commits them, not when they are enqueued. `flushBuffer()` plays
// the commit.
const bufferFlush = vi.hoisted(() => ({ listener: null as ((count: number) => void) | null }));
vi.mock('../../../../main/stats/query-events-buffer', () => ({
	enqueueQueryEvent: (...args: unknown[]) => mockEnqueueQueryEvent(...args),
	flushQueryEventsSync: () => mockFlushQueryEventsSync(),
	setQueryEventsFlushListener: (listener: ((count: number) => void) | null) => {
		bufferFlush.listener = listener;
	},
}));
function flushBuffer(count = 1): void {
	bufferFlush.listener?.(count);
}

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the web-desktop bridge fanout. stats:updated now routes through
// safeSend, which always broadcasts to bridge clients regardless of the
// desktop renderer's liveness. Mocking it lets us assert web clients receive
// the event even when the Electron window is null or destroyed.
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';

describe('stats IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockStatsDB: Partial<StatsDB>;
	let mockMainWindow: {
		webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> };
		isDestroyed: ReturnType<typeof vi.fn>;
	};
	let getMainWindow: () => typeof mockMainWindow | null;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Create mock stats database
		mockStatsDB = {
			// PR-B 1.5: the record-query handler no longer calls insertQueryEvent;
			// it enqueues into query-events-buffer instead. Other paths (auto-run,
			// session-lifecycle) still call the direct DB methods.
			database: {} as never,
			insertQueryEvent: vi.fn().mockReturnValue('query-event-id'),
			insertAutoRunSession: vi.fn().mockReturnValue('autorun-session-id'),
			updateAutoRunSession: vi.fn().mockReturnValue(true),
			finishAutoRunSession: vi.fn().mockReturnValue(true),
			getAutoRunTurnsByHour: vi.fn().mockReturnValue([]),
			getShortcutUsageByShortcut: vi.fn().mockReturnValue([]),
			insertAutoRunTask: vi.fn().mockReturnValue('autorun-task-id'),
			getQueryEvents: vi.fn().mockReturnValue([]),
			getAutoRunSessions: vi.fn().mockReturnValue([]),
			getAutoRunTasks: vi.fn().mockReturnValue([]),
			getAggregatedStats: vi.fn().mockReturnValue({
				totalQueries: 0,
				totalDuration: 0,
				avgDuration: 0,
				byAgent: {},
				bySource: { user: 0, auto: 0 },
				byLocation: { local: 0, remote: 0 },
				byDay: [],
				byHour: [],
				byDayHour: [],
				window: { startYmd: '2026-11-08', endYmd: '2026-11-14' },
				earliestQueryAt: null,
				streak: { current: 0, longest: 0 },
				totalSessions: 0,
				byAgentByDay: {},
				bySessionByDay: {},
				bySessionSource: {},
				bySessionLastQuery: {},
				bySessionTokens: {},
				worktreeQueries: 0,
				parentQueries: 0,
				byAgentWorktree: {},
				imageAnnotations: 0,
			}),
			getInitializationResult: vi.fn().mockReturnValue(null),
			clearInitializationResult: vi.fn(),
			recordResilienceEvent: vi.fn().mockReturnValue('resilience-id'),
			recordWizardRun: vi.fn().mockReturnValue('wizard-run-id'),
			getDatabaseSize: vi.fn().mockReturnValue({ sizeBytes: 1024, sizeFormatted: '1 KB' }),
			recordSessionCreated: vi.fn().mockReturnValue('session-lifecycle-id'),
			recordSessionClosed: vi.fn().mockReturnValue(true),
			getSessionLifecycleEvents: vi.fn().mockReturnValue([]),
			incrementShortcutUsage: vi.fn().mockReturnValue('2026-06-21'),
			isReady: vi.fn().mockReturnValue(true),
		};

		vi.mocked(statsDbModule.getStatsDB).mockReturnValue(mockStatsDB as unknown as StatsDB);

		// Create mock main window with webContents.send
		mockMainWindow = {
			webContents: {
				send: vi.fn(),
				isDestroyed: vi.fn().mockReturnValue(false),
			},
			isDestroyed: vi.fn().mockReturnValue(false),
		};

		getMainWindow = () => mockMainWindow;
		openWindows.all = [mockMainWindow];

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers with our mock getMainWindow
		registerStatsHandlers({});
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all stats handlers', () => {
			const expectedChannels = [
				'stats:record-query',
				'stats:start-autorun',
				'stats:end-autorun',
				'stats:record-task',
				'stats:get-stats',
				'stats:get-autorun-sessions',
				'stats:get-autorun-turns-by-hour',
				'stats:get-shortcut-usage-by-shortcut',
				'stats:get-aggregation',
				'stats:export',
				'stats:get-database-size',
				'stats:record-session-created',
				'stats:record-session-closed',
				'stats:get-session-lifecycle',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});

		it('no longer registers the retired cleanup and earliest-timestamp channels', () => {
			expect(handlers.has('stats:clear-old-data')).toBe(false);
			expect(handlers.has('stats:get-earliest-timestamp')).toBe(false);
		});

		// PR-B 1.5: registerStatsHandlers must wire flushQueryEventsSync to
		// app:before-quit so buffered events aren't lost on quit.
		it('registers a before-quit handler that flushes the query event buffer', async () => {
			const { app } = await import('electron');
			const beforeQuitCalls = vi.mocked(app.on).mock.calls.filter((c) => c[0] === 'before-quit');
			expect(beforeQuitCalls.length).toBeGreaterThanOrEqual(1);

			// Capture the most-recently-registered before-quit handler - the
			// stats handler is one of several modules that may register on
			// this event, so we don't assume length === 1.
			const handler = beforeQuitCalls[beforeQuitCalls.length - 1][1] as () => void;
			mockFlushQueryEventsSync.mockClear();

			handler();

			expect(mockFlushQueryEventsSync).toHaveBeenCalledTimes(1);
		});

		it('before-quit handler swallows flush errors (does not block shutdown)', async () => {
			const { app } = await import('electron');
			const beforeQuitCalls = vi.mocked(app.on).mock.calls.filter((c) => c[0] === 'before-quit');
			const handler = beforeQuitCalls[beforeQuitCalls.length - 1][1] as () => void;

			mockFlushQueryEventsSync.mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			// Should NOT propagate - failing to flush stats must not block
			// app shutdown. Sentry capture is fire-and-forget inside the catch.
			expect(() => handler()).not.toThrow();
		});
	});

	describe('stats:updated broadcast verification', () => {
		describe('stats:record-query', () => {
			it('should broadcast stats:updated after recording a query event', async () => {
				const handler = handlers.get('stats:record-query');
				const queryEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: Date.now(),
					duration: 5000,
					projectPath: '/test/project',
					tabId: 'tab-1',
				};

				await handler!({} as any, queryEvent);

				// PR-B 1.5: enqueueQueryEvent is called instead of insertQueryEvent
				expect(mockEnqueueQueryEvent).toHaveBeenCalledWith(mockStatsDB.database, queryEvent);
				// Nothing is announced until the buffer commits the row...
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();

				flushBuffer();

				// ...then every window and web-desktop client hears which table moved.
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
					'stats:updated',
					'query_events'
				);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('stats:updated', ['query_events']);
			});

			it('reaches every open window, not just the main one', async () => {
				const secondWindow = {
					webContents: { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) },
					isDestroyed: vi.fn().mockReturnValue(false),
				};
				openWindows.all = [mockMainWindow, secondWindow];

				await handlers.get('stats:record-task')!({} as any, {
					autoRunSessionId: 'autorun-session-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					taskIndex: 0,
					startTime: Date.now(),
					duration: 1000,
					success: true,
				});

				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
				expect(secondWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
			});

			it('should not broadcast when no window is open', async () => {
				openWindows.all = [];

				const handler = handlers.get('stats:record-query');
				const queryEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: Date.now(),
					duration: 5000,
				};

				await handler!({} as any, queryEvent);
				flushBuffer();

				// No error should be thrown, and no send should happen
				expect(mockEnqueueQueryEvent).toHaveBeenCalled();
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});

			it('should not broadcast when main window is destroyed', async () => {
				mockMainWindow.isDestroyed.mockReturnValue(true);

				const handler = handlers.get('stats:record-query');
				const queryEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: Date.now(),
					duration: 5000,
				};

				await handler!({} as any, queryEvent);
				flushBuffer();

				expect(mockEnqueueQueryEvent).toHaveBeenCalled();
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});

			/**
			 * Web Login attribution. The row is written by the DESKTOP renderer's
			 * exit listener even for a turn a browser sent, so the account comes
			 * from what the spawn noted (keyed by agent + tab) rather than from
			 * `getActingUser()`, which is undefined out here.
			 */
			describe('Web Login attribution', () => {
				afterEach(() => {
					resetTurnActors();
				});

				const baseEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: 1,
					duration: 2,
					tabId: 'tab-3',
				};

				it('stamps the account the spawn noted for this agent and tab', async () => {
					noteTurnActor('session-1', 'tab-3', {
						id: 'u1',
						username: 'pedram',
						displayName: 'Pedram A',
					});

					await handlers.get('stats:record-query')!({} as any, baseEvent);

					expect(mockEnqueueQueryEvent).toHaveBeenCalledWith(
						mockStatsDB.database,
						expect.objectContaining({ userName: 'pedram' })
					);
				});

				it('leaves a desktop turn unattributed', async () => {
					await handlers.get('stats:record-query')!({} as any, baseEvent);

					const recorded = mockEnqueueQueryEvent.mock.calls[0][1] as { userName?: string };
					expect(recorded.userName).toBeUndefined();
				});

				it('does not credit a turn from another tab of the same agent', async () => {
					noteTurnActor('session-1', 'tab-3', {
						id: 'u1',
						username: 'pedram',
						displayName: 'Pedram A',
					});

					await handlers.get('stats:record-query')!({} as any, { ...baseEvent, tabId: 'tab-9' });

					const recorded = mockEnqueueQueryEvent.mock.calls[0][1] as { userName?: string };
					expect(recorded.userName).toBeUndefined();
				});

				it('prefers a live acting user over the noted actor', async () => {
					noteTurnActor('session-1', 'tab-3', {
						id: 'u1',
						username: 'pedram',
						displayName: 'Pedram A',
					});

					await runAsActingUser({ id: 'u2', username: 'raza', displayName: 'Raza' }, () =>
						handlers.get('stats:record-query')!({} as any, baseEvent)
					);

					const recorded = mockEnqueueQueryEvent.mock.calls[0][1] as { userName?: string };
					expect(recorded.userName).toBe('raza');
				});
			});
		});

		describe('web-desktop bridge fanout', () => {
			it('should still reach bridge clients when no window is open', async () => {
				openWindows.all = [];

				const handler = handlers.get('stats:record-query');
				await handler!({} as any, {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: Date.now(),
					duration: 5000,
				});

				flushBuffer();

				// Desktop renderer skipped (no window), but web clients still get it.
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('stats:updated', ['query_events']);
			});

			it('should still reach bridge clients when the main window is destroyed', async () => {
				mockMainWindow.isDestroyed.mockReturnValue(true);

				const handler = handlers.get('stats:record-query');
				await handler!({} as any, {
					sessionId: 'session-1',
					agentType: 'claude-code',
					source: 'user' as const,
					startTime: Date.now(),
					duration: 5000,
				});

				flushBuffer();

				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('stats:updated', ['query_events']);
			});
		});

		describe('stats:start-autorun', () => {
			it('should broadcast stats:updated after starting an Auto Run session', async () => {
				const handler = handlers.get('stats:start-autorun');
				const autoRunSession = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					documentPath: '/docs/task.md',
					startTime: Date.now(),
					tasksTotal: 5,
					projectPath: '/test/project',
				};

				const result = await handler!({} as any, autoRunSession);

				expect(result).toBe('autorun-session-id');
				expect(mockStatsDB.insertAutoRunSession).toHaveBeenCalled();
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
			});

			it('passes the run kind through to the database', async () => {
				const handler = handlers.get('stats:start-autorun');

				await handler!({} as any, {
					sessionId: 'session-1',
					agentType: 'claude-code',
					startTime: Date.now(),
					kind: 'goal-driven',
				});

				expect(mockStatsDB.insertAutoRunSession).toHaveBeenCalledWith(
					expect.objectContaining({ kind: 'goal-driven', duration: 0 })
				);
			});

			it('accepts a start with no kind', async () => {
				const handler = handlers.get('stats:start-autorun');

				await expect(
					handler!({} as any, {
						sessionId: 'session-1',
						agentType: 'claude-code',
						startTime: Date.now(),
					})
				).resolves.toBe('autorun-session-id');

				const calls = mockStatsDB.insertAutoRunSession.mock.calls;
				expect(calls[calls.length - 1][0].kind).toBeUndefined();
			});
		});

		describe('stats:end-autorun', () => {
			it('should broadcast stats:updated after ending an Auto Run session', async () => {
				const handler = handlers.get('stats:end-autorun');

				const result = await handler!({} as any, 'autorun-session-id', 60000, 4);

				expect(result).toBe(true);
				expect(mockStatsDB.finishAutoRunSession).toHaveBeenCalledWith(
					'autorun-session-id',
					60000,
					4,
					undefined,
					undefined
				);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
			});

			it('should broadcast stats:updated even when session not found', async () => {
				vi.mocked(mockStatsDB.finishAutoRunSession!).mockReturnValue(false);

				const handler = handlers.get('stats:end-autorun');
				const result = await handler!({} as any, 'nonexistent-id', 60000, 4);

				expect(result).toBe(false);
				// Should still broadcast - UI may need to refresh regardless
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
			});
		});

		describe('stats:end-autorun tasks total', () => {
			it('forwards a finite tasksTotal and drops anything else', async () => {
				const handler = handlers.get('stats:end-autorun');

				await handler!({} as any, 'run-1', 1000, 12, 12);
				expect(mockStatsDB.finishAutoRunSession).toHaveBeenLastCalledWith(
					'run-1',
					1000,
					12,
					12,
					undefined
				);

				await handler!({} as any, 'run-2', 1000, 3, Number.NaN);
				expect(mockStatsDB.finishAutoRunSession).toHaveBeenLastCalledWith(
					'run-2',
					1000,
					3,
					undefined,
					undefined
				);
			});
		});

		describe('stats:end-autorun outcome', () => {
			it('forwards the outcome and its failures', async () => {
				const handler = handlers.get('stats:end-autorun');
				const failures = [
					{
						kind: 'halt',
						documentFilename: 'A.md',
						taskIndex: 2,
						agentType: 'codex',
						createdAt: 5,
					},
				];

				await handler!({} as any, 'run-1', 1000, 2, 3, {
					status: 'failed',
					documentsStalled: 0,
					failures,
				});

				expect(mockStatsDB.finishAutoRunSession).toHaveBeenLastCalledWith('run-1', 1000, 2, 3, {
					status: 'failed',
					documentsStalled: 0,
					failures,
				});
			});

			it('drops an outcome that is not an object and a failures field that is not a list', async () => {
				const handler = handlers.get('stats:end-autorun');

				await handler!({} as any, 'run-1', 1000, 2, 3, 'completed');
				expect(mockStatsDB.finishAutoRunSession).toHaveBeenLastCalledWith(
					'run-1',
					1000,
					2,
					3,
					undefined
				);

				await handler!({} as any, 'run-2', 1000, 2, 3, { status: 'completed', failures: 'nope' });
				expect(mockStatsDB.finishAutoRunSession).toHaveBeenLastCalledWith('run-2', 1000, 2, 3, {
					status: 'completed',
					failures: [],
				});
			});
		});

		describe('stats:get-autorun-turns-by-hour', () => {
			it('reads the grouped turns for the range', async () => {
				const hours = [{ hour: 9, count: 2, successCount: 1 }];
				vi.mocked(mockStatsDB.getAutoRunTurnsByHour!).mockReturnValue(hours);
				const handler = handlers.get('stats:get-autorun-turns-by-hour');

				expect(await handler!({} as any, 'week')).toBe(hours);
				expect(mockStatsDB.getAutoRunTurnsByHour).toHaveBeenCalledWith('week');
			});
		});

		describe('stats:get-shortcut-usage-by-shortcut', () => {
			it('reads per-shortcut counts for the range', async () => {
				const rows = [{ shortcutId: 'toggleSidebar', count: 4 }];
				vi.mocked(mockStatsDB.getShortcutUsageByShortcut!).mockReturnValue(rows);
				const handler = handlers.get('stats:get-shortcut-usage-by-shortcut');

				expect(await handler!({} as any, 'month')).toBe(rows);
				expect(mockStatsDB.getShortcutUsageByShortcut).toHaveBeenCalledWith('month');
			});
		});

		describe('stats:record-task', () => {
			it('should broadcast stats:updated after recording an Auto Run task', async () => {
				const handler = handlers.get('stats:record-task');
				const task = {
					autoRunSessionId: 'autorun-session-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					taskIndex: 0,
					taskContent: 'First task',
					startTime: Date.now(),
					duration: 10000,
					success: true,
				};

				const result = await handler!({} as any, task);

				expect(result).toBe('autorun-task-id');
				expect(mockStatsDB.insertAutoRunTask).toHaveBeenCalledWith(task);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'auto_run');
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
			});
		});

		describe('stats:record-shortcut-usage', () => {
			it('records usage and broadcasts when the stats DB is ready', async () => {
				const handler = handlers.get('stats:record-shortcut-usage');
				const firedAt = Date.UTC(2026, 5, 21, 12, 0, 0);

				const result = await handler!({} as any, firedAt);

				expect(result).toBe('2026-06-21');
				expect(mockStatsDB.incrementShortcutUsage).toHaveBeenCalledWith(firedAt, undefined);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
					'stats:updated',
					'shortcut_usage'
				);
			});

			it('passes the shortcut id through, ignoring a non-string one', async () => {
				const handler = handlers.get('stats:record-shortcut-usage');
				const firedAt = Date.UTC(2026, 5, 21, 12, 0, 0);

				await handler!({} as any, firedAt, 'toggleSidebar');
				expect(mockStatsDB.incrementShortcutUsage).toHaveBeenLastCalledWith(
					firedAt,
					'toggleSidebar'
				);

				await handler!({} as any, firedAt, 42);
				expect(mockStatsDB.incrementShortcutUsage).toHaveBeenLastCalledWith(firedAt, undefined);
			});

			// MAESTRO-SP: a shortcut can fire before the stats DB finishes
			// initializing. The handler must skip silently rather than throw
			// "Database not initialized" (which would otherwise propagate across
			// the IPC bridge into the renderer and Sentry).
			it('skips silently without throwing when the stats DB is not yet ready', async () => {
				vi.mocked(mockStatsDB.isReady!).mockReturnValue(false);
				const handler = handlers.get('stats:record-shortcut-usage');

				const result = await handler!({} as any, Date.now());

				expect(result).toBeNull();
				expect(mockStatsDB.incrementShortcutUsage).not.toHaveBeenCalled();
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});
	});

	describe('read-only operations should not broadcast', () => {
		describe('stats:get-stats', () => {
			it('should not broadcast stats:updated when getting stats', async () => {
				const handler = handlers.get('stats:get-stats');

				await handler!({} as any, 'week', { agentType: 'claude-code' });

				expect(mockStatsDB.getQueryEvents).toHaveBeenCalledWith('week', {
					agentType: 'claude-code',
				});
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});

		describe('stats:get-autorun-sessions', () => {
			it('should not broadcast stats:updated when getting Auto Run sessions', async () => {
				const handler = handlers.get('stats:get-autorun-sessions');

				await handler!({} as any, 'month');

				expect(mockStatsDB.getAutoRunSessions).toHaveBeenCalledWith('month');
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});

		describe('stats:get-aggregation', () => {
			it('should not broadcast stats:updated when getting aggregation', async () => {
				const handler = handlers.get('stats:get-aggregation');

				await handler!({} as any, 'year');

				expect(mockStatsDB.getAggregatedStats).toHaveBeenCalledWith('year');
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});

		describe('delegation reads', () => {
			it('forward the range to the shared delegation reads', async () => {
				mockGetDelegationTotals.mockReturnValue({ totals: true });
				mockGetDelegationByDay.mockReturnValue([{ date: '2026-11-14' }]);

				await expect(
					handlers.get('stats:get-delegation-totals')!({} as any, 'month')
				).resolves.toEqual({ totals: true });
				await expect(handlers.get('stats:get-delegation-by-day')!({} as any)).resolves.toEqual([
					{ date: '2026-11-14' },
				]);
				expect(mockGetDelegationTotals).toHaveBeenCalledWith('month');
				expect(mockGetDelegationByDay).toHaveBeenCalledWith('all');
			});
		});

		describe('stats:export', () => {
			it('hands the request to exportUsageData and does not broadcast stats:updated', async () => {
				const result = { path: '/tmp/usage.json', format: 'json', rowCounts: {}, notes: [] };
				mockExportUsageData.mockResolvedValue(result);
				const handler = handlers.get('stats:export');

				await expect(handler!({} as any, 'all', 'json', '/tmp/usage.json')).resolves.toEqual(
					result
				);

				expect(mockExportUsageData).toHaveBeenCalledWith(
					expect.objectContaining({
						range: 'all',
						format: 'json',
						filePath: '/tmp/usage.json',
						appVersion: '0.0.0-test',
					})
				);
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});
	});

	describe('broadcast timing', () => {
		it('should broadcast only once the buffer commits the query event', async () => {
			const executionOrder: string[] = [];

			mockEnqueueQueryEvent.mockImplementation(() => {
				executionOrder.push('enqueue');
				return 'buffered-id';
			});

			mockMainWindow.webContents.send = vi.fn().mockImplementation(() => {
				executionOrder.push('broadcast');
			});

			const handler = handlers.get('stats:record-query');
			await handler!({} as any, {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user' as const,
				startTime: Date.now(),
				duration: 5000,
			});

			// Enqueue is sync (no DB write yet); the broadcast waits for the commit,
			// so a dashboard refetching on it reads the new row.
			expect(executionOrder).toEqual(['enqueue']);
			flushBuffer();
			expect(executionOrder).toEqual(['enqueue', 'broadcast']);
		});
	});

	describe('multiple write operations', () => {
		it('should broadcast once per write operation', async () => {
			// Record query
			const recordQueryHandler = handlers.get('stats:record-query');
			await recordQueryHandler!({} as any, {
				sessionId: 'session-1',
				agentType: 'claude-code',
				source: 'user' as const,
				startTime: Date.now(),
				duration: 5000,
			});

			// Start auto run
			const startAutoRunHandler = handlers.get('stats:start-autorun');
			await startAutoRunHandler!({} as any, {
				sessionId: 'session-1',
				agentType: 'claude-code',
				startTime: Date.now(),
				tasksTotal: 3,
			});

			// Record task
			const recordTaskHandler = handlers.get('stats:record-task');
			await recordTaskHandler!({} as any, {
				autoRunSessionId: 'autorun-session-id',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				startTime: Date.now(),
				duration: 10000,
				success: true,
			});

			// End auto run
			const endAutoRunHandler = handlers.get('stats:end-autorun');
			await endAutoRunHandler!({} as any, 'autorun-session-id', 60000, 3);

			// The buffered query event commits last
			flushBuffer();

			// Should have broadcast 4 times (once per write operation)
			expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(4);
			expect(mockMainWindow.webContents.send).toHaveBeenNthCalledWith(
				1,
				'stats:updated',
				'auto_run'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenNthCalledWith(
				2,
				'stats:updated',
				'auto_run'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenNthCalledWith(
				3,
				'stats:updated',
				'auto_run'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenNthCalledWith(
				4,
				'stats:updated',
				'query_events'
			);
		});
	});

	describe('session lifecycle handlers', () => {
		describe('stats:record-session-created', () => {
			it('should broadcast stats:updated after recording session created', async () => {
				const handler = handlers.get('stats:record-session-created');
				const lifecycleEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					projectPath: '/test/project',
					createdAt: Date.now(),
					isRemote: false,
				};

				const result = await handler!({} as any, lifecycleEvent);

				expect(result).toBe('session-lifecycle-id');
				expect(mockStatsDB.recordSessionCreated).toHaveBeenCalledWith(lifecycleEvent);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
					'stats:updated',
					'session_lifecycle'
				);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
			});

			it('should not send to a window when none is open', async () => {
				openWindows.all = [];

				const handler = handlers.get('stats:record-session-created');
				const lifecycleEvent = {
					sessionId: 'session-1',
					agentType: 'claude-code',
					createdAt: Date.now(),
				};

				await handler!({} as any, lifecycleEvent);

				expect(mockStatsDB.recordSessionCreated).toHaveBeenCalled();
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});

			it('should skip silently when the stats DB is not yet initialized', async () => {
				vi.mocked(mockStatsDB.isReady!).mockReturnValue(false);
				const handler = handlers.get('stats:record-session-created');

				const result = await handler!({} as any, {
					sessionId: 'session-1',
					agentType: 'claude-code',
					createdAt: Date.now(),
				});

				expect(result).toBeNull();
				expect(mockStatsDB.recordSessionCreated).not.toHaveBeenCalled();
			});
		});

		describe('stats:record-session-closed', () => {
			it('should broadcast stats:updated after recording session closed', async () => {
				const handler = handlers.get('stats:record-session-closed');
				const sessionId = 'session-1';
				const closedAt = Date.now();

				const result = await handler!({} as any, sessionId, closedAt);

				expect(result).toBe(true);
				expect(mockStatsDB.recordSessionClosed).toHaveBeenCalledWith(sessionId, closedAt);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
					'stats:updated',
					'session_lifecycle'
				);
				expect(mockMainWindow.webContents.send).toHaveBeenCalledTimes(1);
			});

			it('should skip silently when the stats DB is not yet initialized', async () => {
				vi.mocked(mockStatsDB.isReady!).mockReturnValue(false);
				const handler = handlers.get('stats:record-session-closed');

				const result = await handler!({} as any, 'session-1', Date.now());

				expect(result).toBe(false);
				expect(mockStatsDB.recordSessionClosed).not.toHaveBeenCalled();
			});

			it('should broadcast stats:updated even when session not found', async () => {
				vi.mocked(mockStatsDB.recordSessionClosed).mockReturnValue(false);

				const handler = handlers.get('stats:record-session-closed');
				const result = await handler!({} as any, 'nonexistent-session', Date.now());

				expect(result).toBe(false);
				// Should still broadcast - UI may need to refresh regardless
				expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
					'stats:updated',
					'session_lifecycle'
				);
			});
		});

		describe('stats:get-session-lifecycle', () => {
			it('should not broadcast stats:updated when getting session lifecycle events', async () => {
				const handler = handlers.get('stats:get-session-lifecycle');

				await handler!({} as any, 'week');

				expect(mockStatsDB.getSessionLifecycleEvents).toHaveBeenCalledWith('week');
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			});
		});
	});

	describe('resilience and wizard writes', () => {
		it('broadcasts the resilience table after recording an outage', async () => {
			const result = await handlers.get('stats:record-resilience')!({} as any, {
				id: 'outage-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				strategy: 'availability',
				outcome: 'recovered',
				startedAt: 1,
				resolvedAt: 2,
				retries: 1,
			});

			expect(result).toBe('resilience-id');
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'resilience');
		});

		it('broadcasts the wizard table after a wizard milestone', async () => {
			const result = await handlers.get('stats:record-wizard-run')!({} as any, {
				id: 'run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				surface: 'inline',
				mode: 'new',
				outcome: 'in-progress',
				startedAt: 1,
				endedAt: 2,
				exchanges: 1,
				documents: 0,
				tasks: 0,
			});

			expect(result).toBe('wizard-run-id');
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stats:updated', 'wizard_runs');
		});
	});

	describe('initialization result', () => {
		it('returns what opening the database had to do', async () => {
			const notice = {
				success: true,
				wasReset: true,
				backupPath: '/data/stats.db.corrupted.1',
				userMessage: 'The usage statistics database was damaged...',
			};
			vi.mocked(mockStatsDB.getInitializationResult!).mockReturnValue(notice);

			await expect(handlers.get('stats:get-initialization-result')!({} as any)).resolves.toEqual(
				notice
			);
		});

		it('returns null when the database opened cleanly', async () => {
			await expect(handlers.get('stats:get-initialization-result')!({} as any)).resolves.toBeNull();
		});

		it('clears the result once the renderer has shown it', async () => {
			await expect(handlers.get('stats:clear-initialization-result')!({} as any)).resolves.toBe(
				true
			);
			expect(mockStatsDB.clearInitializationResult).toHaveBeenCalledTimes(1);
		});
	});
});

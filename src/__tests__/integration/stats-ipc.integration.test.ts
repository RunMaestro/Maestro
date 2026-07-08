import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
	appOn: vi.fn(),
	handle: vi.fn(),
}));

const statsMocks = vi.hoisted(() => ({
	getStatsDB: vi.fn(),
}));

const queryBufferMocks = vi.hoisted(() => ({
	enqueueQueryEvent: vi.fn(() => 'buffered-query-event-id'),
	flushQueryEventsSync: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		on: electronMocks.appOn,
	},
	BrowserWindow: vi.fn(),
	ipcMain: {
		handle: electronMocks.handle,
	},
}));

vi.mock('../../main/stats', () => ({
	getStatsDB: statsMocks.getStatsDB,
}));

vi.mock('../../main/stats/query-events-buffer', () => ({
	enqueueQueryEvent: queryBufferMocks.enqueueQueryEvent,
	flushQueryEventsSync: queryBufferMocks.flushQueryEventsSync,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import { registerStatsHandlers } from '../../main/ipc/handlers/stats';
import { logger } from '../../main/utils/logger';

function createStatsDb() {
	return {
		database: {},
		insertQueryEvent: vi.fn(() => 'query-1'),
		insertAutoRunSession: vi.fn(() => 'autorun-1'),
		updateAutoRunSession: vi.fn(() => true),
		insertAutoRunTask: vi.fn(() => 'task-1'),
		getQueryEvents: vi.fn(() => [{ id: 'query-1' }]),
		getAutoRunSessions: vi.fn(() => [{ id: 'autorun-1' }]),
		getAutoRunTasks: vi.fn(() => [{ id: 'task-1' }]),
		getAggregatedStats: vi.fn(() => ({ totalQueries: 1 })),
		exportToCsv: vi.fn(() => 'id,sessionId\nquery-1,session-1'),
		clearOldData: vi.fn(() => ({ success: true, deletedRows: 2 })),
		getDatabaseSize: vi.fn(() => ({ bytes: 1024, formatted: '1 KB' })),
		recordSessionCreated: vi.fn(() => 'lifecycle-1'),
		recordSessionClosed: vi.fn(() => true),
		getSessionLifecycleEvents: vi.fn(() => [{ sessionId: 'session-1' }]),
		incrementShortcutUsage: vi.fn(() => '2026-05-27'),
		getShortcutUsageByDay: vi.fn(() => [{ date: '2026-05-27', count: 2 }]),
		getShortcutUsageTotal: vi.fn(() => 2),
		insertImageAnnotation: vi.fn(() => 'image-1'),
		getEarliestTimestamp: vi.fn(() => 123),
	};
}

async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = electronMocks.handlers.get(channel);
	if (!handler) {
		throw new Error(`Missing IPC handler: ${channel}`);
	}
	return (await handler({}, ...args)) as T;
}

describe('stats IPC handlers integration', () => {
	let db: ReturnType<typeof createStatsDb>;
	let webContents: { send: ReturnType<typeof vi.fn> };
	let mainWindow: { isDestroyed: ReturnType<typeof vi.fn>; webContents: typeof webContents };
	let getMainWindow: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		electronMocks.handlers.clear();
		electronMocks.appOn.mockReturnValue(undefined);
		electronMocks.handle.mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				electronMocks.handlers.set(channel, handler);
			}
		);
		db = createStatsDb();
		statsMocks.getStatsDB.mockReturnValue(db);
		webContents = { send: vi.fn() };
		mainWindow = { isDestroyed: vi.fn(() => false), webContents };
		getMainWindow = vi.fn(() => mainWindow);
	});

	it('registers and executes all stats handlers against the stats database', async () => {
		registerStatsHandlers({ getMainWindow });

		expect([...electronMocks.handlers.keys()]).toEqual([
			'stats:record-query',
			'stats:start-autorun',
			'stats:end-autorun',
			'stats:record-task',
			'stats:get-stats',
			'stats:get-autorun-sessions',
			'stats:get-autorun-tasks',
			'stats:get-aggregation',
			'stats:export-csv',
			'stats:clear-old-data',
			'stats:get-database-size',
			'stats:record-session-created',
			'stats:record-session-closed',
			'stats:get-session-lifecycle',
			'stats:record-shortcut-usage',
			'stats:get-shortcut-usage-by-day',
			'stats:get-shortcut-usage-total',
			'stats:record-image-annotation',
			'stats:get-earliest-timestamp',
			'stats:get-initialization-result',
			'stats:clear-initialization-result',
		]);

		const range = { start: 1, end: 10 };
		const query = {
			sessionId: 'session-1',
			agentType: 'codex',
			source: 'interactive',
			duration: 42,
			timestamp: 2,
		};
		const autorun = {
			sessionId: 'session-1',
			documentPath: '/repo/Auto Run Docs/Phase-01.md',
			startedAt: 3,
			totalTasks: 2,
		};
		const task = {
			autoRunSessionId: 'autorun-1',
			taskIndex: 0,
			taskText: 'Ship it',
			success: true,
			duration: 12,
			timestamp: 4,
		};
		const lifecycle = {
			sessionId: 'session-1',
			agentType: 'codex',
			projectPath: '/repo',
			createdAt: 5,
		};

		await expect(invoke('stats:record-query', query)).resolves.toBe('buffered-query-event-id');
		await expect(invoke('stats:start-autorun', autorun)).resolves.toBe('autorun-1');
		await expect(invoke('stats:end-autorun', 'autorun-1', 120, 2)).resolves.toBe(true);
		await expect(invoke('stats:record-task', task)).resolves.toBe('task-1');
		await expect(invoke('stats:get-stats', range, { agentType: 'codex' })).resolves.toEqual([
			{ id: 'query-1' },
		]);
		await expect(invoke('stats:get-autorun-sessions', range)).resolves.toEqual([
			{ id: 'autorun-1' },
		]);
		await expect(invoke('stats:get-autorun-tasks', 'autorun-1')).resolves.toEqual([
			{ id: 'task-1' },
		]);
		await expect(invoke('stats:get-aggregation', range)).resolves.toEqual({ totalQueries: 1 });
		await expect(invoke('stats:export-csv', range)).resolves.toBe(
			'id,sessionId\nquery-1,session-1'
		);
		await expect(invoke('stats:clear-old-data', 30)).resolves.toEqual({
			success: true,
			deletedRows: 2,
		});
		await expect(invoke('stats:get-database-size')).resolves.toEqual({
			bytes: 1024,
			formatted: '1 KB',
		});
		await expect(invoke('stats:record-session-created', lifecycle)).resolves.toBe('lifecycle-1');
		await expect(invoke('stats:record-session-closed', 'session-1', 20)).resolves.toBe(true);
		await expect(invoke('stats:get-session-lifecycle', range)).resolves.toEqual([
			{ sessionId: 'session-1' },
		]);
		await expect(invoke('stats:record-shortcut-usage', 6)).resolves.toBe('2026-05-27');
		await expect(invoke('stats:get-shortcut-usage-by-day', range)).resolves.toEqual([
			{ date: '2026-05-27', count: 2 },
		]);
		await expect(invoke('stats:get-shortcut-usage-total', range)).resolves.toBe(2);
		await expect(invoke('stats:record-image-annotation', 7)).resolves.toBe('image-1');
		await expect(invoke('stats:get-earliest-timestamp')).resolves.toBe(123);
		await expect(invoke('stats:get-initialization-result')).resolves.toBeNull();
		await expect(invoke('stats:clear-initialization-result')).resolves.toBe(true);

		expect(db.insertAutoRunSession).toHaveBeenCalledWith({ ...autorun, duration: 0 });
		expect(db.updateAutoRunSession).toHaveBeenCalledWith('autorun-1', {
			duration: 120,
			tasksCompleted: 2,
		});
		expect(queryBufferMocks.enqueueQueryEvent).toHaveBeenCalledWith(db.database, query);
		expect(db.getQueryEvents).toHaveBeenCalledWith(range, { agentType: 'codex' });
		expect(db.incrementShortcutUsage).toHaveBeenCalledWith(6);
		expect(db.getShortcutUsageByDay).toHaveBeenCalledWith(range);
		expect(db.getShortcutUsageTotal).toHaveBeenCalledWith(range);
		expect(db.insertImageAnnotation).toHaveBeenCalledWith(7);
		expect(webContents.send).toHaveBeenCalledWith('stats:updated');
		expect(logger.info).toHaveBeenCalledWith('Ended Auto Run session: autorun-1', '[Stats]', {
			duration: 120,
			tasksCompleted: 2,
		});
		expect(logger.debug).toHaveBeenCalledWith('Recorded session closed: session-1', '[Stats]');
	});

	it('skips record handlers when stats collection is explicitly disabled', async () => {
		const settingsStore = { get: vi.fn(() => false) };
		registerStatsHandlers({ getMainWindow, settingsStore });

		await expect(invoke('stats:record-query', { sessionId: 'session-1' })).resolves.toBeNull();
		await expect(invoke('stats:start-autorun', { sessionId: 'session-1' })).resolves.toBeNull();
		await expect(
			invoke('stats:record-task', { autoRunSessionId: 'autorun-1' })
		).resolves.toBeNull();
		await expect(
			invoke('stats:record-session-created', { sessionId: 'session-1' })
		).resolves.toBeNull();
		await expect(invoke('stats:record-shortcut-usage', 6)).resolves.toBeNull();
		await expect(invoke('stats:record-image-annotation', 7)).resolves.toBeNull();

		expect(db.insertQueryEvent).not.toHaveBeenCalled();
		expect(queryBufferMocks.enqueueQueryEvent).not.toHaveBeenCalled();
		expect(db.insertAutoRunSession).not.toHaveBeenCalled();
		expect(db.insertAutoRunTask).not.toHaveBeenCalled();
		expect(db.recordSessionCreated).not.toHaveBeenCalled();
		expect(db.incrementShortcutUsage).not.toHaveBeenCalled();
		expect(db.insertImageAnnotation).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalledWith(
			'Stats collection disabled, skipping query event',
			'[Stats]'
		);
	});

	it('handles non-broadcasting branches and propagates wrapped handler errors', async () => {
		registerStatsHandlers({ getMainWindow, settingsStore: { get: vi.fn(() => true) } });

		db.updateAutoRunSession.mockReturnValueOnce(false);
		await expect(invoke('stats:end-autorun', 'missing', 1, 0)).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith('Auto Run session not found: missing', '[Stats]');

		webContents.send.mockClear();
		db.clearOldData.mockReturnValueOnce({ success: false, deletedRows: 0 });
		await expect(invoke('stats:clear-old-data', 365)).resolves.toEqual({
			success: false,
			deletedRows: 0,
		});
		expect(webContents.send).not.toHaveBeenCalled();

		webContents.send.mockClear();
		mainWindow.isDestroyed.mockReturnValueOnce(true);
		await invoke('stats:record-task', {
			autoRunSessionId: 'autorun-1',
			taskIndex: 1,
			success: true,
		});
		expect(webContents.send).not.toHaveBeenCalled();

		getMainWindow.mockReturnValueOnce(null);
		await invoke('stats:record-query', {
			sessionId: 'session-2',
			agentType: 'claude-code',
			source: 'interactive',
			duration: 5,
		});
		expect(webContents.send).not.toHaveBeenCalled();

		db.recordSessionClosed.mockReturnValueOnce(false);
		await expect(invoke('stats:record-session-closed', 'missing-session', 100)).resolves.toBe(
			false
		);

		db.getQueryEvents.mockImplementationOnce(() => {
			throw new Error('db offline');
		});
		await expect(invoke('stats:get-stats', { start: 0, end: 1 })).rejects.toThrow('db offline');
		expect(logger.error).toHaveBeenCalledWith(
			'getStats error',
			'[Stats]',
			expect.objectContaining({ message: 'db offline' })
		);
	});
});

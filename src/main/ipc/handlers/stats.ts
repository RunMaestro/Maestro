/**
 * Stats IPC Handlers
 *
 * These handlers provide access to the stats tracking database for recording
 * and querying AI interaction metrics across Maestro sessions.
 *
 * Features:
 * - Record query events (interactive AI conversations)
 * - Track Auto Run sessions and individual tasks
 * - Query stats with time range and filter support
 * - Aggregated statistics for dashboard display
 * - CSV export for data analysis
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { getStatsDB } from '../../stats-db';
import {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
} from '../../../shared/stats-types';

const LOG_CONTEXT = '[Stats]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies for stats handlers
 */
export interface StatsHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	settingsStore?: {
		get: (key: string) => unknown;
	};
}

/**
 * Check if stats collection is enabled
 */
function isStatsCollectionEnabled(settingsStore?: { get: (key: string) => unknown }): boolean {
	if (!settingsStore) return true; // Default to enabled if no settings store
	const enabled = settingsStore.get('statsCollectionEnabled');
	// Default to true if not explicitly set to false
	return enabled !== false;
}

/**
 * Broadcast stats update to renderer
 */
function broadcastStatsUpdate(getMainWindow: () => BrowserWindow | null): void {
	const mainWindow = getMainWindow();
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('stats:updated');
	}
}

/**
 * Register all Stats-related IPC handlers.
 *
 * These handlers provide stats persistence and query operations:
 * - Record query events for interactive sessions
 * - Start/end Auto Run sessions
 * - Record individual Auto Run tasks
 * - Get stats with filtering and time range
 * - Get aggregated stats for dashboard
 * - Export stats to CSV
 */
export function registerStatsHandlers(deps: StatsHandlerDependencies): void {
	const { getMainWindow, settingsStore } = deps;

	// Record a query event (interactive conversation turn)
	ipcMain.handle(
		'stats:record-query',
		withIpcErrorLogging(handlerOpts('recordQuery'), async (event: Omit<QueryEvent, 'id'>) => {
			// Check if stats collection is enabled
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping query event', LOG_CONTEXT);
				return null;
			}

			const db = getStatsDB();
			const id = db.insertQueryEvent(event);
			logger.debug(`Recorded query event: ${id}`, LOG_CONTEXT, {
				sessionId: event.sessionId,
				agentType: event.agentType,
				source: event.source,
				duration: event.duration,
			});
			broadcastStatsUpdate(getMainWindow);
			return id;
		})
	);

	// Start an Auto Run session (returns ID for later updates)
	ipcMain.handle(
		'stats:start-autorun',
		withIpcErrorLogging(
			handlerOpts('startAutoRun'),
			async (session: Omit<AutoRunSession, 'id' | 'duration'>) => {
				// Check if stats collection is enabled
				if (!isStatsCollectionEnabled(settingsStore)) {
					logger.debug('Stats collection disabled, skipping Auto Run session start', LOG_CONTEXT);
					return null;
				}

				const db = getStatsDB();
				const fullSession: Omit<AutoRunSession, 'id'> = {
					...session,
					duration: 0, // Will be updated when session ends
				};
				const id = db.insertAutoRunSession(fullSession);
				logger.info(`Started Auto Run session: ${id}`, LOG_CONTEXT, {
					sessionId: session.sessionId,
					documentPath: session.documentPath,
				});
				broadcastStatsUpdate(getMainWindow);
				return id;
			}
		)
	);

	// End an Auto Run session (update duration and completed count)
	ipcMain.handle(
		'stats:end-autorun',
		withIpcErrorLogging(
			handlerOpts('endAutoRun'),
			async (id: string, duration: number, tasksCompleted: number) => {
				const db = getStatsDB();
				const updated = db.updateAutoRunSession(id, { duration, tasksCompleted });
				if (updated) {
					logger.info(`Ended Auto Run session: ${id}`, LOG_CONTEXT, {
						duration,
						tasksCompleted,
					});
				} else {
					logger.warn(`Auto Run session not found: ${id}`, LOG_CONTEXT);
				}
				broadcastStatsUpdate(getMainWindow);
				return updated;
			}
		)
	);

	// Record an Auto Run task completion
	ipcMain.handle(
		'stats:record-task',
		withIpcErrorLogging(handlerOpts('recordTask'), async (task: Omit<AutoRunTask, 'id'>) => {
			// Check if stats collection is enabled
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping Auto Run task', LOG_CONTEXT);
				return null;
			}

			const db = getStatsDB();
			const id = db.insertAutoRunTask(task);
			logger.debug(`Recorded Auto Run task: ${id}`, LOG_CONTEXT, {
				autoRunSessionId: task.autoRunSessionId,
				taskIndex: task.taskIndex,
				success: task.success,
			});
			broadcastStatsUpdate(getMainWindow);
			return id;
		})
	);

	// Get query events with time range and optional filters
	ipcMain.handle(
		'stats:get-stats',
		withIpcErrorLogging(
			handlerOpts('getStats'),
			async (range: StatsTimeRange, filters?: StatsFilters) => {
				const db = getStatsDB();
				return db.getQueryEvents(range, filters);
			}
		)
	);

	// Get Auto Run sessions within a time range
	ipcMain.handle(
		'stats:get-autorun-sessions',
		withIpcErrorLogging(handlerOpts('getAutoRunSessions'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getAutoRunSessions(range);
		})
	);

	// Get tasks for a specific Auto Run session
	ipcMain.handle(
		'stats:get-autorun-tasks',
		withIpcErrorLogging(handlerOpts('getAutoRunTasks'), async (autoRunSessionId: string) => {
			const db = getStatsDB();
			return db.getAutoRunTasks(autoRunSessionId);
		})
	);

	// Get aggregated stats for dashboard display
	ipcMain.handle(
		'stats:get-aggregation',
		withIpcErrorLogging(handlerOpts('getAggregation'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getAggregatedStats(range);
		})
	);

	// Export query events to CSV
	ipcMain.handle(
		'stats:export-csv',
		withIpcErrorLogging(handlerOpts('exportCsv'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.exportToCsv(range);
		})
	);

	// Clear old stats data (older than specified number of days)
	ipcMain.handle(
		'stats:clear-old-data',
		withIpcErrorLogging(handlerOpts('clearOldData'), async (olderThanDays: number) => {
			const db = getStatsDB();
			const result = db.clearOldData(olderThanDays);
			if (result.success) {
				// Broadcast update so any open dashboards refresh
				broadcastStatsUpdate(getMainWindow);
			}
			return result;
		})
	);

	// Get database size (for UI display)
	ipcMain.handle(
		'stats:get-database-size',
		withIpcErrorLogging(handlerOpts('getDatabaseSize'), async () => {
			const db = getStatsDB();
			return db.getDatabaseSize();
		})
	);

	// Record session creation (launched)
	ipcMain.handle(
		'stats:record-session-created',
		withIpcErrorLogging(
			handlerOpts('recordSessionCreated'),
			async (event: Omit<SessionLifecycleEvent, 'id' | 'closedAt' | 'duration'>) => {
				// Check if stats collection is enabled
				if (!isStatsCollectionEnabled(settingsStore)) {
					logger.debug('Stats collection disabled, skipping session creation', LOG_CONTEXT);
					return null;
				}

				const db = getStatsDB();
				const id = db.recordSessionCreated(event);
				logger.debug(`Recorded session created: ${event.sessionId}`, LOG_CONTEXT, {
					agentType: event.agentType,
					projectPath: event.projectPath,
				});
				broadcastStatsUpdate(getMainWindow);
				return id;
			}
		)
	);

	// Record session closure
	ipcMain.handle(
		'stats:record-session-closed',
		withIpcErrorLogging(
			handlerOpts('recordSessionClosed'),
			async (sessionId: string, closedAt: number) => {
				const db = getStatsDB();
				const updated = db.recordSessionClosed(sessionId, closedAt);
				if (updated) {
					logger.debug(`Recorded session closed: ${sessionId}`, LOG_CONTEXT);
				}
				broadcastStatsUpdate(getMainWindow);
				return updated;
			}
		)
	);

	// Get session lifecycle events within a time range
	ipcMain.handle(
		'stats:get-session-lifecycle',
		withIpcErrorLogging(handlerOpts('getSessionLifecycle'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getSessionLifecycleEvents(range);
		})
	);
}

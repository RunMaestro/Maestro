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

import { ipcMain, BrowserWindow, app } from 'electron';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend, SafeSendFn } from '../../utils/safe-send';
import { getStatsDB } from '../../stats';
import { isStatsCollectionEnabled } from '../../stats/utils';
import { flushTelemetry } from '../../cue/cue-telemetry';
import { enqueueQueryEvent, flushQueryEventsSync } from '../../stats/query-events-buffer';
import {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
} from '../../../shared/stats-types';
import type { TokenUsageQuery } from '../../../shared/tokenUsage';
import { getTokenUsageAggregate } from '../../stats/token-usage/token-usage-accessor';

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
 * Broadcast stats update to renderer and web-desktop bridge clients.
 */
function broadcastStatsUpdate(safeSend: SafeSendFn): void {
	safeSend('stats:updated');
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
	const safeSend = createSafeSend(getMainWindow);

	// PR-B 1.5: flush any buffered query events synchronously before the app
	// exits so we don't drop them. The handler is fire-and-forget - if it
	// throws (e.g. DB already closed) the buffer module logs it; we don't
	// want to block quit on stats persistence.
	app.on('before-quit', () => {
		try {
			flushQueryEventsSync();
		} catch (err) {
			logger.warn('Failed to flush query event buffer on quit', LOG_CONTEXT, err);
			// Surface to Sentry so we get a real signal in production -
			// quit-time data loss is the worst time to lose telemetry, since
			// we can't retry. Per CLAUDE.md §"Error Handling & Sentry".
			void captureException(err instanceof Error ? err : new Error(String(err)), {
				operation: 'stats:beforeQuitFlush',
			});
		}
	});

	// Record a query event (interactive conversation turn).
	//
	// PR-B 1.5: events are buffered and flushed in a single transaction every
	// 500ms or every 50 events (whichever first). This collapses many
	// per-turn fsyncs into one, on the streaming hot path. The buffered
	// id is generated synchronously and returned - callers don't need to
	// wait for the actual write.
	ipcMain.handle(
		'stats:record-query',
		withIpcErrorLogging(handlerOpts('recordQuery'), async (event: Omit<QueryEvent, 'id'>) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping query event', LOG_CONTEXT);
				return null;
			}

			const db = getStatsDB();
			const id = enqueueQueryEvent(db.database, event);
			logger.debug(`Buffered query event: ${id}`, LOG_CONTEXT, {
				sessionId: event.sessionId,
				agentType: event.agentType,
				source: event.source,
				duration: event.duration,
			});
			// Notify renderer that stats may have changed soon. The actual
			// write happens asynchronously; the dashboard is best-effort
			// realtime, so a small lag (≤500ms) is acceptable.
			broadcastStatsUpdate(safeSend);
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
				broadcastStatsUpdate(safeSend);
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
				broadcastStatsUpdate(safeSend);

				// Cue telemetry - autorun completion is the user's natural quiet
				// window, so we flush the outbox here. Fire-and-forget: a failed
				// flush leaves rows in the outbox for the next attempt and must
				// not delay the IPC return. The submitter checks Encore flags
				// internally; nothing happens if Cue/usageStats are off.
				flushTelemetry({ reason: 'autorun' }).catch((error) => {
					void captureException(error, {
						operation: 'stats:end-autorun.flushTelemetry',
					});
				});

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
			broadcastStatsUpdate(safeSend);
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

	// Token & cost usage aggregate for the Cost & Tokens dashboard. Reads each
	// agent's on-disk session storage (not the stats DB), served through a
	// per-session incremental cache. `force` bypasses the in-memory memo.
	ipcMain.handle(
		'stats:get-token-usage',
		withIpcErrorLogging(
			handlerOpts('getTokenUsage'),
			async (query: TokenUsageQuery = {}, force = false) => {
				return getTokenUsageAggregate(query, force);
			}
		)
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
				broadcastStatsUpdate(safeSend);
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
				// Fire-and-forget analytics: an agent can be created (restored on boot,
				// spawned by the wizard) before the stats DB has finished initializing.
				// Skip that window rather than throwing "Database not initialized", an
				// unactionable error that otherwise crosses the IPC bridge into Sentry.
				// (MAESTRO-2S, same startup race as MAESTRO-SP below.)
				if (!db.isReady()) {
					return null;
				}
				const id = db.recordSessionCreated(event);
				logger.debug(`Recorded session created: ${event.sessionId}`, LOG_CONTEXT, {
					agentType: event.agentType,
					projectPath: event.projectPath,
				});
				broadcastStatsUpdate(safeSend);
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
				// Same fire-and-forget startup race as record-session-created: agents torn
				// down during early boot would otherwise throw "Database not initialized".
				// (MAESTRO-2Z)
				if (!db.isReady()) {
					return false;
				}
				const updated = db.recordSessionClosed(sessionId, closedAt);
				if (updated) {
					logger.debug(`Recorded session closed: ${sessionId}`, LOG_CONTEXT);
				}
				broadcastStatsUpdate(safeSend);
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

	// Record a keyboard shortcut firing. Buckets the event into the local-time
	// day that contains `firedAt`. Idempotent at the call-site level only -
	// every invocation increments the daily counter by 1.
	ipcMain.handle(
		'stats:record-shortcut-usage',
		withIpcErrorLogging(handlerOpts('recordShortcutUsage'), async (firedAt: number) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				return null;
			}

			const db = getStatsDB();
			// Shortcut usage is fire-and-forget analytics. A shortcut can fire
			// during early startup before the stats DB has finished initializing;
			// skip silently in that window rather than throwing "Database not
			// initialized" - an unactionable error that otherwise propagates
			// across the IPC bridge and into Sentry. (MAESTRO-SP)
			if (!db.isReady()) {
				return null;
			}
			const date = db.incrementShortcutUsage(firedAt);
			broadcastStatsUpdate(safeSend);
			return date;
		})
	);

	// Get per-day shortcut usage counts within a time range
	ipcMain.handle(
		'stats:get-shortcut-usage-by-day',
		withIpcErrorLogging(handlerOpts('getShortcutUsageByDay'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getShortcutUsageByDay(range);
		})
	);

	// Get total shortcut firings within a time range (summary card)
	ipcMain.handle(
		'stats:get-shortcut-usage-total',
		withIpcErrorLogging(handlerOpts('getShortcutUsageTotal'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getShortcutUsageTotal(range);
		})
	);

	// Record an image annotation save event
	ipcMain.handle(
		'stats:record-image-annotation',
		withIpcErrorLogging(handlerOpts('recordImageAnnotation'), async (createdAt: number) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping image annotation', LOG_CONTEXT);
				return null;
			}

			const db = getStatsDB();
			const id = db.insertImageAnnotation(createdAt);
			logger.debug(`Recorded image annotation: ${id}`, LOG_CONTEXT);
			broadcastStatsUpdate(safeSend);
			return id;
		})
	);

	// Get earliest timestamp across all stats tables
	ipcMain.handle(
		'stats:get-earliest-timestamp',
		withIpcErrorLogging(handlerOpts('getEarliestTimestamp'), async () => {
			const db = getStatsDB();
			return db.getEarliestTimestamp();
		})
	);

	// Get initialization result (for showing database reset notification)
	ipcMain.handle(
		'stats:get-initialization-result',
		withIpcErrorLogging(handlerOpts('getInitializationResult'), async () => {
			// This feature is not yet implemented - return null for now
			// Future implementation would track if DB was reset due to corruption
			return null;
		})
	);

	// Clear initialization result (after user has acknowledged the notification)
	ipcMain.handle(
		'stats:clear-initialization-result',
		withIpcErrorLogging(handlerOpts('clearInitializationResult'), async () => {
			// This feature is not yet implemented - return true for now
			return true;
		})
	);
}

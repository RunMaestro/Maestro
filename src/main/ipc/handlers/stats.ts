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
 * - Usage export (JSON, or a zip of CSVs) for data analysis
 */

import { ipcMain, BrowserWindow, app } from 'electron';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend, SafeSendFn } from '../../utils/safe-send';
import { getStatsDB } from '../../stats';
import { isStatsCollectionEnabled } from '../../stats/utils';
import { flushTelemetry } from '../../cue/cue-telemetry';
import { exportUsageData } from '../../stats/usage-export';
import { getDelegationByDay, getDelegationTotals } from '../../stats/usage-dashboard-reads';
import {
	enqueueQueryEvent,
	flushQueryEventsSync,
	setQueryEventsFlushListener,
} from '../../stats/query-events-buffer';
import { getActingUser } from '../../web-server/auth/acting-user';
import { resolveTurnActor } from '../../web-server/auth/turn-attribution';
import {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	ResilienceEvent,
	WizardRun,
	StatsTimeRange,
	StatsTable,
	StatsFilters,
	UsageExportFormat,
	UsageExportResult,
} from '../../../shared/stats-types';
import type { DelegationDay, DelegationTotals } from '../../../shared/delegation';
import type { TokenUsageQuery } from '../../../shared/tokenUsage';
import { getTokenUsageAggregate } from '../../stats/token-usage/token-usage-accessor';
import {
	STATS_INDEXING_CHANNEL,
	getStatsIndexingState,
	setStatsIndexingBroadcaster,
} from '../../stats/stats-indexing';
import type { StatsIndexingState } from '../../../shared/statsIndexing';

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
	settingsStore?: {
		get: (key: string) => unknown;
	};
}

/**
 * Broadcast a stats update to every window and web-desktop bridge client,
 * naming the table that changed so a dashboard panel can skip refetches for
 * tables it does not read.
 */
function broadcastStatsUpdate(safeSend: SafeSendFn, table: StatsTable): void {
	safeSend('stats:updated', table);
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
 * - Export every stats table for a range (JSON, or a zip of CSVs)
 */
export function registerStatsHandlers(deps: StatsHandlerDependencies): void {
	const { settingsStore } = deps;

	// Every window (and web-desktop client) can open the Usage Dashboard, so
	// stats updates and indexing progress reach all of them, not just the main
	// window.
	const broadcastToAllWindows = createSafeSend(() => BrowserWindow.getAllWindows());
	const safeSend = broadcastToAllWindows;
	setStatsIndexingBroadcaster((state) => broadcastToAllWindows(STATS_INDEXING_CHANNEL, state));

	// Query events are buffered, so the update is announced when the batch is
	// committed: a dashboard that refetches on the event then reads the new rows.
	setQueryEventsFlushListener(() => broadcastStatsUpdate(safeSend, 'query_events'));

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

			// Web Login attribution. Like the History entry, this row is written
			// by the DESKTOP renderer's exit listener even when a browser sent
			// the turn, so `getActingUser()` is undefined here and the account
			// comes from what the spawn noted (web-server/auth/turn-attribution).
			// A call carrying an acting user came over the bridge, and that user
			// wins whatever the payload claims: a browser must not file its turns
			// under another account. Only the desktop's own calls may name one.
			const attributed = ((): Omit<QueryEvent, 'id'> => {
				const acting = getActingUser();
				if (!acting && event.userName) return event;
				const username =
					acting?.username ?? resolveTurnActor(event.sessionId, event.tabId)?.username;
				return username ? { ...event, userName: username } : event;
			})();

			const db = getStatsDB();
			const id = enqueueQueryEvent(db.database, attributed);
			logger.debug(`Buffered query event: ${id}`, LOG_CONTEXT, {
				sessionId: event.sessionId,
				agentType: event.agentType,
				source: event.source,
				duration: event.duration,
			});
			// No broadcast here: the flush listener announces the write once the
			// batch is committed (at most QUERY_EVENT_FLUSH_INTERVAL_MS later).
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
					kind: session.kind,
				});
				broadcastStatsUpdate(safeSend, 'auto_run');
				return id;
			}
		)
	);

	// End an Auto Run session (update duration and completed count)
	ipcMain.handle(
		'stats:end-autorun',
		withIpcErrorLogging(
			handlerOpts('endAutoRun'),
			async (id: string, duration: number, tasksCompleted: number, tasksTotal?: number) => {
				const db = getStatsDB();
				// Raises tasks_total to at least tasks_completed, so a looping run
				// cannot report more than 100% done (see finishAutoRunSession).
				const updated = db.finishAutoRunSession(
					id,
					duration,
					tasksCompleted,
					typeof tasksTotal === 'number' && Number.isFinite(tasksTotal) ? tasksTotal : undefined
				);
				if (updated) {
					logger.info(`Ended Auto Run session: ${id}`, LOG_CONTEXT, {
						duration,
						tasksCompleted,
					});
				} else {
					logger.warn(`Auto Run session not found: ${id}`, LOG_CONTEXT);
				}
				broadcastStatsUpdate(safeSend, 'auto_run');

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
			broadcastStatsUpdate(safeSend, 'auto_run');
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

	// Auto Run agent turns per local hour of day over a range, in one grouped
	// query (24 entries, zero-filled).
	ipcMain.handle(
		'stats:get-autorun-turns-by-hour',
		withIpcErrorLogging(handlerOpts('getAutoRunTurnsByHour'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getAutoRunTurnsByHour(range);
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

	// Interactive vs autonomous (Auto Run + Cue) split for the delegation
	// surfaces. The merge of the two stats systems lives in
	// usage-dashboard-reads.ts so `maestro-cli stats-delegation` reads the same
	// function.
	ipcMain.handle(
		'stats:get-delegation-totals',
		withIpcErrorLogging(
			handlerOpts('getDelegationTotals'),
			async (range: StatsTimeRange = 'all'): Promise<DelegationTotals> => getDelegationTotals(range)
		)
	);

	// The same split bucketed by local-time day, for the Activity trend chart.
	// Days with no activity in either system are omitted - the renderer
	// zero-fills so the axis stays calendar-true.
	ipcMain.handle(
		'stats:get-delegation-by-day',
		withIpcErrorLogging(
			handlerOpts('getDelegationByDay'),
			async (range: StatsTimeRange = 'all'): Promise<DelegationDay[]> => getDelegationByDay(range)
		)
	);

	// Progress of the long transcript scans behind the usage caches (version
	// upgrades and first indexing). Pushed on `stats:indexingUpdate` as it moves;
	// this read is for a surface that mounts mid-scan.
	ipcMain.handle(
		'stats:get-indexing-state',
		withIpcErrorLogging(handlerOpts('getIndexingState'), async (): Promise<StatsIndexingState> => {
			return getStatsIndexingState();
		})
	);

	// Token & cost usage aggregate for the Cost & Tokens dashboard. Reads each
	// agent's on-disk session storage (not the stats DB), served through a
	// per-session incremental cache. `force` bypasses the in-memory memo.
	// `waitForRemote` waits for the count of agents on another computer; without
	// it the local totals return at once and that count refreshes behind them.
	ipcMain.handle(
		'stats:get-token-usage',
		withIpcErrorLogging(
			handlerOpts('getTokenUsage'),
			async (query: TokenUsageQuery = {}, force = false, waitForRemote = false) => {
				return getTokenUsageAggregate(query, force, { waitForRemote: waitForRemote === true });
			}
		)
	);

	// Export everything the Usage Dashboard reads for a range. The work lives in
	// usage-export.ts so `maestro-cli stats-export` runs the same function.
	ipcMain.handle(
		'stats:export',
		withIpcErrorLogging(
			handlerOpts('export'),
			async (
				range: StatsTimeRange,
				format: UsageExportFormat,
				filePath: string
			): Promise<UsageExportResult> =>
				exportUsageData({
					range,
					format,
					filePath,
					settingsStore: settingsStore ?? { get: () => undefined },
					appVersion: app.getVersion(),
				})
		)
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
				broadcastStatsUpdate(safeSend, 'session_lifecycle');
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
				broadcastStatsUpdate(safeSend, 'session_lifecycle');
				return updated;
			}
		)
	);

	// Agent Resilience: record a RESOLVED outage (recovered or user-stopped).
	// Called fire-and-forget from the renderer's retryStore at resolution time;
	// live countdowns are never recorded.
	ipcMain.handle(
		'stats:record-resilience',
		withIpcErrorLogging(handlerOpts('recordResilience'), async (event: ResilienceEvent) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping resilience event', LOG_CONTEXT);
				return null;
			}
			const db = getStatsDB();
			const id = db.recordResilienceEvent(event);
			broadcastStatsUpdate(safeSend, 'resilience');
			return id;
		})
	);

	ipcMain.handle(
		'stats:get-resilience',
		withIpcErrorLogging(handlerOpts('getResilience'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getResilienceEvents(range);
		})
	);

	// Auto Run wizard: upsert one run row. Called at every milestone of a wizard
	// conversation (opened, exchange, documents written, closed) so a run that
	// is never closed still leaves accurate counts behind.
	ipcMain.handle(
		'stats:record-wizard-run',
		withIpcErrorLogging(handlerOpts('recordWizardRun'), async (run: WizardRun) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping wizard run', LOG_CONTEXT);
				return null;
			}
			const db = getStatsDB();
			const id = db.recordWizardRun(run);
			broadcastStatsUpdate(safeSend, 'wizard_runs');
			return id;
		})
	);

	ipcMain.handle(
		'stats:get-wizard-runs',
		withIpcErrorLogging(handlerOpts('getWizardRuns'), async (range: StatsTimeRange) => {
			const db = getStatsDB();
			return db.getWizardRuns(range);
		})
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
		withIpcErrorLogging(
			handlerOpts('recordShortcutUsage'),
			async (firedAt: number, shortcutId?: unknown) => {
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
				const date = db.incrementShortcutUsage(
					firedAt,
					typeof shortcutId === 'string' && shortcutId.length > 0 ? shortcutId : undefined
				);
				broadcastStatsUpdate(safeSend, 'shortcut_usage');
				return date;
			}
		)
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

	// Firings per shortcut id within a time range, most used first
	ipcMain.handle(
		'stats:get-shortcut-usage-by-shortcut',
		withIpcErrorLogging(
			handlerOpts('getShortcutUsageByShortcut'),
			async (range: StatsTimeRange) => {
				const db = getStatsDB();
				return db.getShortcutUsageByShortcut(range);
			}
		)
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
			broadcastStatsUpdate(safeSend, 'image_annotations');
			return id;
		})
	);

	// What opening the database had to do to a damaged file (restored from a
	// backup, or started fresh), for the renderer's one-shot warning toast.
	// Null when it opened cleanly or the notice was already shown.
	ipcMain.handle(
		'stats:get-initialization-result',
		withIpcErrorLogging(handlerOpts('getInitializationResult'), async () => {
			return getStatsDB().getInitializationResult();
		})
	);

	// Clear the initialization result once the renderer has shown it, so a
	// second window (or a reload) does not repeat the toast.
	ipcMain.handle(
		'stats:clear-initialization-result',
		withIpcErrorLogging(handlerOpts('clearInitializationResult'), async () => {
			getStatsDB().clearInitializationResult();
			return true;
		})
	);
}

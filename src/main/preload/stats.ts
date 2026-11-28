/**
 * Preload API for stats operations
 *
 * Provides the window.maestro.stats namespace for:
 * - Usage tracking and analytics
 * - Query event recording
 * - Auto Run session tracking
 */

import { ipcRenderer } from 'electron';
import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	AutoRunTurnsByHour,
	SessionLifecycleEvent,
	ShortcutUsageDay,
	ShortcutUsageByShortcut,
	StatsAggregation,
	StatsTimeRange,
	StatsTable,
	ResilienceEvent,
	WizardRun,
	UsageExportFormat,
	UsageExportResult,
} from '../../shared/stats-types';
export type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	ShortcutUsageDay,
	StatsAggregation,
} from '../../shared/stats-types';
import type { TokenUsageQuery, TokenUsageAggregate } from '../../shared/tokenUsage';
export type { TokenUsageQuery, TokenUsageAggregate } from '../../shared/tokenUsage';
import type { DelegationDay, DelegationTotals } from '../../shared/delegation';
export type { DelegationDay, DelegationTotals } from '../../shared/delegation';
import type { StatsIndexingState } from '../../shared/statsIndexing';
export type { StatsIndexingState } from '../../shared/statsIndexing';

/**
 * Session lifecycle event for recording session creation.
 * Subset of SessionLifecycleEvent from shared/stats-types.
 */
export type SessionCreatedEvent = Pick<
	SessionLifecycleEvent,
	'sessionId' | 'agentType' | 'projectPath' | 'createdAt' | 'isRemote' | 'isWorktree'
>;

/**
 * Creates the Stats API object for preload exposure
 */
export function createStatsApi() {
	return {
		// Record a query event (interactive conversation turn)
		recordQuery: (event: QueryEvent): Promise<string> =>
			ipcRenderer.invoke('stats:record-query', event),

		// Start an Auto Run session (returns session ID)
		startAutoRun: (session: AutoRunSession): Promise<string> =>
			ipcRenderer.invoke('stats:start-autorun', session),

		// End an Auto Run session (update duration and completed count). The
		// optional `tasksTotal` is the run's best checkbox total (a looping run
		// re-checks tasks); main never stores a total below the completed count.
		endAutoRun: (
			id: string,
			duration: number,
			tasksCompleted: number,
			tasksTotal?: number
		): Promise<boolean> =>
			ipcRenderer.invoke('stats:end-autorun', id, duration, tasksCompleted, tasksTotal),

		// Record an Auto Run task completion
		recordAutoTask: (task: AutoRunTask): Promise<string> =>
			ipcRenderer.invoke('stats:record-task', task),

		// Get query events with time range and optional filters
		getStats: (
			range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all',
			filters?: {
				agentType?: string;
				source?: 'user' | 'auto';
				projectPath?: string;
				sessionId?: string;
			}
		): Promise<
			Array<{
				id: string;
				sessionId: string;
				agentType: string;
				source: 'user' | 'auto';
				startTime: number;
				duration: number;
				projectPath?: string;
				tabId?: string;
			}>
		> => ipcRenderer.invoke('stats:get-stats', range, filters),

		// Get Auto Run sessions within a time range
		getAutoRunSessions: (
			range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
		): Promise<
			Array<{
				id: string;
				sessionId: string;
				agentType: string;
				documentPath?: string;
				startTime: number;
				duration: number;
				tasksTotal?: number;
				tasksCompleted?: number;
				projectPath?: string;
			}>
		> => ipcRenderer.invoke('stats:get-autorun-sessions', range),

		// Auto Run agent turns per local hour of day (24 entries, zero-filled)
		getAutoRunTurnsByHour: (range: StatsTimeRange): Promise<AutoRunTurnsByHour[]> =>
			ipcRenderer.invoke('stats:get-autorun-turns-by-hour', range),

		// Get aggregated stats for dashboard display
		getAggregation: (
			range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
		): Promise<StatsAggregation> => ipcRenderer.invoke('stats:get-aggregation', range),

		// Interactive vs autonomous (Auto Run + Cue) totals. Merges the stats DB
		// and the Cue DB in the main process; defaults to all retained history,
		// which is what the lifetime delegation score reads.
		getDelegationTotals: (range: StatsTimeRange = 'all'): Promise<DelegationTotals> =>
			ipcRenderer.invoke('stats:get-delegation-totals', range),

		// The same split bucketed by local-time day. Days with no activity are
		// omitted; the caller zero-fills.
		getDelegationByDay: (range: StatsTimeRange = 'all'): Promise<DelegationDay[]> =>
			ipcRenderer.invoke('stats:get-delegation-by-day', range),

		// Token & cost usage aggregate (Cost & Tokens tab). Reads agent session
		// storage; `force` bypasses the accessor's in-memory memo for a refresh.
		// `waitForRemote` resolves once agents on another computer are counted.
		getTokenUsage: (
			query: TokenUsageQuery = {},
			force = false,
			waitForRemote = false
		): Promise<TokenUsageAggregate> =>
			ipcRenderer.invoke('stats:get-token-usage', query, force, waitForRemote),

		// Export every stats table for a range to `filePath`: one JSON file, or a
		// zip with one CSV per table. Main writes the file.
		exportUsage: (
			range: StatsTimeRange,
			format: UsageExportFormat,
			filePath: string
		): Promise<UsageExportResult> => ipcRenderer.invoke('stats:export', range, format, filePath),

		// Progress of the long transcript scans behind the usage caches (a version
		// upgrade or a first index). `getIndexingState` reads it once; the
		// subscription follows it.
		getIndexingState: (): Promise<StatsIndexingState> =>
			ipcRenderer.invoke('stats:get-indexing-state'),
		onIndexingUpdate: (callback: (state: StatsIndexingState) => void) => {
			const handler = (_event: Electron.IpcRendererEvent, state: StatsIndexingState) =>
				callback(state);
			ipcRenderer.on('stats:indexingUpdate', handler);
			return () => ipcRenderer.removeListener('stats:indexingUpdate', handler);
		},

		// Subscribe to stats updates (for real-time dashboard refresh)
		// The event names the table that changed (undefined when unknown), so a
		// panel can skip refetches for tables it does not read.
		onStatsUpdate: (callback: (table?: StatsTable) => void) => {
			const handler = (_event: Electron.IpcRendererEvent, table?: StatsTable) => callback(table);
			ipcRenderer.on('stats:updated', handler);
			return () => ipcRenderer.removeListener('stats:updated', handler);
		},

		// Get database size in bytes
		getDatabaseSize: (): Promise<number> => ipcRenderer.invoke('stats:get-database-size'),

		// Record a keyboard shortcut firing. The main process buckets `firedAt`
		// into a local-time day and increments that day's counter. Resolves to
		// the YYYY-MM-DD bucket, or null when stats collection is disabled.
		// `shortcutId` also bumps that shortcut's own counter (Most used shortcuts).
		recordShortcutUsage: (firedAt: number, shortcutId?: string): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-shortcut-usage', firedAt, shortcutId),

		// Get per-day shortcut usage counts within a time range. Days with no
		// activity are omitted; the renderer is responsible for zero-filling.
		getShortcutUsageByDay: (range: StatsTimeRange): Promise<ShortcutUsageDay[]> =>
			ipcRenderer.invoke('stats:get-shortcut-usage-by-day', range),

		// Get the total number of shortcut firings in a time range
		getShortcutUsageTotal: (range: StatsTimeRange): Promise<number> =>
			ipcRenderer.invoke('stats:get-shortcut-usage-total', range),

		// Firings per shortcut id within a time range, most used first
		getShortcutUsageByShortcut: (range: StatsTimeRange): Promise<ShortcutUsageByShortcut[]> =>
			ipcRenderer.invoke('stats:get-shortcut-usage-by-shortcut', range),

		// Record an image annotation save event
		recordImageAnnotation: (createdAt: number): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-image-annotation', createdAt),

		// Record a resolved Agent Resilience outage
		recordResilience: (event: ResilienceEvent): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-resilience', event),

		getResilience: (range: StatsTimeRange): Promise<ResilienceEvent[]> =>
			ipcRenderer.invoke('stats:get-resilience', range),

		// Upsert one Auto Run wizard run (idempotent on run.id) - called at each
		// milestone of a wizard conversation, not just at the end.
		recordWizardRun: (run: WizardRun): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-wizard-run', run),

		getWizardRuns: (range: StatsTimeRange): Promise<WizardRun[]> =>
			ipcRenderer.invoke('stats:get-wizard-runs', range),

		recordSessionCreated: (event: SessionCreatedEvent): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-session-created', event),

		// Record session closure (for lifecycle tracking)
		recordSessionClosed: (sessionId: string, closedAt: number): Promise<boolean> =>
			ipcRenderer.invoke('stats:record-session-closed', sessionId, closedAt),

		// Get session lifecycle events within a time range
		getSessionLifecycle: (
			range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
		): Promise<
			Array<{
				id: string;
				sessionId: string;
				agentType: string;
				projectPath?: string;
				createdAt: number;
				closedAt?: number;
				duration?: number;
				isRemote?: boolean;
			}>
		> => ipcRenderer.invoke('stats:get-session-lifecycle', range),

		// Get initialization result (for showing database reset notification).
		// Non-null only when opening the database had to replace a damaged file.
		getInitializationResult: (): Promise<{
			success: boolean;
			wasReset: boolean;
			backupPath?: string;
			error?: string;
			userMessage?: string;
		} | null> => ipcRenderer.invoke('stats:get-initialization-result'),

		// Clear initialization result (after user has acknowledged the notification)
		clearInitializationResult: (): Promise<boolean> =>
			ipcRenderer.invoke('stats:clear-initialization-result'),
	};
}

export type StatsApi = ReturnType<typeof createStatsApi>;

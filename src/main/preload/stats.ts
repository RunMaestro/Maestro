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
	SessionLifecycleEvent,
	ShortcutUsageDay,
	StatsAggregation,
	StatsTimeRange,
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

		// End an Auto Run session (update duration and completed count)
		endAutoRun: (id: string, duration: number, tasksCompleted: number): Promise<boolean> =>
			ipcRenderer.invoke('stats:end-autorun', id, duration, tasksCompleted),

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

		// Get tasks for a specific Auto Run session
		getAutoRunTasks: (
			autoRunSessionId: string
		): Promise<
			Array<{
				id: string;
				autoRunSessionId: string;
				sessionId: string;
				agentType: string;
				taskIndex: number;
				taskContent?: string;
				startTime: number;
				duration: number;
				success: boolean;
			}>
		> => ipcRenderer.invoke('stats:get-autorun-tasks', autoRunSessionId),

		// Get aggregated stats for dashboard display
		getAggregation: (
			range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
		): Promise<StatsAggregation> => ipcRenderer.invoke('stats:get-aggregation', range),

		// Token & cost usage aggregate (Cost & Tokens tab). Reads agent session
		// storage; `force` bypasses the accessor's in-memory memo for a refresh.
		getTokenUsage: (query: TokenUsageQuery = {}, force = false): Promise<TokenUsageAggregate> =>
			ipcRenderer.invoke('stats:get-token-usage', query, force),

		// Export query events to CSV
		exportCsv: (range: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'): Promise<string> =>
			ipcRenderer.invoke('stats:export-csv', range),

		// Subscribe to stats updates (for real-time dashboard refresh)
		onStatsUpdate: (callback: () => void) => {
			const handler = () => callback();
			ipcRenderer.on('stats:updated', handler);
			return () => ipcRenderer.removeListener('stats:updated', handler);
		},

		// Clear old stats data (older than specified number of days)
		clearOldData: (
			olderThanDays: number
		): Promise<{
			success: boolean;
			deletedQueryEvents: number;
			deletedAutoRunSessions: number;
			deletedAutoRunTasks: number;
			error?: string;
		}> => ipcRenderer.invoke('stats:clear-old-data', olderThanDays),

		// Get database size in bytes
		getDatabaseSize: (): Promise<number> => ipcRenderer.invoke('stats:get-database-size'),

		// Get earliest stat timestamp (null if no entries)
		getEarliestTimestamp: (): Promise<number | null> =>
			ipcRenderer.invoke('stats:get-earliest-timestamp'),

		// Record a keyboard shortcut firing. The main process buckets `firedAt`
		// into a local-time day and increments that day's counter. Resolves to
		// the YYYY-MM-DD bucket, or null when stats collection is disabled.
		recordShortcutUsage: (firedAt: number): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-shortcut-usage', firedAt),

		// Get per-day shortcut usage counts within a time range. Days with no
		// activity are omitted; the renderer is responsible for zero-filling.
		getShortcutUsageByDay: (range: StatsTimeRange): Promise<ShortcutUsageDay[]> =>
			ipcRenderer.invoke('stats:get-shortcut-usage-by-day', range),

		// Get the total number of shortcut firings in a time range
		getShortcutUsageTotal: (range: StatsTimeRange): Promise<number> =>
			ipcRenderer.invoke('stats:get-shortcut-usage-total', range),

		// Record an image annotation save event
		recordImageAnnotation: (createdAt: number): Promise<string | null> =>
			ipcRenderer.invoke('stats:record-image-annotation', createdAt),

		// Record session creation (for lifecycle tracking)
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

		// Get initialization result (for showing database reset notification)
		// Returns info about whether the database was reset due to corruption
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

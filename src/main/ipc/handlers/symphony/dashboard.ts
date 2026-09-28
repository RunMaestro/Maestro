import { ipcMain } from 'electron';
import type Store from 'electron-store';
import { logger } from '../../../utils/logger';
import { createIpcHandler } from '../../../utils/ipcHandler';
import type { SessionsData, StoredSession } from '../../../stores/types';
import type {
	ActiveContribution,
	CompletedContribution,
	ContributorStats,
	SymphonyState,
} from '../../../../shared/symphony-types';
import { LOG_CONTEXT, handlerOpts, readState, SymphonyHandlerDependencies } from './shared';

/**
 * Filter out orphaned contributions whose sessions no longer exist.
 * Returns only contributions that have a corresponding session in the sessions store.
 *
 * Pass logOrphans: false for callers that run on a poll timer. getStats is
 * polled every 5 seconds, and the orphaned ids it would report are already
 * logged by the getState / getActive paths, so logging there is pure duplication.
 */
function filterOrphanedContributions(
	contributions: ActiveContribution[],
	sessionsStore: Store<SessionsData>,
	logOrphans = true
): ActiveContribution[] {
	const sessions = sessionsStore.get('sessions', []) as StoredSession[];
	const sessionIds = new Set(sessions.map((s) => s.id));

	const validContributions: ActiveContribution[] = [];
	const orphanedIds: string[] = [];

	for (const contribution of contributions) {
		if (sessionIds.has(contribution.sessionId)) {
			validContributions.push(contribution);
		} else {
			orphanedIds.push(contribution.id);
		}
	}

	if (logOrphans && orphanedIds.length > 0) {
		logger.info(
			`Filtering ${orphanedIds.length} orphaned contribution(s) with missing sessions`,
			LOG_CONTEXT,
			{ orphanedIds }
		);
	}

	return validContributions;
}

/**
 * Register dashboard Symphony IPC handlers: getState, getActive, getCompleted, getStats.
 */
export function registerDashboardHandlers({
	app,
	sessionsStore,
}: SymphonyHandlerDependencies): void {
	/**
	 * Get current symphony state.
	 * Filters out contributions whose sessions no longer exist.
	 */
	ipcMain.handle(
		'symphony:getState',
		createIpcHandler(
			handlerOpts('getState', false),
			async (): Promise<{ state: SymphonyState }> => {
				const state = await readState(app);
				// Filter out orphaned contributions whose sessions are gone
				state.active = filterOrphanedContributions(state.active, sessionsStore);
				return { state };
			}
		)
	);

	/**
	 * Get active contributions.
	 * Filters out contributions whose sessions no longer exist.
	 */
	ipcMain.handle(
		'symphony:getActive',
		createIpcHandler(
			handlerOpts('getActive', false),
			async (): Promise<{ contributions: ActiveContribution[] }> => {
				const state = await readState(app);
				const validContributions = filterOrphanedContributions(state.active, sessionsStore);
				return { contributions: validContributions };
			}
		)
	);

	/**
	 * Get completed contributions.
	 */
	ipcMain.handle(
		'symphony:getCompleted',
		createIpcHandler(
			handlerOpts('getCompleted', false),
			async (limit?: number): Promise<{ contributions: CompletedContribution[] }> => {
				const state = await readState(app);
				const sorted = [...state.history].sort(
					(a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
				);
				return {
					contributions: limit ? sorted.slice(0, limit) : sorted,
				};
			}
		)
	);

	/**
	 * Get contributor statistics.
	 * Includes real-time stats from active contributions for live updates.
	 */
	ipcMain.handle(
		'symphony:getStats',
		createIpcHandler(
			handlerOpts('getStats', false),
			async (): Promise<{ stats: ContributorStats }> => {
				const state = await readState(app);

				// Start with base completed stats
				const baseStats = state.stats;

				// Aggregate stats from active contributions for real-time display
				let activeTokens = 0;
				let activeTime = 0;
				let activeCost = 0;
				let activeDocs = 0;
				let activeTasks = 0;

				const validActive = filterOrphanedContributions(state.active, sessionsStore, false);
				for (const contribution of validActive) {
					activeTokens +=
						contribution.tokenUsage.inputTokens + contribution.tokenUsage.outputTokens;
					activeTime += contribution.timeSpent;
					activeCost += contribution.tokenUsage.estimatedCost;
					activeDocs += contribution.progress.completedDocuments;
					activeTasks += contribution.progress.completedTasks;
				}

				// Return combined stats (completed + active in-progress)
				return {
					stats: {
						...baseStats,
						// Add active contribution stats to totals
						totalTokensUsed: baseStats.totalTokensUsed + activeTokens,
						totalTimeSpent: baseStats.totalTimeSpent + activeTime,
						estimatedCostDonated: baseStats.estimatedCostDonated + activeCost,
						totalDocumentsProcessed: baseStats.totalDocumentsProcessed + activeDocs,
						totalTasksCompleted: baseStats.totalTasksCompleted + activeTasks,
					},
				};
			}
		)
	);
}

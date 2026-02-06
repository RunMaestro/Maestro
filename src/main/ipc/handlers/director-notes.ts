/**
 * Director's Notes IPC Handlers
 *
 * Provides IPC handlers for the Director's Notes feature:
 * - Unified history aggregation across all sessions
 * - Token estimation for synopsis generation
 * - AI synopsis generation (placeholder until Phase 07)
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { HistoryEntry } from '../../../shared/types';
import { getHistoryManager } from '../../history-manager';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[DirectorNotes]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface UnifiedHistoryOptions {
	lookbackDays: number;
	filter?: 'AUTO' | 'USER' | null; // null = both
}

export interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string; // The agent/session name for display
	sourceSessionId: string; // Which session this entry came from
}

export interface SynopsisOptions {
	lookbackDays: number;
	provider: 'claude-code' | 'codex' | 'opencode';
}

export interface SynopsisResult {
	success: boolean;
	synopsis: string;
	error?: string;
}

/**
 * Register all Director's Notes IPC handlers.
 *
 * These handlers provide:
 * - Unified history aggregation across all sessions
 * - Token estimation for synopsis generation strategy
 * - AI synopsis generation (placeholder for Phase 07)
 */
export function registerDirectorNotesHandlers(): void {
	const historyManager = getHistoryManager();

	// Aggregate history from all sessions within a time range
	ipcMain.handle(
		'director-notes:getUnifiedHistory',
		withIpcErrorLogging(
			handlerOpts('getUnifiedHistory'),
			async (options: UnifiedHistoryOptions) => {
				const { lookbackDays, filter } = options;
				const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

				// Get all session IDs from history manager
				const sessionIds = historyManager.listSessionsWithHistory();

				// For each session, get entries within time range
				const allEntries: UnifiedHistoryEntry[] = [];
				for (const sessionId of sessionIds) {
					const entries = historyManager.getEntries(sessionId);
					const filtered = entries.filter((e) => {
						if (e.timestamp < cutoffTime) return false;
						if (filter && e.type !== filter) return false;
						return true;
					});

					// Add source session info to each entry
					for (const entry of filtered) {
						allEntries.push({
							...entry,
							sourceSessionId: sessionId,
							agentName: entry.sessionName || sessionId.split('-')[0],
						});
					}
				}

				// Sort by timestamp (newest first)
				allEntries.sort((a, b) => b.timestamp - a.timestamp);

				logger.debug(
					`Unified history: ${allEntries.length} entries from ${sessionIds.length} sessions (${lookbackDays}d lookback)`,
					LOG_CONTEXT
				);

				return allEntries;
			}
		)
	);

	// Estimate tokens for synopsis generation to determine strategy
	ipcMain.handle(
		'director-notes:estimateTokens',
		withIpcErrorLogging(handlerOpts('estimateTokens'), async (entries: HistoryEntry[]) => {
			// Heuristic: ~4 characters per token
			const totalChars = entries.reduce((sum, e) => {
				return sum + (e.summary?.length || 0) + (e.fullResponse?.length || 0);
			}, 0);
			return Math.ceil(totalChars / 4);
		})
	);

	// Generate AI synopsis (placeholder - actual agent spawning in Phase 07)
	ipcMain.handle(
		'director-notes:generateSynopsis',
		withIpcErrorLogging(
			handlerOpts('generateSynopsis'),
			async (options: SynopsisOptions): Promise<SynopsisResult> => {
				// Placeholder synopsis - actual agent-based generation is a future enhancement
				logger.info(
					`Synopsis generation requested for ${options.lookbackDays} days via ${options.provider}`,
					LOG_CONTEXT
				);
				return {
					success: true,
					synopsis: `# Director's Notes\n\n*Generated for the past ${options.lookbackDays} days*\n\n## Accomplishments\n\n- Synopsis generation not yet implemented\n\n## Challenges\n\n- Pending implementation\n\n## Next Steps\n\n- Complete Phase 07 to enable AI synopsis generation`,
				};
			}
		)
	);
}

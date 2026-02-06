/**
 * Director's Notes IPC Handlers
 *
 * Provides IPC handlers for the Director's Notes feature:
 * - Unified history aggregation across all sessions
 * - Token estimation for synopsis generation
 * - AI synopsis generation via batch-mode agent (groomContext)
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { HistoryEntry } from '../../../shared/types';
import { getHistoryManager } from '../../history-manager';
import { withIpcErrorLogging, requireDependency, CreateHandlerOptions } from '../../utils/ipcHandler';
import { groomContext } from '../../utils/context-groomer';
import { directorNotesPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';

const LOG_CONTEXT = '[DirectorNotes]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for Director's Notes handler registration
 */
export interface DirectorNotesHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
}

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
 * - AI synopsis generation via batch-mode agent
 */
export function registerDirectorNotesHandlers(deps: DirectorNotesHandlerDependencies): void {
	const { getProcessManager, getAgentDetector } = deps;
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

	// Generate AI synopsis via batch-mode agent
	ipcMain.handle(
		'director-notes:generateSynopsis',
		withIpcErrorLogging(
			handlerOpts('generateSynopsis'),
			async (options: SynopsisOptions): Promise<SynopsisResult> => {
				logger.info(
					`Synopsis generation requested for ${options.lookbackDays} days via ${options.provider}`,
					LOG_CONTEXT
				);

				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Verify the requested agent is available
				const agent = await agentDetector.getAgent(options.provider);
				if (!agent || !agent.available) {
					return {
						success: false,
						synopsis: '',
						error: `Agent "${options.provider}" is not available. Please install it or select a different provider in Settings > Director's Notes.`,
					};
				}

				// Gather history entries for the requested time period
				const cutoffTime = Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000;
				const sessionIds = historyManager.listSessionsWithHistory();
				const entries: Array<{
					summary: string;
					type: string;
					timestamp: number;
					success?: boolean;
					agentName: string;
				}> = [];

				for (const sessionId of sessionIds) {
					const sessionEntries = historyManager.getEntries(sessionId);
					for (const entry of sessionEntries) {
						if (entry.timestamp >= cutoffTime) {
							entries.push({
								summary: entry.summary,
								type: entry.type,
								timestamp: entry.timestamp,
								success: entry.success,
								agentName: entry.sessionName || sessionId.split('-')[0],
							});
						}
					}
				}

				if (entries.length === 0) {
					return {
						success: true,
						synopsis: `# Director's Notes\n\n*Generated for the past ${options.lookbackDays} days*\n\nNo history entries found for the selected time period.`,
					};
				}

				// Sort entries by timestamp (newest first)
				entries.sort((a, b) => b.timestamp - a.timestamp);

				// Build the prompt with the system instructions and history data
				const historyJson = JSON.stringify(entries, null, 2);
				const prompt = `${directorNotesPrompt}\n\n---\n\nHistory entries (${entries.length} total, past ${options.lookbackDays} days):\n\n${historyJson}`;

				logger.info(
					`Generating synopsis from ${entries.length} entries across ${sessionIds.length} sessions`,
					LOG_CONTEXT,
					{ promptLength: prompt.length }
				);

				try {
					const result = await groomContext(
						{
							projectRoot: process.cwd(),
							agentType: options.provider,
							prompt,
							readOnlyMode: true,
						},
						processManager,
						agentDetector
					);

					const synopsis = result.response.trim();
					if (!synopsis) {
						return {
							success: false,
							synopsis: '',
							error: 'Agent returned an empty response. Try again or use a different provider.',
						};
					}

					logger.info('Synopsis generation complete', LOG_CONTEXT, {
						responseLength: synopsis.length,
						durationMs: result.durationMs,
						completionReason: result.completionReason,
					});

					return {
						success: true,
						synopsis,
					};
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					logger.error('Synopsis generation failed', LOG_CONTEXT, { error: errorMsg });
					return {
						success: false,
						synopsis: '',
						error: `Synopsis generation failed: ${errorMsg}`,
					};
				}
			}
		)
	);
}

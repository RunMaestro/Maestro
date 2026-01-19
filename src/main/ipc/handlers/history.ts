/**
 * History IPC Handlers
 *
 * These handlers provide history persistence operations using the per-session
 * HistoryManager for improved scalability and session isolation.
 *
 * Features:
 * - 5,000 entries per session (up from 1,000 global)
 * - Per-session file storage in history/ directory
 * - Cross-session queries for global views
 * - Pagination support for large datasets
 * - Context integration for AI agents via history:getFilePath
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { HistoryEntry } from '../../../shared/types';
import { PaginationOptions, ORPHANED_SESSION_ID } from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[History]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all History-related IPC handlers.
 *
 * These handlers provide history persistence operations:
 * - Get all history entries (with optional project/session filtering and pagination)
 * - Add new history entry
 * - Clear history (all, by project, or by session)
 * - Delete individual history entry
 * - Update history entry (e.g., setting validated flag)
 * - Get history file path (for AI context integration)
 * - List sessions with history
 */
export function registerHistoryHandlers(): void {
	const historyManager = getHistoryManager();

	// Get all history entries, optionally filtered by project and/or session
	// Legacy handler - returns all entries (use history:getAllPaginated for large datasets)
	ipcMain.handle(
		'history:getAll',
		withIpcErrorLogging(handlerOpts('getAll'), async (projectPath?: string, sessionId?: string) => {
			if (sessionId) {
				// Get entries for specific session only - don't include orphaned entries
				// to prevent history bleeding across different agent sessions in the same directory
				const entries = historyManager.getEntries(sessionId);
				// Sort by timestamp descending
				entries.sort((a, b) => b.timestamp - a.timestamp);
				return entries;
			}

			if (projectPath) {
				// Get all entries for sessions in this project
				return historyManager.getEntriesByProjectPath(projectPath);
			}

			// Return all entries (for global view)
			return historyManager.getAllEntries();
		})
	);

	// Get history entries with pagination support
	ipcMain.handle(
		'history:getAllPaginated',
		withIpcErrorLogging(
			handlerOpts('getAllPaginated'),
			async (options?: {
				projectPath?: string;
				sessionId?: string;
				pagination?: PaginationOptions;
			}) => {
				const { projectPath, sessionId, pagination } = options || {};

				if (sessionId) {
					// Get paginated entries for specific session
					return historyManager.getEntriesPaginated(sessionId, pagination);
				}

				if (projectPath) {
					// Get paginated entries for sessions in this project
					return historyManager.getEntriesByProjectPathPaginated(projectPath, pagination);
				}

				// Return paginated entries (for global view)
				return historyManager.getAllEntriesPaginated(pagination);
			}
		)
	);

	// Force reload history from disk (no-op for new format since we read fresh each time)
	// Kept for API compatibility
	ipcMain.handle(
		'history:reload',
		withIpcErrorLogging(handlerOpts('reload'), async () => {
			logger.debug('history:reload called (no-op for per-session storage)', LOG_CONTEXT);
			return true;
		})
	);

	// Add a new history entry
	ipcMain.handle(
		'history:add',
		withIpcErrorLogging(handlerOpts('add'), async (entry: HistoryEntry) => {
			const sessionId = entry.sessionId || ORPHANED_SESSION_ID;
			historyManager.addEntry(sessionId, entry.projectPath, entry);
			logger.info(`Added history entry: ${entry.type}`, LOG_CONTEXT, { summary: entry.summary });
			return true;
		})
	);

	// Clear history entries (all, by project, or by session)
	ipcMain.handle(
		'history:clear',
		withIpcErrorLogging(handlerOpts('clear'), async (projectPath?: string, sessionId?: string) => {
			if (sessionId) {
				historyManager.clearSession(sessionId);
				logger.info(`Cleared history for session: ${sessionId}`, LOG_CONTEXT);
				return true;
			}

			if (projectPath) {
				// Clear all sessions for this project
				historyManager.clearByProjectPath(projectPath);
				logger.info(`Cleared history for project: ${projectPath}`, LOG_CONTEXT);
				return true;
			}

			// Clear all history
			historyManager.clearAll();
			return true;
		})
	);

	// Delete a single history entry by ID
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (entryId: string, sessionId?: string) => {
			if (sessionId) {
				const deleted = historyManager.deleteEntry(sessionId, entryId);
				if (deleted) {
					logger.info(`Deleted history entry: ${entryId} from session ${sessionId}`, LOG_CONTEXT);
				} else {
					logger.warn(`History entry not found: ${entryId} in session ${sessionId}`, LOG_CONTEXT);
				}
				return deleted;
			}

			// Search all sessions for the entry (slower, but works for legacy calls without sessionId)
			const sessions = historyManager.listSessionsWithHistory();
			for (const sid of sessions) {
				if (historyManager.deleteEntry(sid, entryId)) {
					logger.info(`Deleted history entry: ${entryId} from session ${sid}`, LOG_CONTEXT);
					return true;
				}
			}

			logger.warn(`History entry not found: ${entryId}`, LOG_CONTEXT);
			return false;
		})
	);

	// Update a history entry (for setting validated flag, etc.)
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:update',
		withIpcErrorLogging(
			handlerOpts('update'),
			async (entryId: string, updates: Partial<HistoryEntry>, sessionId?: string) => {
				if (sessionId) {
					const updated = historyManager.updateEntry(sessionId, entryId, updates);
					if (updated) {
						logger.info(`Updated history entry: ${entryId} in session ${sessionId}`, LOG_CONTEXT, {
							updates,
						});
					} else {
						logger.warn(
							`History entry not found for update: ${entryId} in session ${sessionId}`,
							LOG_CONTEXT
						);
					}
					return updated;
				}

				// Search all sessions for the entry
				const sessions = historyManager.listSessionsWithHistory();
				for (const sid of sessions) {
					if (historyManager.updateEntry(sid, entryId, updates)) {
						logger.info(`Updated history entry: ${entryId} in session ${sid}`, LOG_CONTEXT, {
							updates,
						});
						return true;
					}
				}

				logger.warn(`History entry not found for update: ${entryId}`, LOG_CONTEXT);
				return false;
			}
		)
	);

	// Update sessionName for all entries matching a agentSessionId (used when renaming tabs)
	ipcMain.handle(
		'history:updateSessionName',
		withIpcErrorLogging(
			handlerOpts('updateSessionName'),
			async (agentSessionId: string, sessionName: string) => {
				const count = historyManager.updateSessionNameByClaudeSessionId(
					agentSessionId,
					sessionName
				);
				logger.info(
					`Updated sessionName for ${count} history entries with agentSessionId ${agentSessionId}`,
					LOG_CONTEXT
				);
				return count;
			}
		)
	);

	// NEW: Get history file path for AI context integration
	ipcMain.handle(
		'history:getFilePath',
		withIpcErrorLogging(handlerOpts('getFilePath'), async (sessionId: string) => {
			return historyManager.getHistoryFilePath(sessionId);
		})
	);

	// NEW: List sessions with history
	ipcMain.handle(
		'history:listSessions',
		withIpcErrorLogging(handlerOpts('listSessions'), async () => {
			return historyManager.listSessionsWithHistory();
		})
	);
}

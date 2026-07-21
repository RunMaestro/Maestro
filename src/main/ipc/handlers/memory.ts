/**
 * IPC handlers for per-project memory (Claude Code).
 *
 * Surface consumed by the renderer Memory Viewer.
 */

import { ipcMain } from 'electron';
import {
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	getMemoryDirectoryPath,
} from '../../memory-manager';
import { logger } from '../../utils/logger';
import { createIpcHandler } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(): void {
	ipcMain.handle(
		'memory:list',
		createIpcHandler(
			{ context: LOG_CONTEXT, operation: 'list memory entries', logSuccess: false },
			async (projectPath: string, agentId: string = 'claude-code') => ({
				...(await listMemoryEntries(projectPath, agentId)),
			})
		)
	);

	ipcMain.handle(
		'memory:read',
		createIpcHandler(
			{ context: LOG_CONTEXT, operation: 'read memory entry', logSuccess: false },
			async (projectPath: string, filename: string, agentId: string = 'claude-code') => ({
				content: await readMemoryEntry(projectPath, filename, agentId),
			})
		)
	);

	ipcMain.handle(
		'memory:write',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await writeMemoryEntry(projectPath, filename, content, agentId);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to write memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:create',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await createMemoryEntry(projectPath, filename, content, agentId);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to create memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:delete',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				await deleteMemoryEntry(projectPath, filename, agentId);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to delete memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:getPath',
		createIpcHandler(
			{ context: LOG_CONTEXT, operation: 'resolve memory path', logSuccess: false },
			async (projectPath: string, agentId: string = 'claude-code') => ({
				path: getMemoryDirectoryPath(projectPath, agentId),
			})
		)
	);

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}

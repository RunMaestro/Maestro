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

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(): void {
	ipcMain.handle(
		'memory:list',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				const result = await listMemoryEntries(projectPath, agentId);
				return { success: true, ...result };
			} catch (error) {
				logger.error(`Failed to list memory entries: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:read',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				const content = await readMemoryEntry(projectPath, filename, agentId);
				return { success: true, content };
			} catch (error) {
				logger.error(`Failed to read memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
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
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				return { success: true, path: getMemoryDirectoryPath(projectPath, agentId) };
			} catch (error) {
				logger.error(`Failed to resolve memory path: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}

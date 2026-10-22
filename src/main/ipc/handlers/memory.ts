/**
 * IPC handlers for agent memory (Claude Code per project, Codex per account).
 *
 * Surface consumed by the renderer Memory Viewer. Every channel takes a
 * `MemoryTarget` first; `resolveMemoryLayout` turns it into the store the
 * agent actually reads.
 */

import { ipcMain } from 'electron';
import {
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../memory-manager';
import { resolveMemoryLayout } from '../../memory-location';
import type { MemoryTarget } from '../../../shared/agentMemory';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(): void {
	ipcMain.handle('memory:list', async (_event, target: MemoryTarget) => {
		try {
			const result = await listMemoryEntries(await resolveMemoryLayout(target));
			return { success: true, ...result };
		} catch (error) {
			logger.error(`Failed to list memory entries: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('memory:read', async (_event, target: MemoryTarget, filename: string) => {
		try {
			const content = await readMemoryEntry(await resolveMemoryLayout(target), filename);
			return { success: true, content };
		} catch (error) {
			logger.error(`Failed to read memory ${filename}: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		'memory:write',
		async (_event, target: MemoryTarget, filename: string, content: string) => {
			try {
				await writeMemoryEntry(await resolveMemoryLayout(target), filename, content);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to write memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:create',
		async (_event, target: MemoryTarget, filename: string, content: string) => {
			try {
				await createMemoryEntry(await resolveMemoryLayout(target), filename, content);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to create memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle('memory:delete', async (_event, target: MemoryTarget, filename: string) => {
		try {
			await deleteMemoryEntry(await resolveMemoryLayout(target), filename);
			return { success: true };
		} catch (error) {
			logger.error(`Failed to delete memory ${filename}: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('memory:search', async (_event, target: MemoryTarget, query: string) => {
		try {
			const matches = await searchMemoryEntries(await resolveMemoryLayout(target), query);
			return { success: true, matches };
		} catch (error) {
			logger.error(`Failed to search memory: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('memory:orphans', async (_event, target: MemoryTarget) => {
		try {
			const report = await findOrphanMemories(await resolveMemoryLayout(target));
			return { success: true, ...report };
		} catch (error) {
			logger.error(`Failed to find orphan memories: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle('memory:getPath', async (_event, target: MemoryTarget) => {
		try {
			return { success: true, path: (await resolveMemoryLayout(target)).directoryPath };
		} catch (error) {
			logger.error(`Failed to resolve memory path: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}

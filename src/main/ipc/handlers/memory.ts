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
import { redactSecrets } from '../../../shared/redactSecrets';

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(): void {
	ipcMain.handle('memory:list', async (_event, target: MemoryTarget) => {
		try {
			const result = await listMemoryEntries(await resolveMemoryLayout(target));
			return { success: true, ...result };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to list memory entries: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	ipcMain.handle('memory:read', async (_event, target: MemoryTarget, filename: string) => {
		try {
			const content = await readMemoryEntry(await resolveMemoryLayout(target), filename);
			return { success: true, content };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to read memory: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	ipcMain.handle(
		'memory:write',
		async (_event, target: MemoryTarget, filename: string, content: string) => {
			try {
				await writeMemoryEntry(await resolveMemoryLayout(target), filename, content);
				return { success: true };
			} catch (error) {
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to write memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
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
				const message = redactSecrets(String(error)).text;
				logger.error(`Failed to create memory: ${message}`, LOG_CONTEXT);
				return { success: false, error: message };
			}
		}
	);

	ipcMain.handle('memory:delete', async (_event, target: MemoryTarget, filename: string) => {
		try {
			await deleteMemoryEntry(await resolveMemoryLayout(target), filename);
			return { success: true };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to delete memory: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	ipcMain.handle('memory:search', async (_event, target: MemoryTarget, query: string) => {
		try {
			const matches = await searchMemoryEntries(await resolveMemoryLayout(target), query);
			return { success: true, matches };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to search memory: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	ipcMain.handle('memory:orphans', async (_event, target: MemoryTarget) => {
		try {
			const report = await findOrphanMemories(await resolveMemoryLayout(target));
			return { success: true, ...report };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to find orphan memories: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	ipcMain.handle('memory:getPath', async (_event, target: MemoryTarget) => {
		try {
			return { success: true, path: (await resolveMemoryLayout(target)).directoryPath };
		} catch (error) {
			const message = redactSecrets(String(error)).text;
			logger.error(`Failed to resolve memory path: ${message}`, LOG_CONTEXT);
			return { success: false, error: message };
		}
	});

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}

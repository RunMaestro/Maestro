/**
 * BMAD IPC Handlers
 *
 * Provides IPC handlers for managing BMAD commands:
 * - Get metadata (version, last refresh date)
 * - Get all commands with prompts
 * - Save user edits to prompts
 * - Reset prompts to bundled defaults
 * - Refresh prompts from GitHub
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	getBmadMetadata,
	getBmadPrompts,
	saveBmadPrompt,
	resetBmadPrompt,
	refreshBmadPrompts,
	getBmadCommandBySlash,
	BmadCommand,
	BmadMetadata,
} from '../../bmad-manager';

const LOG_CONTEXT = '[BMAD]';

const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Register all BMAD IPC handlers.
 */
export function registerBmadHandlers(): void {
	ipcMain.handle(
		'bmad:getMetadata',
		createIpcHandler(handlerOpts('getMetadata', false), async () => {
			const metadata = await getBmadMetadata();
			return { metadata };
		})
	);

	ipcMain.handle(
		'bmad:getPrompts',
		createIpcHandler(handlerOpts('getPrompts', false), async () => {
			const commands = await getBmadPrompts();
			return { commands };
		})
	);

	ipcMain.handle(
		'bmad:getCommand',
		createIpcHandler(handlerOpts('getCommand', false), async (slashCommand: string) => {
			const command = await getBmadCommandBySlash(slashCommand);
			return { command };
		})
	);

	ipcMain.handle(
		'bmad:savePrompt',
		createIpcHandler(handlerOpts('savePrompt'), async (id: string, content: string) => {
			await saveBmadPrompt(id, content);
			logger.info(`Saved custom prompt for bmad.${id}`, LOG_CONTEXT);
			return {};
		})
	);

	ipcMain.handle(
		'bmad:resetPrompt',
		createIpcHandler(handlerOpts('resetPrompt'), async (id: string) => {
			const prompt = await resetBmadPrompt(id);
			logger.info(`Reset bmad.${id} to bundled default`, LOG_CONTEXT);
			return { prompt };
		})
	);

	ipcMain.handle(
		'bmad:refresh',
		createIpcHandler(handlerOpts('refresh'), async () => {
			const metadata = await refreshBmadPrompts();
			logger.info(`Refreshed BMAD prompts to ${metadata.sourceVersion}`, LOG_CONTEXT);
			return { metadata };
		})
	);

	logger.debug(`${LOG_CONTEXT} BMAD IPC handlers registered`);
}

export type { BmadCommand, BmadMetadata };

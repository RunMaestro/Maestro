/**
 * OpenSpec IPC Handlers
 *
 * Provides IPC handlers for managing OpenSpec commands:
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
	getOpenSpecMetadata,
	getOpenSpecPrompts,
	saveOpenSpecPrompt,
	resetOpenSpecPrompt,
	refreshOpenSpecPrompts,
	getOpenSpecCommandBySlash,
	OpenSpecCommand,
	OpenSpecMetadata,
} from '../../openspec-manager';

const LOG_CONTEXT = '[OpenSpec]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Register all OpenSpec IPC handlers.
 */
export function registerOpenSpecHandlers(): void {
	// Get metadata (version info, last refresh date)
	ipcMain.handle(
		'openspec:getMetadata',
		createIpcHandler(handlerOpts('getMetadata', false), async () => {
			const metadata = await getOpenSpecMetadata();
			return { metadata };
		})
	);

	// Get all openspec prompts
	ipcMain.handle(
		'openspec:getPrompts',
		createIpcHandler(handlerOpts('getPrompts', false), async () => {
			const commands = await getOpenSpecPrompts();
			return { commands };
		})
	);

	// Get a single command by slash command string
	ipcMain.handle(
		'openspec:getCommand',
		createIpcHandler(handlerOpts('getCommand', false), async (slashCommand: string) => {
			const command = await getOpenSpecCommandBySlash(slashCommand);
			return { command };
		})
	);

	// Save user's edit to a prompt
	ipcMain.handle(
		'openspec:savePrompt',
		createIpcHandler(handlerOpts('savePrompt'), async (id: string, content: string) => {
			await saveOpenSpecPrompt(id, content);
			logger.info(`Saved custom prompt for openspec.${id}`, LOG_CONTEXT);
			return {};
		})
	);

	// Reset a prompt to bundled default
	ipcMain.handle(
		'openspec:resetPrompt',
		createIpcHandler(handlerOpts('resetPrompt'), async (id: string) => {
			const prompt = await resetOpenSpecPrompt(id);
			logger.info(`Reset openspec.${id} to bundled default`, LOG_CONTEXT);
			return { prompt };
		})
	);

	// Refresh prompts from GitHub
	ipcMain.handle(
		'openspec:refresh',
		createIpcHandler(handlerOpts('refresh'), async () => {
			const metadata = await refreshOpenSpecPrompts();
			logger.info(`Refreshed OpenSpec prompts to commit ${metadata.commitSha}`, LOG_CONTEXT);
			return { metadata };
		})
	);

	logger.debug(`${LOG_CONTEXT} OpenSpec IPC handlers registered`);
}

// Export types for preload
export type { OpenSpecCommand, OpenSpecMetadata };

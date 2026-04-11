/**
 * IPC handlers for core prompts
 *
 * Provides full CRUD for the Maestro Prompts UI tab.
 * Changes are saved to customizations file AND applied immediately in memory.
 */

import { ipcMain } from 'electron';
import {
	getPrompt,
	getAllPrompts,
	getAllPromptIds,
	savePrompt,
	resetPrompt,
	arePromptsInitialized,
} from '../../prompt-manager';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[IPC:Prompts]';

export function registerPromptsHandlers(): void {
	// Get a single prompt by ID
	ipcMain.handle('prompts:get', async (_, id: string) => {
		try {
			if (!arePromptsInitialized()) {
				return { success: false, error: 'Prompts not yet initialized' };
			}
			const content = getPrompt(id);
			return { success: true, content };
		} catch (error) {
			logger.error(`Failed to get prompt ${id}: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	// Get all prompts with metadata (for UI)
	ipcMain.handle('prompts:getAll', async () => {
		try {
			if (!arePromptsInitialized()) {
				return { success: false, error: 'Prompts not yet initialized' };
			}
			const prompts = getAllPrompts();
			return { success: true, prompts };
		} catch (error) {
			logger.error(`Failed to get all prompts: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	// Get all prompt IDs (for reference)
	ipcMain.handle('prompts:getAllIds', async () => {
		try {
			if (!arePromptsInitialized()) {
				return { success: false, error: 'Prompts not yet initialized' };
			}
			const ids = getAllPromptIds();
			return { success: true, ids };
		} catch (error) {
			logger.error(`Failed to get prompt IDs: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	// Save user's edit to a prompt (immediate effect)
	ipcMain.handle('prompts:save', async (_, id: string, content: string) => {
		try {
			await savePrompt(id, content);
			return { success: true };
		} catch (error) {
			logger.error(`Failed to save prompt ${id}: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	// Reset a prompt to bundled default (immediate effect)
	ipcMain.handle('prompts:reset', async (_, id: string) => {
		try {
			const content = await resetPrompt(id);
			return { success: true, content };
		} catch (error) {
			logger.error(`Failed to reset prompt ${id}: ${error}`, LOG_CONTEXT);
			return { success: false, error: String(error) };
		}
	});

	logger.info('Prompts IPC handlers registered', LOG_CONTEXT);
}

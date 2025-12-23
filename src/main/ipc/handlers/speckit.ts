/**
 * Spec Kit IPC Handlers
 *
 * Provides IPC handlers for managing spec-kit commands:
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
  getSpeckitMetadata,
  getSpeckitPrompts,
  saveSpeckitPrompt,
  resetSpeckitPrompt,
  refreshSpeckitPrompts,
  getSpeckitCommandBySlash,
  SpecKitCommand,
  SpecKitMetadata,
} from '../../speckit-manager';

const LOG_CONTEXT = '[SpecKit]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
  context: LOG_CONTEXT,
  operation,
  logSuccess,
});

/**
 * Register all Spec Kit IPC handlers.
 */
export function registerSpeckitHandlers(): void {
  // Get metadata (version info, last refresh date)
  ipcMain.handle(
    'speckit:getMetadata',
    createIpcHandler(handlerOpts('getMetadata', false), async () => {
      const metadata = await getSpeckitMetadata();
      return { metadata };
    })
  );

  // Get all spec-kit prompts
  ipcMain.handle(
    'speckit:getPrompts',
    createIpcHandler(handlerOpts('getPrompts', false), async () => {
      const commands = await getSpeckitPrompts();
      return { commands };
    })
  );

  // Get a single command by slash command string
  ipcMain.handle(
    'speckit:getCommand',
    createIpcHandler(handlerOpts('getCommand', false), async (slashCommand: string) => {
      const command = await getSpeckitCommandBySlash(slashCommand);
      return { command };
    })
  );

  // Save user's edit to a prompt
  ipcMain.handle(
    'speckit:savePrompt',
    createIpcHandler(handlerOpts('savePrompt'), async (id: string, content: string) => {
      await saveSpeckitPrompt(id, content);
      logger.info(`Saved custom prompt for speckit.${id}`, LOG_CONTEXT);
      return {};
    })
  );

  // Reset a prompt to bundled default
  ipcMain.handle(
    'speckit:resetPrompt',
    createIpcHandler(handlerOpts('resetPrompt'), async (id: string) => {
      const prompt = await resetSpeckitPrompt(id);
      logger.info(`Reset speckit.${id} to bundled default`, LOG_CONTEXT);
      return { prompt };
    })
  );

  // Refresh prompts from GitHub
  ipcMain.handle(
    'speckit:refresh',
    createIpcHandler(handlerOpts('refresh'), async () => {
      const metadata = await refreshSpeckitPrompts();
      logger.info(`Refreshed spec-kit prompts to ${metadata.sourceVersion}`, LOG_CONTEXT);
      return { metadata };
    })
  );

  logger.debug(`${LOG_CONTEXT} Spec Kit IPC handlers registered`);
}

// Export types for preload
export type { SpecKitCommand, SpecKitMetadata };

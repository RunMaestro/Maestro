/**
 * OpenSpec Service
 *
 * Provides access to bundled OpenSpec commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { OpenSpecCommand } from '../types';
import { logger } from '../utils/logger';

/**
 * Get all OpenSpec commands from the main process
 */
export async function getOpenSpecCommands(): Promise<OpenSpecCommand[]> {
	try {
		const result = await window.maestro.openspec.getPrompts();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		logger.error('[OpenSpec] Failed to get commands:', undefined, error);
		return [];
	}
}

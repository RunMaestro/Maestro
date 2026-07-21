/**
 * BMAD Service
 *
 * Provides access to bundled BMAD commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { BmadCommand } from '../types';
import { logger } from '../utils/logger';

/**
 * Get all BMAD commands from the main process.
 */
export async function getBmadCommands(): Promise<BmadCommand[]> {
	try {
		const api = window.maestro?.bmad;
		if (!api) {
			return [];
		}
		const result = await api.getPrompts();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		logger.error('[BMAD] Failed to get commands:', undefined, error);
		return [];
	}
}

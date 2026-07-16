/**
 * Spec Kit Service
 *
 * Provides access to bundled spec-kit commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { SpecKitCommand } from '../types';
import { logger } from '../utils/logger';

/**
 * Get all spec-kit commands from the main process
 */
export async function getSpeckitCommands(): Promise<SpecKitCommand[]> {
	try {
		const result = await window.maestro.speckit.getPrompts();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		logger.error('[SpecKit] Failed to get commands:', undefined, error);
		return [];
	}
}

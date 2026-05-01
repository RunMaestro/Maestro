/**
 * PM Service
 *
 * Provides access to bundled /PM verb prompts for the renderer.
 * These commands integrate with the customAICommands slash command dispatch path
 * (the same path used by Spec-Kit, OpenSpec, and BMAD).
 */

import { logger } from '../utils/logger';

export interface PmCommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

/**
 * Get all /PM commands from the main process.
 */
export async function getPmCommands(): Promise<PmCommand[]> {
	try {
		const api = window.maestro?.pm;
		if (!api) {
			return [];
		}
		const result = await api.loadCommands();
		if (result.success && result.commands) {
			return result.commands;
		}
		return [];
	} catch (error) {
		logger.error('[PM] Failed to get commands:', undefined, error);
		return [];
	}
}

/**
 * BMAD Service
 *
 * Provides access to bundled BMAD commands for the renderer.
 * These commands integrate with the slash command system.
 */

import type { BmadCommand, BmadMetadata } from '../types';
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

/**
 * Get BMAD metadata (version, refresh date).
 */
export async function getBmadMetadata(): Promise<BmadMetadata | null> {
	try {
		const api = window.maestro?.bmad;
		if (!api) {
			return null;
		}
		const result = await api.getMetadata();
		if (result.success && result.metadata) {
			return result.metadata;
		}
		return null;
	} catch (error) {
		logger.error('[BMAD] Failed to get metadata:', undefined, error);
		return null;
	}
}

/**
 * Get a single BMAD command by its slash command string.
 */
export async function getBmadCommand(slashCommand: string): Promise<BmadCommand | null> {
	try {
		const api = window.maestro?.bmad;
		if (!api) {
			return null;
		}
		const result = await api.getCommand(slashCommand);
		if (result.success && result.command) {
			return result.command;
		}
		return null;
	} catch (error) {
		logger.error('[BMAD] Failed to get command:', undefined, error);
		return null;
	}
}
